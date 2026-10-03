/**
 * Clients / CRD (README §13, §14, §15, §119) + entreprises & agences (§16, §17).
 * - Recherche par nom/téléphone/email (README §84).
 * - Documents d'identité : données sensibles -> masquage partiel en lecture.
 * - Préférences client.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, ilike, isNull, or } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditService } from '../audit/audit';
import { AuthModule, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import type { AuthUser } from '../auth/auth';
import { NotFoundError, ValidationError } from '../common/errors';
import { maskDocumentNumber, newId } from '../common/utils';

export interface GuestDto {
  propertyId: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  gender?: 'M' | 'F' | 'OTHER';
  dateOfBirth?: string;
  nationality?: string;
  country?: string;
  phone?: string;
  secondaryPhone?: string;
  email?: string;
  address?: string;
  city?: string;
  region?: string;
  companyId?: string;
  vipLevel?: number;
  notes?: string;
  marketingConsent?: boolean;
}

@Injectable()
export class GuestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Prochaine guest code séquentielle par propriété (ex: G-000123). */
  private async nextGuestCode(db: Db, propertyId: string): Promise<string> {
    const rows = await db
      .select({ id: S.guests.id })
      .from(S.guests)
      .where(eq(S.guests.propertyId, propertyId));
    return `G-${String(rows.length + 1).padStart(6, '0')}`;
  }

  async create(auth: AuthUser, dto: GuestDto) {
    if (!dto?.propertyId || !dto?.firstName || !dto?.lastName) {
      throw new ValidationError({ propertyId: 'required', firstName: 'required', lastName: 'required' });
    }
    const id = newId();
    const code = await this.nextGuestCode(this.db, dto.propertyId);
    const values = {
      id,
      propertyId: dto.propertyId,
      guestCode: code,
      firstName: dto.firstName.trim(),
      lastName: dto.lastName.trim(),
      middleName: dto.middleName ?? null,
      displayName: `${dto.lastName.trim().toUpperCase()} ${dto.firstName.trim()}`,
      gender: dto.gender ?? null,
      dateOfBirth: dto.dateOfBirth ?? null,
      nationality: dto.nationality ?? null,
      country: dto.country ?? null,
      phone: dto.phone ?? null,
      secondaryPhone: dto.secondaryPhone ?? null,
      email: dto.email?.toLowerCase() ?? null,
      address: dto.address ?? null,
      city: dto.city ?? null,
      region: dto.region ?? null,
      companyId: dto.companyId ?? null,
      vipLevel: dto.vipLevel ?? 0,
      notes: dto.notes ?? null,
      marketingConsent: dto.marketingConsent ?? false,
    };
    await this.db.insert(S.guests).values(values as any);
    await this.audit.log({
      organizationId: auth.organizationId,
      propertyId: dto.propertyId,
      userId: auth.userId,
      action: 'guest.create',
      resource: 'guest',
      resourceId: id,
      after: { ...values, phone: maskIfPresent(values.phone), email: maskIfPresent(values.email) },
    });
    return this.get(auth, id);
  }

  async get(auth: AuthUser, id: string) {
    const g = (await this.db.select().from(S.guests).where(and(eq(S.guests.id, id), isNull(S.guests.deletedAt))))[0];
    if (!g) throw new NotFoundError('Guest', id);
    return g;
  }

  /** Recherche (README §84) : nom, téléphone, email, code client. */
  async search(auth: AuthUser, propertyId: string, q?: string, limit = 25) {
    const conds = [eq(S.guests.propertyId, propertyId), isNull(S.guests.deletedAt)];
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      conds.push(
        or(
          ilike(S.guests.displayName, like),
          ilike(S.guests.lastName, like),
          ilike(S.guests.firstName, like),
          ilike(S.guests.phone, like),
          ilike(S.guests.email, like),
          ilike(S.guests.guestCode, like),
        )!,
      );
    }
    return this.db
      .select()
      .from(S.guests)
      .where(and(...conds))
      .orderBy(asc(S.guests.lastName))
      .limit(Math.min(limit, 100));
  }

  async update(auth: AuthUser, id: string, patch: Partial<GuestDto>) {
    const before = await this.get(auth, id);
    const clean: Record<string, unknown> = {};
    for (const k of ['firstName', 'lastName', 'middleName', 'gender', 'dateOfBirth', 'nationality',
      'country', 'phone', 'secondaryPhone', 'email', 'address', 'city', 'region',
      'companyId', 'vipLevel', 'notes', 'marketingConsent'] as const) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    if (clean.firstName || clean.lastName) {
      clean.displayName = `${String(clean.lastName ?? before.lastName).toUpperCase()} ${String(clean.firstName ?? before.firstName)}`;
    }
    if (clean.email) clean.email = String(clean.email).toLowerCase();
    await this.db.update(S.guests).set({ ...clean, updatedAt: new Date() } as any).where(eq(S.guests.id, id));
    await this.audit.log({
      organizationId: auth.organizationId,
      propertyId: before.propertyId,
      userId: auth.userId,
      action: 'guest.update',
      resource: 'guest',
      resourceId: id,
      before,
      after: clean,
    });
    return this.get(auth, id);
  }

  /** Soft delete (README §77) — les références historiques restent intactes. */
  async remove(auth: AuthUser, id: string) {
    const before = await this.get(auth, id);
    await this.db.update(S.guests).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(S.guests.id, id));
    await this.audit.log({
      organizationId: auth.organizationId,
      propertyId: before.propertyId,
      userId: auth.userId,
      action: 'guest.delete',
      resource: 'guest',
      resourceId: id,
      before,
      severity: 'WARNING',
    });
    return { ok: true };
  }

  // -- Documents (masqués en lecture, README §14/§119) ----------------------

  async addDocument(auth: AuthUser, guestId: string, body: {
    documentType: string; documentNumber: string; issuingCountry?: string;
    issueDate?: string; expiryDate?: string; fileUrl?: string;
  }) {
    if (!body?.documentType || !body?.documentNumber) {
      throw new ValidationError({ documentType: 'required', documentNumber: 'required' });
    }
    await this.get(auth, guestId);
    const id = newId();
    await this.db.insert(S.guestDocuments).values({
      id,
      guestId,
      documentType: body.documentType,
      documentNumber: body.documentNumber,
      issuingCountry: body.issuingCountry ?? null,
      issueDate: body.issueDate ?? null,
      expiryDate: body.expiryDate ?? null,
      fileUrl: body.fileUrl ?? null,
    });
    await this.audit.log({
      userId: auth.userId,
      action: 'guest_document.create',
      resource: 'guest_document',
      resourceId: id,
      after: { guestId, documentType: body.documentType, documentNumber: maskDocumentNumber(body.documentNumber) },
    });
    return { id, maskedNumber: maskDocumentNumber(body.documentNumber) };
  }

  async listDocuments(auth: AuthUser, guestId: string) {
    const docs = await this.db.select().from(S.guestDocuments).where(eq(S.guestDocuments.guestId, guestId));
    // Masquage côté serveur uniquement (jamais le numéro complet en liste).
    return docs.map((d) => ({ ...d, documentNumber: maskDocumentNumber(d.documentNumber) }));
  }

  // -- Préférences (README §15) ---------------------------------------------

  async setPreference(auth: AuthUser, guestId: string, body: { preferenceType: string; preferenceValue: string; notes?: string }) {
    if (!body?.preferenceType || !body?.preferenceValue) {
      throw new ValidationError({ preferenceType: 'required', preferenceValue: 'required' });
    }
    await this.get(auth, guestId);
    const id = newId();
    await this.db.insert(S.guestPreferences).values({
      id,
      guestId,
      preferenceType: body.preferenceType,
      preferenceValue: body.preferenceValue,
      notes: body.notes ?? null,
    });
    return { id };
  }

  async listPreferences(auth: AuthUser, guestId: string) {
    return this.db.select().from(S.guestPreferences).where(eq(S.guestPreferences.guestId, guestId));
  }

  // -- Entreprises / Agences (README §16, §17) ------------------------------

  async createCompany(auth: AuthUser, body: any) {
    if (!body?.propertyId || !body?.name) throw new ValidationError({ propertyId: 'required', name: 'required' });
    const id = newId();
    await this.db.insert(S.companies).values({
      id,
      propertyId: body.propertyId,
      name: body.name,
      legalName: body.legalName ?? null,
      rccm: body.rccm ?? null,
      taxIdentifier: body.taxIdentifier ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      address: body.address ?? null,
      city: body.city ?? null,
      country: body.country ?? null,
      contactPerson: body.contactPerson ?? null,
      paymentTerms: body.paymentTerms ?? 0,
      creditLimit: body.creditLimit ?? 0,
    });
    await this.audit.log({ userId: auth.userId, propertyId: body.propertyId, action: 'company.create', resource: 'company', resourceId: id, after: body });
    return (await this.db.select().from(S.companies).where(eq(S.companies.id, id)))[0];
  }

  async listCompanies(auth: AuthUser, propertyId: string) {
    return this.db.select().from(S.companies).where(and(eq(S.companies.propertyId, propertyId), isNull(S.companies.deletedAt)));
  }

  async createAgency(auth: AuthUser, body: any) {
    if (!body?.propertyId || !body?.name) throw new ValidationError({ propertyId: 'required', name: 'required' });
    const id = newId();
    await this.db.insert(S.agencies).values({
      id,
      propertyId: body.propertyId,
      name: body.name,
      legalName: body.legalName ?? null,
      registrationNumber: body.registrationNumber ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      address: body.address ?? null,
      commissionType: body.commissionType ?? 'PERCENTAGE',
      commissionValue: body.commissionValue ?? 0,
      paymentTerms: body.paymentTerms ?? 0,
    });
    await this.audit.log({ userId: auth.userId, propertyId: body.propertyId, action: 'agency.create', resource: 'agency', resourceId: id, after: body });
    return (await this.db.select().from(S.agencies).where(eq(S.agencies.id, id)))[0];
  }

  async listAgencies(auth: AuthUser, propertyId: string) {
    return this.db.select().from(S.agencies).where(and(eq(S.agencies.propertyId, propertyId), isNull(S.agencies.deletedAt)));
  }
}

function maskIfPresent(v: string | null | undefined): string | null {
  return v ? maskDocumentNumber(v) : null;
}

@Controller('api/v1')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Post('guests')
  @RequirePermission('guest.create')
  create(@CurrentUser() auth: AuthUser, @Body() dto: GuestDto) {
    return this.guests.create(auth, dto);
  }

  @Get('guests')
  @RequirePermission('guest.view')
  search(
    @CurrentUser() auth: AuthUser,
    @Query('propertyId') propertyId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.guests.search(auth, propertyId, q, limit ? Number(limit) : 25);
  }

  @Get('guests/:id')
  @RequirePermission('guest.view')
  getOne(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.guests.get(auth, id);
  }

  @Post('guests/:id/documents')
  @RequirePermission('guest.update')
  addDoc(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.guests.addDocument(auth, id, body);
  }

  @Get('guests/:id/documents')
  @RequirePermission('guest.view')
  docs(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.guests.listDocuments(auth, id);
  }

  @Post('guests/:id/preferences')
  @RequirePermission('guest.update')
  setPref(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.guests.setPreference(auth, id, body);
  }

  @Get('guests/:id/preferences')
  @RequirePermission('guest.view')
  prefs(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.guests.listPreferences(auth, id);
  }

  @Delete('guests/:id')
  @RequirePermission('guest.delete')
  remove(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.guests.remove(auth, id);
  }

  @Post('companies')
  @RequirePermission('company.manage')
  createCompany(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.guests.createCompany(auth, body);
  }

  @Get('companies')
  @RequirePermission('company.view')
  companies(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string) {
    return this.guests.listCompanies(auth, propertyId);
  }

  @Post('agencies')
  @RequirePermission('agency.manage')
  createAgency(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.guests.createAgency(auth, body);
  }

  @Get('agencies')
  @RequirePermission('agency.view')
  agencies(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string) {
    return this.guests.listAgencies(auth, propertyId);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [GuestsController],
  providers: [GuestsService, DatabaseService, AuditService, { provide: DB, useExisting: DatabaseService }],
  exports: [GuestsService],
})
export class GuestsModule {}
