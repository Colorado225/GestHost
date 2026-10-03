/**
 * GestHost PMS — Schéma Drizzle (source de vérité : PostgreSQL).
 *
 * Conventions non négociables (README §6) :
 *  - Argent : BIGINT en unités XOF entières (jamais de float). `currency_code` présent partout.
 *  - Dates techniques en UTC (timestamptz). Dates hôtelières : DATE (business_date).
 *  - Multi-tenancy : property_id/organization_id sur toutes les entités opérationnelles,
 *    indexés, et vérifiés côté service (jamais confiance au client).
 *  - Soft delete sur les données maîtres uniquement (deleted_at).
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Colonne "argent" : BIGINT en unités minimales de devise (FCFA entiers). */
export const money = (name: string) =>
  bigint(name, { mode: 'number' }).notNull().default(0);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

// ---------------------------------------------------------------------------
// #8 — Organizations / Properties
// ---------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  slug: text('slug').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  defaultCurrency: text('default_currency').notNull().default('XOF'),
  countryCode: text('country_code').notNull().default('CI'),
  // Subscription-ready (README §129) — facturation SaaS non construite au V1.
  planCode: text('plan_code').notNull().default('FREE'),
  subscriptionStatus: text('subscription_status').notNull().default('TRIAL'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  uqSlug: uniqueIndex('uq_organizations_slug').on(t.slug),
}));

export const properties = pgTable('properties', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  code: text('code').notNull(),
  slug: text('slug').notNull(),
  legalName: text('legal_name'),
  rccm: text('rccm'),
  taxIdentifier: text('tax_identifier'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  region: text('region'),
  district: text('district'),
  postalCode: text('postal_code'),
  country: text('country').notNull().default('Côte d\'Ivoire'),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  timezone: text('timezone').notNull().default('Africa/Abidjan'),
  currency: text('currency').notNull().default('XOF'),
  hotelClassification: text('hotel_classification').notNull().default('NO_STAR'),
  starRating: integer('star_rating').notNull().default(0),
  checkInTime: text('check_in_time').notNull().default('14:00'),
  checkOutTime: text('check_out_time').notNull().default('12:00'),
  status: text('status').notNull().default('DRAFT'),
  logoUrl: text('logo_url'),
  /** Business date courante (README §105) — contrôlée par le Night Audit. */
  currentBusinessDate: date('current_business_date').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  uqOrgCode: uniqueIndex('uq_properties_org_code').on(t.organizationId, t.code),
  uqSlug: uniqueIndex('uq_properties_slug').on(t.slug),
}));

/** Clé/valeur typé (README §8.3) — les paramètres CRITIQUES ont des tables dédiées. */
export const propertySettings = pgTable('property_settings', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  key: text('key').notNull(),
  value: text('value').notNull(),
  valueType: text('value_type').notNull().default('STRING'), // STRING|NUMBER|BOOLEAN|JSON|DATE
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqKey: uniqueIndex('uq_property_settings_key').on(t.propertyId, t.key),
}));

// ---------------------------------------------------------------------------
// #9 — Structure physique
// ---------------------------------------------------------------------------

export const buildings = pgTable('buildings', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  code: text('code').notNull(),
  description: text('description'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqCode: uniqueIndex('uq_buildings_code').on(t.propertyId, t.code),
}));

export const floors = pgTable('floors', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  buildingId: text('building_id').references(() => buildings.id),
  name: text('name').notNull(),
  number: integer('number').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_floors_number').on(t.propertyId, t.buildingId, t.number),
}));

export const amenities = pgTable('amenities', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  code: text('code').notNull(),
  description: text('description'),
  createdAt: createdAt(),
}, (t) => ({
  uqCode: uniqueIndex('uq_amenities_code').on(t.propertyId, t.code),
}));

export const roomTypes = pgTable('room_types', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  code: text('code').notNull(),
  description: text('description'),
  shortDescription: text('short_description'),
  capacityAdults: integer('capacity_adults').notNull().default(2),
  capacityChildren: integer('capacity_children').notNull().default(0),
  maxOccupancy: integer('max_occupancy').notNull().default(2),
  baseOccupancy: integer('base_occupancy').notNull().default(2),
  bedConfiguration: text('bed_configuration'),
  surfaceArea: integer('surface_area'), // m² x100 (évite le float)
  defaultRate: money('default_rate'),
  currency: text('currency').notNull().default('XOF'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  uqCode: uniqueIndex('uq_room_types_code').on(t.propertyId, t.code),
  idxProperty: index('idx_room_types_property').on(t.propertyId, t.status),
}));

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  buildingId: text('building_id').references(() => buildings.id),
  floorId: text('floor_id').references(() => floors.id),
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  number: text('number').notNull(),
  code: text('code').notNull(),
  status: text('status').notNull().default('AVAILABLE'), // RoomStatus
  housekeepingStatus: text('housekeeping_status').notNull().default('CLEAN'),
  frontOfficeStatus: text('front_office_status').notNull().default('VACANT'),
  maintenanceStatus: text('maintenance_status').notNull().default('OK'),
  floorLocation: text('floor_location'),
  capacity: integer('capacity').notNull().default(2),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_rooms_number').on(t.propertyId, t.number),
  idxPropertyStatus: index('idx_rooms_property_status').on(t.propertyId, t.status),
  idxPropertyType: index('idx_rooms_property_type').on(t.propertyId, t.roomTypeId),
}));

export const roomAmenities = pgTable('room_amenities', {
  roomId: text('room_id').notNull().references(() => rooms.id),
  amenityId: text('amenity_id').notNull().references(() => amenities.id),
}, (t) => ({
  pk: uniqueIndex('pk_room_amenities').on(t.roomId, t.amenityId),
}));

export const roomTypeAmenities = pgTable('room_type_amenities', {
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  amenityId: text('amenity_id').notNull().references(() => amenities.id),
}, (t) => ({
  pk: uniqueIndex('pk_room_type_amenities').on(t.roomTypeId, t.amenityId),
}));

// ---------------------------------------------------------------------------
// #10 — Historique des statuts de chambres
// ---------------------------------------------------------------------------

export const roomStatusHistory = pgTable('room_status_history', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  roomId: text('room_id').notNull().references(() => rooms.id),
  previousStatus: text('previous_status').notNull(),
  newStatus: text('new_status').notNull(),
  reason: text('reason'),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  changedBy: text('changed_by'),
  createdAt: createdAt(),
}, (t) => ({
  idxRoom: index('idx_room_status_history_room').on(t.roomId, t.createdAt),
}));

// ---------------------------------------------------------------------------
// #11/#12 — Tarification & politiques
// ---------------------------------------------------------------------------

export const cancellationPolicies = pgTable('cancellation_policies', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  description: text('description'),
  deadlineHours: integer('deadline_hours').notNull().default(24),
  penaltyType: text('penalty_type').notNull().default('FIRST_NIGHT'),
  penaltyValue: money('penalty_value'),
  noShowPenaltyType: text('no_show_penalty_type').notNull().default('FIRST_NIGHT'),
  noShowPenaltyValue: money('no_show_penalty_value'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxProperty: index('idx_cancellation_policies_property').on(t.propertyId),
}));

export const ratePlans = pgTable('rate_plans', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  code: text('code').notNull(), // BAR, CORPORATE, AGENCY, NON_REFUNDABLE, PROMO, LONG_STAY
  description: text('description'),
  mealPlan: text('meal_plan').notNull().default('RO'),
  cancellationPolicyId: text('cancellation_policy_id').references(() => cancellationPolicies.id),
  paymentPolicy: text('payment_policy').notNull().default('AT_CHECKOUT'), // AT_CHECKOUT|PREPAID|DEPOSIT
  depositPercentage: integer('deposit_percentage').notNull().default(0),
  isRefundable: boolean('is_refundable').notNull().default(true),
  isPublic: boolean('is_public').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqCode: uniqueIndex('uq_rate_plans_code').on(t.propertyId, t.code),
}));

export const seasons = pgTable('seasons', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  priority: integer('priority').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => ({
  idxProperty: index('idx_seasons_property').on(t.propertyId, t.isActive),
}));

export const ratePlanPrices = pgTable('rate_plan_prices', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  ratePlanId: text('rate_plan_id').notNull().references(() => ratePlans.id),
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  seasonId: text('season_id').references(() => seasons.id),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to').notNull(),
  occupancy: integer('occupancy').notNull().default(1),
  amount: money('amount'),
  currency: text('currency').notNull().default('XOF'),
  minimumNights: integer('minimum_nights').notNull().default(1),
  maximumNights: integer('maximum_nights'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxLookup: index('idx_rate_plan_prices_lookup')
    .on(t.ratePlanId, t.roomTypeId, t.validFrom, t.validTo),
}));

// ---------------------------------------------------------------------------
// #13–#17 — Clients, documents, préférences, entreprises, agences
// ---------------------------------------------------------------------------

export const companies = pgTable('companies', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  rccm: text('rccm'),
  taxIdentifier: text('tax_identifier'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  city: text('city'),
  country: text('country'),
  contactPerson: text('contact_person'),
  paymentTerms: integer('payment_terms').notNull().default(0), // jours
  creditLimit: money('credit_limit'),
  status: text('status').notNull().default('ACTIVE'),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  idxName: index('idx_companies_name').on(t.propertyId, t.name),
}));

export const agencies = pgTable('agencies', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  registrationNumber: text('registration_number'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  commissionType: text('commission_type').notNull().default('PERCENTAGE'), // PERCENTAGE|FIXED
  commissionValue: money('commission_value'),
  paymentTerms: integer('payment_terms').notNull().default(0),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  idxName: index('idx_agencies_name').on(t.propertyId, t.name),
}));

export const guests = pgTable('guests', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  guestCode: text('guest_code').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  middleName: text('middle_name'),
  displayName: text('display_name').notNull(),
  gender: text('gender'), // M|F|OTHER
  dateOfBirth: date('date_of_birth'),
  nationality: text('nationality'),
  country: text('country'),
  phone: text('phone'),
  secondaryPhone: text('secondary_phone'),
  email: text('email'),
  address: text('address'),
  city: text('city'),
  region: text('region'),
  companyId: text('company_id').references(() => companies.id),
  vipLevel: integer('vip_level').notNull().default(0),
  notes: text('notes'),
  marketingConsent: boolean('marketing_consent').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  uqCode: uniqueIndex('uq_guests_code').on(t.propertyId, t.guestCode),
  idxPhone: index('idx_guests_phone').on(t.propertyId, t.phone),
  idxEmail: index('idx_guests_email').on(t.propertyId, t.email),
  idxName: index('idx_guests_name').on(t.propertyId, t.lastName, t.firstName),
}));

/** Numéros de documents = données sensibles : masquage partiel à la lecture (README §14). */
export const guestDocuments = pgTable('guest_documents', {
  id: text('id').primaryKey(),
  guestId: text('guest_id').notNull().references(() => guests.id),
  documentType: text('document_type').notNull(), // CNI|PASSPORT|DRIVER_LICENSE|RESIDENCE_PERMIT
  documentNumber: text('document_number').notNull(),
  issuingCountry: text('issuing_country'),
  issueDate: date('issue_date'),
  expiryDate: date('expiry_date'),
  fileUrl: text('file_url'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxGuest: index('idx_guest_documents_guest').on(t.guestId),
}));

export const guestPreferences = pgTable('guest_preferences', {
  id: text('id').primaryKey(),
  guestId: text('guest_id').notNull().references(() => guests.id),
  preferenceType: text('preference_type').notNull(), // ROOM_FLOOR|BED|DIET|PILLOW|QUIET_ROOM|SMOKING
  preferenceValue: text('preference_value').notNull(),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxGuest: index('idx_guest_preferences_guest').on(t.guestId),
}));

// ---------------------------------------------------------------------------
// #18–#20 — Réservations
// ---------------------------------------------------------------------------

export const reservations = pgTable('reservations', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  reservationNumber: text('reservation_number').notNull(),
  source: text('source').notNull().default('DIRECT'),
  channel: text('channel'), // Booking/Expedia/... futur channel manager (README §124)
  status: text('status').notNull().default('DRAFT'),
  guestId: text('guest_id').references(() => guests.id),
  companyId: text('company_id').references(() => companies.id),
  agencyId: text('agency_id').references(() => agencies.id),
  arrivalDate: date('arrival_date').notNull(),
  departureDate: date('departure_date').notNull(),
  nights: integer('nights').notNull(),
  adults: integer('adults').notNull().default(1),
  children: integer('children').notNull().default(0),
  infants: integer('infants').notNull().default(0),
  currency: text('currency').notNull().default('XOF'),
  subtotal: money('subtotal'),
  discountAmount: money('discount_amount'),
  taxAmount: money('tax_amount'),
  totalAmount: money('total_amount'),
  depositRequired: money('deposit_required'),
  depositAmount: money('deposit_amount'),
  depositDueDate: date('deposit_due_date'),
  specialRequests: text('special_requests'),
  internalNotes: text('internal_notes'),
  externalReference: text('external_reference'),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancellationReason: text('cancellation_reason'),
  noShowAt: timestamp('no_show_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_reservations_number').on(t.propertyId, t.reservationNumber),
  idxArrival: index('idx_reservations_property_arrival').on(t.propertyId, t.arrivalDate),
  idxDeparture: index('idx_reservations_property_departure').on(t.propertyId, t.departureDate),
  idxStatus: index('idx_reservations_property_status').on(t.propertyId, t.status),
  idxGuest: index('idx_reservations_guest').on(t.guestId),
}));

/** Une réservation peut réserver un room_type sans chambre physique assignée (README §19). */
export const reservationRooms = pgTable('reservation_rooms', {
  id: text('id').primaryKey(),
  reservationId: text('reservation_id').notNull().references(() => reservations.id),
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  roomId: text('room_id').references(() => rooms.id),
  ratePlanId: text('rate_plan_id').notNull().references(() => ratePlans.id),
  adults: integer('adults').notNull().default(1),
  children: integer('children').notNull().default(0),
  arrivalDate: date('arrival_date').notNull(),
  departureDate: date('departure_date').notNull(),
  numberOfNights: integer('number_of_nights').notNull(),
  baseAmount: money('base_amount'),
  discountAmount: money('discount_amount'),
  discountReason: text('discount_reason'),
  discountApprovedBy: text('discount_approved_by'),
  taxAmount: money('tax_amount'),
  totalAmount: money('total_amount'),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE|CANCELLED
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxTypeDates: index('idx_reservation_rooms_availability')
    .on(t.roomTypeId, t.arrivalDate, t.departureDate),
  idxRoomDates: index('idx_reservation_rooms_room_dates')
    .on(t.roomId, t.arrivalDate, t.departureDate),
  idxReservation: index('idx_reservation_rooms_reservation').on(t.reservationId),
}));

export const reservationGuests = pgTable('reservation_guests', {
  id: text('id').primaryKey(),
  reservationId: text('reservation_id').notNull().references(() => reservations.id),
  guestId: text('guest_id').notNull().references(() => guests.id),
  role: text('role').notNull().default('PRIMARY'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: createdAt(),
}, (t) => ({
  uqGuest: uniqueIndex('uq_reservation_guests').on(t.reservationId, t.guestId),
}));

/**
 * Verrou d'inventaire anti double-réservation (README §45, §71, AC §134).
 * Pour chaque nuit réservée : ligne unique (room_type, date, réservation).
 * La capacité est verrouillée via SELECT ... FOR UPDATE sur la ligne
 * d'inventaire (inventory_capacity) puis contrôle INSERT.
 */
export const inventoryLocks = pgTable('inventory_locks', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  stayDate: date('stay_date').notNull(),
  reservationId: text('reservation_id').notNull().references(() => reservations.id),
  quantity: integer('quantity').notNull().default(1),
  createdAt: createdAt(),
}, (t) => ({
  uqLock: uniqueIndex('uq_inventory_locks').on(t.roomTypeId, t.stayDate, t.reservationId),
  idxTypeDate: index('idx_inventory_locks_type_date').on(t.roomTypeId, t.stayDate),
}));

/** Ligne d'inventaire vendable par (type, date) — verrouillée FOR UPDATE lors du booking. */
export const inventoryCapacity = pgTable('inventory_capacity', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  stayDate: date('stay_date').notNull(),
  sellableRooms: integer('sellable_rooms').notNull().default(0),
  soldRooms: integer('sold_rooms').notNull().default(0),
  blockedRooms: integer('blocked_rooms').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqCell: uniqueIndex('uq_inventory_capacity_cell').on(t.roomTypeId, t.stayDate),
}));

// ---------------------------------------------------------------------------
// #21/#22 — Séjours
// ---------------------------------------------------------------------------

export const stays = pgTable('stays', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  stayNumber: text('stay_number').notNull(),
  reservationId: text('reservation_id').notNull().references(() => reservations.id),
  primaryGuestId: text('primary_guest_id').references(() => guests.id),
  status: text('status').notNull().default('EXPECTED'),
  actualCheckInAt: timestamp('actual_check_in_at', { withTimezone: true }),
  actualCheckOutAt: timestamp('actual_check_out_at', { withTimezone: true }),
  plannedCheckIn: date('planned_check_in').notNull(),
  plannedCheckOut: date('planned_check_out').notNull(),
  assignedBy: text('assigned_by'),
  checkedInBy: text('checked_in_by'),
  checkedOutBy: text('checked_out_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_stays_number').on(t.propertyId, t.stayNumber),
  idxReservation: index('idx_stays_reservation').on(t.reservationId),
  idxStatus: index('idx_stays_property_status').on(t.propertyId, t.status),
}));

/** Permet changement de chambre / upgrade / historique (README §22). */
export const stayRooms = pgTable('stay_rooms', {
  id: text('id').primaryKey(),
  stayId: text('stay_id').notNull().references(() => stays.id),
  roomId: text('room_id').notNull().references(() => rooms.id),
  roomTypeId: text('room_type_id').notNull().references(() => roomTypes.id),
  arrivalDate: date('arrival_date').notNull(),
  departureDate: date('departure_date').notNull(),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: text('assigned_by'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  idxStay: index('idx_stay_rooms_stay').on(t.stayId),
  idxRoomActive: index('idx_stay_rooms_room_active').on(t.roomId, t.releasedAt),
}));

// ---------------------------------------------------------------------------
// #23–#27 — Folios, charges, paiements, remboursements
// ---------------------------------------------------------------------------

export const folios = pgTable('folios', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  folioNumber: text('folio_number').notNull(),
  stayId: text('stay_id').notNull().references(() => stays.id),
  guestId: text('guest_id').references(() => guests.id),
  companyId: text('company_id').references(() => companies.id),
  status: text('status').notNull().default('OPEN'),
  currency: text('currency').notNull().default('XOF'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** Solde recalculé depuis folio_items/paiements (source de vérité, README §107). */
  balance: money('balance'),
  creditLimit: money('credit_limit'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_folios_number').on(t.propertyId, t.folioNumber),
  idxStay: index('idx_folios_stay').on(t.stayId),
}));

/** Items immuables : correction par void + transaction compensatoire (README §24, §51). */
export const folioItems = pgTable('folio_items', {
  id: text('id').primaryKey(),
  folioId: text('folio_id').notNull().references(() => folios.id),
  businessDate: date('business_date').notNull(),
  transactionDate: timestamp('transaction_date', { withTimezone: true }).notNull().defaultNow(),
  type: text('type').notNull(), // FolioItemType
  category: text('category'),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitAmount: money('unit_amount'),
  discountAmount: money('discount_amount'),
  netAmount: money('net_amount'),
  taxAmount: money('tax_amount'),
  grossAmount: money('gross_amount'),
  currency: text('currency').notNull().default('XOF'),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  postedBy: text('posted_by'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: text('voided_by'),
  voidReason: text('void_reason'),
  voidedByItem: text('voided_by_item'),
  nightCount: integer('night_count'), // pour ROOM : nombre de nuits postées
  createdAt: createdAt(),
}, (t) => ({
  idxFolio: index('idx_folio_items_folio').on(t.folioId, t.businessDate),
}));

export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  paymentNumber: text('payment_number').notNull(),
  folioId: text('folio_id').notNull().references(() => folios.id),
  amount: money('amount'),
  currency: text('currency').notNull().default('XOF'),
  method: text('method').notNull(),
  status: text('status').notNull().default('COMPLETED'),
  reference: text('reference'),
  externalReference: text('external_reference'),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
  receivedBy: text('received_by'),
  cashSessionId: text('cash_session_id'),
  notes: text('notes'),
  /** Clé d'idempotence API (README §70) — empêche le double paiement réseau. */
  idempotencyKey: text('idempotency_key'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_payments_number').on(t.propertyId, t.paymentNumber),
  uqIdem: uniqueIndex('uq_payments_idempotency').on(t.propertyId, t.idempotencyKey),
  idxFolio: index('idx_payments_folio').on(t.folioId),
  idxPropertyPaidAt: index('idx_payments_property_paid_at').on(t.propertyId, t.paidAt),
}));

export const paymentAllocations = pgTable('payment_allocations', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id').notNull().references(() => payments.id),
  folioId: text('folio_id').notNull().references(() => folios.id),
  amount: money('amount'),
  createdAt: createdAt(),
}, (t) => ({
  idxPayment: index('idx_payment_allocations_payment').on(t.paymentId),
  idxFolio: index('idx_payment_allocations_folio').on(t.folioId),
}));

export const refunds = pgTable('refunds', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id').notNull().references(() => payments.id),
  propertyId: text('property_id').notNull().references(() => properties.id),
  amount: money('amount'),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('COMPLETED'),
  reference: text('reference'),
  approvedBy: text('approved_by'),
  processedBy: text('processed_by'),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// #28–#32 — Factures, taxes
// ---------------------------------------------------------------------------

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  invoiceNumber: text('invoice_number').notNull(),
  folioId: text('folio_id').notNull().references(() => folios.id),
  guestId: text('guest_id').references(() => guests.id),
  companyId: text('company_id').references(() => companies.id),
  status: text('status').notNull().default('DRAFT'),
  invoiceType: text('invoice_type').notNull().default('STANDARD'), // STANDARD|PROFORMA|CREDIT_NOTE
  currency: text('currency').notNull().default('XOF'),
  subtotal: money('subtotal'),
  discountAmount: money('discount_amount'),
  taxAmount: money('tax_amount'),
  totalAmount: money('total_amount'),
  amountPaid: money('amount_paid'),
  balanceDue: money('balance_due'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  dueAt: date('due_at'),
  fneStatus: text('fne_status').notNull().default('NOT_SUBMITTED'),
  fneReference: text('fne_reference'),
  fneNumber: text('fne_number'),
  createdBy: text('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqNumber: uniqueIndex('uq_invoices_number').on(t.propertyId, t.invoiceNumber),
  idxPropertyIssued: index('idx_invoices_property_issued').on(t.propertyId, t.issuedAt),
  idxStatus: index('idx_invoices_property_status').on(t.propertyId, t.status),
  idxFolio: index('idx_invoices_folio').on(t.folioId),
}));

export const invoiceItems = pgTable('invoice_items', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitPrice: money('unit_price'),
  discountAmount: money('discount_amount'),
  netAmount: money('net_amount'),
  taxAmount: money('tax_amount'),
  grossAmount: money('gross_amount'),
  taxCode: text('tax_code'),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
});

/** Moteur de taxation configurable avec dates d'effet (README §30, §90, §127). */
export const taxRules = pgTable('tax_rules', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  code: text('code').notNull(), // TVA, TCN, ...
  taxType: text('tax_type').notNull(),
  jurisdiction: text('jurisdiction').notNull().default('COMMUNE'),
  calculationMethod: text('calculation_method').notNull().default('PERCENTAGE'),
  /** Pourcentage x100 stocké en entier : 18% => 1800 (jamais de float). */
  rateBasisPoints: integer('rate_basis_points').notNull().default(0),
  fixedAmount: money('fixed_amount'),
  isInclusive: boolean('is_inclusive').notNull().default(false),
  appliesTo: text('applies_to').notNull().default('ALL'), // ALL|ROOM|SERVICES
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  conditions: jsonb('conditions'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqCode: uniqueIndex('uq_tax_rules_code').on(t.propertyId, t.code, t.effectiveFrom),
  idxActive: index('idx_tax_rules_active').on(t.propertyId, t.isActive),
}));

/** Taxe communale de nuitée — barème paramétrable, jamais hardcodé frontend (README §31). */
export const nightTaxConfigurations = pgTable('night_tax_configurations', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  hotelClassification: text('hotel_classification').notNull(),
  amountPerNight: money('amount_per_night'),
  currency: text('currency').notNull().default('XOF'),
  jurisdictionType: text('jurisdiction_type').notNull().default('COMMUNE'),
  beneficiaryType: text('beneficiary_type').notNull().default('COMMUNE'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => ({
  idxLookup: index('idx_night_tax_lookup').on(t.propertyId, t.hotelClassification, t.effectiveFrom),
}));

/** Suivi collecté/déclaré/payé — ces états ne doivent pas être confondus (README §127). */
export const taxObligations = pgTable('tax_obligations', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  taxType: text('tax_type').notNull(),
  taxCode: text('tax_code').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  amountDue: money('amount_due'),
  amountCollected: money('amount_collected'),
  amountDeclared: money('amount_declared'),
  amountPaid: money('amount_paid'),
  status: text('status').notNull().default('OPEN'),
  dueDate: date('due_date'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqPeriod: uniqueIndex('uq_tax_obligations_period').on(t.propertyId, t.taxCode, t.periodStart),
}));

// ---------------------------------------------------------------------------
// #33, #97 — FNE (abstraction provider, outbox, tentatives)
// ---------------------------------------------------------------------------

export const fneDocuments = pgTable('fne_documents', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id),
  externalReference: text('external_reference'),
  submissionStatus: text('submission_status').notNull().default('PENDING'),
  fneNumber: text('fne_number'),
  certificationReference: text('certification_reference'),
  qrCodeData: text('qr_code_data'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  certifiedAt: timestamp('certified_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  attemptsCount: integer('attempts_count').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxInvoice: index('idx_fne_documents_invoice').on(t.invoiceId),
  idxPending: index('idx_fne_documents_pending').on(t.submissionStatus, t.nextRetryAt),
}));

export const fneSubmissionAttempts = pgTable('fne_submission_attempts', {
  id: text('id').primaryKey(),
  fneDocumentId: text('fne_document_id').notNull().references(() => fneDocuments.id),
  attemptNumber: integer('attempt_number').notNull(),
  requestId: text('request_id').notNull(),
  status: text('status').notNull(),
  responseCode: text('response_code'),
  responseBodySanitized: text('response_body_sanitized'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: createdAt(),
}, (t) => ({
  idxDoc: index('idx_fne_attempts_doc').on(t.fneDocumentId, t.attemptNumber),
}));

// ---------------------------------------------------------------------------
// #34 — Caisse
// ---------------------------------------------------------------------------

export const cashRegisters = pgTable('cash_registers', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  name: text('name').notNull(),
  code: text('code').notNull(),
  location: text('location'),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => ({
  uqCode: uniqueIndex('uq_cash_registers_code').on(t.propertyId, t.code),
}));

export const cashSessions = pgTable('cash_sessions', {
  id: text('id').primaryKey(),
  cashRegisterId: text('cash_register_id').references(() => cashRegisters.id),
  propertyId: text('property_id').notNull().references(() => properties.id),
  userId: text('user_id').notNull(),
  businessDate: date('business_date').notNull(),
  currency: text('currency').notNull().default('XOF'),
  terminalLabel: text('terminal_label'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  openingFloat: money('opening_float'),
  expectedCash: money('expected_cash'),
  declaredCash: money('declared_cash'),
  variance: money('variance'),
  notes: text('notes'),
  status: text('status').notNull().default('OPEN'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),
  updatedAt: updatedAt(),
}, (t) => ({
  /** Une seule session ouverte par user+propriété — course-safe via contrainte partielle unique. */
  uqOpen: uniqueIndex('uq_cash_sessions_open')
    .on(t.propertyId, t.userId)
    .where(sql`${t.status} IN ('OPEN','CLOSING')`),
  idxOpen: index('idx_cash_sessions_open').on(t.cashRegisterId, t.status),
}));

export const cashMovements = pgTable('cash_movements', {
  id: text('id').primaryKey(),
  cashSessionId: text('cash_session_id').notNull().references(() => cashSessions.id),
  type: text('type').notNull(),
  amount: money('amount'),
  description: text('description'),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  createdBy: text('created_by'),
  createdAt: createdAt(),
}, (t) => ({
  idxSession: index('idx_cash_movements_session').on(t.cashSessionId),
}));

// ---------------------------------------------------------------------------
// #35–#37 — Housekeeping & maintenance
// ---------------------------------------------------------------------------

export const housekeepingTasks = pgTable('housekeeping_tasks', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  roomId: text('room_id').notNull().references(() => rooms.id),
  taskType: text('task_type').notNull(),
  priority: text('priority').notNull().default('NORMAL'),
  status: text('status').notNull().default('PENDING'),
  assignedTo: text('assigned_to'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),
  inspectedAt: timestamp('inspected_at', { withTimezone: true }),
  inspectedBy: text('inspected_by'),
  resultStatus: text('result_status'),
  scheduledDate: date('scheduled_date'),
  notes: text('notes'),
  businessDate: date('business_date').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxBoard: index('idx_housekeeping_board').on(t.propertyId, t.status, t.businessDate),
  idxRoom: index('idx_housekeeping_room').on(t.roomId),
}));

export const assets = pgTable('assets', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  roomId: text('room_id').references(() => rooms.id),
  name: text('name').notNull(),
  category: text('category'),
  serialNumber: text('serial_number'),
  manufacturer: text('manufacturer'),
  purchaseDate: date('purchase_date'),
  warrantyEnd: date('warranty_end'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const maintenanceTickets = pgTable('maintenance_tickets', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  roomId: text('room_id').references(() => rooms.id),
  assetId: text('asset_id').references(() => assets.id),
  title: text('title').notNull(),
  description: text('description'),
  priority: text('priority').notNull().default('NORMAL'),
  status: text('status').notNull().default('OPEN'),
  reportedBy: text('reported_by'),
  assignedTo: text('assigned_to'),
  estimatedCost: money('estimated_cost'),
  actualCost: money('actual_cost'),
  /** Met la chambre OOO/OOS pendant les travaux (README §38). */
  outOfOrder: boolean('out_of_order').notNull().default(false),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  idxStatus: index('idx_maintenance_status').on(t.propertyId, t.status),
}));

// ---------------------------------------------------------------------------
// #39–#42 — Utilisateurs, rôles, permissions, audit
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  /** Super-admin système (README §128) — hors organisations. */
  isSystemAdmin: boolean('is_system_admin').notNull().default(false),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
}, (t) => ({
  uqEmail: uniqueIndex('uq_users_email').on(t.email),
  uqUsername: uniqueIndex('uq_username').on(t.organizationId, t.username),
}));

export const userProperties = pgTable('user_properties', {
  userId: text('user_id').notNull().references(() => users.id),
  propertyId: text('property_id').notNull().references(() => properties.id),
}, (t) => ({
  pk: uniqueIndex('pk_user_properties').on(t.userId, t.propertyId),
}));

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').references(() => organizations.id), // null = rôle système global
  name: text('name').notNull(),
  code: text('code').notNull(),
  description: text('description'),
  isSystemRole: boolean('is_system_role').notNull().default(false),
}, (t) => ({
  uqCode: uniqueIndex('uq_roles_code').on(t.organizationId, t.code),
}));

export const permissions = pgTable('permissions', {
  id: text('id').primaryKey(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description'),
}, (t) => ({
  uqPerm: uniqueIndex('uq_permissions_resource_action').on(t.resource, t.action),
}));

export const rolePermissions = pgTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id),
  permissionId: text('permission_id').notNull().references(() => permissions.id),
}, (t) => ({
  pk: uniqueIndex('pk_role_permissions').on(t.roleId, t.permissionId),
}));

export const userRoles = pgTable('user_roles', {
  userId: text('user_id').notNull().references(() => users.id),
  roleId: text('role_id').notNull().references(() => roles.id),
  /** Portée du rôle : organisation entière ou propriété précise. */
  propertyId: text('property_id').references(() => properties.id),
}, (t) => ({
  pk: uniqueIndex('pk_user_roles').on(t.userId, t.roleId, t.propertyId),
}));

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  propertyId: text('property_id'),
  userId: text('user_id'),
  action: text('action').notNull(),
  resource: text('resource').notNull(),
  resourceId: text('resource_id'),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  severity: text('severity').notNull().default('INFO'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  correlationId: text('correlation_id'),
  createdAt: createdAt(),
}, (t) => ({
  idxProperty: index('idx_audit_logs_property_created').on(t.propertyId, t.createdAt),
  idxUser: index('idx_audit_logs_user').on(t.userId, t.createdAt),
}));

// ---------------------------------------------------------------------------
// #55, #106 — Night audit & agrégats dashboard
// ---------------------------------------------------------------------------

export const nightAudits = pgTable('night_audits', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  businessDate: date('business_date').notNull(),
  status: text('status').notNull().default('PENDING'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  startedBy: text('started_by'),
  completedBy: text('completed_by'),
  totalRoomRevenue: money('total_room_revenue'),
  totalOtherRevenue: money('total_other_revenue'),
  totalTax: money('total_tax'),
  totalPayments: money('total_payments'),
  variance: money('variance'),
  errorSummary: text('error_summary'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  /** Idempotence : une seule clôture par (propriété, business date) (AC §136). */
  uqDate: uniqueIndex('uq_night_audits_date').on(t.propertyId, t.businessDate),
}));

export const dailyHotelMetrics = pgTable('daily_hotel_metrics', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull().references(() => properties.id),
  businessDate: date('business_date').notNull(),
  availableRooms: integer('available_rooms').notNull().default(0),
  occupiedRooms: integer('occupied_rooms').notNull().default(0),
  outOfOrderRooms: integer('out_of_order_rooms').notNull().default(0),
  /** x10000 : 62.5% => 6250 (pas de float). */
  occupancyRateBps: integer('occupancy_rate_bps').notNull().default(0),
  roomRevenue: money('room_revenue'),
  otherRevenue: money('other_revenue'),
  grossRevenue: money('gross_revenue'),
  taxRevenue: money('tax_revenue'),
  adr: money('adr'),
  revpar: money('revpar'),
  paymentsTotal: money('payments_total'),
  outstanding: money('outstanding'),
  arrivals: integer('arrivals').notNull().default(0),
  departures: integer('departures').notNull().default(0),
  inHouse: integer('in_house').notNull().default(0),
  noShows: integer('no_shows').notNull().default(0),
  cancellations: integer('cancellations').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  uqDay: uniqueIndex('uq_daily_metrics').on(t.propertyId, t.businessDate),
}));

// ---------------------------------------------------------------------------
// #66, #96 — Notifications & outbox
// ---------------------------------------------------------------------------

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  propertyId: text('property_id'),
  userId: text('user_id').notNull(),
  channel: text('channel').notNull().default('IN_APP'),
  eventType: text('event_type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  linkUrl: text('link_url'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  idxUser: index('idx_notifications_user_read').on(t.userId, t.readAt),
}));

/** Outbox pattern (README §96) : événement écrit dans la même transaction que la mutation. */
export const outboxEvents = pgTable('outbox_events', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  propertyId: text('property_id'),
  eventType: text('event_type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
}, (t) => ({
  idxPending: index('idx_outbox_pending').on(t.status, t.availableAt),
}));

/** Idempotency keys génériques (README §70). */
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  key: text('key').notNull(),
  operation: text('operation').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => ({
  uqKey: uniqueIndex('uq_idempotency_keys').on(t.organizationId, t.key),
}));

export const schema = {
  organizations,
  properties,
  propertySettings,
  buildings,
  floors,
  amenities,
  roomTypes,
  rooms,
  roomAmenities,
  roomTypeAmenities,
  roomStatusHistory,
  cancellationPolicies,
  ratePlans,
  seasons,
  ratePlanPrices,
  companies,
  agencies,
  guests,
  guestDocuments,
  guestPreferences,
  reservations,
  reservationRooms,
  reservationGuests,
  inventoryLocks,
  inventoryCapacity,
  stays,
  stayRooms,
  folios,
  folioItems,
  payments,
  paymentAllocations,
  refunds,
  invoices,
  invoiceItems,
  taxRules,
  nightTaxConfigurations,
  taxObligations,
  fneDocuments,
  fneSubmissionAttempts,
  cashRegisters,
  cashSessions,
  cashMovements,
  housekeepingTasks,
  assets,
  maintenanceTickets,
  users,
  userProperties,
  roles,
  permissions,
  rolePermissions,
  userRoles,
  auditLogs,
  nightAudits,
  dailyHotelMetrics,
  notifications,
  outboxEvents,
  idempotencyKeys,
};

export type DbSchema = typeof schema;
