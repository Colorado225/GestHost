/**
 * Réservations (README §18–§20, workflows §44, §46–§48, walk-in §112).
 *
 * Cycle de vie : DRAFT -> OPTION -> CONFIRMED -> CHECKED_IN -> CHECKED_OUT/CLOSED
 *                          \-> CANCELLED / NO_SHOW
 * - Création dans une transaction : inventaire verrouillé (FOR UPDATE) +
 *   audit + outbox event atomiques (AC §134 anti double-booking).
 * - Annulation : pénalité selon politique (§12), libération d'inventaire.
 * - No-show : pénalité no-show, chambre libérée après night audit (§48).
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditService } from '../audit/audit';
import { AuthModule, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import type { AuthUser } from '../auth/auth';
import { OutboxService } from '../outbox/outbox';
import { PricingModule, PricingService } from '../pricing/pricing';
import { InventoryModule, AvailabilityService } from '../inventory/availability';
import { DomainEventType, PenaltyType, ReservationStatus } from '../common/enums';
import { BizError, NotFoundError, ValidationError } from '../common/errors';
import { addDays, newId, nightsBetween } from '../common/utils';

export interface CreateReservationDto {
  propertyId: string;
  guestId?: string;
  companyId?: string;
  agencyId?: string;
  source?: string;
  arrivalDate: string;
  departureDate: string;
  adults?: number;
  children?: number;
  roomId?: string; // affectation physique immédiate (walk-in / assignation)
  rooms: Array<{
    roomTypeId: string;
    ratePlanId: string;
    quantity?: number;
    adults?: number;
    children?: number;
    discountAmount?: number;
    discountReason?: string;
  }>;
  specialRequests?: string;
  internalNotes?: string;
  externalReference?: string;
}

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['OPTION', 'CONFIRMED', 'CANCELLED'],
  OPTION: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  WAITLISTED: ['CONFIRMED', 'CANCELLED'],
  CHECKED_IN: ['CHECKED_OUT', 'CLOSED'],
  CANCELLED: [],
  NO_SHOW: ['CANCELLED'],
  CHECKED_OUT: ['CLOSED'],
  CLOSED: [],
};

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly pricing: PricingService,
    private readonly availability: AvailabilityService,
  ) {}

  /** Numéro de réservation séquentiel par propriété et par jour (ex: RS-20261004-0007). */
  private async nextReservationNumber(db: Db, propertyId: string, businessDate: string): Promise<string> {
    const rows = await db
      .select({ id: S.reservations.id })
      .from(S.reservations)
      .where(and(eq(S.reservations.propertyId, propertyId), gte(S.reservations.createdAt, new Date(`${businessDate}T00:00:00Z`))));
    return `RS-${businessDate.replaceAll('-', '')}-${String(rows.length + 1).padStart(4, '0')}`;
  }

  async create(auth: AuthUser, dto: CreateReservationDto) {
    if (!dto?.propertyId || !dto?.arrivalDate || !dto?.departureDate || !dto?.rooms?.length) {
      throw new ValidationError({ propertyId: 'required', arrivalDate: 'required', departureDate: 'required', rooms: 'required' });
    }
    const nights = nightsBetween(dto.arrivalDate, dto.departureDate);

    const prop = (await this.db.select().from(S.properties).where(eq(S.properties.id, dto.propertyId)))[0];
    if (!prop) throw new NotFoundError('Property', dto.propertyId);

    const reservationId = newId();

    // Transaction unique : inventaire + réservation + lignes + audit + outbox (README §93, §96).
    const created = await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;

      let subtotal = 0;
      let taxTotal = 0;
      let totalAll = 0;
      let depositRequired = 0;
      const lineResults: any[] = [];

      for (const line of dto.rooms) {
        const qty = Math.max(1, line.quantity ?? 1);
        const breakdown = await this.pricing.priceStay(tx as unknown as Db, {
          propertyId: dto.propertyId,
          ratePlanId: line.ratePlanId,
          roomTypeId: line.roomTypeId,
          arrival: dto.arrivalDate,
          departure: dto.departureDate,
          adults: line.adults ?? dto.adults ?? 1,
          children: line.children ?? dto.children ?? 0,
          discountAmount: line.discountAmount ?? 0,
        });
        const plan = (await tx.select().from(S.ratePlans).where(eq(S.ratePlans.id, line.ratePlanId)))[0];
        if (!plan) throw new NotFoundError('RatePlan', line.ratePlanId);

        subtotal += breakdown.subtotal * qty;
        taxTotal += breakdown.taxTotal * qty;
        totalAll += breakdown.total * qty;
        const dep = Math.floor((breakdown.total * qty * (plan.depositPercentage ?? 0)) / 100);
        depositRequired += dep;

        lineResults.push({ breakdown, plan, line, qty });
      }

      await tx.insert(S.reservations).values({
        id: reservationId,
        propertyId: dto.propertyId,
        reservationNumber: await this.nextReservationNumber(tx as unknown as Db, dto.propertyId, prop.currentBusinessDate),
        source: dto.source ?? 'DIRECT',
        status: ReservationStatus.DRAFT,
        guestId: dto.guestId ?? null,
        companyId: dto.companyId ?? null,
        agencyId: dto.agencyId ?? null,
        arrivalDate: dto.arrivalDate,
        departureDate: dto.departureDate,
        nights,
        adults: dto.adults ?? dto.rooms[0]?.adults ?? 1,
        children: dto.children ?? dto.rooms[0]?.children ?? 0,
        currency: prop.currency,
        subtotal,
        taxAmount: taxTotal,
        totalAmount: totalAll,
        depositRequired,
        specialRequests: dto.specialRequests ?? null,
        internalNotes: dto.internalNotes ?? null,
        externalReference: dto.externalReference ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });

      if (dto.guestId) {
        await tx.insert(S.reservationGuests).values({
          id: newId(),
          reservationId,
          guestId: dto.guestId,
          role: 'PRIMARY',
          isPrimary: true,
        });
      }

      for (const r of lineResults) {
        const rrId = newId();
        await tx.insert(S.reservationRooms).values({
          id: rrId,
          reservationId,
          roomTypeId: r.line.roomTypeId,
          roomId: dto.roomId ?? null,
          ratePlanId: r.line.ratePlanId,
          adults: r.line.adults ?? dto.adults ?? 1,
          children: r.line.children ?? dto.children ?? 0,
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
          numberOfNights: nights,
          baseAmount: r.breakdown.subtotal * r.qty,
          discountAmount: r.breakdown.discountAmount * r.qty,
          discountReason: r.line.discountReason ?? null,
          taxAmount: r.breakdown.taxTotal * r.qty,
          totalAmount: r.breakdown.total * r.qty,
        });

        // Verrou d'inventaire par nuit — cœur anti double-réservation (AC §134).
        await this.availability.reserveNights(tx as unknown as Db, {
          propertyId: dto.propertyId,
          roomTypeId: r.line.roomTypeId,
          reservationId,
          arrival: dto.arrivalDate,
          departure: dto.departureDate,
          quantity: r.qty,
        });
      }

      // Affectation physique éventuelle dès la création (walk-in §112)
      if (dto.roomId) {
        for (const r of lineResults) {
          await this.availability.assertRoomAssignable(tx as unknown as Db, dto.roomId);
        }
      }

      await this.audit.log(
        {
          organizationId: auth.organizationId,
          propertyId: dto.propertyId,
          userId: auth.userId,
          action: 'reservation.create',
          resource: 'reservation',
          resourceId: reservationId,
          after: { dto: { ...dto }, totals: { subtotal, taxTotal, totalAll } },
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.RESERVATION_CREATED,
        aggregateType: 'reservation',
        aggregateId: reservationId,
        organizationId: auth.organizationId,
        propertyId: dto.propertyId,
        payload: { reservationNumber: reservationId, arrivalDate: dto.arrivalDate, departureDate: dto.departureDate },
      });

      return { id: reservationId };
    });

    return this.getFull(created.id);
  }

  async getFull(id: string) {
    const res = (await this.db.select().from(S.reservations).where(eq(S.reservations.id, id)))[0];
    if (!res) throw new NotFoundError('Reservation', id);
    const rooms = await this.db
      .select()
      .from(S.reservationRooms)
      .where(and(eq(S.reservationRooms.reservationId, id), eq(S.reservationRooms.status, 'ACTIVE')));
    const guests = await this.db
      .select()
      .from(S.reservationGuests)
      .where(eq(S.reservationGuests.reservationId, id));
    return { ...res, rooms, guests };
  }

  async list(auth: AuthUser, opts: { propertyId: string; status?: string; arrivalFrom?: string; arrivalTo?: string; guestId?: string; limit?: number }) {
    const conds = [eq(S.reservations.propertyId, opts.propertyId)];
    if (opts.status) conds.push(eq(S.reservations.status, opts.status));
    if (opts.arrivalFrom) conds.push(gte(S.reservations.arrivalDate, opts.arrivalFrom));
    if (opts.arrivalTo) conds.push(lte(S.reservations.arrivalDate, opts.arrivalTo));
    if (opts.guestId) conds.push(eq(S.reservations.guestId, opts.guestId));
    return this.db
      .select()
      .from(S.reservations)
      .where(and(...conds))
      .orderBy(desc(S.reservations.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200));
  }

  /** Transitions DRAFT->OPTION->CONFIRMED (README §44). */
  async transition(auth: AuthUser, id: string, toStatus: ReservationStatus) {
    const res = (await this.db.select().from(S.reservations).where(eq(S.reservations.id, id)))[0];
    if (!res) throw new NotFoundError('Reservation', id);
    const allowed = TRANSITIONS[res.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw BizError.invalidStateTransition('reservation', res.status, toStatus);
    }
    await this.db
      .update(S.reservations)
      .set({ status: toStatus, updatedBy: auth.userId, updatedAt: new Date() })
      .where(eq(S.reservations.id, id));
    await this.audit.log({
      organizationId: auth.organizationId,
      propertyId: res.propertyId,
      userId: auth.userId,
      action: `reservation.${toStatus.toLowerCase()}`,
      resource: 'reservation',
      resourceId: id,
      before: { status: res.status },
      after: { status: toStatus },
    });
    if (toStatus === ReservationStatus.CONFIRMED) {
      await this.outbox.emit(this.db, {
        eventType: DomainEventType.RESERVATION_CONFIRMED,
        aggregateType: 'reservation',
        aggregateId: id,
        propertyId: res.propertyId,
        payload: {},
      });
    }
    return this.getFull(id);
  }

  /** Modification avant arrivée (README §46) : dates/type -> ré-reserve l'inventaire. */
  async update(auth: AuthUser, id: string, patch: Partial<CreateReservationDto>) {
    const res = (await this.db.select().from(S.reservations).where(eq(S.reservations.id, id)))[0];
    if (!res) throw new NotFoundError('Reservation', id);
    if (![ReservationStatus.DRAFT, ReservationStatus.OPTION, ReservationStatus.CONFIRMED].includes(res.status as any)) {
      throw BizError.invalidStateTransition('reservation', res.status, 'UPDATE');
    }
    const changeDates = patch.arrivalDate && patch.arrivalDate !== res.arrivalDate;
    const changeDeparture = patch.departureDate && patch.departureDate !== res.departureDate;

    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      if (changeDates || changeDeparture) {
        const arrival = patch.arrivalDate ?? res.arrivalDate;
        const departure = patch.departureDate ?? res.departureDate;
        const nights = nightsBetween(arrival, departure);
        // Libère puis re-réserve chaque ligne pour recalculer les nuits concernées.
        const lines = await tx
          .select()
          .from(S.reservationRooms)
          .where(and(eq(S.reservationRooms.reservationId, id), eq(S.reservationRooms.status, 'ACTIVE')));
        await this.availability.releaseNights(tx as unknown as Db, id);
        for (const l of lines) {
          await tx
            .update(S.reservationRooms)
            .set({ arrivalDate: arrival, departureDate: departure, numberOfNights: nights, updatedAt: new Date() })
            .where(eq(S.reservationRooms.id, l.id));
          await this.availability.reserveNights(tx as unknown as Db, {
            propertyId: res.propertyId,
            roomTypeId: l.roomTypeId,
            reservationId: id,
            arrival,
            departure,
            quantity: 1,
          });
        }
        await tx
          .update(S.reservations)
          .set({ arrivalDate: arrival, departureDate: departure, nights, updatedBy: auth.userId, updatedAt: new Date() })
          .where(eq(S.reservations.id, id));
      } else {
        const clean: Record<string, unknown> = { updatedAt: new Date(), updatedBy: auth.userId };
        for (const k of ['specialRequests', 'internalNotes', 'externalReference'] as const) {
          if ((patch as any)[k] !== undefined) clean[k] = (patch as any)[k];
        }
        await tx.update(S.reservations).set(clean as any).where(eq(S.reservations.id, id));
      }
      await this.audit.log(
        {
          organizationId: auth.organizationId,
          propertyId: res.propertyId,
          userId: auth.userId,
          action: 'reservation.update',
          resource: 'reservation',
          resourceId: id,
          before: res,
          after: patch,
        },
        tx as unknown as Db,
      );
    });
    return this.getFull(id);
  }

  /** Calcule la pénalité d'annulation selon la politique du rate plan (README §12, §47). */
  async computeCancellationPenalty(db: Db, reservationId: string, at: Date): Promise<number> {
    const lines = await db
      .select()
      .from(S.reservationRooms)
      .where(and(eq(S.reservationRooms.reservationId, reservationId), eq(S.reservationRooms.status, 'ACTIVE')));
    let penalty = 0;
    for (const l of lines) {
      const plan = (await db.select().from(S.ratePlans).where(eq(S.ratePlans.id, l.ratePlanId)))[0];
      if (!plan?.cancellationPolicyId) continue;
      const pol = (await db.select().from(S.cancellationPolicies).where(eq(S.cancellationPolicies.id, plan.cancellationPolicyId)))[0];
      if (!pol) continue;
      const deadlineMs = Date.parse(`${l.arrivalDate}T00:00:00Z`) - pol.deadlineHours * 3_600_000;
      if (at.getTime() >= deadlineMs) {
        // Hors délai -> pénalité appliquée
        switch (pol.penaltyType) {
          case PenaltyType.NONE: break;
          case PenaltyType.FIXED_AMOUNT: penalty += pol.penaltyValue; break;
          case PenaltyType.FIRST_NIGHT: penalty += Math.floor(l.totalAmount / Math.max(1, l.numberOfNights)); break;
          case PenaltyType.PERCENTAGE: penalty += Math.floor((l.totalAmount * pol.penaltyValue) / 100); break;
          case PenaltyType.FULL_STAY: penalty += l.totalAmount; break;
        }
      }
    }
    return penalty;
  }

  /** Annulation (README §47) : pénalité + libération d'inventaire + folio si check-in. */
  async cancel(auth: AuthUser, id: string, reason: string, waivePenalty = false) {
    const res = (await this.db.select().from(S.reservations).where(eq(S.reservations.id, id)))[0];
    if (!res) throw new NotFoundError('Reservation', id);
    if (![ReservationStatus.DRAFT, ReservationStatus.OPTION, ReservationStatus.CONFIRMED, ReservationStatus.WAITLISTED].includes(res.status as any)) {
      throw BizError.invalidStateTransition('reservation', res.status, 'CANCELLED');
    }
    const penalty = waivePenalty ? 0 : await this.computeCancellationPenalty(this.db, id, new Date());

    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx
        .update(S.reservations)
        .set({
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: reason,
          updatedBy: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(S.reservations.id, id));
      await tx
        .update(S.reservationRooms)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(S.reservationRooms.reservationId, id));
      await this.availability.releaseNights(tx as unknown as Db, id);
      await this.audit.log(
        {
          organizationId: auth.organizationId,
          propertyId: res.propertyId,
          userId: auth.userId,
          action: 'reservation.cancel',
          resource: 'reservation',
          resourceId: id,
          before: { status: res.status },
          after: { status: 'CANCELLED', reason, penalty, waived: waivePenalty },
          severity: 'WARNING',
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.RESERVATION_CANCELLED,
        aggregateType: 'reservation',
        aggregateId: id,
        propertyId: res.propertyId,
        payload: { reason, penalty },
      });
    });
    return { ...(await this.getFull(id)), penaltyApplied: penalty };
  }

  /** No-show (README §48) : pénalité no-show, nuit perdue, statut NO_SHOW. */
  async markNoShow(auth: AuthUser, id: string) {
    const res = (await this.db.select().from(S.reservations).where(eq(S.reservations.id, id)))[0];
    if (!res) throw new NotFoundError('Reservation', id);
    if (res.status !== ReservationStatus.CONFIRMED && res.status !== ReservationStatus.OPTION) {
      throw BizError.invalidStateTransition('reservation', res.status, 'NO_SHOW');
    }
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx
        .update(S.reservations)
        .set({ status: ReservationStatus.NO_SHOW, noShowAt: new Date(), updatedBy: auth.userId, updatedAt: new Date() })
        .where(eq(S.reservations.id, id));
      // La nuit non consommée est tout de même facturée via pénalité au checkout/no-show ;
      // l'inventaire des nuits restantes est libéré.
      await this.availability.releaseNightsFrom(tx as unknown as Db, id, addDays(res.arrivalDate, 1));
      await this.audit.log(
        {
          organizationId: auth.organizationId,
          propertyId: res.propertyId,
          userId: auth.userId,
          action: 'reservation.no_show',
          resource: 'reservation',
          resourceId: id,
          before: { status: res.status },
          after: { status: 'NO_SHOW' },
          severity: 'WARNING',
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.RESERVATION_NO_SHOW,
        aggregateType: 'reservation',
        aggregateId: id,
        propertyId: res.propertyId,
        payload: {},
      });
    });
    return this.getFull(id);
  }
}

@Controller('api/v1/reservations')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReservationsController {
  constructor(private readonly service: ReservationsService) {}

  @Post()
  @RequirePermission('reservation.create')
  create(@CurrentUser() auth: AuthUser, @Body() dto: CreateReservationDto) {
    return this.service.create(auth, dto);
  }

  @Get()
  @RequirePermission('reservation.view')
  list(
    @CurrentUser() auth: AuthUser,
    @Query('propertyId') propertyId: string,
    @Query('status') status?: string,
    @Query('arrivalFrom') arrivalFrom?: string,
    @Query('arrivalTo') arrivalTo?: string,
    @Query('guestId') guestId?: string,
  ) {
    return this.service.list(auth, { propertyId, status, arrivalFrom, arrivalTo, guestId });
  }

  @Get(':id')
  @RequirePermission('reservation.view')
  getOne(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.service.getFull(id);
  }

  @Patch(':id')
  @RequirePermission('reservation.update')
  update(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() patch: Partial<CreateReservationDto>) {
    return this.service.update(auth, id, patch);
  }

  @Post(':id/confirm')
  @RequirePermission('reservation.update')
  confirm(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.service.transition(auth, id, ReservationStatus.CONFIRMED);
  }

  @Post(':id/option')
  @RequirePermission('reservation.update')
  option(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.service.transition(auth, id, ReservationStatus.OPTION);
  }

  @Post(':id/cancel')
  @RequirePermission('reservation.cancel')
  cancel(
    @CurrentUser() auth: AuthUser,
    @Param('id') id: string,
    @Body() body: { reason: string; waivePenalty?: boolean },
  ) {
    return this.service.cancel(auth, id, body?.reason ?? 'non précisé', !!body?.waivePenalty);
  }

  @Post(':id/no-show')
  @RequirePermission('reservation.no_show')
  noShow(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.service.markNoShow(auth, id);
  }
}

@Module({
  imports: [AuthModule, PricingModule, InventoryModule],
  controllers: [ReservationsController],
  providers: [
    ReservationsService,
    DatabaseService,
    AuditService,
    OutboxService,
    { provide: DB, useExisting: DatabaseService },
  ],
  exports: [ReservationsService],
})
export class ReservationsModule {}
