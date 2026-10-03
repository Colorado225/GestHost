/**
 * Facturation (README §28, workflow §54) : facture émise à partir d'un folio
 * clôturé. Numérotation séquentielle sans trou. Note de crédit = facture
 * CREDIT_NOTE qui réduit la dette — l'original n'est jamais modifié (§51).
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
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditService } from '../audit/audit';
import { AuthModule, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import type { AuthUser } from '../auth/auth';
import { OutboxService } from '../outbox/outbox';
import { FoliosModule, FoliosService } from './folios';
import { DomainEventType, InvoiceStatus } from '../common/enums';
import { BizError, NotFoundError, ValidationError } from '../common/errors';
import { addDays, newId } from '../common/utils';

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly folios: FoliosService,
  ) {}

  /** Numéro de facture séquentiel par propriété — sans trou (README §73). */
  async nextInvoiceNumber(db: Db, propertyId: string): Promise<string> {
    const rows = await db.select({ id: S.invoices.id }).from(S.invoices).where(eq(S.invoices.propertyId, propertyId));
    return `INV-${String(rows.length + 1).padStart(6, '0')}`;
  }

  /** Génère la facture depuis un folio (typiquement au check-out). */
  async generateFromFolio(auth: AuthUser, folioId: string, opts: { dueInDays?: number } = {}) {
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, folioId)))[0];
    if (!folio) throw new NotFoundError('Folio', folioId);

    // Une facture ouverte existe déjà pour ce folio ? (idempotence)
    const existing = await this.db
      .select()
      .from(S.invoices)
      .where(and(
        eq(S.invoices.folioId, folioId),
        inArray(S.invoices.status, [InvoiceStatus.DRAFT, InvoiceStatus.FINALIZED, InvoiceStatus.SUBMITTED, InvoiceStatus.CERTIFIED]),
      ));
    if (existing.length) return existing[0];

    const items = await this.db
      .select()
      .from(S.folioItems)
      .where(and(eq(S.folioItems.folioId, folioId), isNull(S.folioItems.voidedAt)));
    const payments = await this.db
      .select()
      .from(S.payments)
      .where(and(eq(S.payments.folioId, folioId), eq(S.payments.status, 'COMPLETED')));

    const subtotal = items.reduce((s, i) => s + i.netAmount, 0);
    const taxAmount = items.reduce((s, i) => s + i.taxAmount, 0);
    const total = subtotal + taxAmount;
    const amountPaid = payments.reduce((s, p) => s + p.amount, 0);
    const balanceDue = Math.max(0, total - amountPaid);

    const invoiceId = newId();
    const number = await this.nextInvoiceNumber(this.db, folio.propertyId);
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(S.invoices).values({
        id: invoiceId,
        propertyId: folio.propertyId,
        invoiceNumber: number,
        folioId,
        guestId: folio.guestId,
        companyId: folio.companyId,
        status: InvoiceStatus.FINALIZED,
        currency: folio.currency,
        subtotal,
        taxAmount,
        totalAmount: total,
        amountPaid,
        balanceDue,
        issuedAt: new Date(),
        dueAt: addDays(new Date().toISOString().slice(0, 10), opts.dueInDays ?? 0),
        createdBy: auth.userId,
      });
      for (const it of items) {
        await tx.insert(S.invoiceItems).values({
          id: newId(),
          invoiceId,
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitAmount,
          netAmount: it.netAmount,
          taxAmount: it.taxAmount,
          grossAmount: it.grossAmount,
          referenceType: 'folio_item',
          referenceId: it.id,
        });
      }
      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: folio.propertyId, userId: auth.userId,
          action: 'invoice.generate', resource: 'invoice', resourceId: invoiceId,
          after: { folioId, number, total, balanceDue },
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.INVOICE_FINALIZED,
        aggregateType: 'invoice', aggregateId: invoiceId, propertyId: folio.propertyId,
        payload: { invoiceNumber: number, folioId, total, balanceDue },
      });
    });
    return (await this.db.select().from(S.invoices).where(eq(S.invoices.id, invoiceId)))[0];
  }

  /**
   * Note de crédit (README §28, workflow §53) : facture CREDIT_NEGATIVE ->
   * statut CREDITED sur l'originale partiellement, et écriture compensatoire
   * au folio si celui-ci est encore ouvert. L'originale n'est jamais modifiée.
   */
  async issueCreditNote(auth: AuthUser, invoiceId: string, body: { amount: number; reason: string }) {
    const inv = (await this.db.select().from(S.invoices).where(eq(S.invoices.id, invoiceId)))[0];
    if (!inv) throw new NotFoundError('Invoice', invoiceId);
    if (!body?.reason || !body?.amount || body.amount <= 0 || body.amount > inv.balanceDue) {
      throw new ValidationError({ amount: `0 < amount <= solde (${inv.balanceDue})`, reason: 'required' });
    }
    const creditId = newId();
    const number = await this.nextInvoiceNumber(this.db, inv.propertyId);
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(S.invoices).values({
        id: creditId,
        propertyId: inv.propertyId,
        invoiceNumber: number,
        folioId: inv.folioId,
        guestId: inv.guestId,
        companyId: inv.companyId,
        status: InvoiceStatus.FINALIZED,
        invoiceType: 'CREDIT_NOTE',
        currency: inv.currency,
        subtotal: -body.amount,
        taxAmount: 0,
        totalAmount: -body.amount,
        amountPaid: 0,
        balanceDue: -body.amount,
        issuedAt: new Date(),
        createdBy: auth.userId,
      });
      await tx.insert(S.invoiceItems).values({
        id: newId(),
        invoiceId: creditId,
        description: `Note de crédit — ${body.reason}`,
        quantity: 1,
        unitPrice: -body.amount,
        netAmount: -body.amount,
        taxAmount: 0,
        grossAmount: -body.amount,
        referenceType: 'invoice',
        referenceId: invoiceId,
      });
      // Met à jour le solde de l'originale (crédit appliqué)
      const newBalance = inv.balanceDue - body.amount;
      await tx.update(S.invoices).set({
        amountPaid: inv.amountPaid + body.amount,
        balanceDue: Math.max(0, newBalance),
        status: newBalance <= 0 ? InvoiceStatus.CREDITED : inv.status,
        updatedAt: new Date(),
      }).where(eq(S.invoices.id, invoiceId));
      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: inv.propertyId, userId: auth.userId,
          action: 'invoice.credit_note', resource: 'invoice', resourceId: creditId,
          before: inv, after: { amount: body.amount, reason: body.reason }, severity: 'WARNING',
        },
        tx as unknown as Db,
      );
    });
    return (await this.db.select().from(S.invoices).where(eq(S.invoices.id, creditId)))[0];
  }

  async getInvoice(auth: AuthUser, id: string) {
    const inv = (await this.db.select().from(S.invoices).where(eq(S.invoices.id, id)))[0];
    if (!inv) throw new NotFoundError('Invoice', id);
    const items = await this.db.select().from(S.invoiceItems).where(eq(S.invoiceItems.invoiceId, id));
    const fneDoc = (await this.db.select().from(S.fneDocuments).where(eq(S.fneDocuments.invoiceId, id)))[0] ?? null;
    return { ...inv, items, fne: fneDoc };
  }

  async listInvoices(auth: AuthUser, propertyId: string, opts: { from?: string; to?: string } = {}) {
    const conds = [eq(S.invoices.propertyId, propertyId)];
    if (opts.from) conds.push(sql`${S.invoices.issuedAt} >= ${opts.from}`);
    if (opts.to) conds.push(sql`${S.invoices.issuedAt} <= ${opts.to}`);
    return this.db.select().from(S.invoices).where(and(...conds)).orderBy(desc(S.invoices.issuedAt)).limit(200);
  }
}

@Controller('api/v1/invoices')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('from-folio/:folioId')
  @RequirePermission('invoice.generate')
  generate(@CurrentUser() auth: AuthUser, @Param('folioId') folioId: string, @Body() body: { dueInDays?: number }) {
    return this.invoices.generateFromFolio(auth, folioId, body ?? {});
  }

  @Post(':id/credit-note')
  @RequirePermission('invoice.credit_note')
  creditNote(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: { amount: number; reason: string }) {
    return this.invoices.issueCreditNote(auth, id, body);
  }

  @Get(':id')
  @RequirePermission('invoice.view')
  getOne(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.invoices.getInvoice(auth, id);
  }

  @Get()
  @RequirePermission('invoice.view')
  list(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string) {
    return this.invoices.listInvoices(auth, propertyId);
  }
}

@Module({
  imports: [AuthModule, FoliosModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, DatabaseService, AuditService, OutboxService, { provide: DB, useExisting: DatabaseService }],
  exports: [InvoicesService],
})
export class InvoicesModule {}
