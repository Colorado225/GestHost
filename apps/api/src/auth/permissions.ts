/**
 * RBAC/ABAC — Catalogue de permissions et rôles système (README §40, §75).
 */

export const PERMISSIONS = [
  // Organisation / propriété
  'organization.manage',
  'property.view', 'property.manage', 'property.delete',
  // Chambres & inventory
  'room.view', 'room.manage', 'room.change_status',
  'room_type.view', 'room_type.manage',
  'rate.view', 'rate.manage', 'rate.override',
  // Clients
  'guest.view', 'guest.create', 'guest.update', 'guest.delete',
  'company.view', 'company.manage', 'agency.view', 'agency.manage',
  // Réservations
  'reservation.view', 'reservation.create', 'reservation.update',
  'reservation.cancel', 'reservation.no_show',
  // Séjours
  'stay.view', 'stay.check_in', 'stay.check_out', 'stay.change_room',
  'stay.extend', 'stay.split', 'stay.checkout_with_balance',
  // Folios & facturation
  'folio.view', 'folio.post_charge', 'folio.void_charge', 'folio.transfer_charge',
  'payment.view', 'payment.record', 'payment.refund',
  'invoice.view', 'invoice.generate', 'invoice.credit_note',
  'discount.apply', 'discount.approve',
  // FNE
  'fne.view', 'fne.submit', 'fne.retry',
  // Housekeeping / maintenance
  'housekeeping.view', 'housekeeping.assign', 'housekeeping.update',
  'maintenance.view', 'maintenance.create', 'maintenance.resolve',
  // Caisse
  'cash.view', 'cash.open_session', 'cash.close_session', 'cash.adjust',
  // Audit & rapports
  'audit.view', 'report.view', 'report.export',
  // Administration
  'user.manage', 'role.manage', 'settings.manage', 'night_audit.run',
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

/** Rôles système globaux (isSystemRole=true), instanciés par organisation. */
export const SYSTEM_ROLES: Record<string, { name: string; permissions: PermissionCode[] }> = {
  SUPER_ADMIN: {
    name: 'Super administrateur',
    permissions: [...PERMISSIONS],
  },
  GENERAL_MANAGER: {
    name: 'Directeur général',
    permissions: PERMISSIONS.filter((p) => p !== 'organization.manage'),
  },
  FRONT_DESK_MANAGER: {
    name: 'Chef de réception',
    permissions: [
      'property.view', 'room.view', 'room.manage', 'room.change_status',
      'room_type.view', 'room_type.manage', 'rate.view', 'rate.manage', 'rate.override',
      'guest.view', 'guest.create', 'guest.update',
      'company.view', 'company.manage', 'agency.view', 'agency.manage',
      'reservation.view', 'reservation.create', 'reservation.update',
      'reservation.cancel', 'reservation.no_show',
      'stay.view', 'stay.check_in', 'stay.check_out', 'stay.change_room',
      'stay.extend', 'stay.split', 'stay.checkout_with_balance',
      'folio.view', 'folio.post_charge', 'folio.void_charge', 'folio.transfer_charge',
      'payment.view', 'payment.record', 'payment.refund',
      'invoice.view', 'invoice.generate', 'invoice.credit_note',
      'discount.apply', 'discount.approve',
      'fne.view', 'fne.submit', 'fne.retry',
      'housekeeping.view', 'housekeeping.assign', 'housekeeping.update',
      'maintenance.view', 'maintenance.create', 'maintenance.resolve',
      'cash.view', 'cash.open_session', 'cash.close_session', 'cash.adjust',
      'audit.view', 'report.view', 'report.export', 'night_audit.run',
      'user.manage',
    ],
  },
  RECEPTIONIST: {
    name: 'Réceptionniste',
    permissions: [
      'property.view', 'room.view', 'room.change_status', 'rate.view',
      'guest.view', 'guest.create', 'guest.update', 'company.view', 'agency.view',
      'reservation.view', 'reservation.create', 'reservation.update', 'reservation.cancel',
      'stay.view', 'stay.check_in', 'stay.check_out', 'stay.change_room',
      'folio.view', 'folio.post_charge',
      'payment.view', 'payment.record',
      'invoice.view',
      'housekeeping.view',
      'cash.view', 'cash.open_session', 'cash.close_session',
      'discount.apply',
    ],
  },
  HOUSEKEEPING: {
    name: 'Gouvernant(e)',
    permissions: ['property.view', 'room.view', 'housekeeping.view', 'housekeeping.update'],
  },
  ACCOUNTANT: {
    name: 'Comptable',
    permissions: [
      'property.view', 'folio.view', 'payment.view', 'invoice.view', 'invoice.generate',
      'invoice.credit_note', 'fne.view', 'report.view', 'report.export', 'audit.view',
    ],
  },
  MAINTENANCE: {
    name: 'Technicien',
    permissions: ['property.view', 'room.view', 'maintenance.view', 'maintenance.resolve', 'housekeeping.view'],
  },
};

/** Limite d'override tarifaire (%) par rôle — rate_override_policy (README §110). */
export const DEFAULT_RATE_OVERRIDE_LIMITS_BPS: Record<string, number> = {
  RECEPTIONIST: 0, // prix standard uniquement
  FRONT_DESK_MANAGER: 1500, // jusqu'à 15 %
  GENERAL_MANAGER: 1000000, // sans limite raisonnable
  SUPER_ADMIN: 1000000,
};
