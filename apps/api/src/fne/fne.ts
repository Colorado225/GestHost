/**
 * Intégration FNE — Côte d'Ivoire (README §33, workflow §56, résidu §97).
 *
 * Principe structurant : le PMS ne connaît PAS le fournisseur. On parle à une
 * interface `FneProvider` ; l'adaptateur réel (API officielle DGII/FNE) sera
 * branché dès que les specs et credentials seront fournis (§128, §97). En
 * attendant, FNE_MODE=SIMULATION fournit un bac à sable déterministe :
 *  - certification réussie pour les montants valides,
 *  - rejet si la date de la facture est dans le futur (règle fiscale),
 *  - numéros FNE simulés préfixés "SIM-".
 *
 * Soumission asynchrone via outbox (aucun appel HTTP dans une transaction DB)
 * + retries exponentiels (nextRetryAt) + tentatives journalisées.
 */
import { Inject, Injectable, Module } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditService } from '../audit/audit';
import { AuthModule } from '../auth/auth';
import { OutboxModule, OutboxService } from '../outbox/outbox';
import { env } from '../common/env';
import { DomainEventType, FneSubmissionStatus, InvoiceStatus } from '../common/enums';
import { BizError, NotFoundError } from '../common/errors';
import { newId } from '../common/utils';

// ---------------------------------------------------------------------------
// Contrat provider (la seule chose que le reste du PMS connaît)
// ---------------------------------------------------------------------------

export interface FneInvoicePayload {
  invoiceId: string;
  invoiceNumber: string;
  issuedAt: string;
  buyerName: string;
  buyerTaxId?: string | null;
  currency: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
}

export type FneSubmitResult =
  | { ok: true; fneNumber: string; certificationReference: string; qrCodeData: string }
  | { ok: false; code: string; message: string };

export const FNE_PROVIDER = Symbol('FNE_PROVIDER');

export interface FneProvider {
  readonly mode: 'SIMULATION' | 'SANDBOX' | 'PRODUCTION';
  submit(payload: FneInvoicePayload): Promise<FneSubmitResult>;
}

/** Adaptateur simulé — comportement déterministe, remplace l'appel réseau. */
@Injectable()
export class SimulationFneProvider implements FneProvider {
  readonly mode = 'SIMULATION' as const;

  async submit(payload: FneInvoicePayload): Promise<FneSubmitResult> {
    // Règles de validation simulées (proches des règles réelles FNE) :
    if (payload.totalAmount <= 0 && payload.invoiceNumber.startsWith('INV')) {
      return { ok: false, code: 'FNE_INVALID_TOTAL', message: 'Montant total invalide.' };
    }
    if (Date.parse(payload.issuedAt) > Date.now() + 60_000) {
      return { ok: false, code: 'FNE_FUTURE_DATE', message: 'Date de facture postérieure à la date courante.' };
    }
    const sim = newId().replace(/-/g, '').slice(0, 12).toUpperCase();
    return {
      ok: true,
      fneNumber: `SIM-${sim}`,
      certificationReference: `CERT-${sim}`,
      qrCodeData: `FNE|${payload.invoiceNumber}|${payload.totalAmount}|${sim}`,
    };
  }
}

/**
 * Squelette de l'adaptateur officiel — à compléter quand les specs FNE seront
 * disponibles (README §97, §128). Aucun secret hardcodé : baseUrl/credentials
 * viennent de l'environnement.
 */
@Injectable()
export class HttpFneProvider implements FneProvider {
  readonly mode = (env().FNE_MODE === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX') as 'SANDBOX' | 'PRODUCTION';

  async submit(payload: FneInvoicePayload): Promise<FneSubmitResult> {
    const e = env();
    if (!e.FNE_BASE_URL || !e.FNE_API_KEY || !e.FNE_API_SECRET) {
      return { ok: false, code: 'FNE_NOT_CONFIGURED', message: 'Identifiants FNE non configurés (FNE_BASE_URL/FNE_API_KEY/FNE_API_SECRET).' };
    }
    try {
      const res = await fetch(`${e.FNE_BASE_URL}/api/v1/documents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.token()}`,
          'x-api-key': e.FNE_API_KEY,
        },
        body: JSON.stringify({
          type: 'FACTURE',
          numero: payload.invoiceNumber,
          dateCreation: payload.issuedAt,
          client: { nom: payload.buyerName, numeroContribuable: payload.buyerTaxId ?? undefined },
          montantHT: payload.subtotal,
          montantTVA: payload.taxAmount,
          montantTTC: payload.totalAmount,
          devise: payload.currency,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || json?.statut !== 'valide') {
        return { ok: false, code: String(json?.code ?? res.status), message: String(json?.message ?? 'Rejet FNE.') };
      }
      return {
        ok: true,
        fneNumber: json.numeroFne ?? json.docId,
        certificationReference: json.referenceCertification ?? json.docId,
        qrCodeData: json.qrCode ?? '',
      };
    } catch (err: any) {
      return { ok: false, code: 'FNE_NETWORK', message: err?.message ?? 'Erreur réseau FNE.' };
    }
  }

  private async token(): Promise<string> {
    const e = env();
    const res = await fetch(`${e.FNE_BASE_URL}/api/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clePrivee: e.FNE_API_SECRET }),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json();
    if (!json?.token) throw new Error('Authentification FNE échouée');
    return json.token;
  }
}

/** Fabrique : SIMULATION par défaut tant que §97 n'est pas levé. */
export function makeFneProvider(): FneProvider {
  return env().FNE_MODE === 'SIMULATION' ? new SimulationFneProvider() : new HttpFneProvider();
}

// ---------------------------------------------------------------------------
// Service de soumission + worker de retry
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;

@Injectable()
export class FneService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
    @Inject(FNE_PROVIDER) private readonly provider: FneProvider,
  ) {}

  /** Prépare la soumission : crée le document FNE + événement outbox (transaction). */
  async queueSubmission(authUser: { userId: string; organizationId: string }, invoiceId: string) {
    const inv = (await this.db.select().from(S.invoices).where(eq(S.invoices.id, invoiceId)))[0];
    if (!inv) throw new NotFoundError('Invoice', invoiceId);
    if (inv.status === InvoiceStatus.CERTIFIED) return { alreadyCertified: true, invoiceId };
    if (![InvoiceStatus.FINALIZED, InvoiceStatus.REJECTED].includes(inv.status as any)) {
      throw BizError.invalidStateTransition('invoice', inv.status, 'FNE_SUBMIT');
    }
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, inv.folioId)))[0];
    const guest = folio?.guestId
      ? (await this.db.select().from(S.guests).where(eq(S.guests.id, folio.guestId)))[0]
      : null;

    const docId = newId();
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(S.fneDocuments).values({
        id: docId,
        propertyId: inv.propertyId,
        invoiceId,
        submissionStatus: FneSubmissionStatus.PENDING,
      });
      await tx.update(S.invoices).set({ fneStatus: 'PENDING', updatedAt: new Date() }).where(eq(S.invoices.id, invoiceId));
      await tx.insert(S.outboxEvents).values({
        id: newId(),
        organizationId: authUser.organizationId,
        propertyId: inv.propertyId,
        eventType: DomainEventType.FNE_SUBMIT_REQUESTED,
        aggregateType: 'fne_document',
        aggregateId: docId,
        payload: { invoiceId, docId },
        status: 'PENDING',
        availableAt: new Date(),
      });
      await this.audit.log(
        {
          userId: authUser.userId, propertyId: inv.propertyId,
          action: 'fne.submit_requested', resource: 'fne_document', resourceId: docId,
          after: { invoiceId, invoiceNumber: inv.invoiceNumber },
        },
        tx as unknown as Db,
      );
    });
    return { docId };
  }

  /** Exécute une tentative de soumission (appelée par le worker outbox ou manuellement). */
  async processSubmission(docId: string): Promise<'CERTIFIED' | 'RETRYING' | 'FAILED'> {
    const doc = (await this.db.select().from(S.fneDocuments).where(eq(S.fneDocuments.id, docId)))[0];
    if (!doc) throw new NotFoundError('FneDocument', docId);
    if (doc.submissionStatus === FneSubmissionStatus.CERTIFIED) return 'CERTIFIED';

    const inv = (await this.db.select().from(S.invoices).where(eq(S.invoices.id, doc.invoiceId)))[0];
    const folio = (await this.db.select().from(S.folios).where(eq(S.folios.id, inv.folioId)))[0];
    const guest = folio?.guestId
      ? (await this.db.select().from(S.guests).where(eq(S.guests.id, folio.guestId)))[0]
      : null;
    const company = folio?.companyId
      ? (await this.db.select().from(S.companies).where(eq(S.companies.id, folio.companyId)))[0]
      : null;

    const attemptNo = doc.attemptsCount + 1;
    const requestId = newId();
    const result = await this.provider.submit({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      issuedAt: (inv.issuedAt ?? new Date()).toISOString(),
      buyerName: company?.name ?? (guest ? `${guest.firstName} ${guest.lastName}` : 'Client comptoir'),
      buyerTaxId: company?.taxIdentifier ?? null,
      currency: inv.currency,
      subtotal: inv.subtotal,
      taxAmount: inv.taxAmount,
      totalAmount: inv.totalAmount,
    });

    const nextStatus = result.ok
      ? FneSubmissionStatus.CERTIFIED
      : attemptNo >= MAX_ATTEMPTS
        ? FneSubmissionStatus.FAILED
        : FneSubmissionStatus.RETRYING;
    // backoff exponentiel : 30s, 2m, 8m, 32m...
    const delayMs = 30_000 * Math.pow(4, attemptNo - 1);

    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(S.fneSubmissionAttempts).values({
        id: newId(),
        fneDocumentId: docId,
        attemptNumber: attemptNo,
        requestId,
        status: result.ok ? 'SUCCESS' : 'FAILURE',
        responseCode: result.ok ? 'OK' : result.code,
        errorMessage: result.ok ? null : result.message,
        responseBodySanitized: JSON.stringify(result).slice(0, 2000),
      });
      await tx.update(S.fneDocuments).set({
        submissionStatus: nextStatus,
        attemptsCount: attemptNo,
        nextRetryAt: nextStatus === FneSubmissionStatus.RETRYING ? new Date(Date.now() + delayMs) : null,
        submittedAt: new Date(),
        ...(result.ok
          ? {
              fneNumber: result.fneNumber,
              certificationReference: result.certificationReference,
              qrCodeData: result.qrCodeData,
              certifiedAt: new Date(),
            }
          : { rejectedAt: new Date(), rejectionReason: result.message }),
        updatedAt: new Date(),
      } as any).where(eq(S.fneDocuments.id, docId));

      await tx.update(S.invoices).set({
        status: result.ok ? InvoiceStatus.CERTIFIED : InvoiceStatus.REJECTED,
        fneStatus: nextStatus,
        ...(result.ok ? { fneNumber: result.fneNumber } : {}),
        updatedAt: new Date(),
      } as any).where(eq(S.invoices.id, inv.id));

      await this.audit.log(
        {
          propertyId: inv.propertyId,
          action: result.ok ? 'fne.certified' : 'fne.rejected',
          resource: 'fne_document',
          resourceId: docId,
          after: { attempt: attemptNo, result },
          severity: result.ok ? 'INFO' : 'WARNING',
        },
        tx as unknown as Db,
      );
      if (result.ok) {
        await tx.insert(S.outboxEvents).values({
          id: newId(), propertyId: inv.propertyId,
          eventType: DomainEventType.FNE_CERTIFIED,
          aggregateType: 'invoice', aggregateId: inv.id,
          payload: { fneNumber: result.fneNumber }, status: 'PENDING', availableAt: new Date(),
        });
      }
    });
    return nextStatus as any;
  }

  /** Worker : documents en attente dont nextRetryAt est échu. */
  async runDueSubmissions(): Promise<number> {
    const due = await this.db
      .select({ id: S.fneDocuments.id })
      .from(S.fneDocuments)
      .where(
        and(
          inArray(S.fneDocuments.submissionStatus, [FneSubmissionStatus.PENDING, FneSubmissionStatus.RETRYING]),
          or(isNull(S.fneDocuments.nextRetryAt), lte(S.fneDocuments.nextRetryAt, new Date())),
        ),
      )
      .limit(20);
    let n = 0;
    for (const d of due) {
      try {
        await this.processSubmission(d.id);
        n += 1;
      } catch {
        /* le prochain tick réessaiera */
      }
    }
    return n;
  }

  /** Retry manuel (permission fne.retry). */
  async manualRetry(auth: { userId: string }, docId: string) {
    const doc = (await this.db.select().from(S.fneDocuments).where(eq(S.fneDocuments.id, docId)))[0];
    if (!doc) throw new NotFoundError('FneDocument', docId);
    if (![FneSubmissionStatus.FAILED, FneSubmissionStatus.REJECTED, FneSubmissionStatus.RETRYING].includes(doc.submissionStatus as any)) {
      throw BizError.invalidStateTransition('fne_document', doc.submissionStatus, 'RETRY');
    }
    await this.db.update(S.fneDocuments).set({
      submissionStatus: FneSubmissionStatus.PENDING,
      nextRetryAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(S.fneDocuments.id, docId));
    await this.audit.log({ userId: auth.userId, action: 'fne.retry', resource: 'fne_document', resourceId: docId, severity: 'WARNING' });
    return this.processSubmission(docId);
  }

  async getDocument(invoiceId: string) {
    const doc = (await this.db
      .select()
      .from(S.fneDocuments)
      .where(eq(S.fneDocuments.invoiceId, invoiceId))
      .orderBy(sql`${S.fneDocuments.createdAt} desc`))[0];
    if (!doc) throw new NotFoundError('FneDocument', invoiceId);
    const attempts = await this.db
      .select()
      .from(S.fneSubmissionAttempts)
      .where(eq(S.fneSubmissionAttempts.fneDocumentId, doc.id))
      .orderBy(sql`${S.fneSubmissionAttempts.attemptNumber} asc`);
    return { ...doc, attempts };
  }
}

@Module({
  imports: [AuthModule, OutboxModule],
  providers: [
    FneService,
    DatabaseService,
    AuditService,
    { provide: FNE_PROVIDER, useFactory: makeFneProvider },
    { provide: DB, useExisting: DatabaseService },
  ],
  exports: [FneService, FNE_PROVIDER],
})
export class FneModule {}
