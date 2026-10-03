/**
 * Folios, charges, paiements (README §23–§27, workflows §51–§54).
 * - Items immuables : correction par void + item compensatoire (§51, règle 6/7).
 * - Solde = somme(gross items non voidés) - paiements — recalculé depuis les écritures.
 * - Paiement idempotent via clef Idempotency-Key (README §70, AC anti double-paiement).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
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
import { DomainEventType, FolioItemType, PaymentMethod, PaymentStatus } from '../common/enums';
import {  DomainError, BizError, NotFoundError, ValidationError  } from '../common/errors';
import { newId } from '../common/utils';

@Injectable()
export class FoliosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Crée un folio dans la transaction appelante (utilisé par le check-in). */
  async createFolio(tx: Db, opts: {
    propertyId: string; stayId: string; guestId?: string | null; companyId?: string | null; currency: string;
  }): Promise<string> {
    const id = newId();
    const rows = await tx.select({ n: S.folios.id }).from(S.folios).where(eq(S.folios.propertyId, opts.propertyId));
    await tx.insert(S.folios).values({
      id,
      propertyId: opts.propertyId,
      folioNumber: `FL-${String(rows.length + 1).padStart(6, '0')}`,
      stayId: opts.stayId,
      guestId: opts.guestId ?? null,
      companyId: opts.companyId ?? null,
      status: 'OPEN',
      currency: opts.currency,
    });
    return id;
  }

  /** Solde réel = écritures valides - paiements valides (jamais confiance au champ stocké). */
  async computeBalance(db: Db, folioId: string): Promise<number> {
    const charges = await db
      .select({ v: sql<string>`coalesce(sum(${S.folioItems.grossAmount}), 0)::text` })
      .from(S.folioItems)
      .where(and(eq(S.folioItems.folioId, folioId), isNull(S.folioItems.voidedAt)));
    const pays = await db
      .select({ v: sql<string>`coalesce(sum(${S.payments.amount}), 0)::text` })
      .from(S.payments)
      .where(and(eq(S.payments.folioId, folioId), inArray(S.payments.status, [PaymentStatus.COMPLETED])));
    return Number(charges[0]?.v ?? 0) - Number(pays[0]?.v ?? 0);
  }

  /** Poste une charge (boisson, restaurant, linge...) — folio doit être OPEN (README §24). */
  async postCharge(auth: AuthUser, folioId: string, body: {
    type: FolioItemType; description: string; quantity?: number; unitAmount: number;
    taxAmount?: number; category?: string; businessDate: string;
  }) {
    if (!body?.description || body.unitAmount === undefined) {
      throw new ValidationError({ description: 'required', unitAmount: 'required' });
    }
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, folioId)))[0];
    if (!folio) throw new NotFoundError('Folio', folioId);
    if (folio.status === 'CLOSED') throw BizError.folioClosed(folioId);

    const qty = Math.max(1, body.quantity ?? 1);
    const net = body.unitAmount * qty;
    const tax = (body.taxAmount ?? 0) * qty;
    const itemId = newId();
    await this.db.insert(S.folioItems).values({
      id: itemId,
      folioId,
      businessDate: body.businessDate,
      type: body.type ?? FolioItemType.OTHER_SERVICE,
      category: body.category ?? null,
      description: body.description,
      quantity: qty,
      unitAmount: body.unitAmount,
      netAmount: net,
      taxAmount: tax,
      grossAmount: net + tax,
      currency: folio.currency,
      postedBy: auth.userId,
    });
    await this.refreshBalance(folioId);
    await this.audit.log({
      organizationId: auth.organizationId, propertyId: folio.propertyId, userId: auth.userId,
      action: 'folio.post_charge', resource: 'folio_item', resourceId: itemId,
      after: { folioId, ...body },
    });
    await this.outbox.emit(this.db, {
      eventType: DomainEventType.CHARGE_POSTED,
      aggregateType: 'folio', aggregateId: folioId, propertyId: folio.propertyId,
      payload: { itemId, type: body.type, grossAmount: net + tax },
    });
    return { id: itemId, grossAmount: net + tax };
  }

  /**
   * Void d'une charge (README §51) : l'item original reste, on marque voided_at
   * et on poste un item ADJUSTMENT négatif compensatoire — jamais de UPDATE du montant.
   */
  async voidCharge(auth: AuthUser, itemId: string, reason: string) {
    const item = (await this.db.select().from(S.folioItems).where(eq(S.folioItems.id, itemId)))[0];
    if (!item) throw new NotFoundError('FolioItem', itemId);
    if (item.voidedAt) throw new DomainError('ALREADY_VOIDED', 'Cette écriture est déjà annulée.', 409);
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, item.folioId)))[0];
    if (!folio) throw new NotFoundError('Folio', item.folioId);
    if (folio.status === 'CLOSED') throw BizError.folioClosed(folio.id);

    const compensatoryId = newId();
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.update(S.folioItems)
        .set({ voidedAt: new Date(), voidedBy: auth.userId, voidReason: reason, voidedByItem: compensatoryId })
        .where(eq(S.folioItems.id, itemId));
      await tx.insert(S.folioItems).values({
        id: compensatoryId,
        folioId: item.folioId,
        businessDate: (await tx.select({ bd: S.properties.currentBusinessDate }).from(S.properties).where(eq(S.properties.id, folio.propertyId)))[0]?.bd ?? new Date().toISOString().slice(0, 10),
        type: FolioItemType.ADJUSTMENT,
        description: `Annulation: ${item.description} (${reason})`,
        quantity: 1,
        unitAmount: -item.netAmount,
        netAmount: -item.netAmount,
        taxAmount: -item.taxAmount,
        grossAmount: -item.grossAmount,
        currency: item.currency,
        referenceType: 'folio_item',
        referenceId: itemId,
        postedBy: auth.userId,
      });
      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: folio.propertyId, userId: auth.userId,
          action: 'folio.void_charge', resource: 'folio_item', resourceId: itemId,
          before: item, after: { compensatoryId, reason }, severity: 'WARNING',
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.CHARGE_VOIDED,
        aggregateType: 'folio', aggregateId: item.folioId, propertyId: folio.propertyId,
        payload: { itemId, reason },
      });
    });
    await this.refreshBalance(item.folioId);
    return { voided: itemId, compensatory: compensatoryId };
  }

  /** Transfert d'écriture vers un autre folio (README workflow §52). */
  async transferCharge(auth: AuthUser, itemId: string, toFolioId: string, reason: string) {
    const item = (await this.db.select().from(S.folioItems).where(eq(S.folioItems.id, itemId)))[0];
    if (!item || item.voidedAt) throw new NotFoundError('FolioItem', itemId);
    const to = (await this.db.select().from(S.folios).where(eq(S.folios.id, toFolioId)))[0];
    if (!to) throw new NotFoundError('Folio', toFolioId);
    if (to.status === 'CLOSED') throw BizError.folioClosed(toFolioId);
    await this.voidCharge(auth, itemId, `transfert:${reason}`);
    return this.postCharge(auth, toFolioId, {
      type: item.type as FolioItemType,
      description: `Transféré (${reason}): ${item.description}`,
      quantity: 1,
      unitAmount: item.netAmount,
      taxAmount: item.taxAmount,
      businessDate: new Date().toISOString().slice(0, 10),
    });
  }

  /**
   * Encaissement idempotent (README §26, §70, AC §133). La clef d'idempotence
   * (header ou body) est unique en base : un replay renvoie le paiement existant
   * au lieu d'en créer un second.
   */
  async recordPayment(auth: AuthUser, folioId: string, body: {
    amount: number; method: PaymentMethod; reference?: string; idempotencyKey?: string; cashSessionId?: string;
  }, headerKey?: string) {
    if (!body?.amount || body.amount <= 0) throw new ValidationError({ amount: 'must be > 0' });
    const idem = headerKey ?? body.idempotencyKey;
    if (!idem) throw new ValidationError({ idempotencyKey: 'requis (header Idempotency-Key ou body)' });

    const existing = await this.db
      .select()
      .from(S.payments)
      .where(and(eq(S.payments.propertyId, (await this.db.select({ p: S.folios.propertyId }).from(S.folios).where(eq(S.folios.id, folioId)))[0]?.p ?? ''), eq(S.payments.idempotencyKey, idem)));
    if (existing.length) {
      // Replay : renvoie le même résultat, aucun doublon (AC §133).
      return { ...existing[0], replayed: true };
    }

    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, folioId)))[0];
    if (!folio) throw new NotFoundError('Folio', folioId);
    if (folio.status === 'CLOSED') throw BizError.folioClosed(folioId);

    const balance = await this.computeBalance(this.db, folioId);
    if (body.amount > balance) throw BizError.paymentExceedsBalance(body.amount, balance);

    const paymentId = newId();
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const nums = await tx.select({ n: S.payments.id }).from(S.payments).where(eq(S.payments.propertyId, folio.propertyId));
      await tx.insert(S.payments).values({
        id: paymentId,
        propertyId: folio.propertyId,
        paymentNumber: `PAY-${String(nums.length + 1).padStart(6, '0')}`,
        folioId,
        amount: body.amount,
        currency: folio.currency,
        method: body.method ?? PaymentMethod.CASH,
        status: PaymentStatus.COMPLETED,
        reference: body.reference ?? null,
        receivedBy: auth.userId,
        cashSessionId: body.cashSessionId ?? null,
        idempotencyKey: idem,
      });
      await tx.insert(S.paymentAllocations).values({
        id: newId(), paymentId, folioId, amount: body.amount,
      });
      // Caisse : mouvement CASH si espèce et session fournie
      if ((body.method ?? PaymentMethod.CASH) === PaymentMethod.CASH && body.cashSessionId) {
        await tx.insert(S.cashMovements).values({
          id: newId(), cashSessionId: body.cashSessionId, type: 'PAYMENT',
          amount: body.amount, referenceType: 'payment', referenceId: paymentId, createdBy: auth.userId,
        });
      }
      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: folio.propertyId, userId: auth.userId,
          action: 'payment.record', resource: 'payment', resourceId: paymentId,
          after: { folioId, amount: body.amount, method: body.method },
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.PAYMENT_COMPLETED,
        aggregateType: 'payment', aggregateId: paymentId, propertyId: folio.propertyId,
        payload: { folioId, amount: body.amount },
      });
    });

    await this.refreshBalance(folioId);
    return { id: paymentId, amount: body.amount, replayed: false };
  }

  /** Remboursement (README workflow §53) — permission payment.refund. */
  async refundPayment(auth: AuthUser, paymentId: string, body: { amount: number; reason: string }) {
    const pay = (await this.db.select().from(S.payments).where(eq(S.payments.id, paymentId)))[0];
    if (!pay) throw new NotFoundError('Payment', paymentId);
    if (!body?.reason || !body?.amount || body.amount <= 0 || body.amount > pay.amount) {
      throw new ValidationError({ amount: '0 < amount <= paiement', reason: 'required' });
    }
    const refundId = newId();
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(S.refunds).values({
        id: refundId, paymentId, propertyId: pay.propertyId,
        amount: body.amount, reason: body.reason, approvedBy: auth.userId, processedBy: auth.userId,
      });
      await tx.update(S.payments).set({
        status: body.amount >= pay.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
        updatedAt: new Date(),
      }).where(eq(S.payments.id, paymentId));
      // Écriture de credit au folio
      const folio = (await tx.select().from(S.folios).where(eq(S.folios.id, pay.folioId)))[0];
      await tx.insert(S.folioItems).values({
        id: newId(),
        folioId: pay.folioId,
        businessDate: (await tx.select({ bd: S.properties.currentBusinessDate }).from(S.properties).where(eq(S.properties.id, pay.propertyId)))[0]?.bd ?? new Date().toISOString().slice(0, 10),
        type: FolioItemType.ADJUSTMENT,
        description: `Remboursement ${body.reason}`,
        quantity: 1,
        unitAmount: -body.amount,
        netAmount: -body.amount,
        taxAmount: 0,
        grossAmount: -body.amount,
        currency: pay.currency,
        referenceType: 'refund',
        referenceId: refundId,
        postedBy: auth.userId,
      });
      void folio;
      await this.audit.log(
        {
          organizationId: auth.organizationId, propertyId: pay.propertyId, userId: auth.userId,
          action: 'payment.refund', resource: 'refund', resourceId: refundId,
          before: pay, after: body, severity: 'WARNING',
        },
        tx as unknown as Db,
      );
      await this.outbox.emit(tx as unknown as Db, {
        eventType: DomainEventType.REFUND_COMPLETED,
        aggregateType: 'refund', aggregateId: refundId, propertyId: pay.propertyId,
        payload: { paymentId, amount: body.amount },
      });
    });
    await this.refreshBalance(pay.folioId);
    return { id: refundId };
  }

  /** Recalcule et persiste le solde + statut du folio depuis les écritures. */
  async refreshBalance(folioId: string): Promise<number> {
    const balance = await this.computeBalance(this.db, folioId);
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, folioId)))[0];
    if (!folio || folio.status === 'CLOSED') return balance;
    let charges = 0;
    const c = await this.db
      .select({ v: sql<string>`coalesce(sum(${S.folioItems.grossAmount}),0)::text` })
      .from(S.folioItems)
      .where(and(eq(S.folioItems.folioId, folioId), isNull(S.folioItems.voidedAt)));
    charges = Number(c[0]?.v ?? 0);
    const status = balance <= 0 && charges > 0 ? 'PAID' : balance < charges && balance > 0 ? 'PARTIALLY_PAID' : folio.status;
    await this.db.update(S.folios).set({ balance, status, updatedAt: new Date() }).where(eq(S.folios.id, folioId));
    return balance;
  }

  async getFolio(auth: AuthUser, id: string) {
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, id)))[0];
    if (!folio) throw new NotFoundError('Folio', id);
    const items = await this.db
      .select()
      .from(S.folioItems)
      .where(eq(S.folioItems.folioId, id))
      .orderBy(desc(S.folioItems.transactionDate));
    const payments = await this.db
      .select()
      .from(S.payments)
      .where(eq(S.payments.folioId, id))
      .orderBy(desc(S.payments.paidAt));
    const balance = await this.computeBalance(this.db, id);
    return { ...folio, items, payments, computedBalance: balance };
  }

  /** Poste les revenus chambre d'un séjour (night audit & checkout — README §55/§58). */
  async postRoomCharges(auth: AuthUser, folioId: string, businessDate: string) {
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, folioId)))[0];
    if (!folio) throw new NotFoundError('Folio', folioId);
    const stay = (await this.db.select().from(S.stays).where(eq(S.stays.id, folio.stayId)))[0];
    if (!stay) throw new NotFoundError('Stay', folio.stayId);
    const rr = (await this.db
      .select()
      .from(S.reservationRooms)
      .where(and(eq(S.reservationRooms.reservationId, stay.reservationId), eq(S.reservationRooms.status, 'ACTIVE'))))[0];
    if (!rr) return { posted: 0 };
    // Déjà postée pour cette nuit ? (idempotence night audit)
    const dup = await this.db
      .select({ id: S.folioItems.id })
      .from(S.folioItems)
      .where(and(
        eq(S.folioItems.folioId, folioId),
        eq(S.folioItems.type, FolioItemType.ROOM),
        eq(S.folioItems.businessDate, businessDate),
        isNull(S.folioItems.voidedAt),
      ));
    if (dup.length) return { posted: 0, already: true };
    const perNight = Math.floor(rr.totalAmount / Math.max(1, rr.numberOfNights));
    await this.db.insert(S.folioItems).values({
      id: newId(),
      folioId,
      businessDate,
      type: FolioItemType.ROOM,
      description: `Chambre ${rr.roomTypeId} — nuit du ${businessDate}`,
      quantity: 1,
      unitAmount: perNight,
      netAmount: perNight,
      taxAmount: Math.floor((rr.taxAmount * 1) / Math.max(1, rr.numberOfNights)),
      grossAmount: perNight + Math.floor((rr.taxAmount * 1) / Math.max(1, rr.numberOfNights)),
      currency: folio.currency,
      referenceType: 'reservation_room',
      referenceId: rr.id,
      nightCount: 1,
      postedBy: auth.userId,
    });
    await this.refreshBalance(folioId);
    return { posted: 1 };
  }
}

@Controller('api/v1')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FoliosController {
  constructor(private readonly folios: FoliosService) {}

  @Get('folios/:id')
  @RequirePermission('folio.view')
  getOne(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.folios.getFolio(auth, id);
  }

  @Post('folios/:id/charges')
  @RequirePermission('folio.post_charge')
  postCharge(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.folios.postCharge(auth, id, body);
  }

  @Post('folio-items/:itemId/void')
  @RequirePermission('folio.void_charge')
  voidCharge(@CurrentUser() auth: AuthUser, @Param('itemId') itemId: string, @Body() body: { reason: string }) {
    return this.folios.voidCharge(auth, itemId, body?.reason ?? 'non précisé');
  }

  @Post('folio-items/:itemId/transfer')
  @RequirePermission('folio.transfer_charge')
  transfer(@CurrentUser() auth: AuthUser, @Param('itemId') itemId: string, @Body() body: { toFolioId: string; reason: string }) {
    return this.folios.transferCharge(auth, itemId, body.toFolioId, body.reason ?? '');
  }

  @Post('folios/:id/payments')
  @RequirePermission('payment.record')
  pay(
    @CurrentUser() auth: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.folios.recordPayment(auth, id, body, key);
  }

  @Post('payments/:id/refund')
  @RequirePermission('payment.refund')
  refund(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.folios.refundPayment(auth, id, body);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [FoliosController],
  providers: [FoliosService, DatabaseService, AuditService, OutboxService, { provide: DB, useExisting: DatabaseService }],
  exports: [FoliosService],
})
export class FoliosModule {}
