/**
 * Housekeeping (README §34–§36, workflows §36/§57).
 * - Statuts : PENDING -> ASSIGNED -> IN_PROGRESS -> DONE (+ SKIPPED/CANCELLED).
 * - Inspection valide ou invalide la remise en location.
 * - Passage CLEAN & inspecté -> chambre AVAILABLE ; OOO/OOS bloquent la vente.
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
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditService } from '../audit/audit';
import { AuthModule, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import type { AuthUser } from '../auth/auth';
import { BizError, NotFoundError, ValidationError } from '../common/errors';
import { newId } from '../common/utils';

@Injectable()
export class HousekeepingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createTask(auth: AuthUser, body: {
    propertyId: string; roomId: string; taskType?: string; priority?: string;
    scheduledDate?: string; businessDate?: string; assignedTo?: string; notes?: string;
  }) {
    if (!body?.propertyId || !body?.roomId) throw new ValidationError({ propertyId: 'required', roomId: 'required' });
    const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, body.roomId)))[0];
    if (!room) throw new NotFoundError('Room', body.roomId);
    const prop = (await this.db.select().from(S.properties).where(eq(S.properties.id, body.propertyId)))[0];
    const id = newId();
    await this.db.insert(S.housekeepingTasks).values({
      id,
      propertyId: body.propertyId,
      roomId: body.roomId,
      taskType: body.taskType ?? 'STAY_OVER',
      priority: body.priority ?? 'NORMAL',
      status: 'PENDING',
      scheduledDate: body.scheduledDate ?? null,
      businessDate: body.businessDate ?? prop?.currentBusinessDate ?? new Date().toISOString().slice(0, 10),
      assignedTo: body.assignedTo ?? null,
      notes: body.notes ?? null,
    });
    await this.audit.log({ userId: auth.userId, propertyId: body.propertyId, action: 'hk.task_create', resource: 'housekeeping_task', resourceId: id, after: body });
    return (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, id)))[0];
  }

  /** Affectation à un employé -> ASSIGNED. */
  async assign(auth: AuthUser, taskId: string, assignedTo: string) {
    const t = (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, taskId)))[0];
    if (!t) throw new NotFoundError('HousekeepingTask', taskId);
    if (['DONE', 'CANCELLED'].includes(t.status)) throw BizError.invalidStateTransition('task', t.status, 'ASSIGN');
    await this.db.update(S.housekeepingTasks).set({ assignedTo, status: 'ASSIGNED', updatedAt: new Date() }).where(eq(S.housekeepingTasks.id, taskId));
    await this.audit.log({ userId: auth.userId, propertyId: t.propertyId, action: 'hk.task_assign', resource: 'housekeeping_task', resourceId: taskId, after: { assignedTo } });
    return (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, taskId)))[0];
  }

  /** Démarrage du travail -> IN_PROGRESS. */
  async start(auth: AuthUser, taskId: string) {
    const t = (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, taskId)))[0];
    if (!t) throw new NotFoundError('HousekeepingTask', taskId);
    if (!['PENDING', 'ASSIGNED'].includes(t.status)) throw BizError.invalidStateTransition('task', t.status, 'START');
    await this.db.update(S.housekeepingTasks).set({ status: 'IN_PROGRESS', startedAt: new Date(), updatedAt: new Date() }).where(eq(S.housekeepingTasks.id, taskId));
    return (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, taskId)))[0];
  }

  /**
   * Terminer : met à jour le statut housekeeping de la chambre. La chambre ne
   * redevient louable qu'après inspection (sauf tâches légères type turndown).
   */
  async complete(auth: AuthUser, taskId: string, body: { resultStatus?: 'CLEAN' | 'CLEAN_INSPECTED' | 'NEEDS_ATTENTION'; notes?: string } = {}) {
    const t = (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, taskId)))[0];
    if (!t) throw new NotFoundError('HousekeepingTask', taskId);
    if (!['ASSIGNED', 'IN_PROGRESS', 'PENDING'].includes(t.status)) throw BizError.invalidStateTransition('task', t.status, 'DONE');
    const result = body.resultStatus ?? 'CLEAN';
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.update(S.housekeepingTasks).set({
        status: 'DONE', completedAt: new Date(), resultStatus: result,
        inspectedBy: result === 'CLEAN_INSPECTED' ? auth.userId : null,
        inspectedAt: result === 'CLEAN_INSPECTED' ? new Date() : null,
        notes: body.notes ?? t.notes, updatedAt: new Date(),
      }).where(eq(S.housekeepingTasks.id, taskId));
      // Chambre occupée ? On garde OCCUPIED mais maj hkStatus (stay-over).
      const occupied = await tx
        .select({ id: S.stayRooms.id })
        .from(S.stayRooms)
        .innerJoin(S.stays, eq(S.stayRooms.stayId, S.stays.id))
        .where(and(eq(S.stayRooms.roomId, t.roomId), isNull(S.stayRooms.releasedAt), inArray(S.stays.status, ['CHECKED_IN'])));
      const set: Record<string, unknown> = { housekeepingStatus: result === 'CLEAN_INSPECTED' ? 'CLEAN_INSPECTED' : result, updatedAt: new Date() };
      if (result === 'CLEAN_INSPECTED' && occupied.length === 0) {
        set.status = 'AVAILABLE';
        set.frontOfficeStatus = 'VACANT';
      } else if (result === 'NEEDS_ATTENTION') {
        set.housekeepingStatus = 'NEEDS_ATTENTION';
      }
      await tx.update(S.rooms).set(set as any).where(eq(S.rooms.id, t.roomId));
      if (result === 'CLEAN_INSPECTED' && occupied.length === 0) {
        await tx.insert(S.roomStatusHistory).values({
          id: newId(), propertyId: t.propertyId, roomId: t.roomId,
          previousStatus: (await tx.select({ s: S.rooms.status }).from(S.rooms).where(eq(S.rooms.id, t.roomId)))[0]?.s ?? 'DIRTY',
          newStatus: 'AVAILABLE', reason: 'housekeeping_inspected', referenceType: 'housekeeping_task', referenceId: taskId, changedBy: auth.userId,
        });
      }
      await this.audit.log(
        { userId: auth.userId, propertyId: t.propertyId, action: 'hk.task_complete', resource: 'housekeeping_task', resourceId: taskId, after: { result, ...body } },
        tx as unknown as Db,
      );
    });
    return (await this.db.select().from(S.housekeepingTasks).where(eq(S.housekeepingTasks.id, taskId)))[0];
  }

  /** Inspection d'une chambre (workflow §36) : valide ou renvoie en nettoyage. */
  async inspect(auth: AuthUser, roomId: string, body: { approved: boolean; notes?: string }) {
    const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, roomId)))[0];
    if (!room) throw new NotFoundError('Room', roomId);
    const hk = body.approved ? 'CLEAN_INSPECTED' : 'DIRTY';
    const set: Record<string, unknown> = { housekeepingStatus: hk, updatedAt: new Date() };
    if (body.approved && room.frontOfficeStatus === 'VACANT' && !['OUT_OF_ORDER', 'OUT_OF_SERVICE', 'BLOCKED'].includes(room.status)) {
      set.status = 'AVAILABLE';
    }
    await this.db.update(S.rooms).set(set as any).where(eq(S.rooms.id, roomId));
    await this.audit.log({ userId: auth.userId, propertyId: room.propertyId, action: 'hk.inspect', resource: 'room', resourceId: roomId, after: { approved: body.approved, notes: body.notes } });
    return (await this.db.select().from(S.rooms).where(eq(S.rooms.id, roomId)))[0];
  }

  /**
   * Blocage / déblocage de chambre (hors vente) — motif obligatoire,
   * historique statut (README §10).
   */
  async blockRoom(auth: AuthUser, roomId: string, body: { blocked: boolean; reason: string; untilDate?: string }) {
    if (!body?.reason) throw new ValidationError({ reason: 'required' });
    const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, roomId)))[0];
    if (!room) throw new NotFoundError('Room', roomId);
    const newStatus = body.blocked ? 'BLOCKED' : 'AVAILABLE';
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.update(S.rooms).set({
        status: newStatus as any,
        frontOfficeStatus: body.blocked ? 'OUT_OF_SERVICE' : 'VACANT',
        updatedAt: new Date(),
      }).where(eq(S.rooms.id, roomId));
      await tx.insert(S.roomStatusHistory).values({
        id: newId(), propertyId: room.propertyId, roomId,
        previousStatus: room.status, newStatus, reason: `block:${body.reason}`, changedBy: auth.userId,
      });
      await this.audit.log(
        { userId: auth.userId, propertyId: room.propertyId, action: body.blocked ? 'room.block' : 'room.unblock', resource: 'room', resourceId: roomId, after: body },
        tx as unknown as Db,
      );
    });
    return (await this.db.select().from(S.rooms).where(eq(S.rooms.id, roomId)))[0];
  }

  /** Tableau par date métier : tâches groupées par statut. */
  async board(auth: AuthUser, propertyId: string, businessDate: string) {
    const tasks = await this.db
      .select()
      .from(S.housekeepingTasks)
      .where(and(
        eq(S.housekeepingTasks.propertyId, propertyId),
        eq(S.housekeepingTasks.businessDate, businessDate),
        notIn(['CANCELLED']),
      ))
      .orderBy(asc(S.housekeepingTasks.priority));
    const rooms = await this.db
      .select({ id: S.rooms.id, label: S.rooms.number, floor: S.rooms.floorLocation, hk: S.rooms.housekeepingStatus, status: S.rooms.status })
      .from(S.rooms)
      .where(and(eq(S.rooms.propertyId, propertyId), isNull(S.rooms.deletedAt)));
    return { tasks, rooms };
  }
}

function notIn(statuses: string[]) {
  return sql`${S.housekeepingTasks.status} NOT IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`;
}

@Controller('api/v1/housekeeping')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HousekeepingController {
  constructor(private readonly hk: HousekeepingService) {}

  @Post('tasks')
  @RequirePermission('housekeeping.assign')
  create(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.hk.createTask(auth, body);
  }

  @Get('board')
  @RequirePermission('housekeeping.view')
  board(@CurrentUser() auth: AuthUser, @Query('propertyId') propertyId: string, @Query('businessDate') businessDate: string) {
    return this.hk.board(auth, propertyId, businessDate);
  }

  @Post('tasks/:id/assign')
  @RequirePermission('housekeeping.assign')
  assign(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: { assignedTo: string }) {
    return this.hk.assign(auth, id, body.assignedTo);
  }

  @Post('tasks/:id/start')
  @RequirePermission('housekeeping.update_status')
  start(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.hk.start(auth, id);
  }

  @Post('tasks/:id/complete')
  @RequirePermission('housekeeping.update_status')
  complete(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.hk.complete(auth, id, body ?? {});
  }

  @Post('rooms/:id/inspect')
  @RequirePermission('housekeeping.inspection')
  inspect(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: { approved: boolean; notes?: string }) {
    return this.hk.inspect(auth, id, body);
  }

  @Post('rooms/:id/block')
  @RequirePermission('housekeeping.block_room')
  block(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.hk.blockRoom(auth, id, body);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService, DatabaseService, AuditService, { provide: DB, useExisting: DatabaseService }],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}
