/**
 * Seed de démonstration (README §61 : npm run db:seed).
 * Idempotent : saute si l'organisation demo existe déjà.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { env } from '../common/env';
import { newId } from '../common/utils';
import { PERMISSIONS, SYSTEM_ROLES } from '../auth/permissions';

async function main() {
  const pool = new Pool({ connectionString: env().DATABASE_URL });
  const db = drizzle(pool, { schema });
  const { organizations, properties, roomTypes, rooms, guests, users, roles, permissions, rolePermissions, userRoles, ratePlans, ratePlanPrices, cancellationPolicies, taxRules, inventoryCapacity } = schema;

  const existing = await db.select().from(organizations).where(eq(organizations.slug, 'demo'));
  if (existing.length) {
    console.log('✔ seed déjà appliqué (organisation "demo" existe)');
    await pool.end();
    return;
  }

  console.log('→ seed organisation démo…');
  const orgId = newId();
  await db.insert(organizations).values({ id: orgId, name: 'GestHost Démo', slug: 'demo', status: 'ACTIVE' });

  // Permissions + rôles système
  const permIds: Record<string, string> = {};
  for (const code of PERMISSIONS) {
    const [resource, ...rest] = code.split('.');
    const id = newId();
    permIds[code] = id;
    await db.insert(permissions).values({ id, resource, action: rest.join('.'), description: code });
  }
  const roleIds: Record<string, string> = {};
  for (const [code, def] of Object.entries(SYSTEM_ROLES)) {
    const id = newId();
    roleIds[code] = id;
    await db.insert(roles).values({ id, organizationId: orgId, name: def.name, code, isSystemRole: true });
    for (const p of def.permissions) {
      await db.insert(rolePermissions).values({ roleId: id, permissionId: permIds[p] });
    }
  }

  // Utilisateurs démo
  const hash = await bcrypt.hash('Demo@2025', 10);
  const mkUser = async (first: string, last: string, email: string, roleCode: string) => {
    const id = newId();
    await db.insert(users).values({
      id, organizationId: orgId, firstName: first, lastName: last,
      email, username: email.split('@')[0], passwordHash: hash, status: 'ACTIVE',
    });
    await db.insert(userRoles).values({ userId: id, roleId: roleIds[roleCode] });
    return id;
  };
  await mkUser('Awa', 'Traore', 'admin@gesthost.dev', 'SUPER_ADMIN');
  await mkUser('Kofi', 'Mensah', 'reception@gesthost.dev', 'FRONT_DESK_MANAGER');
  await mkUser('Fatou', 'Diop', 'housekeeping@gesthost.dev', 'HOUSEKEEPING');

  // Propriété démo
  const propId = newId();
  const todayIso = new Date().toISOString().slice(0, 10);
  await db.insert(properties).values({
    id: propId, organizationId: orgId, name: 'Hôtel Azur Abidjan', code: 'AZUR',
    slug: 'hotel-azur-abidjan', city: 'Abidjan', hotelClassification: 'FOUR_STAR',
    starRating: 4, status: 'ACTIVE', phone: '+225 27 20 30 40 50',
    email: 'contact@hotelazur.ci', addressLine1: 'Bd de la Corniche, Cocody',
    currentBusinessDate: todayIso,
  });

  // Types de chambres
  const types = [
    { code: 'STD', name: 'Standard', rate: 25000, cap: 2 },
    { code: 'SUP', name: 'Supérieure', rate: 40000, cap: 2 },
    { code: 'DEL', name: 'Deluxe', rate: 65000, cap: 3 },
    { code: 'SUI', name: 'Suite', rate: 120000, cap: 4 },
  ];
  const typeIds: Record<string, string> = {};
  for (const t of types) {
    const id = newId();
    typeIds[t.code] = id;
    await db.insert(roomTypes).values({
      id, propertyId: propId, code: t.code, name: t.name,
      capacityAdults: t.cap, maxOccupancy: t.cap, baseOccupancy: Math.min(2, t.cap),
      defaultRate: t.rate, currency: 'XOF',
    });
  }

  // Chambres physiques
  let roomNo = 100;
  for (const t of types) {
    const count = t.code === 'SUI' ? 2 : t.code === 'DEL' ? 4 : 8;
    for (let i = 0; i < count; i++) {
      roomNo += 1;
      await db.insert(rooms).values({
        id: newId(), propertyId: propId, roomTypeId: typeIds[t.code],
        number: String(roomNo), code: `R${roomNo}`, status: 'AVAILABLE',
      });
    }
  }

  // Politique d'annulation + rate plans + prix
  const polId = newId();
  await db.insert(cancellationPolicies).values({
    id: polId, propertyId: propId, name: 'Standard 24h', deadlineHours: 24, penaltyType: 'FIRST_NIGHT',
  });
  for (const rp of [
    { code: 'BAR', name: 'Meilleur tarif public', refundable: true },
    { code: 'NON_REFUNDABLE', name: 'Non remboursable', refundable: false },
    { code: 'CORPORATE', name: 'Entreprise', refundable: true },
  ]) {
    const rpId = newId();
    await db.insert(ratePlans).values({
      id: rpId, propertyId: propId, code: rp.code, name: rp.name,
      cancellationPolicyId: polId, isRefundable: rp.refundable,
    });
    for (const t of types) {
      const uplift = rp.code === 'NON_REFUNDABLE' ? 0.9 : rp.code === 'CORPORATE' ? 0.85 : 1;
      await db.insert(ratePlanPrices).values({
        id: newId(), propertyId: propId, ratePlanId: rpId, roomTypeId: typeIds[t.code],
        validFrom: '2025-01-01', validTo: '2027-12-31', occupancy: Math.min(2, t.cap),
        amount: Math.round(t.rate * uplift), currency: 'XOF',
      });
    }
  }

  // Taxes (CI : TVA 18% sur hébergement + taxe communale de nuitée)
  await db.insert(taxRules).values([
    { id: newId(), propertyId: propId, name: 'TVA Hébergement', code: 'TVA', taxType: 'VAT', calculationMethod: 'PERCENTAGE', rateBasisPoints: 1800, appliesTo: 'ROOM', effectiveFrom: '2025-01-01' },
    { id: newId(), propertyId: propId, name: 'Taxe Communale de Nuitée', code: 'TCN', taxType: 'CITY_TAX', calculationMethod: 'FIXED_PER_UNIT', fixedAmount: 500, appliesTo: 'ROOM', effectiveFrom: '2025-01-01' },
  ]);

  // Clients démo
  await db.insert(guests).values([
    { id: newId(), propertyId: propId, guestCode: 'G-0001', firstName: 'Jean', lastName: 'Kouassi', displayName: 'Jean Kouassi', gender: 'M', phone: '+225 07 01 02 03', email: 'jean.kouassi@example.ci', country: 'Côte d\'Ivoire' },
    { id: newId(), propertyId: propId, guestCode: 'G-0002', firstName: 'Aminata', lastName: 'Koné', displayName: 'Aminata Koné', gender: 'F', phone: '+225 05 11 22 33', email: 'aminata.kone@example.ci', vipLevel: 2 },
    { id: newId(), propertyId: propId, guestCode: 'G-0003', firstName: 'Pierre', lastName: 'Dupont', displayName: 'Pierre Dupont', nationality: 'France', phone: '+33 6 12 34 56 78' },
  ]);

  // Capacité inventaire pour les 120 prochains jours
  const today = new Date();
  for (const t of types) {
    const physical = t.code === 'SUI' ? 2 : t.code === 'DEL' ? 4 : 8;
    for (let d = 0; d < 120; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() + d);
      const iso = date.toISOString().slice(0, 10);
      await db.insert(inventoryCapacity).values({
        id: newId(), propertyId: propId, roomTypeId: typeIds[t.code], stayDate: iso,
        sellableRooms: physical, soldRooms: 0, blockedRooms: 0,
      }).onConflictDoNothing();
    }
  }

  console.log('✔ seed terminé — login: admin@gesthost.dev / Demo@2025');
  await pool.end();
}

main().catch((e) => {
  console.error('Échec seed:', e.message ?? e);
  process.exit(1);
});
