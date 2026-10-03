/**
 * Disponibilité & inventaire (README §45, §71, AC §134).
 *
 * Règle : la disponibilité se calcule par property + room_type + date range.
 * Elle tient compte des chambres RESERVED/OCCUPIED/BLOCKED/OUT_OF_ORDER/
 * OUT_OF_SERVICE/MAINTENANCE — pas simplement "non occupées".
 *
 * Anti double-réservation : chaque réservation de nuits s'exécute dans une
 * transaction qui verrouille les lignes d'inventaire (SELECT ... FOR UPDATE,
 * ordonnées par stay_date pour éviter les interblocages) puis insère les
 * locks unitaires (contrainte unique (room_type, date, reservation)).
 */
import { Inject, Injectable, Module } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import {  DomainError, BizError, NotFoundError, ValidationError  } from '../common/errors';
import { addDays, newId, nightDates } from '../common/utils';
import { INVENTORY_CONSUMING_RESERVATION_STATUSES } from '../common/enums';

/** Statuts de chambre qui rendent la chambre non vendable (README §45). */
const NON_SELLABLE_ROOM_STATUSES = [
  'BLOCKED',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
  'MAINTENANCE',
] as const;

export interface AvailabilityRow {
  roomTypeId: string;
  date: string;
  sellable: number;
  sold: number;
  available: number;
}

@Injectable()
export class AvailabilityService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Nombre de chambres PHYSIQUES du type qui ne sont ni bloquées/OOO/OOS.
   * Les chambres réservées/occupées restent comptées comme vendables :
   * c'est l'inventaire (locks) qui consomme le stock journalièrement.
   */
  private async sellableCount(db: Db, propertyId: string, roomTypeId: string): Promise<number> {
    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(S.rooms)
      .where(
        and(
          eq(S.rooms.propertyId, propertyId),
          eq(S.rooms.roomTypeId, roomTypeId),
          isNull(S.rooms.deletedAt),
          sql`${S.rooms.status} NOT IN (${sql.join(
            NON_SELLABLE_ROOM_STATUSES.map((v) => sql`${v}`),
            sql`, `,
          )})`,
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }

  /** Disponibilités calculées à la volée sur une plage [from, to]. */
  async getAvailability(
    propertyId: string,
    roomTypeId: string,
    from: string,
    to: string,
  ): Promise<AvailabilityRow[]> {
    if (to < from) throw new ValidationError({ from: 'from doit être <= to' });
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);

    const sellable = await this.sellableCount(this.db, propertyId, roomTypeId);

    // Nuits consommant l'inventaire : réservations actives (OPTION/CONFIRMED/WAITLISTED/CHECKED_IN)
    const soldRows = await this.db
      .select({
        stayDate: S.inventoryLocks.stayDate,
        q: sql<number>`coalesce(sum(${S.inventoryLocks.quantity}), 0)::int`,
      })
      .from(S.inventoryLocks)
      .innerJoin(S.reservations, eq(S.inventoryLocks.reservationId, S.reservations.id))
      .where(
        and(
          eq(S.inventoryLocks.roomTypeId, roomTypeId),
          gte(S.inventoryLocks.stayDate, from),
          lte(S.inventoryLocks.stayDate, to),
          inArray(S.reservations.status, [...INVENTORY_CONSUMING_RESERVATION_STATUSES]),
        ),
      )
      .groupBy(S.inventoryLocks.stayDate);
    const soldByDate = new Map(soldRows.map((r) => [r.stayDate, r.q]));

    return dates.map((d) => {
      const sold = soldByDate.get(d) ?? 0;
      return { roomTypeId, date: d, sellable, sold, available: Math.max(0, sellable - sold) };
    });
  }

  /**
   * Réserve `quantity` nuits pour une réservation. À appeler DANS la
   * transaction appelante (tx). Verrouille les lignes d'inventaire
   * (FOR UPDATE, créées si absentes) puis écrit les inventory_locks.
   * Lève ROOM_TYPE_SOLD_OUT / DOUBLE_BOOKING_BLOCKED en cas de conflit.
   */
  async reserveNights(
    tx: Db,
    opts: {
      propertyId: string;
      roomTypeId: string;
      reservationId: string;
      arrival: string;
      departure: string;
      quantity?: number;
    },
  ): Promise<void> {
    const qty = opts.quantity ?? 1;
    const nights = nightDates(opts.arrival, opts.departure);
    const sellable = await this.sellableCount(tx, opts.propertyId, opts.roomTypeId);

    // Verrou pessimiste : SELECT ... FOR UPDATE ORDER BY stay_date
    // (ordre déterministe => pas d'interblocage entre transactions concurrentes).
    const cells = await tx
      .select()
      .from(S.inventoryCapacity)
      .where(
        and(
          eq(S.inventoryCapacity.roomTypeId, opts.roomTypeId),
          inArray(S.inventoryCapacity.stayDate, nights),
        ),
      )
      .orderBy(asc(S.inventoryCapacity.stayDate))
      .for('update');

    const cellByDate = new Map(cells.map((c) => [c.stayDate, c]));

    for (const d of nights) {
      let cell = cellByDate.get(d);
      if (!cell) {
        await tx
          .insert(S.inventoryCapacity)
          .values({
            id: newId(),
            propertyId: opts.propertyId,
            roomTypeId: opts.roomTypeId,
            stayDate: d,
            sellableRooms: sellable,
            soldRooms: 0,
            blockedRooms: 0,
          })
          .onConflictDoNothing();
        const refetched = await tx
          .select()
          .from(S.inventoryCapacity)
          .where(
            and(
              eq(S.inventoryCapacity.roomTypeId, opts.roomTypeId),
              eq(S.inventoryCapacity.stayDate, d),
            ),
          )
          .for('update');
        cell = refetched[0];
        if (!cell) {
          throw new DomainError('INVENTORY_UNAVAILABLE', "Ligne d'inventaire indisponible.", 409, {
            roomTypeId: opts.roomTypeId,
            date: d,
          });
        }
        cellByDate.set(d, cell);
      }

      // Sold = somme des locks existants (source de vérité = inventory_locks).
      const lockSum = await tx
        .select({
          q: sql<number>`coalesce(sum(${S.inventoryLocks.quantity}), 0)::int`,
        })
        .from(S.inventoryLocks)
        .where(
          and(
            eq(S.inventoryLocks.roomTypeId, opts.roomTypeId),
            eq(S.inventoryLocks.stayDate, d),
          ),
        );
      const currentSold = lockSum[0]?.q ?? 0;
      if (currentSold + qty > cell.sellableRooms) {
        throw BizError.roomTypeSoldOut(opts.roomTypeId, d);
      }

      // Insert sous contrainte unique (type, date, réservation) : deux
      // transactions simultanées sur la dernière chambre -> l'une bloque via
      // FOR UPDATE, l'autre voit sold+qty > sellable et échoue (AC §134).
      await tx.insert(S.inventoryLocks).values({
        id: newId(),
        propertyId: opts.propertyId,
        roomTypeId: opts.roomTypeId,
        stayDate: d,
        reservationId: opts.reservationId,
        quantity: qty,
      });

      await tx
        .update(S.inventoryCapacity)
        .set({ soldRooms: currentSold + qty, updatedAt: new Date() })
        .where(eq(S.inventoryCapacity.id, cell.id));
    }
  }

  /** Libère toutes les nuits verrouillées par une réservation. */
  async releaseNights(tx: Db, reservationId: string): Promise<number> {
    const locks = await tx
      .select()
      .from(S.inventoryLocks)
      .where(eq(S.inventoryLocks.reservationId, reservationId))
      .for('update');
    for (const l of locks) {
      await tx.delete(S.inventoryLocks).where(eq(S.inventoryLocks.id, l.id));
      await tx
        .update(S.inventoryCapacity)
        .set({
          soldRooms: sql`GREATEST(0, ${S.inventoryCapacity.soldRooms} - ${l.quantity})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(S.inventoryCapacity.roomTypeId, l.roomTypeId),
            eq(S.inventoryCapacity.stayDate, l.stayDate),
          ),
        );
    }
    return locks.length;
  }

  /** Libère uniquement les nuits >= fromDate (départ anticipé / écourté). */
  async releaseNightsFrom(tx: Db, reservationId: string, fromDate: string): Promise<number> {
    const locks = await tx
      .select()
      .from(S.inventoryLocks)
      .where(
        and(
          eq(S.inventoryLocks.reservationId, reservationId),
          gte(S.inventoryLocks.stayDate, fromDate),
        ),
      )
      .for('update');
    for (const l of locks) {
      await tx.delete(S.inventoryLocks).where(eq(S.inventoryLocks.id, l.id));
      await tx
        .update(S.inventoryCapacity)
        .set({
          soldRooms: sql`GREATEST(0, ${S.inventoryCapacity.soldRooms} - ${l.quantity})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(S.inventoryCapacity.roomTypeId, l.roomTypeId),
            eq(S.inventoryCapacity.stayDate, l.stayDate),
          ),
        );
    }
    return locks.length;
  }

  /** Chambre assignable ? (exclut OOO/OOS/BLOCKED/maintenance — README §45) */
  async assertRoomAssignable(txOrDb: Db, roomId: string): Promise<typeof S.rooms.$inferSelect> {
    const rows = await txOrDb.select().from(S.rooms).where(eq(S.rooms.id, roomId));
    const room = rows[0];
    if (!room || room.deletedAt) throw new NotFoundError('Room', roomId);
    if ((NON_SELLABLE_ROOM_STATUSES as readonly string[]).includes(room.status)) {
      throw BizError.roomNotAssignable(roomId, `statut ${room.status}`);
    }
    if (room.maintenanceStatus === 'MAINTENANCE') {
      throw BizError.roomNotAssignable(roomId, 'maintenance en cours');
    }
    return room;
  }

  /** Liste des chambres libres d'un type sur une plage (aucune affectation active). */
  async freeRoomsForRange(propertyId: string, roomTypeId: string, arrival: string, departure: string) {
    const activeAssignments = await this.db
      .select({ roomId: S.stayRooms.roomId })
      .from(S.stayRooms)
      .where(and(lt(S.stayRooms.arrivalDate, departure), gt(S.stayRooms.departureDate, arrival)));
    const taken = new Set(activeAssignments.map((r) => r.roomId));
    const rooms = await this.db
      .select()
      .from(S.rooms)
      .where(
        and(
          eq(S.rooms.propertyId, propertyId),
          eq(S.rooms.roomTypeId, roomTypeId),
          isNull(S.rooms.deletedAt),
        ),
      );
    return rooms.filter(
      (r) => !taken.has(r.id) && !(NON_SELLABLE_ROOM_STATUSES as readonly string[]).includes(r.status),
    );
  }
}

@Module({
  providers: [AvailabilityService, DatabaseService, { provide: DB, useExisting: DatabaseService }],
  exports: [AvailabilityService],
})
export class InventoryModule {}
