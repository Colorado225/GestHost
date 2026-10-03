/**
 * Maintenance & assets (README §37–§38).
 * - Ticket OPEN → IN_PROGRESS → RESOLVED → CLOSED ; la fermeture libère la chambre.
 * - outOfOrder=true passe la chambre OUT_OF_ORDER (via CatalogService.changeRoomStatus,
 *   historique de statut obligatoire §10/AC §137) et la sort de l'inventaire vendable (§45).
 */
import {
  Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseModule, DatabaseService, Db } from '../database/database.module';
import * as S from '../database/schema';
import { AuditModule, AuditService } from '../audit/audit';
import { OutboxModule, OutboxService } from '../outbox/outbox';
import { CatalogModule, CatalogService } from '../catalog/catalog';
import { AuthUser, JwtAuthGuard, PermissionGuard, RequirePermission } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import { BizError, NotFoundError } from '../common/errors';
import { DomainEventType, RoomStatus } from '../common/enums';
import { newId } from '../common/utils';

const TICKET_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  CANCELLED: [],
};

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly catalog: CatalogService,
  ) {}

  private get db(): Db {
    return this.dbs.db;
  }

  async createTicket(auth: AuthUser, body: {
    propertyId: string; roomId?: string; assetId?: string; title: string;
    description?: string; priority?: string; reportedBy?: string; outOfOrder?: boolean;
  }) {
    const prop = await this.catalog.getProperty(auth, body.propertyId);
    const id = newId();
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.insert(S.maintenanceTickets).values({
        id,
        propertyId: body.propertyId,
        roomId: body.roomId ?? null,
        assetId: body.assetId ?? null,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'NORMAL',
        status: 'OPEN',
        reportedBy: body.reportedBy ?? auth.userId,
        outOfOrder: !!body.outOfOrder,
      });
      if (body.outOfOrder && body.roomId) {
        const room = (await tx.select().from(S.rooms)
          .where(and(eq(S.rooms.id, body.roomId), isNull(S.rooms.deletedAt))))[0];
        if (!room) throw new NotFoundError('Room', body.roomId);
        await tx.update(S.rooms)
          .set({ maintenanceStatus: 'MAINTENANCE', updatedAt: new Date() })
          .where(eq(S.rooms.id, room.id));
      }
      await this.audit.log({
        organizationId: prop.organizationId, propertyId: body.propertyId, userId: auth.userId,
        action: 'maintenance.create', resource: 'maintenance_ticket', resourceId: id,
        after: { title: body.title, outOfOrder: !!body.outOfOrder },
      }, tx);
    });
    // Blocage OOO : changeRoomStatus gère sa propre transaction + verrou + historique (§10).
    if (body.outOfOrder && body.roomId) {
      const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, body.roomId)))[0];
      if (room && room.status !== RoomStatus.OUT_OF_ORDER && room.status !== RoomStatus.OCCUPIED) {
        await this.catalog.changeRoomStatus(
          auth, body.roomId, RoomStatus.OUT_OF_ORDER,
          `Ticket maintenance ${id}`, { type: 'maintenance_ticket', id },
        );
      }
    }
    await this.outbox.emit(this.db, {
      organizationId: prop.organizationId, propertyId: body.propertyId,
      eventType: DomainEventType.MAINTENANCE_CREATED, aggregateType: 'maintenance_ticket',
      aggregateId: id, payload: { title: body.title, roomId: body.roomId ?? null, outOfOrder: !!body.outOfOrder },
    });
    return this.getTicket(auth, id);
  }

  async getTicket(auth: AuthUser, id: string) {
    const t = (await this.db.select().from(S.maintenanceTickets).where(eq(S.maintenanceTickets.id, id)))[0];
    if (!t) throw new NotFoundError('MaintenanceTicket', id);
    await this.catalog.getProperty(auth, t.propertyId); // contrôle tenant
    return t;
  }

  async listTickets(auth: AuthUser, propertyId: string, status?: string) {
    await this.catalog.getProperty(auth, propertyId);
    const conds = [eq(S.maintenanceTickets.propertyId, propertyId)];
    if (status) conds.push(eq(S.maintenanceTickets.status, status));
    return this.db.select().from(S.maintenanceTickets).where(and(...conds))
      .orderBy(desc(S.maintenanceTickets.openedAt)).limit(200);
  }

  async transition(auth: AuthUser, id: string, body: {
    toStatus: string; assignedTo?: string; actualCost?: number; note?: string;
  }) {
    const ticket = await this.getTicket(auth, id);
    const allowed = TICKET_TRANSITIONS[ticket.status] ?? [];
    if (!allowed.includes(body.toStatus)) {
      throw BizError.invalidStateTransition('MaintenanceTicket', ticket.status, body.toStatus);
    }
    const prop = await this.catalog.getProperty(auth, ticket.propertyId);
    await this.dbs.withTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const now = new Date();
      await tx.update(S.maintenanceTickets).set({
        status: body.toStatus,
        assignedTo: body.assignedTo ?? ticket.assignedTo,
        actualCost: body.actualCost != null ? Number(body.actualCost) : ticket.actualCost,
        resolvedAt: body.toStatus === 'RESOLVED' ? now : ticket.resolvedAt,
        closedAt: body.toStatus === 'CLOSED' ? now : ticket.closedAt,
        updatedAt: now,
      }).where(eq(S.maintenanceTickets.id, id));
      if (ticket.roomId) {
        await tx.update(S.rooms)
          .set({ maintenanceStatus: body.toStatus === 'CLOSED' || body.toStatus === 'CANCELLED' ? 'OK' : 'MAINTENANCE' })
          .where(eq(S.rooms.id, ticket.roomId));
      }
      await this.audit.log({
        organizationId: prop.organizationId, propertyId: ticket.propertyId, userId: auth.userId,
        action: `maintenance.${body.toStatus.toLowerCase()}`, resource: 'maintenance_ticket', resourceId: id,
        before: { status: ticket.status }, after: { status: body.toStatus, note: body.note ?? null },
      }, tx);
    });
    // Libération de la chambre OOO à la clôture (retour AVAILABLE avec traçabilité).
    if ((body.toStatus === 'CLOSED' || body.toStatus === 'CANCELLED') && ticket.outOfOrder && ticket.roomId) {
      const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, ticket.roomId)))[0];
      if (room && room.status === RoomStatus.OUT_OF_ORDER) {
        await this.catalog.changeRoomStatus(
          auth, ticket.roomId, RoomStatus.AVAILABLE,
          `Maintenance terminée (${id})`, { type: 'maintenance_ticket', id },
        );
      }
    }
    if (body.toStatus === 'RESOLVED') {
      await this.outbox.emit(this.db, {
        organizationId: prop.organizationId, propertyId: ticket.propertyId,
        eventType: DomainEventType.MAINTENANCE_RESOLVED, aggregateType: 'maintenance_ticket',
        aggregateId: id, payload: { title: ticket.title },
      });
    }
    return this.getTicket(auth, id);
  }

  // --- Assets (README §37) ---
  async createAsset(auth: AuthUser, body: any) {
    await this.catalog.getProperty(auth, body.propertyId);
    const id = newId();
    await this.db.insert(S.assets).values({
      id, propertyId: body.propertyId, roomId: body.roomId ?? null, name: body.name,
      category: body.category ?? null, serialNumber: body.serialNumber ?? null,
      manufacturer: body.manufacturer ?? null, purchaseDate: body.purchaseDate ?? null,
      warrantyEnd: body.warrantyEnd ?? null,
    });
    return (await this.db.select().from(S.assets).where(eq(S.assets.id, id)))[0];
  }

  async listAssets(auth: AuthUser, propertyId: string) {
    await this.catalog.getProperty(auth, propertyId);
    return this.db.select().from(S.assets).where(eq(S.assets.propertyId, propertyId));
  }
}

@Controller('api/v1')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MaintenanceController {
  constructor(private readonly svc: MaintenanceService) {}

  @Post('maintenance/tickets')
  @RequirePermission('maintenance.create')
  create(@CurrentUser() auth: AuthUser, @Body() body: any) { return this.svc.createTicket(auth, body); }

  @Get('properties/:propertyId/maintenance/tickets')
  @RequirePermission('maintenance.view')
  list(@CurrentUser() auth: AuthUser, @Param('propertyId') pid: string, @Query('status') status?: string) {
    return this.svc.listTickets(auth, pid, status);
  }

  @Get('maintenance/tickets/:id')
  @RequirePermission('maintenance.view')
  get(@CurrentUser() auth: AuthUser, @Param('id') id: string) { return this.svc.getTicket(auth, id); }

  @Patch('maintenance/tickets/:id')
  @RequirePermission('maintenance.resolve')
  trans(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.svc.transition(auth, id, body);
  }

  @Post('assets')
  @RequirePermission('maintenance.create')
  createAsset(@CurrentUser() auth: AuthUser, @Body() body: any) { return this.svc.createAsset(auth, body); }

  @Get('properties/:propertyId/assets')
  @RequirePermission('maintenance.view')
  listAssets(@CurrentUser() auth: AuthUser, @Param('propertyId') pid: string) { return this.svc.listAssets(auth, pid); }
}

@Module({
  imports: [DatabaseModule, AuditModule, OutboxModule, CatalogModule],
  providers: [MaintenanceService],
  controllers: [MaintenanceController],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
