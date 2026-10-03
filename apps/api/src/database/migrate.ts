import { Pool } from 'pg';
import { env } from '../common/env';

/** DDL alignée sur Drizzle schema.ts — idempotente (README §61 db:migrate). */
const DDL = `
CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  legal_name text,
  slug text NOT NULL,
  status text NOT NULL,
  default_currency text NOT NULL,
  country_code text NOT NULL,
  plan_code text NOT NULL,
  subscription_status text NOT NULL,
  trial_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS properties (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  slug text NOT NULL,
  legal_name text,
  rccm text,
  tax_identifier text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  district text,
  postal_code text,
  country text NOT NULL,
  phone text,
  email text,
  website text,
  timezone text NOT NULL,
  currency text NOT NULL,
  hotel_classification text NOT NULL,
  star_rating integer NOT NULL,
  check_in_time text NOT NULL,
  check_out_time text NOT NULL,
  status text NOT NULL,
  logo_url text,
  current_business_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS property_settings (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  value_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buildings (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS floors (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  building_id text,
  name text NOT NULL,
  number integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS amenities (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_types (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  short_description text,
  capacity_adults integer NOT NULL,
  capacity_children integer NOT NULL,
  max_occupancy integer NOT NULL,
  base_occupancy integer NOT NULL,
  bed_configuration text,
  surface_area integer,
  default_rate bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  building_id text,
  floor_id text,
  room_type_id text NOT NULL,
  number text NOT NULL,
  code text NOT NULL,
  status text NOT NULL,
  housekeeping_status text NOT NULL,
  front_office_status text NOT NULL,
  maintenance_status text NOT NULL,
  floor_location text,
  capacity integer NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS room_amenities (
  room_id text NOT NULL,
  amenity_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS room_status_history (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  room_id text NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  reason text,
  reference_type text,
  reference_id text,
  changed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cancellation_policies (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  description text,
  deadline_hours integer NOT NULL,
  penalty_type text NOT NULL,
  penalty_value bigint NOT NULL DEFAULT 0,
  no_show_penalty_type text NOT NULL,
  no_show_penalty_value bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seasons (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  priority integer NOT NULL,
  is_active boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_plans (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  meal_plan text NOT NULL,
  cancellation_policy_id text,
  payment_policy text NOT NULL,
  deposit_percentage integer NOT NULL,
  is_refundable boolean NOT NULL,
  is_public boolean NOT NULL,
  is_active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_plan_prices (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  rate_plan_id text NOT NULL,
  room_type_id text NOT NULL,
  season_id text,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  occupancy integer NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  minimum_nights integer NOT NULL,
  maximum_nights integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_rules (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  tax_type text NOT NULL,
  jurisdiction text NOT NULL,
  calculation_method text NOT NULL,
  rate_basis_points integer NOT NULL,
  fixed_amount bigint NOT NULL DEFAULT 0,
  is_inclusive boolean NOT NULL,
  applies_to text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  conditions jsonb,
  is_active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  legal_name text,
  rccm text,
  tax_identifier text,
  phone text,
  email text,
  address text,
  city text,
  country text,
  contact_person text,
  payment_terms integer NOT NULL,
  credit_limit bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS agencies (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  legal_name text,
  registration_number text,
  phone text,
  email text,
  address text,
  commission_type text NOT NULL,
  commission_value bigint NOT NULL DEFAULT 0,
  payment_terms integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS guests (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  guest_code text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  middle_name text,
  display_name text NOT NULL,
  gender text,
  date_of_birth date,
  nationality text,
  country text,
  phone text,
  secondary_phone text,
  email text,
  address text,
  city text,
  region text,
  company_id text,
  vip_level integer NOT NULL,
  notes text,
  marketing_consent boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS guest_documents (
  id text PRIMARY KEY,
  guest_id text NOT NULL,
  document_type text NOT NULL,
  document_number text NOT NULL,
  issuing_country text,
  issue_date date,
  expiry_date date,
  file_url text,
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guest_preferences (
  id text PRIMARY KEY,
  guest_id text NOT NULL,
  preference_type text NOT NULL,
  preference_value text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  reservation_number text NOT NULL,
  source text NOT NULL,
  channel text,
  status text NOT NULL,
  guest_id text,
  company_id text,
  agency_id text,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  nights integer NOT NULL,
  adults integer NOT NULL,
  children integer NOT NULL,
  infants integer NOT NULL,
  currency text NOT NULL,
  subtotal bigint NOT NULL DEFAULT 0,
  discount_amount bigint NOT NULL DEFAULT 0,
  tax_amount bigint NOT NULL DEFAULT 0,
  total_amount bigint NOT NULL DEFAULT 0,
  deposit_required bigint NOT NULL DEFAULT 0,
  deposit_amount bigint NOT NULL DEFAULT 0,
  deposit_due_date date,
  special_requests text,
  internal_notes text,
  external_reference text,
  created_by text,
  updated_by text,
  cancelled_at timestamptz,
  cancellation_reason text,
  no_show_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_capacity (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date date NOT NULL,
  sellable_rooms integer NOT NULL,
  sold_rooms integer NOT NULL,
  blocked_rooms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_locks (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date date NOT NULL,
  reservation_id text NOT NULL,
  quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stays (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  stay_number text NOT NULL,
  reservation_id text NOT NULL,
  primary_guest_id text,
  status text NOT NULL,
  actual_check_in_at timestamptz,
  actual_check_out_at timestamptz,
  planned_check_in date NOT NULL,
  planned_check_out date NOT NULL,
  assigned_by text,
  checked_in_by text,
  checked_out_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folios (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  folio_number text NOT NULL,
  stay_id text NOT NULL,
  guest_id text,
  company_id text,
  status text NOT NULL,
  currency text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  balance bigint NOT NULL DEFAULT 0,
  credit_limit bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folio_items (
  id text PRIMARY KEY,
  folio_id text NOT NULL,
  business_date date NOT NULL,
  transaction_date timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  category text,
  description text NOT NULL,
  quantity integer NOT NULL,
  unit_amount bigint NOT NULL DEFAULT 0,
  discount_amount bigint NOT NULL DEFAULT 0,
  net_amount bigint NOT NULL DEFAULT 0,
  tax_amount bigint NOT NULL DEFAULT 0,
  gross_amount bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  reference_type text,
  reference_id text,
  posted_by text,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  voided_by_item text,
  night_count integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  payment_number text NOT NULL,
  folio_id text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  method text NOT NULL,
  status text NOT NULL,
  reference text,
  external_reference text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  received_by text,
  cash_session_id text,
  notes text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  invoice_number text NOT NULL,
  folio_id text NOT NULL,
  guest_id text,
  company_id text,
  status text NOT NULL,
  invoice_type text NOT NULL,
  currency text NOT NULL,
  subtotal bigint NOT NULL DEFAULT 0,
  discount_amount bigint NOT NULL DEFAULT 0,
  tax_amount bigint NOT NULL DEFAULT 0,
  total_amount bigint NOT NULL DEFAULT 0,
  amount_paid bigint NOT NULL DEFAULT 0,
  balance_due bigint NOT NULL DEFAULT 0,
  issued_at timestamptz,
  due_at date,
  fne_status text NOT NULL,
  fne_reference text,
  fne_number text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id text PRIMARY KEY,
  invoice_id text NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL,
  unit_price bigint NOT NULL DEFAULT 0,
  discount_amount bigint NOT NULL DEFAULT 0,
  net_amount bigint NOT NULL DEFAULT 0,
  tax_amount bigint NOT NULL DEFAULT 0,
  gross_amount bigint NOT NULL DEFAULT 0,
  tax_code text,
  reference_type text,
  reference_id text
);

CREATE TABLE IF NOT EXISTS fne_documents (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  invoice_id text NOT NULL,
  external_reference text,
  submission_status text NOT NULL,
  fne_number text,
  certification_reference text,
  qr_code_data text,
  submitted_at timestamptz,
  certified_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  attempts_count integer NOT NULL,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_registers (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  location text,
  is_active boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id text PRIMARY KEY,
  cash_register_id text,
  property_id text NOT NULL,
  user_id text NOT NULL,
  business_date date NOT NULL,
  currency text NOT NULL,
  terminal_label text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float bigint NOT NULL DEFAULT 0,
  expected_cash bigint NOT NULL DEFAULT 0,
  declared_cash bigint NOT NULL DEFAULT 0,
  variance bigint NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL,
  closed_at timestamptz,
  closed_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_movements (
  id text PRIMARY KEY,
  cash_session_id text NOT NULL,
  type text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  description text,
  reference_type text,
  reference_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  room_id text NOT NULL,
  task_type text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  assigned_to text,
  started_at timestamptz,
  completed_at timestamptz,
  verified_at timestamptz,
  verified_by text,
  inspected_at timestamptz,
  inspected_by text,
  result_status text,
  scheduled_date date,
  notes text,
  business_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  room_id text,
  asset_id text,
  title text NOT NULL,
  description text,
  priority text NOT NULL,
  status text NOT NULL,
  reported_by text,
  assigned_to text,
  estimated_cost bigint NOT NULL DEFAULT 0,
  actual_cost bigint NOT NULL DEFAULT 0,
  out_of_order boolean NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  room_id text,
  name text NOT NULL,
  category text,
  serial_number text,
  manufacturer text,
  purchase_date date,
  warranty_end date,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS night_audits (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  started_by text,
  completed_by text,
  total_room_revenue bigint NOT NULL DEFAULT 0,
  total_other_revenue bigint NOT NULL DEFAULT 0,
  total_tax bigint NOT NULL DEFAULT 0,
  total_payments bigint NOT NULL DEFAULT 0,
  variance bigint NOT NULL DEFAULT 0,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_hotel_metrics (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  business_date date NOT NULL,
  available_rooms integer NOT NULL,
  occupied_rooms integer NOT NULL,
  out_of_order_rooms integer NOT NULL,
  occupancy_rate_bps integer NOT NULL,
  room_revenue bigint NOT NULL DEFAULT 0,
  other_revenue bigint NOT NULL DEFAULT 0,
  gross_revenue bigint NOT NULL DEFAULT 0,
  tax_revenue bigint NOT NULL DEFAULT 0,
  adr bigint NOT NULL DEFAULT 0,
  revpar bigint NOT NULL DEFAULT 0,
  payments_total bigint NOT NULL DEFAULT 0,
  outstanding bigint NOT NULL DEFAULT 0,
  arrivals integer NOT NULL,
  departures integer NOT NULL,
  in_house integer NOT NULL,
  no_shows integer NOT NULL,
  cancellations integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  organization_id text,
  property_id text,
  user_id text NOT NULL,
  channel text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link_url text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  organization_id text,
  property_id text,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  organization_id text,
  property_id text,
  user_id text,
  action text NOT NULL,
  resource text NOT NULL,
  resource_id text,
  before_data jsonb,
  after_data jsonb,
  severity text NOT NULL,
  ip_address text,
  user_agent text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  username text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL,
  last_login_at timestamptz,
  mfa_enabled boolean NOT NULL,
  is_system_admin boolean NOT NULL,
  failed_login_count integer NOT NULL,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY,
  organization_id text,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  is_system_role boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id text PRIMARY KEY,
  resource text NOT NULL,
  action text NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id text NOT NULL,
  permission_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id text NOT NULL,
  role_id text NOT NULL,
  property_id text
);

CREATE TABLE IF NOT EXISTS user_properties (
  user_id text NOT NULL,
  property_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS room_type_amenities (
  room_type_id text NOT NULL,
  amenity_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS reservation_rooms (
  id text PRIMARY KEY,
  reservation_id text NOT NULL,
  room_type_id text NOT NULL,
  room_id text,
  rate_plan_id text NOT NULL,
  adults integer NOT NULL,
  children integer NOT NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  number_of_nights integer NOT NULL,
  base_amount bigint NOT NULL DEFAULT 0,
  discount_amount bigint NOT NULL DEFAULT 0,
  discount_reason text,
  discount_approved_by text,
  tax_amount bigint NOT NULL DEFAULT 0,
  total_amount bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_guests (
  id text PRIMARY KEY,
  reservation_id text NOT NULL,
  guest_id text NOT NULL,
  role text NOT NULL,
  is_primary boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stay_rooms (
  id text PRIMARY KEY,
  stay_id text NOT NULL,
  room_id text NOT NULL,
  room_type_id text NOT NULL,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by text,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id text PRIMARY KEY,
  payment_id text NOT NULL,
  folio_id text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id text PRIMARY KEY,
  payment_id text NOT NULL,
  property_id text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  reason text NOT NULL,
  status text NOT NULL,
  reference text,
  approved_by text,
  processed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS night_tax_configurations (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  hotel_classification text NOT NULL,
  amount_per_night bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  jurisdiction_type text NOT NULL,
  beneficiary_type text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_obligations (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  tax_type text NOT NULL,
  tax_code text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount_due bigint NOT NULL DEFAULT 0,
  amount_collected bigint NOT NULL DEFAULT 0,
  amount_declared bigint NOT NULL DEFAULT 0,
  amount_paid bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  due_date date,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fne_submission_attempts (
  id text PRIMARY KEY,
  fne_document_id text NOT NULL,
  attempt_number integer NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL,
  response_code text,
  response_body_sanitized text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id text PRIMARY KEY,
  organization_id text,
  key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

async function main() {
  const pool = new Pool({ connectionString: env().DATABASE_URL });
  console.log('→ application du schéma (IF NOT EXISTS)…');
  await pool.query(DDL);
  console.log('✔ migration terminée');
  await pool.end();
}

main().catch((e) => {
  console.error('Échec migration:', e.message ?? e);
  process.exit(1);
});
