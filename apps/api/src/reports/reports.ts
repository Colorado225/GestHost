/**
 * Rapports & exports (README §29–§30, §59–§60) — MVP.
 * - Arrivals/departures/in-house du jour (front desk).
 * - Occupancy par période (à partir des réservations + inventaire).
 * - Revenue daily report (à partir de daily_hotel_metrics post night audit).
 * - Export Excel (exceljs) et PDF (pdfkit) des rapports ci-dessus (§60).
 * Tous les montants sont entiers XOF ; les taux sont en basis points.
 */
import { Controller, Get, Injectable, Module, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { DatabaseModule, DatabaseService, Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuthUser, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import { CatalogModule, CatalogService } from '../catalog/catalog';
import { BizError, NotFoundError } from '../common/errors';
import { ReservationStatus } from '../common/enums';

@Injectable()
export class ReportsService {
  constructor(private readonly dbs: DatabaseService, private readonly catalog: CatalogService) {}

  private get db(): Db {
    return this.dbs.db;
  }

  /** Arrivées / départs / in-house d'une date métier (README écran front desk §81). */
  async dailyBoard(auth: AuthUser, propertyId: string, date: string) {
    await this.catalog.getProperty(auth, propertyId);
    const arrivals = await this.db
      .select({
        id: S.reservations.id, number: S.reservations.reservationNumber, status: S.reservations.status,
        arrival: S.reservations.arrivalDate, departure: S.reservations.departureDate,
        guestName: sql<string>`(
          select coalesce(g.first_name || ' ' || g.last_name, '—')
          from reservation_guests rg
          left join guests g on g.id = rg.guest_id
          where rg.reservation_id = reservations.id order by rg.is_primary desc limit 1)`,
      })
      .from(S.reservations)
      .where(and(
        eq(S.reservations.propertyId, propertyId),
        eq(S.reservations.arrivalDate, date),
        sql`${S.reservations.status} NOT IN ('CANCELLED')`
      ))
      .orderBy(asc(S.reservations.reservationNumber));

    const departures = await this.db
      .select({
        id: S.stays.id, number: S.stays.stayNumber,
        roomNumber: sql<string>`(select r.number from stay_rooms sr join rooms r on r.id = sr.room_id
          where sr.stay_id = stays.id and sr.released_at is null limit 1)`,
        status: S.stays.status,
        guestName: sql<string>`(select coalesce(g.first_name || ' ' || g.last_name, '—')
          from reservation_guests rg left join guests g on g.id = rg.guest_id
          where rg.reservation_id = stays.reservation_id order by rg.is_primary desc limit 1)`,
      })
      .from(S.stays)
      .where(and(
        eq(S.stays.propertyId, propertyId),
        eq(S.stays.plannedCheckOut, date),
        eq(S.stays.status, 'CHECKED_IN'),
      ));

    const inHouse = await this.db
      .select({
        id: S.stays.id, number: S.stays.stayNumber,
        roomNumber: sql<string>`(select r.number from stay_rooms sr join rooms r on r.id = sr.room_id
          where sr.stay_id = stays.id and sr.released_at is null limit 1)`,
        nights: sql<number>`(${S.stays.plannedCheckOut}::date - ${S.stays.plannedCheckIn}::date)::int`,
        guestName: sql<string>`(select coalesce(g.first_name || ' ' || g.last_name, '—')
          from reservation_guests rg left join guests g on g.id = rg.guest_id
          where rg.reservation_id = stays.reservation_id order by rg.is_primary desc limit 1)`,
      })
      .from(S.stays)
      .where(and(eq(S.stays.propertyId, propertyId), eq(S.stays.status, 'CHECKED_IN')));

    return { date, propertyId, arrivals, departures, inHouse };
  }

  /** Rapport d'occupation par nuit sur une période (ventes vs capacité vendable). */
  async occupancyReport(auth: AuthUser, propertyId: string, from: string, to: string) {
    await this.catalog.getProperty(auth, propertyId);
    // Capacité vendable = chambres non supprimées hors OOO/OOS/BLOCKED.
    const capacityRows = await this.db.execute(sql`
      SELECT d::date AS stay_date, count(*) FILTER (
        WHERE r.status NOT IN ('OUT_OF_ORDER','OUT_OF_SERVICE','BLOCKED'))::int AS sellable
      FROM generate_series(${from}::date, (${to}::date - 1), interval '1 day') d,
           rooms r WHERE r.property_id = ${propertyId} AND r.deleted_at IS NULL
      GROUP BY d ORDER BY d`);
    const soldRows = await this.db.execute(sql`
      SELECT d::date AS stay_date,
             count(*)::int AS reserved_rooms,
             coalesce(sum(rr.total_amount), 0)::bigint AS room_revenue
      FROM generate_series(${from}::date, (${to}::date - 1), interval '1 day') d
      JOIN reservation_rooms rr ON rr.arrival_date <= d AND rr.departure_date > d
      JOIN reservations res ON res.id = rr.reservation_id
      WHERE res.property_id = ${propertyId}
        AND res.status NOT IN ('CANCELLED','NO_SHOW') AND rr.status = 'ACTIVE'
      GROUP BY d ORDER BY d`);
    const capMap = new Map<string, number>();
    for (const row of (capacityRows as any).rows ?? []) capMap.set(String(row.stay_date).slice(0, 10), Number(row.sellable));
    const soldMap = new Map<string, any>();
    for (const row of (soldRows as any).rows ?? []) soldMap.set(String(row.stay_date).slice(0, 10), row);

    const days: Array<{ date: string; sellable: number; sold: number; occupancyBps: number; roomRevenue: number }> = [];
    let cur = from;
    while (cur < to) {
      const sellable = capMap.get(cur) ?? 0;
      const s = soldMap.get(cur);
      const sold = s ? Number(s.reserved_rooms ?? 0) : 0;
      days.push({
        date: cur,
        sellable,
        sold,
        occupancyBps: sellable > 0 ? Math.round((sold * 10000) / sellable) : 0,
        roomRevenue: s ? Number(s.room_revenue ?? 0) : 0,
      });
      // next day
      const dt = new Date(cur + 'T12:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + 1);
      cur = dt.toISOString().slice(0, 10);
    }
    const totalSold = days.reduce((a, d) => a + d.sold, 0);
    const totalCap = days.reduce((a, d) => a + d.sellable, 0);
    const totalRev = days.reduce((a, d) => a + d.roomRevenue, 0);
    return {
      propertyId, from, to, days,
      totals: {
        occupancyBps: totalCap > 0 ? Math.round((totalSold * 10000) / totalCap) : 0,
        adr: totalSold > 0 ? Math.round(totalRev / totalSold) : 0,
        revpar: totalCap > 0 ? Math.round(totalRev / totalCap) : 0,
        roomRevenue: totalRev,
      },
    };
  }

  /** Revenus journaliers issus des agrégats du night audit (source vérifiée §58). */
  async revenueReport(auth: AuthUser, propertyId: string, from: string, to: string) {
    await this.catalog.getProperty(auth, propertyId);
    const rows = await this.db
      .select()
      .from(S.dailyHotelMetrics)
      .where(and(
        eq(S.dailyHotelMetrics.propertyId, propertyId),
        gte(S.dailyHotelMetrics.businessDate, from),
        lte(S.dailyHotelMetrics.businessDate, to),
      ))
      .orderBy(asc(S.dailyHotelMetrics.businessDate));
    const num = (v: any) => Number(v ?? 0);
    return {
      propertyId, from, to,
      days: rows.map((r) => ({
        date: r.businessDate,
        roomRevenue: num(r.roomRevenue),
        otherRevenue: num(r.otherRevenue),
        grossRevenue: num(r.grossRevenue),
        tax: num(r.taxRevenue),
        payments: num(r.paymentsTotal),
        adr: num(r.adr),
        revpar: num(r.revpar),
        occupancyBps: r.occupancyRateBps,
      })),
      totals: {
        grossRevenue: rows.reduce((a, r) => a + num(r.grossRevenue), 0),
        payments: rows.reduce((a, r) => a + num(r.paymentsTotal), 0),
        tax: rows.reduce((a, r) => a + num(r.taxRevenue), 0),
      },
    };
  }

  /** Export Excel générique (README §60) : colonnes + lignes déjà sérialisées. */
  async buildExcel(sheetName: string, columns: string[], rows: (string | number)[][]): Promise<Buffer> {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName.slice(0, 31));
    ws.addRow(columns);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Export PDF simple A4 paysage (README §60). */
  async buildPdf(title: string, columns: string[], rows: (string | number)[][]): Promise<Buffer> {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.fontSize(16).text(title, { align: 'left' });
    doc.moveDown();
    doc.fontSize(8);
    const colW = Math.floor((doc.page.width - 80) / Math.max(1, columns.length));
    let y = doc.y;
    doc.font('Helvetica-Bold').text(columns.join('   '), 40, y);
    doc.font('Helvetica');
    y += 16;
    for (const r of rows.slice(0, 200)) {
      doc.text(r.map((c) => String(c)).join('   ').slice(0, 160), 40, y);
      y += 14;
      if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
    }
    void colW;
    doc.end();
    return new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  }
}

@Controller('api/v1/reports')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportsController {
  constructor(private readonly svc: ReportsService, private readonly catalog: CatalogService) {}

  @Get('daily-board')
  @RequirePermission('report.view')
  board(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string, @Query('date') date: string) {
    if (!propertyId || !date) throw new NotFoundError('QueryParam', 'propertyId/date requis');
    return this.svc.dailyBoard(auth, propertyId, date);
  }

  @Get('occupancy')
  @RequirePermission('report.view')
  occ(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.svc.occupancyReport(auth, propertyId, from, to);
  }

  @Get('revenue')
  @RequirePermission('report.view')
  rev(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.svc.revenueReport(auth, propertyId, from, to);
  }

  @Get('revenue/export.xlsx')
  @RequirePermission('report.export')
  async revXlsx(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string,
    @Query('from') from: string, @Query('to') to: string, @Res() res: Response) {
    const rep = await this.svc.revenueReport(auth, propertyId, from, to);
    const buf = await this.svc.buildExcel(
      'Revenus',
      ['Date', 'Chambres HT', 'Autres', 'TTC', 'Taxes', 'Encaissements', 'ADR', 'RevPAR', 'Occupation %'],
      rep.days.map((d) => [d.date, d.roomRevenue, d.otherRevenue, d.grossRevenue, d.tax, d.payments, d.adr, d.revpar, (d.occupancyBps / 100).toFixed(2)]),
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="revenue_${from}_${to}.xlsx"`);
    res.send(buf);
  }

  @Get('occupancy/export.pdf')
  @RequirePermission('report.export')
  async occPdf(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string,
    @Query('from') from: string, @Query('to') to: string, @Res() res: Response) {
    const rep = await this.svc.occupancyReport(auth, propertyId, from, to);
    const prop = await this.catalog.getProperty(auth, propertyId);
    const buf = await this.svc.buildPdf(
      `Rapport d'occupation — ${prop.name} (${from} → ${to})`,
      ['Date', 'Vendable', 'Vendu', 'Occ %', 'CHAMBRES'],
      rep.days.map((d) => [d.date, d.sellable, d.sold, (d.occupancyBps / 100).toFixed(1), d.roomRevenue]),
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="occupancy_${from}_${to}.pdf"`);
    res.send(buf);
  }
}

@Module({
  imports: [DatabaseModule, CatalogModule],
  providers: [ReportsService],
  controllers: [ReportsController],
  exports: [ReportsService],
})
export class ReportsModule {}
