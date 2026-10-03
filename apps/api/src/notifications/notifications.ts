/**
 * Notifications in-app (README §66) — alimentées par le worker outbox.
 * L'API expose la liste et le marquage "lu". L'envoi email/SMS reste hors MVP
 * (provider 'log' par défaut, README §98).
 */
import { Body, Controller, Get, Injectable, Module, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseModule, DatabaseService, Db } from '../database/database.module';
import { notifications, outboxEvents, users } from '../database/schema';
import { AuditModule } from '../audit/audit';
import { AuthUser, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import { NotFoundError } from '../common/errors';
import { newId } from '../common/utils';

@Injectable()
export class NotificationsService {
  constructor(private readonly dbs: DatabaseService) {}

  private get db(): Db {
    return this.dbs.db;
  }

  async listForUser(auth: AuthUser, unreadOnly = false) {
    const conds = [eq(notifications.userId, auth.userId)];
    if (unreadOnly) conds.push(isNull(notifications.readAt));
    return this.db.select().from(notifications).where(and(...conds))
      .orderBy(desc(notifications.createdAt)).limit(100);
  }

  async markRead(auth: AuthUser, id: string) {
    const rows = await this.db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, auth.userId)))
      .returning();
    if (!rows[0]) throw new NotFoundError('Notification', id);
    return rows[0];
  }

  async unreadCount(auth: AuthUser) {
    const r = await this.db.select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, auth.userId), isNull(notifications.readAt)));
    return { count: Number(r[0]?.c ?? 0) };
  }

  /** Créateur de notification interne (worker outbox, README §66/§96). */
  async createForManager(propertyId: string, evt: typeof outboxEvents.$inferSelect): Promise<void> {
    // Destinataires : utilisateurs ayant un rôle avec scope sur la propriété.
    const targets = await this.db.execute(sql`
      SELECT DISTINCT ur.user_id FROM user_roles ur
      WHERE (ur.property_id = ${propertyId} OR ur.property_id IS NULL)
        AND ur.user_id IN (SELECT id FROM users WHERE deleted_at IS NULL)`);
    const rows: any[] = (targets as any).rows ?? [];
    for (const t of rows) {
      await this.db.insert(notifications).values({
        id: newId(),
        organizationId: evt.organizationId,
        propertyId,
        userId: String(t.user_id),
        channel: 'IN_APP',
        eventType: evt.eventType,
        title: `Événement ${evt.eventType}`,
        body: JSON.stringify(evt.payload).slice(0, 500),
        linkUrl: null,
      });
    }
  }
}

@Controller('api/v1/notifications')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() auth: AuthUser, @Query('unread') unread?: string) {
    return this.svc.listForUser(auth, unread === '1' || unread === 'true');
  }

  @Get('unread-count')
  count(@CurrentUser() auth: AuthUser) {
    return this.svc.unreadCount(auth);
  }

  @Patch(':id/read')
  read(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.svc.markRead(auth, id);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
