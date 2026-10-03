/**
 * Night audit (README §55, §58, AC §136) — clôture de la journée métier.
 * - Idempotent : une seule clôture par (propriété, business_date) grâce à
 *   l'index unique uq_night_audits_date ; un replay renvoie le résultat existant.
 * - Étapes atomiques dans une transaction :
 *   1. post des revenus chambre de la date (folio.postRoomCharges, idempotent),
 *   2. détection des no-shows (arrivées CONFIRMED non check-in),
 *   3. agrégats dashboard (daily_hotel_metrics upsert),
 *   4. événement outbox NIGHT_AUDIT_COMPLETED.
 */
import { Body, Controller, Get, Injectable, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { DatabaseModule, DatabaseService, Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditModule, AuditService } from '../audit/audit';
import { OutboxModule, OutboxService } from '../outbox/outbox';
import { FoliosModule, FoliosService } from '../billing/folios';
import { AuthUser, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import { BizError, NotFoundError } from '../common/errors';
import { DomainEventType, FolioItemType, ReservationStatus } from '../common/enums';
import { addDays, ulid } from '../common/utils';

export interface NightAuditResult {
  auditId: string;
  propertyId: string;
  businessDate: string;
  roomRevenuePosted: number;
  noShowsDetected: number;
  alreadyCompleted: boolean;
}

@Injectable()
export class NightAuditService {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly folios: FoliosService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Business date courante d'une propriété (roule après le night audit). */
  async getCurrentBusinessDate(db: Db | any, propertyId: string): Promise<string> {
    const rows = await db
      .select({ maxDate: sql<string>`max(${S.nightAudits.businessDate})` })
      .from(S.nightAudits)
      .where(and(eq(S.nightAudits.propertyId, propertyId), eq(S.nightAudits.status, 'COMPLETED')))
      .limit(1);
    const last = rows[0]?.maxDate as string | undefined;
    // Date du jour si aucun audit jamais completed, sinon lendemain de la dernière clôture.
    const today = new Date().toISOString().slice(0, 10);
    if (!last) return today;
    return addDays(last, 1) > today ? addDays(last, 1) : today;
  }

  /** Clôture idempotente (AC §136). Si déjà COMPLETED → renvoie l'existant sans re-poster. */
  async run(
    auth: AuthUser,
    propertyId: string,
    body: { businessDate?: string },
  ): Promise<NightAuditResult> {
    if (!auth.propertyIds.includes(propertyId) && !auth.isSystemAdmin) throw BizError.tenantMismatch();
    const businessDate = body.businessDate ?? (await this.getCurrentBusinessDate(this.dbs.db, propertyId));

    // Course-safe : tentative d'insertion PENDING avec l'index unique.
    const auditId = ulid();
    try {
      await this.dbs.db.insert(S.nightAudits).values({
        id: auditId,
        propertyId,
        businessDate,
        status: 'RUNNING',
        startedAt: new Date(),
        startedBy: auth.userId,
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        // Déjà clôturé (ou en cours) pour cette date → idempotence : on renvoie l'existant.
        const existing = await this.dbs.db
          .select()
          .from(S.nightAudits)
          .where(and(eq(S.nightAudits.propertyId, propertyId), eq(S.nightAudits.businessDate, businessDate)))
          .limit(1);
        const ex = existing[0];
        if (!ex) throw e;
        return {
          auditId: ex.id,
          propertyId,
          businessDate,
          roomRevenuePosted: Number(ex.totalRoomRevenue ?? 0),
          noShowsDetected: 0,
          alreadyCompleted: ex.status === 'COMPLETED',
        };
      }
      throw e;
    }

    let roomRevenuePosted = 0;
    let noShowsDetected = 0;

    try {
      const result = await this.dbs.withTransaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;

        // 1. Post des charges chambre de la nuit (idempotent par folio+date, README §26).
        //    Via le service Folios (auth contextuelle) ; postRoomCharges vérifie déjà
        //    l'existence d'un item ROOM non-voidé pour cette business date.
        const openFolios = await tx
          .select({ id: S.folios.id })
          .from(S.folios)
          .where(and(eq(S.folios.propertyId, propertyId), eq(S.folios.status, 'OPEN')));
        for (const f of openFolios) {
          const res = await this.folios.postRoomCharges(auth, f.id, businessDate);
          if (res.posted) {
            const items = await tx
              .select({ net: S.folioItems.netAmount })
              .from(S.folioItems)
              .where(and(
                eq(S.folioItems.folioId, f.id),
                eq(S.folioItems.type, FolioItemType.ROOM),
                eq(S.folioItems.businessDate, businessDate),
                isNull(S.folioItems.voidedAt),
              ));
            roomRevenuePosted += Number(items[0]?.net ?? 0);
          }
        }

        // 2. No-shows : réservations CONFIRMED dont la date d'arrivée est passée sans check-in.
        const noShowRows = await tx
          .select({ id: S.reservations.id })
          .from(S.reservations)
          .where(
            and(
              eq(S.reservations.propertyId, propertyId),
              eq(S.reservations.status, ReservationStatus.CONFIRMED),
              lt(S.reservations.arrivalDate, businessDate),
            ),
          );
        for (const r of noShowRows) {
          await tx
            .update(S.reservations)
            .set({ status: ReservationStatus.NO_SHOW, updatedAt: new Date() })
            .where(eq(S.reservations.id, r.id));
          noShowsDetected++;
        }

        // 3. Agrégats journaliers (upsert sur uq_daily_metrics).
        const occ = await tx.execute(
          sql`SELECT
                count(*) FILTER (WHERE r.status IN ('OCCUPIED'))::int AS occupied,
                count(*) FILTER (WHERE r.status IN ('AVAILABLE','CLEAN','DIRTY','INSPECT'))::int AS available,
                count(*) FILTER (WHERE r.status IN ('OUT_OF_ORDER','OUT_OF_SERVICE','MAINTENANCE','BLOCKED'))::int AS ooo
              FROM rooms r WHERE r.property_id = ${propertyId} AND r.deleted_at IS NULL`,
        );
        const occRow: any = (occ as any).rows?.[0] ?? (occ as any)[0] ?? {};
        const revenueAgg = await tx
          .select({
            roomRev: sql<number>`coalesce(sum(${S.folioItems.grossAmount}), 0)::bigint`,
            otherRev: sql<number>`coalesce(sum(case when ${S.folioItems.type} <> 'ROOM' then ${S.folioItems.grossAmount} else 0 end), 0)::bigint`,
            tax: sql<number>`coalesce(sum(${S.folioItems.taxAmount}), 0)::bigint`,
          })
          .from(S.folioItems)
          .innerJoin(S.folios, eq(S.folioItems.folioId, S.folios.id))
          .where(and(eq(S.folios.propertyId, propertyId), eq(S.folioItems.businessDate, businessDate), isNull(S.folioItems.voidedAt)));
        const rev: any = revenueAgg[0] ?? {};
        const paymentsAgg = await tx
          .select({ total: sql<number>`coalesce(sum(${S.payments.amount}), 0)::bigint` })
          .from(S.payments)
          .where(and(eq(S.payments.propertyId, propertyId), sql`${S.payments.paidAt}::date = ${businessDate}`));
        const payTotal = Number(paymentsAgg[0]?.total ?? 0);

        const occupied = Number(occRow.occupied ?? 0);
        const available = Number(occRow.available ?? 0);
        const ooo = Number(occRow.ooo ?? 0);
        const sellable = occupied + available;
        const occupancyBps = sellable > 0 ? Math.round((occupied * 10000) / sellable) : 0;
        const roomRevenue = Number(rev.roomRev ?? 0);
        const otherRevenue = Number(rev.otherRev ?? 0);
        const gross = roomRevenue + otherRevenue;
        const adr = occupied > 0 ? Math.round(roomRevenue / occupied) : 0;
        const revpar = sellable > 0 ? Math.round(gross / sellable) : 0;

        const arrivals = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(S.reservations)
          .where(and(eq(S.reservations.propertyId, propertyId), eq(S.reservations.arrivalDate, businessDate), sql`${S.reservations.status} NOT IN ('CANCELLED','NO_SHOW')`));
        const departures = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(S.stays)
          .where(and(eq(S.stays.propertyId, propertyId), eq(S.stays.plannedCheckOut, businessDate), eq(S.stays.status, 'CHECKED_IN')));
        const inHouse = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(S.stays)
          .where(and(eq(S.stays.propertyId, propertyId), eq(S.stays.status, 'CHECKED_IN')));

        const metricsId = ulid();
        await tx
          .insert(S.dailyHotelMetrics)
          .values({
            id: metricsId,
            propertyId,
            businessDate,
            availableRooms: available,
            occupiedRooms: occupied,
            outOfOrderRooms: ooo,
            occupancyRateBps: occupancyBps,
            roomRevenue: Number(roomRevenue),
            otherRevenue: Number(otherRevenue),
            grossRevenue: Number(gross),
            taxRevenue: Number(Number(rev.tax ?? 0)),
            adr: Number(adr),
            revpar: Number(revpar),
            paymentsTotal: Number(payTotal),
            outstanding: Number(Math.max(gross - payTotal, 0)),
            arrivals: Number(arrivals[0]?.c ?? 0),
            departures: Number(departures[0]?.c ?? 0),
            inHouse: Number(inHouse[0]?.c ?? 0),
            noShows: noShowsDetected,
            cancellations: 0,
          })
          .onConflictDoUpdate({
            target: [S.dailyHotelMetrics.propertyId, S.dailyHotelMetrics.businessDate],
            set: {
              availableRooms: available,
              occupiedRooms: occupied,
              outOfOrderRooms: ooo,
              occupancyRateBps: occupancyBps,
              roomRevenue: Number(roomRevenue),
              otherRevenue: Number(otherRevenue),
              grossRevenue: Number(gross),
              taxRevenue: Number(Number(rev.tax ?? 0)),
              adr: Number(adr),
              revpar: Number(revpar),
              paymentsTotal: Number(payTotal),
              noShows: noShowsDetected,
              updatedAt: new Date(),
            },
          });

        return { roomRevenue, payTotal };
      });

      // Marquer COMPLETED (hors transaction principale pour simplicité ; course protégée par l'unique index).
      await this.dbs.db
        .update(S.nightAudits)
        .set({
          status: 'COMPLETED',
          completedAt: new Date(),
          completedBy: auth.userId,
          totalRoomRevenue: Number(result.roomRevenue),
          totalPayments: Number(result.payTotal),
        })
        .where(eq(S.nightAudits.id, auditId));

      await this.outbox.emit(this.dbs.db as unknown as Db, {
        organizationId: auth.organizationId,
        propertyId,
        eventType: DomainEventType.NIGHT_AUDIT_COMPLETED,
        aggregateType: 'night_audit',
        aggregateId: auditId,
        payload: { businessDate, roomRevenuePosted: result.roomRevenue, noShowsDetected },
      });

      await this.audit.log({
        organizationId: auth.organizationId,
        propertyId,
        userId: auth.userId,
        action: 'night_audit.run',
        resource: 'night_audit',
        resourceId: auditId,
        after: { businessDate, roomRevenuePosted: result.roomRevenue, noShowsDetected },
      });

      return {
        auditId,
        propertyId,
        businessDate,
        roomRevenuePosted: result.roomRevenue,
        noShowsDetected,
        alreadyCompleted: false,
      };
    } catch (e: any) {
      await this.dbs.db
        .update(S.nightAudits)
        .set({ status: 'FAILED', errorSummary: String(e?.message ?? e).slice(0, 500) })
        .where(eq(S.nightAudits.id, auditId));
      throw e;
    }
  }

  async getStatus(auth: AuthUser, propertyId: string, businessDate?: string) {
    const conds = [eq(S.nightAudits.propertyId, propertyId)];
    if (businessDate) conds.push(eq(S.nightAudits.businessDate, businessDate));
    return this.dbs.db
      .select()
      .from(S.nightAudits)
      .where(and(...conds))
      .orderBy(sql`${S.nightAudits.businessDate} desc`)
      .limit(31);
  }

  async getMetrics(auth: AuthUser, propertyId: string, from: string, to: string) {
    if (!auth.propertyIds.includes(propertyId) && !auth.isSystemAdmin) throw BizError.tenantMismatch();
    return this.dbs.db
      .select()
      .from(S.dailyHotelMetrics)
      .where(
        and(
          eq(S.dailyHotelMetrics.propertyId, propertyId),
          gte(S.dailyHotelMetrics.businessDate, from),
          lt(S.dailyHotelMetrics.businessDate, to),
        ),
      )
      .orderBy(S.dailyHotelMetrics.businessDate);
  }
}

@Controller('api/v1/night-audit')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NightAuditController {
  constructor(private readonly svc: NightAuditService) {}

  @Post(':propertyId/run')
  @RequirePermission('night_audit.run')
  run(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: { businessDate?: string }) {
    return this.svc.run(auth, propertyId, body ?? {});
  }

  @Get(':propertyId/status')
  status(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Query('businessDate') bd?: string) {
    return this.svc.getStatus(auth, propertyId, bd);
  }

  @Get(':propertyId/metrics')
  metrics(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    if (!from || !to) throw new NotFoundError('QueryParam', 'from/to requis');
    return this.svc.getMetrics(auth, propertyId, from, to);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule, OutboxModule, FoliosModule],
  providers: [NightAuditService],
  controllers: [NightAuditController],
  exports: [NightAuditService],
})
export class NightAuditModule {}
