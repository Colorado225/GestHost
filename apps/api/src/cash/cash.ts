/**
 * Caisse / cash up (README §32, workflow §57).
 * - Une session OPEN par utilisateur & propriété (contrainte partielle unique).
 * - Mouvements automatiques liés aux paiements espèce (voir FoliosService).
 * - Clôture : comptage déclaré vs attendu, variance justifiée si seuil dépassé.
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
import { CashSessionStatus } from '../common/enums';
import { BizError, NotFoundError, ValidationError } from '../common/errors';
import { newId } from '../common/utils';

@Injectable()
export class CashService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Ouverture de session — une seule OPEN par user+property (README §74). */
  async openSession(auth: AuthUser, body: { propertyId: string; openingFloat: number; terminalLabel?: string }) {
    if (!body?.propertyId || body.openingFloat === undefined) {
      throw new ValidationError({ propertyId: 'required', openingFloat: 'required' });
    }
    const existing = await this.db
      .select()
      .from(S.cashSessions)
      .where(and(
        eq(S.cashSessions.propertyId, body.propertyId),
        eq(S.cashSessions.userId, auth.userId),
        inArray(S.cashSessions.status, [CashSessionStatus.OPEN, CashSessionStatus.CLOSING]),
      ));
    if (existing.length) throw BizError.cashSessionAlreadyOpen(existing[0].id);

    const id = newId();
    const prop = (await this.db.select().from(S.properties).where(eq(S.properties.id, body.propertyId)))[0];
    try {
      await this.db.insert(S.cashSessions).values({
        id,
        propertyId: body.propertyId,
        cashRegisterId: null,
        userId: auth.userId,
        status: CashSessionStatus.OPEN,
        openingFloat: body.openingFloat,
        expectedCash: body.openingFloat,
        currency: prop?.currency ?? 'XOF',
        terminalLabel: body.terminalLabel ?? null,
        businessDate: prop?.currentBusinessDate ?? new Date().toISOString().slice(0, 10),
      });
    } catch (e: any) {
      // Contrainte unique partielle -> même sémantique d'erreur (course sûre).
      if (e?.code === '23505') {
        const dup = (await this.db.select().from(S.cashSessions)
          .where(and(eq(S.cashSessions.propertyId, body.propertyId), eq(S.cashSessions.userId, auth.userId), eq(S.cashSessions.status, CashSessionStatus.OPEN))))[0];
        throw BizError.cashSessionAlreadyOpen(dup?.id ?? '?');
      }
      throw e;
    }
    await this.audit.log({ userId: auth.userId, propertyId: body.propertyId, action: 'cash.session_open', resource: 'cash_session', resourceId: id, after: body });
    return (await this.db.select().from(S.cashSessions).where(eq(S.cashSessions.id, id)))[0];
  }

  /** Attendu = float + mouvements CASH/PAYMENT espèces - remboursements/retraits. */
  async computeExpected(db: Db, session: typeof S.cashSessions.$inferSelect): Promise<number> {
    const rows = await db
      .select({
        v: sql<string>`coalesce(sum(case when ${S.cashMovements.type} in ('SALE','PAYMENT','CASH_IN') then ${S.cashMovements.amount} else -${S.cashMovements.amount} end), 0)::text`,
      })
      .from(S.cashMovements)
      .innerJoin(S.payments, sql`${S.payments.id} = ${S.cashMovements.referenceId}`)
      .where(and(eq(S.cashMovements.cashSessionId, session.id), eq(S.payments.method, 'CASH')));
    const flows = Number(rows[0]?.v ?? 0);
    // ajustements hors paiement
    const adj = await db
      .select({ v: sql<string>`coalesce(sum(case when ${S.cashMovements.type}='CASH_IN' then ${S.cashMovements.amount} else -${S.cashMovements.amount} end),0)::text` })
      .from(S.cashMovements)
      .where(and(eq(S.cashMovements.cashSessionId, session.id), inArray(S.cashMovements.type, ['CASH_IN', 'CASH_OUT', 'ADJUSTMENT'])));
    return session.openingFloat + flows + Number(adj[0]?.v ?? 0);
  }

  /** Mouvement manuel (entrée/sortie/ajustement) — permission cash.adjust pour ADJUSTMENT. */
  async addMovement(auth: AuthUser, sessionId: string, body: { type: 'CASH_IN' | 'CASH_OUT' | 'ADJUSTMENT'; amount: number; reason?: string }) {
    if (!body?.amount || body.amount <= 0) throw new ValidationError({ amount: 'must be > 0' });
    if (body.type === 'ADJUSTMENT' && !body.reason) throw new ValidationError({ reason: 'obligatoire pour un ajustement' });
    const session = (await this.db.select().from(S.cashSessions).where(eq(S.cashSessions.id, sessionId)))[0];
    if (!session) throw new NotFoundError('CashSession', sessionId);
    if (session.status !== CashSessionStatus.OPEN) throw BizError.invalidStateTransition('cash_session', session.status, 'MOVEMENT');
    const id = newId();
    await this.db.insert(S.cashMovements).values({
      id, cashSessionId: sessionId, type: body.type, amount: body.amount,
      description: body.reason ?? null, createdBy: auth.userId,
    });
    const expected = await this.computeExpected(this.db, session);
    await this.db.update(S.cashSessions).set({ expectedCash: expected, updatedAt: new Date() }).where(eq(S.cashSessions.id, sessionId));
    await this.audit.log({
      userId: auth.userId, propertyId: session.propertyId,
      action: `cash.${body.type.toLowerCase()}`, resource: 'cash_movement', resourceId: id,
      after: { sessionId, ...body }, severity: body.type === 'ADJUSTMENT' ? 'WARNING' : 'INFO',
    });
    return { id };
  }

  /**
   * Clôture (cash-up) : variance déclarée vs attendue. Si |variance| > seuil
   * de la propriété, une raison est obligatoire (workflow §57).
   */
  async closeSession(auth: AuthUser, sessionId: string, body: { declaredCash: number; reason?: string }) {
    if (body?.declaredCash === undefined) throw new ValidationError({ declaredCash: 'required' });
    const session = (await this.db.select().from(S.cashSessions).where(eq(S.cashSessions.id, sessionId)))[0];
    if (!session) throw new NotFoundError('CashSession', sessionId);
    if (session.status !== CashSessionStatus.OPEN) throw BizError.invalidStateTransition('cash_session', session.status, 'CLOSED');
    const prop = (await this.db.select().from(S.properties).where(eq(S.properties.id, session.propertyId)))[0];

    const expected = await this.computeExpected(this.db, session);
    const variance = body.declaredCash - expected;
    const threshold = 1000 /* seuil par défaut ; surcharge via property_settings à câbler en V2 */;
    if (Math.abs(variance) > threshold && !body.reason) {
      throw new ValidationError({ reason: `écart de ${variance} > seuil ${threshold} : justification obligatoire` });
    }
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.update(S.cashSessions).set({
        status: CashSessionStatus.CLOSED,
        closedAt: new Date(),
        closedBy: auth.userId,
        declaredCash: body.declaredCash,
        expectedCash: expected,
        variance,
        notes: body.reason ?? session.notes,
        updatedAt: new Date(),
      }).where(eq(S.cashSessions.id, sessionId));
      await this.audit.log(
        {
          userId: auth.userId, propertyId: session.propertyId,
          action: 'cash.session_close', resource: 'cash_session', resourceId: sessionId,
          after: { expected, declared: body.declaredCash, variance, reason: body.reason },
          severity: Math.abs(variance) > threshold ? 'WARNING' : 'INFO',
        },
        tx as unknown as Db,
      );
    });
    return { ok: true, expected, declared: body.declaredCash, variance };
  }

  async currentSession(auth: AuthUser, propertyId: string) {
    return (await this.db
      .select()
      .from(S.cashSessions)
      .where(and(
        eq(S.cashSessions.propertyId, propertyId),
        eq(S.cashSessions.userId, auth.userId),
        inArray(S.cashSessions.status, [CashSessionStatus.OPEN, CashSessionStatus.CLOSING]),
      )))[0] ?? null;
  }

  async listSessions(auth: AuthUser, propertyId: string) {
    return this.db
      .select()
      .from(S.cashSessions)
      .where(eq(S.cashSessions.propertyId, propertyId))
      .orderBy(desc(S.cashSessions.openedAt))
      .limit(100);
  }

  async movements(auth: AuthUser, sessionId: string) {
    return this.db.select().from(S.cashMovements).where(eq(S.cashMovements.cashSessionId, sessionId));
  }
}

@Controller('api/v1/cash')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Post('sessions')
  @RequirePermission('cash.open_session')
  open(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.cash.openSession(auth, body);
  }

  @Get('sessions/current')
  @RequirePermission('cash.view')
  current(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string) {
    return this.cash.currentSession(auth, propertyId);
  }

  @Get('sessions')
  @RequirePermission('cash.view')
  list(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string) {
    return this.cash.listSessions(auth, propertyId);
  }

  @Get('sessions/:id/movements')
  @RequirePermission('cash.view')
  movements(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.cash.movements(auth, id);
  }

  @Post('sessions/:id/movements')
  @RequirePermission('cash.adjust')
  movement(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cash.addMovement(auth, id, body);
  }

  @Post('sessions/:id/close')
  @RequirePermission('cash.close_session')
  close(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cash.closeSession(auth, id, body);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [CashController],
  providers: [CashService, DatabaseService, AuditService, { provide: DB, useExisting: DatabaseService }],
  exports: [CashService],
})
export class CashModule {}
