/**
 * Catalogue : organizations, properties, buildings, floors, room types, rooms,
 * amenities + statuts de chambres (README §8, §9, §10).
 */
import { Body, Controller, Delete, Get, Inject, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import { AuditService } from '../audit/audit';
import { OutboxService } from '../outbox/outbox';
import { AuthModule, AuthorizationService, JwtAuthGuard, RequirePermission } from '../auth/auth';
import type { AuthUser } from '../auth/auth';
import { CurrentUser } from '../common/current-user';
import { NotFoundError, ValidationError, BizError } from '../common/errors';
import { newId, slugify } from '../common/utils';
import { HousekeepingStatus, RoomStatus, FrontOfficeStatus, MaintenanceRoomStatus } from '../common/enums';
import * as S from '../database/schema';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // -- Organizations --------------------------------------------------------

  async createOrganization(auth: AuthUser, body: any) {
    if (!body?.name) throw new ValidationError({ name: 'required' });
    const id = newId();
    await this.db.insert(S.organizations).values({
      id,
      name: body.name,
      legalName: body.legalName ?? null,
      slug: body.slug ? slugify(body.slug) : slugify(body.name),
      defaultCurrency: body.defaultCurrency ?? 'XOF',
      countryCode: body.countryCode ?? 'CI',
      status: 'ACTIVE',
    });
    await this.audit.log({ userId: auth.userId, organizationId: id, action: 'organization.create', resource: 'organization', resourceId: id, after: body });
    return (await this.db.select().from(S.organizations).where(eq(S.organizations.id, id)))[0];
  }

  async listOrganizations(auth: AuthUser) {
    if (auth.isSystemAdmin) return this.db.select().from(S.organizations).where(isNull(S.organizations.deletedAt));
    return this.db.select().from(S.organizations).where(and(eq(S.organizations.id, auth.organizationId), isNull(S.organizations.deletedAt)));
  }

  // -- Properties -----------------------------------------------------------

  async createProperty(auth: AuthUser, body: any) {
    const required = ['organizationId', 'name', 'code'];
    for (const f of required) if (!body?.[f]) throw new ValidationError({ [f]: 'required' });
    const id = newId();
    const today = new Date().toISOString().slice(0, 10);
    await this.db.insert(S.properties).values({
      id,
      organizationId: body.organizationId,
      name: body.name,
      code: body.code,
      slug: slugify(`${body.code}-${body.name}`),
      legalName: body.legalName ?? null,
      rccm: body.rccm ?? null,
      taxIdentifier: body.taxIdentifier ?? null,
      addressLine1: body.addressLine1 ?? null,
      city: body.city ?? null,
      country: body.country ?? 'Côte d\'Ivoire',
      phone: body.phone ?? null,
      email: body.email ?? null,
      timezone: body.timezone ?? 'Africa/Abidjan',
      currency: body.currency ?? 'XOF',
      hotelClassification: body.hotelClassification ?? 'NO_STAR',
      checkInTime: body.checkInTime ?? '14:00',
      checkOutTime: body.checkOutTime ?? '12:00',
      status: body.status ?? 'DRAFT',
      currentBusinessDate: body.currentBusinessDate ?? today,
    });
    await this.audit.log({ userId: auth.userId, organizationId: body.organizationId, propertyId: id, action: 'property.create', resource: 'property', resourceId: id, after: body });
    return (await this.db.select().from(S.properties).where(eq(S.properties.id, id)))[0];
  }

  async listProperties(auth: AuthUser) {
    const conds = [isNull(S.properties.deletedAt)];
    if (!auth.isSystemAdmin) {
      conds.push(eq(S.properties.organizationId, auth.organizationId));
    }
    const rows = await this.db.select().from(S.properties).where(and(...conds));
    // Filtrage ABAC strict : seules les propriétés autorisées (README §75).
    return rows.filter((p) => auth.isSystemAdmin || auth.propertyIds.includes(p.id));
  }

  async getProperty(auth: AuthUser, propertyId: string) {
    const rows = await this.db.select().from(S.properties).where(eq(S.properties.id, propertyId));
    if (!rows[0] || rows[0].deletedAt) throw new NotFoundError('Property', propertyId);
    if (!auth.isSystemAdmin && rows[0].organizationId !== auth.organizationId) throw BizError.tenantMismatch();
    return rows[0];
  }

  async updateProperty(auth: AuthUser, propertyId: string, body: any) {
    const cur = await this.getProperty(auth, propertyId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const allowed = ['name', 'legalName', 'rccm', 'taxIdentifier', 'addressLine1', 'city', 'country', 'phone', 'email', 'website', 'timezone', 'currency', 'hotelClassification', 'starRating', 'checkInTime', 'checkOutTime', 'status', 'logoUrl'];
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    await this.db.update(S.properties).set(patch).where(eq(S.properties.id, propertyId));
    await this.audit.log({ userId: auth.userId, organizationId: cur.organizationId, propertyId, action: 'property.update', resource: 'property', resourceId: propertyId, before: cur, after: patch });
    return this.getProperty(auth, propertyId);
  }

  /** Soft delete (README §77) — refus si réservations actives. */
  async deleteProperty(auth: AuthUser, propertyId: string) {
    const cur = await this.getProperty(auth, propertyId);
    const active = await this.db
      .select({ id: S.reservations.id })
      .from(S.reservations)
      .where(and(eq(S.reservations.propertyId, propertyId), eq(S.reservations.status, 'CHECKED_IN')))
      .limit(1);
    if (active.length) throw new DomainErrorSoftDelete();
    await this.db.update(S.properties).set({ deletedAt: new Date(), status: 'DISABLED' }).where(eq(S.properties.id, propertyId));
    await this.audit.log({ userId: auth.userId, organizationId: cur.organizationId, propertyId, action: 'property.delete', resource: 'property', resourceId: propertyId, severity: 'WARNING' });
    return { ok: true };
  }

  // -- Room types -----------------------------------------------------------

  async createRoomType(auth: AuthUser, propertyId: string, body: any) {
    const p = await this.getProperty(auth, propertyId);
    if (!body?.name || !body?.code) throw new ValidationError({ name: 'required', code: 'required' });
    const id = newId();
    await this.db.insert(S.roomTypes).values({
      id,
      propertyId,
      name: body.name,
      code: body.code,
      description: body.description ?? null,
      capacityAdults: body.capacityAdults ?? 2,
      capacityChildren: body.capacityChildren ?? 0,
      maxOccupancy: body.maxOccupancy ?? 2,
      baseOccupancy: body.baseOccupancy ?? 2,
      bedConfiguration: body.bedConfiguration ?? null,
      defaultRate: body.defaultRate ?? 0,
      currency: p.currency,
      status: 'ACTIVE',
    });
    await this.audit.log({ userId: auth.userId, organizationId: p.organizationId, propertyId, action: 'room_type.create', resource: 'room_type', resourceId: id, after: body });
    return (await this.db.select().from(S.roomTypes).where(eq(S.roomTypes.id, id)))[0];
  }

  async listRoomTypes(auth: AuthUser, propertyId: string) {
    await this.getProperty(auth, propertyId);
    return this.db
      .select()
      .from(S.roomTypes)
      .where(and(eq(S.roomTypes.propertyId, propertyId), isNull(S.roomTypes.deletedAt)))
      .orderBy(asc(S.roomTypes.name));
  }

  async updateRoomType(auth: AuthUser, roomTypeId: string, body: any) {
    const rt = (await this.db.select().from(S.roomTypes).where(eq(S.roomTypes.id, roomTypeId)))[0];
    if (!rt || rt.deletedAt) throw new NotFoundError('RoomType', roomTypeId);
    await this.getProperty(auth, rt.propertyId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['name', 'description', 'capacityAdults', 'capacityChildren', 'maxOccupancy', 'baseOccupancy', 'bedConfiguration', 'defaultRate', 'status']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    await this.db.update(S.roomTypes).set(patch).where(eq(S.roomTypes.id, roomTypeId));
    await this.audit.log({ userId: auth.userId, propertyId: rt.propertyId, action: 'room_type.update', resource: 'room_type', resourceId: roomTypeId, before: rt, after: patch });
    return (await this.db.select().from(S.roomTypes).where(eq(S.roomTypes.id, roomTypeId)))[0];
  }

  async deleteRoomType(auth: AuthUser, roomTypeId: string) {
    const rt = (await this.db.select().from(S.roomTypes).where(eq(S.roomTypes.id, roomTypeId)))[0];
    if (!rt) throw new NotFoundError('RoomType', roomTypeId);
    await this.getProperty(auth, rt.propertyId);
    const inUse = await this.db
      .select({ id: S.rooms.id })
      .from(S.rooms)
      .where(and(eq(S.rooms.roomTypeId, roomTypeId), isNull(S.rooms.deletedAt)))
      .limit(1);
    if (inUse.length) throw new DomainErrorSoftDelete();
    await this.db.update(S.roomTypes).set({ deletedAt: new Date(), status: 'INACTIVE' }).where(eq(S.roomTypes.id, roomTypeId));
    await this.audit.log({ userId: auth.userId, propertyId: rt.propertyId, action: 'room_type.delete', resource: 'room_type', resourceId: roomTypeId, severity: 'WARNING' });
    return { ok: true };
  }

  // -- Rooms ----------------------------------------------------------------

  async createRoom(auth: AuthUser, propertyId: string, body: any) {
    const p = await this.getProperty(auth, propertyId);
    if (!body?.number || !body?.roomTypeId) throw new ValidationError({ number: 'required', roomTypeId: 'required' });
    const rt = (await this.db.select().from(S.roomTypes).where(eq(S.roomTypes.id, body.roomTypeId)))[0];
    if (!rt || rt.propertyId !== propertyId) throw new ValidationError({ roomTypeId: 'unknown_or_other_property' });
    const dup = await this.db
      .select({ id: S.rooms.id })
      .from(S.rooms)
      .where(and(eq(S.rooms.propertyId, propertyId), eq(S.rooms.number, body.number), isNull(S.rooms.deletedAt)))
      .limit(1);
    if (dup.length) throw new ValidationError({ number: 'duplicate_room_number' });
    const id = newId();
    await this.db.insert(S.rooms).values({
      id,
      propertyId,
      buildingId: body.buildingId ?? null,
      floorId: body.floorId ?? null,
      roomTypeId: body.roomTypeId,
      number: body.number,
      code: body.code ?? body.number,
      status: RoomStatus.AVAILABLE,
      housekeepingStatus: HousekeepingStatus.CLEAN,
      frontOfficeStatus: FrontOfficeStatus.VACANT,
      maintenanceStatus: MaintenanceRoomStatus.OK,
      capacity: body.capacity ?? rt.maxOccupancy,
      notes: body.notes ?? null,
    });
    await this.audit.log({ userId: auth.userId, organizationId: p.organizationId, propertyId, action: 'room.create', resource: 'room', resourceId: id, after: body });
    return (await this.db.select().from(S.rooms).where(eq(S.rooms.id, id)))[0];
  }

  async listRooms(auth: AuthUser, propertyId: string, filters?: { status?: string; roomTypeId?: string }) {
    await this.getProperty(auth, propertyId);
    const conds = [eq(S.rooms.propertyId, propertyId), isNull(S.rooms.deletedAt)];
    if (filters?.status) conds.push(eq(S.rooms.status, filters.status));
    if (filters?.roomTypeId) conds.push(eq(S.rooms.roomTypeId, filters.roomTypeId));
    return this.db.select().from(S.rooms).where(and(...conds)).orderBy(asc(S.rooms.number));
  }

  /** Changement de statut chambre avec historique obligatoire (README §10, AC §137). */
  async changeRoomStatus(auth: AuthUser, roomId: string, to: RoomStatus, reason?: string, reference?: { type: string; id: string }) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(S.rooms).where(eq(S.rooms.id, roomId)).for('update');
      const room = rows[0];
      if (!room || room.deletedAt) throw new NotFoundError('Room', roomId);
      const prop = await this.getProperty(auth, room.propertyId);
      const from = room.status as RoomStatus;
      this.assertRoomTransition(from, to);
      const patch: Partial<typeof room> & Record<string, unknown> = { status: to, updatedAt: new Date() };
      if (to === RoomStatus.OCCUPIED) patch.frontOfficeStatus = FrontOfficeStatus.OCCUPIED;
      if (to === RoomStatus.OUT_OF_ORDER) patch.frontOfficeStatus = FrontOfficeStatus.OUT_OF_ORDER;
      if (to === RoomStatus.OUT_OF_SERVICE) patch.frontOfficeStatus = FrontOfficeStatus.OUT_OF_SERVICE;
      if (to === RoomStatus.AVAILABLE) patch.frontOfficeStatus = FrontOfficeStatus.VACANT;
      await tx.update(S.rooms).set(patch as any).where(eq(S.rooms.id, roomId));
      await tx.insert(S.roomStatusHistory).values({
        id: newId(),
        propertyId: room.propertyId,
        roomId,
        previousStatus: from,
        newStatus: to,
        reason: reason ?? null,
        referenceType: reference?.type ?? null,
        referenceId: reference?.id ?? null,
        changedBy: auth.userId,
      });
      await this.audit.log({
        userId: auth.userId,
        organizationId: prop.organizationId,
        propertyId: room.propertyId,
        action: 'room.change_status',
        resource: 'room',
        resourceId: roomId,
        before: { status: from },
        after: { status: to, reason },
      }, tx as unknown as Db);
      await this.outbox.emit(tx as unknown as Db, {
        eventType: 'room.status_changed',
        aggregateType: 'room',
        aggregateId: roomId,
        payload: { from, to, reason },
        propertyId: room.propertyId,
        organizationId: prop.organizationId,
      });
      return (await tx.select().from(S.rooms).where(eq(S.rooms.id, roomId)))[0];
    });
  }

  /** Transitions autorisées (README §38, §68). */
  private assertRoomTransition(from: RoomStatus, to: RoomStatus) {
    const allowed: Record<RoomStatus, RoomStatus[]> = {
      AVAILABLE: [RoomStatus.RESERVED, RoomStatus.OCCUPIED, RoomStatus.BLOCKED, RoomStatus.OUT_OF_ORDER, RoomStatus.OUT_OF_SERVICE],
      RESERVED: [RoomStatus.OCCUPIED, RoomStatus.AVAILABLE, RoomStatus.BLOCKED, RoomStatus.OUT_OF_ORDER, RoomStatus.OUT_OF_SERVICE],
      OCCUPIED: [RoomStatus.AVAILABLE, RoomStatus.OUT_OF_ORDER, RoomStatus.OUT_OF_SERVICE],
      BLOCKED: [RoomStatus.AVAILABLE, RoomStatus.RESERVED, RoomStatus.OUT_OF_ORDER, RoomStatus.OUT_OF_SERVICE],
      OUT_OF_ORDER: [RoomStatus.AVAILABLE, RoomStatus.OUT_OF_SERVICE],
      OUT_OF_SERVICE: [RoomStatus.AVAILABLE, RoomStatus.OUT_OF_ORDER],
    };
    if (from === to) return; // no-op toléré, tracé quand même
    if (!allowed[from].includes(to)) throw BizError.invalidStateTransition('room', from, to);
  }

  async roomStatusHistory(auth: AuthUser, roomId: string) {
    const room = (await this.db.select().from(S.rooms).where(eq(S.rooms.id, roomId)))[0];
    if (!room) throw new NotFoundError('Room', roomId);
    await this.getProperty(auth, room.propertyId);
    return this.db
      .select()
      .from(S.roomStatusHistory)
      .where(eq(S.roomStatusHistory.roomId, roomId))
      .orderBy(asc(S.roomStatusHistory.createdAt));
  }

  // -- Buildings / floors / amenities ---------------------------------------

  async createBuilding(auth: AuthUser, propertyId: string, body: any) {
    await this.getProperty(auth, propertyId);
    const id = newId();
    await this.db.insert(S.buildings).values({ id, propertyId, name: body.name, code: body.code, description: body.description ?? null });
    return (await this.db.select().from(S.buildings).where(eq(S.buildings.id, id)))[0];
  }

  async listBuildings(auth: AuthUser, propertyId: string) {
    await this.getProperty(auth, propertyId);
    return this.db.select().from(S.buildings).where(eq(S.buildings.propertyId, propertyId));
  }

  async createFloor(auth: AuthUser, propertyId: string, body: any) {
    await this.getProperty(auth, propertyId);
    const id = newId();
    await this.db.insert(S.floors).values({ id, propertyId, buildingId: body.buildingId ?? null, name: body.name, number: body.number });
    return (await this.db.select().from(S.floors).where(eq(S.floors.id, id)))[0];
  }

  async listFloors(auth: AuthUser, propertyId: string) {
    await this.getProperty(auth, propertyId);
    return this.db.select().from(S.floors).where(eq(S.floors.propertyId, propertyId)).orderBy(asc(S.floors.number));
  }

  async createAmenity(auth: AuthUser, propertyId: string, body: any) {
    await this.getProperty(auth, propertyId);
    const id = newId();
    await this.db.insert(S.amenities).values({ id, propertyId, name: body.name, code: body.code, description: body.description ?? null });
    return (await this.db.select().from(S.amenities).where(eq(S.amenities.id, id)))[0];
  }

  async listAmenities(auth: AuthUser, propertyId: string) {
    await this.getProperty(auth, propertyId);
    return this.db.select().from(S.amenities).where(eq(S.amenities.propertyId, propertyId));
  }
}

class DomainErrorSoftDelete extends Error {
  readonly status = 409;
  readonly code = 'RESOURCE_IN_USE';
  constructor() {
    super('Impossible de supprimer une ressource utilisée par des données actives.');
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller('v1')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('organizations')
  listOrgs(@CurrentUser() auth: AuthUser) {
    return this.svc.listOrganizations(auth);
  }

  @Post('organizations')
  @RequirePermission('organization.manage')
  createOrg(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.svc.createOrganization(auth, body);
  }

  @Get('properties')
  listProps(@CurrentUser() auth: AuthUser) {
    return this.svc.listProperties(auth);
  }

  @Post('properties')
  @RequirePermission('organization.manage')
  createProp(@CurrentUser() auth: AuthUser, @Body() body: any) {
    return this.svc.createProperty(auth, body);
  }

  @Get('properties/:id')
  getProp(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.svc.getProperty(auth, id);
  }

  @Patch('properties/:id')
  @RequirePermission('property.manage')
  updateProp(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateProperty(auth, id, body);
  }

  @Delete('properties/:id')
  @RequirePermission('property.delete')
  deleteProp(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.svc.deleteProperty(auth, id);
  }

  @Get('properties/:propertyId/room-types')
  listRoomTypes(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listRoomTypes(auth, propertyId);
  }

  @Post('properties/:propertyId/room-types')
  @RequirePermission('room_type.manage')
  createRoomType(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.createRoomType(auth, propertyId, body);
  }

  @Patch('room-types/:id')
  @RequirePermission('room_type.manage')
  updateRoomType(@CurrentUser() auth: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.svc.updateRoomType(auth, id, body);
  }

  @Delete('room-types/:id')
  @RequirePermission('room_type.manage')
  deleteRoomType(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.svc.deleteRoomType(auth, id);
  }

  @Get('properties/:propertyId/rooms')
  listRooms(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Query('status') status?: string, @Query('roomTypeId') roomTypeId?: string) {
    return this.svc.listRooms(auth, propertyId, { status, roomTypeId });
  }

  @Post('properties/:propertyId/rooms')
  @RequirePermission('room.manage')
  createRoom(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.createRoom(auth, propertyId, body);
  }

  @Patch('rooms/:id/status')
  @RequirePermission('room.change_status')
  changeRoomStatus(
    @CurrentUser() auth: AuthUser,
    @Param('id') id: string,
    @Body() body: { status: RoomStatus; reason?: string },
  ) {
    return this.svc.changeRoomStatus(auth, id, body.status, body.reason);
  }

  @Get('rooms/:id/status-history')
  history(@CurrentUser() auth: AuthUser, @Param('id') id: string) {
    return this.svc.roomStatusHistory(auth, id);
  }

  @Post('properties/:propertyId/buildings')
  @RequirePermission('property.manage')
  createBuilding(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.createBuilding(auth, propertyId, body);
  }

  @Get('properties/:propertyId/buildings')
  listBuildings(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listBuildings(auth, propertyId);
  }

  @Post('properties/:propertyId/floors')
  @RequirePermission('property.manage')
  createFloor(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.createFloor(auth, propertyId, body);
  }

  @Get('properties/:propertyId/floors')
  listFloors(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listFloors(auth, propertyId);
  }

  @Post('properties/:propertyId/amenities')
  @RequirePermission('property.manage')
  createAmenity(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string, @Body() body: any) {
    return this.svc.createAmenity(auth, propertyId, body);
  }

  @Get('properties/:propertyId/amenities')
  listAmenities(@CurrentUser() auth: AuthUser, @Param('propertyId') propertyId: string) {
    return this.svc.listAmenities(auth, propertyId);
  }
}

@Module({
  imports: [AuthModule],
  providers: [CatalogService, AuditService, OutboxService, DatabaseService, { provide: DB, useExisting: DatabaseService }],
  controllers: [CatalogController],
  exports: [CatalogService],
})
export class CatalogModule {}
