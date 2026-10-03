/**
 * Authentification (README §39, §74) : JWT access+refresh, bcrypt, verrouillage
 * après échecs répétés, audit de login.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthController } from './auth.controller';
import * as bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { DB, DatabaseService } from '../database/database.module';
import type { Db } from '../database/database.module';
import {
  auditLogs,
  permissions,
  rolePermissions,
  roles,
  userProperties,
  userRoles,
  users,
} from '../database/schema';
import { env } from '../common/env';
import { UnauthorizedError, BizError, ForbiddenError, ValidationError } from '../common/errors';
import { newId } from '../common/utils';
import { PERMISSIONS, PermissionCode } from './permissions';

export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  name: string;
  isSystemAdmin: boolean;
  /** Propriétés accessibles (scope ABAC). */
  propertyIds: string[];
  /** Permissions effectives (rôles système + custom). */
  permissions: string[];
  roleCodes: string[];
}

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly jwt = new JwtService({ secret: env().JWT_SECRET });

  constructor(@Inject(DB) private readonly db: Db) {}

  async login(email: string, password: string, ip?: string, userAgent?: string) {
    const rows = await this.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      await this.auditFailure(ip, userAgent, email, 'unknown_user');
      throw new UnauthorizedError('Identifiants invalides');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw BizError.accountLocked();
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.db
        .update(users)
        .set({
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      await this.auditFailure(ip, userAgent, email, lock ? 'locked' : 'bad_password');
      if (lock) throw BizError.accountLocked();
      throw new UnauthorizedError('Identifiants invalides');
    }

    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const authUser = await this.buildAuthUser(user.id);
    const tokenPayload = { sub: user.id, org: user.organizationId };
    const accessToken = await this.jwt.signAsync({ ...tokenPayload, typ: 'access' }, { expiresIn: env().JWT_EXPIRES_IN });
    const refreshToken = await this.jwt.signAsync({ ...tokenPayload, typ: 'refresh', jti: newId() }, { expiresIn: '7d' });

    await this.writeAudit(user.organizationId, null, user.id, 'auth.login', 'auth', user.id, ip, userAgent);
    return { accessToken, refreshToken, user: authUser };
  }

  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedError('Refresh token invalide');
    }
    if (payload.typ !== 'refresh') throw new UnauthorizedError('Type de token invalide');
    const authUser = await this.buildAuthUser(payload.sub);
    if (!authUser) throw new UnauthorizedError('Compte inactive');
    const accessToken = await this.jwt.signAsync(
      { sub: payload.sub, org: payload.org, typ: 'access' },
      { expiresIn: env().JWT_EXPIRES_IN },
    );
    return { accessToken };
  }

  async buildAuthUser(userId: string): Promise<AuthUser> {
    const u = (await this.db.select().from(users).where(eq(users.id, userId)))[0];
    if (!u || u.status !== 'ACTIVE' || u.deletedAt) throw new UnauthorizedError();

    // Rôles -> permissions
    const ur = await this.db
      .select({ roleId: userRoles.roleId, propertyId: userRoles.propertyId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    const roleIds = ur.map((r) => r.roleId);
    let perms: string[] = [];
    const roleCodes: string[] = [];
    if (roleIds.length) {
      const rs = await this.db
        .select()
        .from(roles)
        .where(and(...roleIds.map((id) => eq(roles.id, id))));
      const byId = new Map(rs.map((r) => [r.id, r]));
      roleIds.forEach((id) => {
        const r = byId.get(id);
        if (r) roleCodes.push(r.code);
      });
      const rp = await this.db
        .select({ permissionId: rolePermissions.permissionId })
        .from(rolePermissions)
        .where(and(...roleIds.map((id) => eq(rolePermissions.roleId, id))));
      const permIds = [...new Set(rp.map((x) => x.permissionId))];
      if (permIds.length) {
        const ps = await this.db
          .select({ resource: permissions.resource, action: permissions.action })
          .from(permissions)
          .where(and(...permIds.map((id) => eq(permissions.id, id))));
        perms = ps.map((p) => `${p.resource}.${p.action}`);
      }
    }
    if (u.isSystemAdmin) perms = [...PERMISSIONS];

    const ups = await this.db
      .select({ propertyId: userProperties.propertyId })
      .from(userProperties)
      .where(eq(userProperties.userId, userId));

    return {
      userId: u.id,
      organizationId: u.organizationId,
      email: u.email,
      name: `${u.firstName} ${u.lastName}`,
      isSystemAdmin: u.isSystemAdmin,
      propertyIds: ups.map((x) => x.propertyId),
      permissions: [...new Set(perms)],
      roleCodes,
    };
  }

  private async auditFailure(ip?: string, ua?: string, email?: string, reason?: string) {
    // Audit des échecs de login sans exposer le mot de passe (README §41).
    await this.writeAuditRaw(null, null, null, 'auth.login_failed', 'auth', email ?? '-', ip, ua, { reason });
  }

  private async writeAudit(
    orgId: string | null, propId: string | null, userId: string | null,
    action: string, resource: string, resourceId: string,
    ip?: string, ua?: string,
  ) {
    await this.writeAuditRaw(orgId, propId, userId, action, resource, resourceId, ip, ua, null);
  }

  private async writeAuditRaw(
    orgId: string | null, propId: string | null, userId: string | null,
    action: string, resource: string, resourceId: string,
    ip?: string, ua?: string, after: unknown = null,
  ) {
    await this.db.insert(auditLogs).values({
      id: newId(),
      organizationId: orgId,
      propertyId: propId,
      userId,
      action,
      resource,
      resourceId,
      afterData: after as any,
      severity: 'INFO',
      ipAddress: ip ?? null as any,
      userAgent: ua ?? null as any,
    });
  }
}

// ---------------------------------------------------------------------------
// Guards & decorators
// ---------------------------------------------------------------------------

export const REQUIRE_PERMISSIONS_KEY = 'gesthost:required-permissions';
export const RequirePermission = (...perms: PermissionCode[]) =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, perms);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new UnauthorizedError('Token invalide ou expiré');
    }
    if (payload.typ !== 'access') throw new UnauthorizedError('Type de token invalide');
    const authz: AuthorizationService = (ctx.switchToHttp() as any).getApplication().get(AuthorizationService);
    req.auth = await authz.load(payload.sub);
    return true;
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly authz: AuthorizationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSIONS_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];
    if (!required.length) return true;
    const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthUser }>();
    const auth = req.auth;
    if (!auth) throw new UnauthorizedError();
    for (const p of required) {
      if (!this.authz.has(auth, p as PermissionCode)) throw new ForbiddenError(p);
    }
    return true;
  }
}

/** Résolution des permissions + contrôle ABAC tenant (README §75, AC §138). */
@Injectable()
export class AuthorizationService {
  private cache = new Map<string, { at: number; auth: AuthUser }>();

  constructor(private readonly authService: AuthService) {}

  async load(userId: string): Promise<AuthUser> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 30_000) return hit.auth;
    const auth = await this.authService.buildAuthUser(userId);
    this.cache.set(userId, { at: Date.now(), auth });
    return auth;
  }

  has(auth: AuthUser, perm: PermissionCode): boolean {
    return auth.permissions.includes(perm);
  }

  assertPropertyScope(auth: AuthUser, propertyId: string) {
    if (auth.isSystemAdmin) return;
    if (!auth.propertyIds.includes(propertyId)) throw BizError.tenantMismatch();
  }

  assertOrganizationScope(auth: AuthUser, organizationId: string) {
    if (auth.isSystemAdmin) return;
    if (auth.organizationId !== organizationId) throw BizError.tenantMismatch();
  }
}

@Module({
  providers: [
    AuthService,
    AuthorizationService,
    JwtService,
    JwtAuthGuard,
    PermissionGuard,
    DatabaseService,
    { provide: DB, useExisting: DatabaseService },
  ],
  controllers: [AuthController],
  exports: [AuthService, AuthorizationService, JwtAuthGuard, PermissionGuard, JwtService],
})
export class AuthModule {}

export function validateLoginDto(body: any) {
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw new ValidationError({ fields: ['email', 'password'] }, 'email et password requis');
  }
  return { email: body.email.trim().toLowerCase(), password: body.password };
}
