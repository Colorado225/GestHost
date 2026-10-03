/**
 * Outbox pattern (README §67, §96) : les événements sont écrits dans la MÊME
 * transaction que la mutation métier, puis consommés de façon asynchrone.
 * Aucun appel HTTP externe n'est fait depuis une transaction DB ouverte (§95).
 */
import { Injectable, Logger, Module } from '@nestjs/common';
import { and, eq, lte, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import { outboxEvents } from '../database/schema';
import { newId } from '../common/utils';
import { DomainEventType } from '../common/enums';

export interface OutboxMessage {
  eventType: DomainEventType | string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  organizationId?: string | null;
  propertyId?: string | null;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly dbs: DatabaseService) {}

  /** À appeler DANS la transaction de la mutation (tx fourni par l'appelant). */
  async emit(tx: Db, msg: OutboxMessage): Promise<string> {
    const id = newId();
    await tx.insert(outboxEvents).values({
      id,
      organizationId: msg.organizationId ?? null,
      propertyId: msg.propertyId ?? null,
      eventType: msg.eventType,
      aggregateType: msg.aggregateType,
      aggregateId: msg.aggregateId,
      payload: msg.payload,
      status: 'PENDING',
    });
    return id;
  }

  /**
   * Consommation : claim pessimiste (FOR UPDATE SKIP LOCKED) pour qu'un worker
   * unique traite chaque événement ; retry exponentiel si échec.
   */
  async processPending(handler: (evt: typeof outboxEvents.$inferSelect) => Promise<void>, batchSize = 20) {
    const db = this.dbs.db;
    const due = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          or(eq(outboxEvents.status, 'PENDING'), eq(outboxEvents.status, 'FAILED')),
          lte(outboxEvents.availableAt, new Date()),
        ),
      )
      .limit(batchSize)
      .for('update', { skipLocked: true });

    for (const evt of due) {
      try {
        await db.update(outboxEvents).set({ status: 'PROCESSING' }).where(eq(outboxEvents.id, evt.id));
        await handler(evt);
        await db
          .update(outboxEvents)
          .set({ status: 'PROCESSED', processedAt: new Date() })
          .where(eq(outboxEvents.id, evt.id));
      } catch (e: any) {
        const attempts = evt.attempts + 1;
        const backoffMs = Math.min(2 ** attempts * 30_000, 3_600_000);
        await db
          .update(outboxEvents)
          .set({
            status: 'FAILED',
            attempts,
            lastError: String(e?.message ?? e).slice(0, 500),
            availableAt: new Date(Date.now() + backoffMs),
          })
          .where(eq(outboxEvents.id, evt.id));
        this.logger.warn(`outbox ${evt.id} (${evt.eventType}) attempt ${attempts} failed: ${e?.message}`);
      }
    }
    return due.length;
  }
}

@Module({ providers: [OutboxService, DatabaseService], exports: [OutboxService] })
export class OutboxModule {}
