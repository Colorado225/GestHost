/**
 * Audit trail (README §41, §76, AC §137) — écriture avant/après sur les actions critiques.
 * Le log est append-only : aucune API de modification/suppression n'est exposée.
 */
import { Inject, Injectable, Module } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import { auditLogs } from '../database/schema';
import { newId } from '../common/utils';

export interface AuditEntry {
  organizationId?: string | null;
  propertyId?: string | null;
  userId?: string | null;
  action: string; // ex: reservation.create, payment.record
  resource: string; // ex: reservation
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Écrit dans la transaction courante si fournie (atomicité avec la mutation). */
  async log(entry: AuditEntry, tx?: Db): Promise<void> {
    const repo = tx ?? this.db;
    await repo.insert(auditLogs).values({
      id: newId(),
      organizationId: entry.organizationId ?? null,
      propertyId: entry.propertyId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? null,
      beforeData: (entry.before ?? null) as any,
      afterData: entry.after != null ? this.sanitize(entry.after) : null,
      severity: entry.severity ?? 'INFO',
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      correlationId: entry.correlationId ?? null,
    });
  }

  /** Ne jamais journaliser de mots de passe/tokens (README §41). */
  private sanitize(value: unknown): unknown {
    if (value == null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = Array.isArray(value) ? ([] as any) : {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/password|token|secret|authorization/i.test(k)) out[k] = '[REDACTED]';
      else out[k] = this.sanitize(v);
    }
    return out;
  }

  /** Lecture filtrée pour la page Audit Log (README §88). */
  async query(opts: {
    propertyId?: string;
    userId?: string;
    action?: string;
    resource?: string;
    severity?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds = [];
    if (opts.propertyId) conds.push(eq(auditLogs.propertyId, opts.propertyId));
    if (opts.userId) conds.push(eq(auditLogs.userId, opts.userId));
    if (opts.action) conds.push(eq(auditLogs.action, opts.action));
    if (opts.resource) conds.push(eq(auditLogs.resource, opts.resource));
    if (opts.severity) conds.push(eq(auditLogs.severity, opts.severity));
    if (opts.from) conds.push(gte(auditLogs.createdAt, new Date(`${opts.from}T00:00:00Z`)));
    if (opts.to) conds.push(lte(auditLogs.createdAt, new Date(`${opts.to}T23:59:59Z`)));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(opts.limit ?? 100, 500))
      .offset(opts.offset ?? 0);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where);

    return { items: rows, total: Number(count) };
  }
}

@Module({
  providers: [AuditService, DatabaseService, { provide: DB, useExisting: DatabaseService }],
  exports: [AuditService],
})
export class AuditModule {}
