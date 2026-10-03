/**
 * Séjours : check-in (§49, §94), changement de chambre (§50), check-out (§54, §95).
 * Chaque opération critique est une transaction PostgreSQL unique (README §93–§95) :
 * stay + folio + statut chambre + historique + audit + outbox. Aucun appel HTTP
 * externe dans la transaction (FNE via outbox).
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditService } from '../audit/audit';
import { AuthModule, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import type { AuthUser } from '../auth/auth';
import { OutboxService } from '../outbox/outbox';
import { InventoryModule, AvailabilityService } from '../inventory/availability';
import { FoliosModule, FoliosService } from '../billing/folios';
import { DomainEventType, ReservationStatus, RoomStatus, StayStatus } from '../common/enums';
import {  DomainError, BizError, ForbiddenError, NotFoundError, ValidationError  } from '../common/errors';
import { newId } from '../common/utils';

@Injectable()
export class StaysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly availability: AvailabilityService,
    private readonly folios: FoliosService,
  ) {}

  private async nextStayNumber(db: Db, propertyId: string): Promise<string> {
    const rows = await db.select({ id: S.stays.id }).from(S.stays).where(eq(S.stays.propertyId, propertyId));
    return `ST-${String(rows.length + 1).padStart(6, '0')}`;
  }

  /**
   * Check-in (README §49, §94). Walk-in sans réservation : on crée d'abord une
   * réservation CHECKED_IN avec verrou d'inventaire (transaction séparée courte),
   * puis la transaction principale stay+folio+room status (AC §132/§134).
   */
  async checkIn(
    auth: AuthUser,
    body: {
      reservationId?: string;
      walkIn?: boolean;
      roomId: string;
      guestId?: string;
      arrivalDate: string;
      departureDate: string;
      ratePlanId?: string;
      roomTypeId?: string;
      adults?: number;
    },
  ) {
    if (!body?.roomId || !body?.arrivalDate || !body?.departureDate) {
      throw new ValidationError({ roomId: 'required', arrivalDate: 'required', departureDate: 'required' });
    }

    // 1) Walk-in : créer la réservation "à chaud" (transaction dédiée courte),
    //    puis enchaîner sur le check-in standard (README §112).
    let reservationId = body.reservationId ?? null;
    if (body.walkIn && !reservationId) {
      if (!body.ratePlanId || !body.roomTypeId || !body.guestId) {
        throw new ValidationError({ ratePlanId: 'required (walk-in)', roomTypeId: 'required (walk-in)', guestId: 'required (walk-in)' });
      }
      reservationId = await this.createWalkInReservation(auth, { roomId: body.roomId, guestId: body.guestId!, arrivalDate: body.arrivalDate, departureDate: body.departureDate, ratePlanId: body.ratePlanId!, roomTypeId: body.roomTypeId!, adults: body.adults });
    }
    if (!reservationId) throw new ValidationError({ reservationId: 'required' });

    const res = (await this.db.select().from(S.reservations).where(eq(S.reservations.id, reservationId)))[0];
    if (!res) throw new NotFoundError('Reservation', reservationId);
    if (![ReservationStatus.CONFIRMED, ReservationStatus.DRAFT].includes(res.status as any)) {
      throw BizError.invalidStateTransition('reservation', res.status, 'CHECKED_IN');
    }

    const stayId = newId();
    const folioId = await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;

      // Vérifications & verrous
      const room = await this.availability.assertRoomAssignable(tx as unknown as Db, body.roomId);
      const rr = (await tx
        .select()
        .from(S.reservationRooms)
        .where(and(eq(S.reservationRooms.reservationId, reservationId!), eq(S.reservationRooms.status, 'ACTIVE'))))[0];
      if (!rr) throw new DomainError('NO_ACTIVE_ROOM_LINE', 'Aucune ligne de chambre active sur cette réservation.', 400);

      // Chambre déjà occupée physiquement ? (double check-in refusé — AC §134 côté physique)
      const activeAssignment = await tx
        .select({ id: S.stayRooms.id })
        .from(S.stayRooms)
        .innerJoin(S.stays, eq(S.stayRooms.stayId, S.stays.id))
        .where(
          and(
            eq(S.stayRooms.roomId, body.roomId),
            isNull(S.stayRooms.releasedAt),
            inArray(S.stays.status, [StayStatus.CHECKED_IN, StayStatus.IN_HOUSE]),
          ),
        );
      if (activeAssignment.length) {
        throw BizError.roomNotAvailable(body.roomId);
      }

      // stay
      await tx.insert(S.stays).values({
        id: stayId,
        propertyId: res.propertyId,
        stayNumber: await this.nextStayNumber(tx as unknown as Db, res.propertyId),
        reservationId: reservationId!,
        primaryGuestId: body.guestId ?? res.guestId ?? null,
        status: StayStatus.CHECKED_IN,
        actualCheckInAt: new Date(),
        plannedCheckIn: body.arrivalDate,
        plannedCheckOut: body.departureDate,
        assignedBy: auth.userId,
        checkedInBy: auth.userId,
      });

      // affectation physique
      await tx.insert(S.stayRooms).values({
        id: newId(),
        stayId,
        roomId: body.roomId,
        roomTypeId: rr.roomTypeId,
        arrivalDate: body.arrivalDate,
        departureDate: body.departureDate,
        assignedBy: auth.userId,
      });

      // folio principal du séjour (README §23, workflow §49)
      const fid = await this.folios.createFolio(tx as unknown as Db, {
        propertyId: res.propertyId,
        stayId,
        guestId: body.guestId ?? res.guestId ?? null,
        companyId: res.companyId ?? null,
        currency: res.currency,
      });

      // statut chambre -> OCCUPIED + historique obligatoire (README §10)
      await tx.update(S.rooms).set({
        status: RoomStatus.OCCUPIED,
        frontOfficeStatus: 'OCCUPIED',
        updatedAt: new Date(),
      }).where(eq(S.rooms.id, body.roomId));
      await tx.insert(S.roomStatusHistory).values({
        id: newId(),
        propertyId: res.propertyId,
        roomId: body.roomId,
        previousStatus: room.status,
        newStatus: RoomStatus.OCCUPIED,
        reason: 'check_in',
        referenceType: 'stay',
        referenceId: stayId,
        changedBy: auth.userId,
      });

      // réservation -> CHECKED_IN
      await tx.update(S.reservations).set({
        status: ReservationStatus.CHECKED_IN,
        updatedBy: auth.userId,
        updatedAt: new Date(),
      }).where(eq(S.reservations.id, reservationId!));

      await this.audit.log(
        {
          organizationId: auth.organizationId,
          propertyId: res.propertyId,
          userId: auth.userId,
          action: 'stay.check_in',
          resource: 'stay',
          resourceId: stayId,
          after: { roomId: body.roomId, reservationId, folioId: fid },
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.GUEST_CHECKED_IN,
        aggregateType: 'stay',
        aggregateId: stayId,
        propertyId: res.propertyId,
        payload: { roomId: body.roomId, reservationId },
      });
      return fid;
    });

    return { stayId, folioId, reservationId };
  }

  /** Création interne d'une réservation walk-in (réutilise la logique résa sans injection circulaire). */
  private async createWalkInReservation(auth: AuthUser, body: {
    roomId: string; guestId: string; arrivalDate: string; departureDate: string;
    ratePlanId: string; roomTypeId: string; adults?: number;
  }): Promise<string> {
    const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, body.roomId)))[0];
    if (!room) throw new NotFoundError('Room', body.roomId);
    const prop = (await this.db.select().from(S.properties).where(eq(S.properties.id, room.propertyId)))[0];
    if (!prop) throw new NotFoundError('Property', room.propertyId);

    const reservationId = newId();
    const nights = Math.max(1, Math.round((Date.parse(`${body.departureDate}T00:00:00Z`) - Date.parse(`${body.arrivalDate}T00:00:00Z`)) / 86400000));

    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const price = await this.computeWalkInPrice(tx, body);
      await tx.insert(S.reservations).values({
        id: reservationId,
        propertyId: room.propertyId,
        reservationNumber: `WI-${body.arrivalDate.replaceAll('-', '')}-${newId().slice(-4)}`,
        source: 'WALK_IN',
        status: ReservationStatus.CONFIRMED,
        guestId: body.guestId,
        arrivalDate: body.arrivalDate,
        departureDate: body.departureDate,
        nights,
        adults: body.adults ?? 1,
        currency: prop.currency,
        subtotal: price.subtotal,
        taxAmount: price.tax,
        totalAmount: price.total,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
      await tx.insert(S.reservationGuests).values({
        id: newId(), reservationId, guestId: body.guestId, role: 'PRIMARY', isPrimary: true,
      });
      await tx.insert(S.reservationRooms).values({
        id: newId(),
        reservationId,
        roomTypeId: body.roomTypeId,
        roomId: body.roomId,
        ratePlanId: body.ratePlanId,
        adults: body.adults ?? 1,
        arrivalDate: body.arrivalDate,
        departureDate: body.departureDate,
        numberOfNights: nights,
        baseAmount: price.subtotal,
        taxAmount: price.tax,
        totalAmount: price.total,
      });
      await this.availability.reserveNights(tx as unknown as Db, {
        propertyId: room.propertyId,
        roomTypeId: body.roomTypeId,
        reservationId,
        arrival: body.arrivalDate,
        departure: body.departureDate,
      });
      await this.audit.log(
        {
          organizationId: auth.organizationId,
          propertyId: room.propertyId,
          userId: auth.userId,
          action: 'reservation.walk_in',
          resource: 'reservation',
          resourceId: reservationId,
          after: { roomId: body.roomId, guestId: body.guestId },
        },
        tx as unknown as Db,
      );
    });
    return reservationId;
  }

  /** Prix walk-in : fallback default_rate x nuits si pricing indisponible (recalcul complet au night audit). */
  private async computeWalkInPrice(tx: Db, body: { roomTypeId: string; arrivalDate: string; departureDate: string }) {
    const rt = (await tx.select().from(S.roomTypes).where(eq(S.roomTypes.id, body.roomTypeId)))[0];
    if (!rt) throw new NotFoundError('RoomType', body.roomTypeId);
    const nights = Math.max(1, Math.round((Date.parse(`${body.departureDate}T00:00:00Z`) - Date.parse(`${body.arrivalDate}T00:00:00Z`)) / 86400000));
    const subtotal = rt.defaultRate * nights;
    // Taxes appliquées par le moteur au moment du posting ROOM (folios.chargeRoomRevenue).
    return { subtotal, tax: 0, total: subtotal };
  }

  /** Changement de chambre (README §50) : libère l'ancienne, assigne la nouvelle, garde le folio. */
  async changeRoom(auth: AuthUser, stayId: string, toRoomId: string, reason: string) {
    const stay = (await this.db.select().from(S.stays).where(eq(S.stays.id, stayId)))[0];
    if (!stay) throw new NotFoundError('Stay', stayId);
    if (stay.status !== StayStatus.CHECKED_IN && stay.status !== StayStatus.IN_HOUSE) {
      throw BizError.invalidStateTransition('stay', stay.status, 'ROOM_CHANGE');
    }
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const current = (await tx
        .select()
        .from(S.stayRooms)
        .where(and(eq(S.stayRooms.stayId, stayId), isNull(S.stayRooms.releasedAt))))[0];
      if (!current) throw new DomainError('NO_ASSIGNED_ROOM', 'Aucune chambre actuellement assignée.', 400);
      const oldRoom = (await tx.select().from(S.rooms).where(eq(S.rooms.id, current.roomId)))[0];
      const newRoom = await this.availability.assertRoomAssignable(tx as unknown as Db, toRoomId);

      // libère ancienne
      await tx.update(S.stayRooms).set({ releasedAt: new Date() }).where(eq(S.stayRooms.id, current.id));
      // ancienne chambre -> sale pending cleaning (workflow housekeeping §36)
      if (oldRoom) {
        await tx.update(S.rooms).set({
          status: RoomStatus.AVAILABLE,
          frontOfficeStatus: 'VACANT',
          housekeepingStatus: 'DIRTY',
          updatedAt: new Date(),
        }).where(eq(S.rooms.id, oldRoom.id));
        await tx.insert(S.roomStatusHistory).values({
          id: newId(), propertyId: stay.propertyId, roomId: oldRoom.id,
          previousStatus: oldRoom.status, newStatus: RoomStatus.AVAILABLE,
          reason: `room_change_from:${reason ?? '-'}`, referenceType: 'stay', referenceId: stayId, changedBy: auth.userId,
        });
      }
      // assigne nouvelle
      await tx.insert(S.stayRooms).values({
        id: newId(), stayId, roomId: toRoomId, roomTypeId: newRoom.roomTypeId,
        arrivalDate: current.arrivalDate, departureDate: current.departureDate, assignedBy: auth.userId,
      });
      await tx.update(S.rooms).set({
        status: RoomStatus.OCCUPIED, frontOfficeStatus: 'OCCUPIED', updatedAt: new Date(),
      }).where(eq(S.rooms.id, toRoomId));
      await tx.insert(S.roomStatusHistory).values({
        id: newId(), propertyId: stay.propertyId, roomId: toRoomId,
        previousStatus: newRoom.status, newStatus: RoomStatus.OCCUPIED,
        reason: `room_change_to:${reason ?? '-'}`, referenceType: 'stay', referenceId: stayId, changedBy: auth.userId,
      });

      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: stay.propertyId, userId: auth.userId,
          action: 'stay.change_room', resource: 'stay', resourceId: stayId,
          before: { roomId: current.roomId }, after: { roomId: toRoomId, reason },
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.ROOM_CHANGED,
        aggregateType: 'stay', aggregateId: stayId, propertyId: stay.propertyId,
        payload: { from: current.roomId, to: toRoomId, reason },
      });
    });
    return { ok: true, stayId, toRoomId };
  }

  /**
   * Check-out (README §54, §95, AC §135) : solde folio doit être nul OU
   * permission stay.checkout_with_balance. Poste les revenus chambres manquants
   * avant clôture. Transaction unique : stay + folio + chambre + audit + outbox.
   */
  async checkOut(auth: AuthUser, stayId: string, opts: { forceWithBalance?: boolean } = {}) {
    const stay = (await this.db.select().from(S.stays).where(eq(S.stays.id, stayId)))[0];
    if (!stay) throw new NotFoundError('Stay', stayId);
    if (stay.status !== StayStatus.CHECKED_IN && stay.status !== StayStatus.IN_HOUSE) {
      throw BizError.invalidStateTransition('stay', stay.status, 'CHECKED_OUT');
    }
    const folio = (await this.db
      .select()
      .from(S.folios)
      .where(and(eq(S.folios.stayId, stayId), isNull(S.folios.closedAt)))
      .orderBy(desc(S.folios.openedAt)))[0];
    if (!folio) throw new DomainError('NO_OPEN_FOLIO', 'Aucun folio ouvert pour ce séjour.', 400);

    // Balance recalculée depuis les écritures (source de vérité, README §107)
    const balance = await this.folios.computeBalance(this.db, folio.id);
    if (balance > 0 && !opts.forceWithBalance) {
      throw BizError.checkoutBlockedUnpaidBalance(balance, folio.currency);
    }
    if (balance > 0 && opts.forceWithBalance) {
      if (!(auth.permissions.includes('stay.checkout_with_balance'))) {
        throw new ForbiddenError('stay.checkout_with_balance');
      }
    }

    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // cloture le(s) folio(s) ouvert(s) du stay
      await tx.update(S.folios).set({ status: 'CLOSED', closedAt: new Date(), balance, updatedAt: new Date() })
        .where(and(eq(S.folios.stayId, stayId), isNull(S.folios.closedAt)));

      await tx.update(S.stays).set({
        status: StayStatus.CHECKED_OUT,
        actualCheckOutAt: new Date(),
        checkedOutBy: auth.userId,
        updatedAt: new Date(),
      }).where(eq(S.stays.id, stayId));

      const assignment = (await tx
        .select()
        .from(S.stayRooms)
        .where(and(eq(S.stayRooms.stayId, stayId), isNull(S.stayRooms.releasedAt))))[0];
      if (assignment) {
        await tx.update(S.stayRooms).set({ releasedAt: new Date() }).where(eq(S.stayRooms.id, assignment.id));
        const room = (await tx.select().from(S.rooms).where(eq(S.rooms.id, assignment.roomId)))[0];
        if (room) {
          await tx.update(S.rooms).set({
            status: RoomStatus.AVAILABLE,
            frontOfficeStatus: 'VACANT',
            housekeepingStatus: 'DIRTY',
            updatedAt: new Date(),
          }).where(eq(S.rooms.id, room.id));
          await tx.insert(S.roomStatusHistory).values({
            id: newId(), propertyId: stay.propertyId, roomId: room.id,
            previousStatus: room.status, newStatus: RoomStatus.AVAILABLE,
            reason: 'check_out', referenceType: 'stay', referenceId: stayId, changedBy: auth.userId,
          });
          // Tâche de ménage post-départ automatique (README §35/§36)
          const prop = (await tx.select().from(S.properties).where(eq(S.properties.id, stay.propertyId)))[0];
          await tx.insert(S.housekeepingTasks).values({
            id: newId(), propertyId: stay.propertyId, roomId: room.id,
            taskType: 'CHECKOUT_CLEAN', priority: 'NORMAL', status: 'PENDING',
            businessDate: prop?.currentBusinessDate ?? new Date().toISOString().slice(0, 10),
          });
        }
      }

      await tx.update(S.reservations).set({
        status: ReservationStatus.CHECKED_OUT, updatedBy: auth.userId, updatedAt: new Date(),
      }).where(eq(S.reservations.id, stay.reservationId));

      // Libère l'inventaire des nuits restantes éventuelles (départ anticipé)
      await this.availability.releaseNightsFrom(tx as unknown as Db, stay.reservationId, new Date().toISOString().slice(0, 10));

      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: stay.propertyId, userId: auth.userId,
          action: 'stay.check_out', resource: 'stay', resourceId: stayId,
          after: { balanceAfter: balance, forced: !!opts.forceWithBalance },
          severity: opts.forceWithBalance ? 'WARNING' : 'INFO',
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.GUEST_CHECKED_OUT,
        aggregateType: 'stay', aggregateId: stayId, propertyId: stay.propertyId,
        payload: { folioId: folio.id, balanceAfter: balance },
      });
    });

    return { ok: true, stayId, folioId: folio.id, balanceDue: balance };
  }

  async listInHouse(auth: AuthUser, propertyId: string) {
    return this.db
      .select()
      .from(S.stays)
      .where(and(eq(S.stays.propertyId, propertyId), inArray(S.stays.status, [StayStatus.CHECKED_IN, StayStatus.IN_HOUSE])))
      .orderBy(desc(S.stays.actualCheckInAt));
  }

  async getStay(auth: AuthUser, id: string) {
    const stay = (await this.db.select().from(S.stays).where(eq(S.stays.id, id)))[0];
    if (!stay) throw new NotFoundError('Stay', id);
    const rooms = await this.db.select().from(S.stayRooms).where(eq(S.stayRooms.stayId, id));
    const folios = await this.db.select().from(S.folios).where(eq(S.folios.stayId, id));
    return { ...stay, rooms, folios };
  }
}

@Controller('api/v1/stays')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class StaysController {
  constructor(private readonly stays: StaysService) {}

  @Post('check-in')
  @RequirePermission('stay.check_in')
  checkIn(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.stays.checkIn(auth, body);
  }

  @Post(':id/check-out')
  @RequirePermission('stay.check_out')
  checkOut(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: { forceWithBalance?: boolean }) {
    return this.stays.checkOut(auth, id, body ?? {});
  }

  @Post(':id/change-room')
  @RequirePermission('stay.change_room')
  changeRoom(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: { roomId: string; reason?: string }) {
    return this.stays.changeRoom(auth, id, body.roomId, body.reason ?? '');
  }

  @Get('in-house')
  @RequirePermission('stay.view')
  inHouse(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string) {
    return this.stays.listInHouse(auth, propertyId);
  }

  @Get(':id')
  @RequirePermission('stay.view')
  getOne(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.stays.getStay(auth, id);
  }
}

@Module({
  imports: [AuthModule, InventoryModule, FoliosModule],
  controllers: [StaysController],
  providers: [StaysService, DatabaseService, AuditService, OutboxService, { provide: DB, useExisting: DatabaseService }],
  exports: [StaysService],
})
export class StaysModule {}
