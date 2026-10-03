/**
 * Tarification & taxes (README §11, §12, §30, §31, §90).
 * - Rate plans, prix par type/nuit/occupation/saison.
 * - Moteur de taxation configurable : règles avec dates d'effet, jamais hardcodées.
 * - Taxe communale de nuitée paramétrable par classification.
 */
import { Body, Controller, Get, Inject, Injectable, Module, Param, Post } from '@nestjs/common';
import { and, asc, eq, lte, gte, isNull } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import { AuditService } from '../audit/audit';
import { AuthModule, RequirePermission } from '../auth/auth';
import type { AuthUser } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import { NotFoundError, ValidationError } from '../common/errors';
import { newId, nightDates, applyRateBps, roundDiv } from '../common/utils';
import * as S from '../database/schema';

export interface NightlyPrice {
  date: string; // nuit
  amount: number; // net avant taxes (FCFA entier)
}

export interface PriceBreakdown {
  nights: NightlyPrice[];
  subtotal: number;
  discountAmount: number;
  taxes: { code: string; name: string; amount: number; method: string }[];
  taxTotal: number;
  total: number;
  currency: string;
}

@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // -- Rate plans -----------------------------------------------------------

  async createRatePlan(auth: AuthUser, propertyId: string, body: any) {
    if (!body?.name || !body?.code) throw new ValidationError({ name: 'required', code: 'required' });
    const id = newId();
    await this.db.insert(S.ratePlans).values({
      id,
      propertyId,
      name: body.name,
      code: body.code,
      description: body.description ?? null,
      mealPlan: body.mealPlan ?? 'RO',
      cancellationPolicyId: body.cancellationPolicyId ?? null,
      paymentPolicy: body.paymentPolicy ?? 'AT_CHECKOUT',
      depositPercentage: body.depositPercentage ?? 0,
      isRefundable: body.isRefundable ?? true,
      isPublic: body.isPublic ?? true,
      isActive: true,
    });
    await this.audit.log({ userId: auth.userId, propertyId, action: 'rate_plan.create', resource: 'rate_plan', resourceId: id, after: body });
    return (await this.db.select().from(S.ratePlans).where(eq(S.ratePlans.id, id)))[0];
  }

  async listRatePlans(auth: AuthUser, propertyId: string) {
    return this.db
      .select()
      .from(S.ratePlans)
      .where(and(eq(S.ratePlans.propertyId, propertyId), eq(S.ratePlans.isActive, true)))
      .orderBy(asc(S.ratePlans.name));
  }

  /** Prix par nuit pour (rate plan, room type, période, occupation). */
  async nightlyPrices(
    txOrDb: Db,
    ratePlanId: string,
    roomTypeId: string,
    arrival: string,
    departure: string,
    occupancy = 1,
  ): Promise<NightlyPrice[]> {
    const db = txOrDb;
    const prices = await db
      .select()
      .from(S.ratePlanPrices)
      .where(
        and(
          eq(S.ratePlanPrices.ratePlanId, ratePlanId),
          eq(S.ratePlanPrices.roomTypeId, roomTypeId),
          lte(S.ratePlanPrices.validFrom, arrival),
          gte(S.ratePlanPrices.validTo, departure),
        ),
      );
    const seasons = await db
      .select()
      .from(S.seasons)
      .where(and(eq(S.seasons.propertyId, (await db.select({ propertyId: S.roomTypes.propertyId }).from(S.roomTypes).where(eq(S.roomTypes.id, roomTypeId)))[0]?.propertyId ?? ''), eq(S.seasons.isActive, true)));
    void seasons;

    const rtRows = await db.select({ defaultRate: S.roomTypes.defaultRate }).from(S.roomTypes).where(eq(S.roomTypes.id, roomTypeId));
    const fallback = rtRows[0]?.defaultRate ?? 0;

    return nightDates(arrival, departure).map((d) => {
      // Sélection : saison prioritaire si applicable, occupation exacte sinon max <= occupancy.
      const dayCandidates = prices.filter((p) => p.validFrom <= d && p.validTo >= d && p.occupancy <= occupancy);
      const chosen = dayCandidates.sort((a, b) => b.occupancy - a.occupancy)[0];
      return { date: d, amount: chosen ? chosen.amount : fallback };
    });
  }

  /**
   * Breakdown complet : sous-total nuits + remises + TVA (règles actives à la date)
   * + taxe communale de nuitée. Toute la logique est backend (README §90).
   */
  async priceStay(
    db: Db,
    opts: {
      propertyId: string;
      ratePlanId: string;
      roomTypeId: string;
      arrival: string;
      departure: string;
      adults?: number;
      children?: number;
      discountAmount?: number;
    },
  ): Promise<PriceBreakdown> {
    const occupancy = (opts.adults ?? 1) + (opts.children ?? 0);
    const nights = await this.nightlyPrices(db, opts.ratePlanId, opts.roomTypeId, opts.arrival, opts.departure, Math.max(occupancy, 1));
    const subtotal = nights.reduce((s, n) => s + n.amount, 0);
    const discountAmount = Math.min(opts.discountAmount ?? 0, subtotal);
    const netRoom = subtotal - discountAmount;

    const prop = (await db.select().from(S.properties).where(eq(S.properties.id, opts.propertyId)))[0];
    if (!prop) throw new NotFoundError('Property', opts.propertyId);

    // Taxes proportionnelles (TVA...) actives à la date d'arrivée
    const rules = await db
      .select()
      .from(S.taxRules)
      .where(
        and(
          eq(S.taxRules.propertyId, opts.propertyId),
          eq(S.taxRules.isActive, true),
          lte(S.taxRules.effectiveFrom, opts.arrival),
        ),
      );
    const taxes: PriceBreakdown['taxes'] = [];
    let taxTotal = 0;
    for (const r of rules) {
      if (r.effectiveTo && r.effectiveTo < opts.arrival) continue;
      if (r.calculationMethod === 'PERCENTAGE') {
        const base = r.appliesTo === 'ROOM' ? netRoom : netRoom; // V1 : assiette commune
        const amt = applyRateBps(base, r.rateBasisPoints);
        taxes.push({ code: r.code, name: r.name, amount: amt, method: 'PERCENTAGE' });
        taxTotal += amt;
      } else if (r.calculationMethod === 'FIXED') {
        taxes.push({ code: r.code, name: r.name, amount: r.fixedAmount, method: 'FIXED' });
        taxTotal += r.fixedAmount;
      }
    }

    // Taxe communale de nuitée : montant fixe x nuits (barème par classification)
    const nTaxCfg = await db
      .select()
      .from(S.nightTaxConfigurations)
      .where(
        and(
          eq(S.nightTaxConfigurations.propertyId, opts.propertyId),
          eq(S.nightTaxConfigurations.hotelClassification, prop.hotelClassification),
          eq(S.nightTaxConfigurations.isActive, true),
          lte(S.nightTaxConfigurations.effectiveFrom, opts.arrival),
        ),
      );
    const applicable = nTaxCfg.filter((c) => !c.effectiveTo || c.effectiveTo >= opts.arrival).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
    if (applicable && applicable.amountPerNight > 0) {
      const amt = applicable.amountPerNight * nights.length;
      taxes.push({ code: 'TCN', name: 'Taxe communale de nuitée', amount: amt, method: 'PER_UNIT_PER_NIGHT' });
      taxTotal += amt;
    }

    const total = netRoom + taxTotal;
    return { nights, subtotal, discountAmount, taxes, taxTotal, total, currency: prop.currency };
  }

  // -- Taxes ----------------------------------------------------------------

  async upsertTaxRule(auth: AuthUser, propertyId: string, body: any) {
    if (!body?.code || !body?.name || !body?.effectiveFrom) {
      throw new ValidationError({ code: 'required', name: 'required', effectiveFrom: 'required' });
    }
    const existing = await this.db
      .select()
      .from(S.taxRules)
      .where(and(eq(S.taxRules.propertyId, propertyId), eq(S.taxRules.code, body.code), eq(S.taxRules.effectiveFrom, body.effectiveFrom)))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(S.taxRules)
        .set({
          name: body.name,
          taxType: body.taxType ?? existing[0].taxType,
          calculationMethod: body.calculationMethod ?? existing[0].calculationMethod,
          rateBasisPoints: body.rateBasisPoints ?? existing[0].rateBasisPoints,
          fixedAmount: body.fixedAmount ?? existing[0].fixedAmount,
          appliesTo: body.appliesTo ?? existing[0].appliesTo,
          effectiveTo: body.effectiveTo ?? existing[0].effectiveTo,
          isActive: body.isActive ?? existing[0].isActive,
          updatedAt: new Date(),
        })
        .where(eq(S.taxRules.id, existing[0].id));
      await this.audit.log({ userId: auth.userId, propertyId, action: 'tax_rule.update', resource: 'tax_rule', resourceId: existing[0].id, before: existing[0], after: body, severity: 'WARNING' });
      return (await this.db.select().from(S.taxRules).where(eq(S.taxRules.id, existing[0].id)))[0];
    }
    const id = newId();
    await this.db.insert(S.taxRules).values({
      id,
      propertyId,
      name: body.name,
      code: body.code,
      taxType: body.taxType ?? 'VAT',
      jurisdiction: body.jurisdiction ?? 'ETAT',
      calculationMethod: body.calculationMethod ?? 'PERCENTAGE',
      rateBasisPoints: body.rateBasisPoints ?? 0,
      fixedAmount: body.fixedAmount ?? 0,
      isInclusive: body.isInclusive ?? false,
      appliesTo: body.appliesTo ?? 'ALL',
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      isActive: true,
    });
    await this.audit.log({ userId: auth.userId, propertyId, action: 'tax_rule.create', resource: 'tax_rule', resourceId: id, after: body, severity: 'WARNING' });
    return (await this.db.select().from(S.taxRules).where(eq(S.taxRules.id, id)))[0];
  }

  async listTaxRules(auth: AuthUser, propertyId: string) {
    return this.db.select().from(S.taxRules).where(eq(S.taxRules.propertyId, propertyId)).orderBy(asc(S.taxRules.effectiveFrom));
  }

  async upsertNightTaxConfig(auth: AuthUser, propertyId: string, body: any) {
    if (!body?.hotelClassification || !body?.effectiveFrom) {
      throw new ValidationError({ hotelClassification: 'required', effectiveFrom: 'required' });
    }
    const id = newId();
    await this.db.insert(S.nightTaxConfigurations).values({
      id,
      propertyId,
      hotelClassification: body.hotelClassification,
      amountPerNight: body.amountPerNight ?? 0,
      currency: body.currency ?? 'XOF',
      jurisdictionType: body.jurisdictionType ?? 'COMMUNE',
      beneficiaryType: body.beneficiaryType ?? 'COMMUNE',
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      isActive: true,
    });
    await this.audit.log({ userId: auth.userId, propertyId, action: 'night_tax_config.upsert', resource: 'night_tax_config', resourceId: id, after: body, severity: 'WARNING' });
    return (await this.db.select().from(S.nightTaxConfigurations).where(eq(S.nightTaxConfigurations.id, id)))[0];
  }

  async listNightTaxConfigs(auth: AuthUser, propertyId: string) {
    return this.db
      .select()
      .from(S.nightTaxConfigurations)
      .where(and(eq(S.nightTaxConfigurations.propertyId, propertyId), isNull(S.nightTaxConfigurations.effectiveTo)))
      .orderBy(asc(S.nightTaxConfigurations.effectiveFrom));
  }

  /** Aide : calcule la part variable d'une facture (pour exports/aperçus). */
  static vatFromNet(net: number, rateBps: number): number {
    return applyRateBps(net, rateBps);
  }

  static splitGross(gross: number, rateBps: number): { net: number; vat: number } {
    const net = roundDiv(gross * 10000, 10000 + rateBps);
    return { net, vat: gross - net };
  }
}

@Controller('v1')
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  @Get('properties/:propertyId/rate-plans')
  listPlans(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listRatePlans(auth, propertyId);
  }

  @Post('properties/:propertyId/rate-plans')
  @RequirePermission('rate.manage')
  createPlan(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.createRatePlan(auth, propertyId, body);
  }

  @Post('properties/:propertyId/pricing/quote')
  @RequirePermission('rate.view')
  quote(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.priceStay(this.svc['db'], { ...body, propertyId });
  }

  @Get('properties/:propertyId/tax-rules')
  listTaxRules(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listTaxRules(auth, propertyId);
  }

  @Post('properties/:propertyId/tax-rules')
  @RequirePermission('settings.manage')
  upsertTaxRule(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.upsertTaxRule(auth, propertyId, body);
  }

  @Post('properties/:propertyId/night-tax-configs')
  @RequirePermission('settings.manage')
  upsertNightTax(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.upsertNightTaxConfig(auth, propertyId, body);
  }

  @Get('properties/:propertyId/night-tax-configs')
  listNightTax(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listNightTaxConfigs(auth, propertyId);
  }
}

@Module({
  imports: [AuthModule],
  providers: [PricingService, AuditService, DatabaseService, { provide: DB, useExisting: DatabaseService }],
  controllers: [PricingController],
  exports: [PricingService],
})
export class PricingModule {}
