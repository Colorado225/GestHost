/**
 * GestHost PMS — Nomenclatures de statuts (README §92).
 * Enums domaine/base : ne jamais utiliser de chaînes arbitraires.
 * Les valeurs sont stockées en TEXT + CHECK constraints côté PostgreSQL,
 * afin de rester lisibles dans les exports sans dépendre d'enums PG natifs.
 */

export const OrganizationStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

export const PropertyStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type PropertyStatus = (typeof PropertyStatus)[keyof typeof PropertyStatus];

export const HotelClassification = {
  NO_STAR: 'NO_STAR',
  ONE_STAR: 'ONE_STAR',
  TWO_STAR: 'TWO_STAR',
  THREE_STAR_PLUS: 'THREE_STAR_PLUS',
} as const;
export type HotelClassification =
  (typeof HotelClassification)[keyof typeof HotelClassification];

export const RoomStatus = {
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  OCCUPIED: 'OCCUPIED',
  BLOCKED: 'BLOCKED',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
} as const;
export type RoomStatus = (typeof RoomStatus)[keyof typeof RoomStatus];

export const HousekeepingStatus = {
  CLEAN: 'CLEAN',
  DIRTY: 'DIRTY',
  IN_PROGRESS: 'IN_PROGRESS',
  INSPECTED: 'INSPECTED',
} as const;
export type HousekeepingStatus = (typeof HousekeepingStatus)[keyof typeof HousekeepingStatus];

export const MaintenanceRoomStatus = {
  OK: 'OK',
  MAINTENANCE: 'MAINTENANCE',
} as const;
export type MaintenanceRoomStatus =
  (typeof MaintenanceRoomStatus)[keyof typeof MaintenanceRoomStatus];

export const FrontOfficeStatus = {
  VACANT: 'VACANT',
  RESERVED: 'RESERVED',
  OCCUPIED: 'OCCUPIED',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
} as const;
export type FrontOfficeStatus = (typeof FrontOfficeStatus)[keyof typeof FrontOfficeStatus];

export const MasterStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;
export type MasterStatus = (typeof MasterStatus)[keyof typeof MasterStatus];

export const ReservationStatus = {
  DRAFT: 'DRAFT',
  OPTION: 'OPTION',
  CONFIRMED: 'CONFIRMED',
  WAITLISTED: 'WAITLISTED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  CHECKED_IN: 'CHECKED_IN',
  CHECKED_OUT: 'CHECKED_OUT',
  CLOSED: 'CLOSED',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

/** Statuts qui consomment l'inventaire (README §45 règle de disponibilité). */
export const INVENTORY_CONSUMING_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.OPTION,
  ReservationStatus.CONFIRMED,
  ReservationStatus.WAITLISTED,
  ReservationStatus.CHECKED_IN,
];

export const ReservationSource = {
  DIRECT: 'DIRECT',
  PHONE: 'PHONE',
  WHATSAPP: 'WHATSAPP',
  WALK_IN: 'WALK_IN',
  WEBSITE: 'WEBSITE',
  OTA: 'OTA',
  AGENCY: 'AGENCY',
  CORPORATE: 'CORPORATE',
  OTHER: 'OTHER',
} as const;
export type ReservationSource = (typeof ReservationSource)[keyof typeof ReservationSource];

export const MealPlan = {
  RO: 'RO', // room only
  BB: 'BB', // bed & breakfast
  HB: 'HB', // half board
  FB: 'FB', // full board
  AI: 'AI', // all inclusive
} as const;
export type MealPlan = (typeof MealPlan)[keyof typeof MealPlan];

export const PenaltyType = {
  NONE: 'NONE',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  FIRST_NIGHT: 'FIRST_NIGHT',
  PERCENTAGE: 'PERCENTAGE',
  FULL_STAY: 'FULL_STAY',
} as const;
export type PenaltyType = (typeof PenaltyType)[keyof typeof PenaltyType];

export const GuestRole = {
  PRIMARY: 'PRIMARY',
  ADULT: 'ADULT',
  CHILD: 'CHILD',
  COMPANION: 'COMPANION',
} as const;
export type GuestRole = (typeof GuestRole)[keyof typeof GuestRole];

export const StayStatus = {
  EXPECTED: 'EXPECTED',
  CHECKED_IN: 'CHECKED_IN',
  IN_HOUSE: 'IN_HOUSE',
  CHECKED_OUT: 'CHECKED_OUT',
  CANCELLED: 'CANCELLED',
} as const;
export type StayStatus = (typeof StayStatus)[keyof typeof StayStatus];

export const FolioStatus = {
  OPEN: 'OPEN',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  CLOSED: 'CLOSED',
} as const;
export type FolioStatus = (typeof FolioStatus)[keyof typeof FolioStatus];

export const FolioItemType = {
  ROOM: 'ROOM',
  BREAKFAST: 'BREAKFAST',
  RESTAURANT: 'RESTAURANT',
  BAR: 'BAR',
  LAUNDRY: 'LAUNDRY',
  ROOM_SERVICE: 'ROOM_SERVICE',
  SPA: 'SPA',
  OTHER_SERVICE: 'OTHER_SERVICE',
  DISCOUNT: 'DISCOUNT',
  TAX: 'TAX',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type FolioItemType = (typeof FolioItemType)[keyof typeof FolioItemType];

export const PaymentMethod = {
  CASH: 'CASH',
  CARD: 'CARD',
  BANK_TRANSFER: 'BANK_TRANSFER',
  CHEQUE: 'CHEQUE',
  MOBILE_MONEY: 'MOBILE_MONEY',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  FINALIZED: 'FINALIZED',
  SUBMITTED: 'SUBMITTED',
  CERTIFIED: 'CERTIFIED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CREDITED: 'CREDITED',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const TaxType = {
  VAT: 'VAT',
  NIGHT_TAX: 'NIGHT_TAX',
  TOURIST_TAX: 'TOURIST_TAX',
  OTHER: 'OTHER',
} as const;
export type TaxType = (typeof TaxType)[keyof typeof TaxType];

export const CalculationMethod = {
  PERCENTAGE: 'PERCENTAGE',
  PER_UNIT_PER_NIGHT: 'PER_UNIT_PER_NIGHT',
  FIXED: 'FIXED',
} as const;
export type CalculationMethod = (typeof CalculationMethod)[keyof typeof CalculationMethod];

export const TaxObligationStatus = {
  OPEN: 'OPEN',
  DECLARED: 'DECLARED',
  PAID: 'PAID',
} as const;
export type TaxObligationStatus = (typeof TaxObligationStatus)[keyof typeof TaxObligationStatus];

export const FneSubmissionStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  CERTIFIED: 'CERTIFIED',
  REJECTED: 'REJECTED',
  RETRYING: 'RETRYING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type FneSubmissionStatus = (typeof FneSubmissionStatus)[keyof typeof FneSubmissionStatus];

export const CashSessionStatus = {
  OPEN: 'OPEN',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
} as const;
export type CashSessionStatus = (typeof CashSessionStatus)[keyof typeof CashSessionStatus];

export const CashMovementType = {
  SALE: 'SALE',
  PAYMENT: 'PAYMENT',
  REFUND: 'REFUND',
  CASH_IN: 'CASH_IN',
  CASH_OUT: 'CASH_OUT',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type CashMovementType = (typeof CashMovementType)[keyof typeof CashMovementType];

export const HousekeepingTaskType = {
  CHECKOUT_CLEAN: 'CHECKOUT_CLEAN',
  STAYOVER: 'STAYOVER',
  DEEP_CLEAN: 'DEEP_CLEAN',
  INSPECTION: 'INSPECTION',
  VIP_PREP: 'VIP_PREP',
  MAINTENANCE_FOLLOWUP: 'MAINTENANCE_FOLLOWUP',
} as const;
export type HousekeepingTaskType =
  (typeof HousekeepingTaskType)[keyof typeof HousekeepingTaskType];

export const HousekeepingTaskStatus = {
  PENDING: 'PENDING',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  INSPECTED: 'INSPECTED',
  BLOCKED: 'BLOCKED',
} as const;
export type HousekeepingTaskStatus =
  (typeof HousekeepingTaskStatus)[keyof typeof HousekeepingTaskStatus];

export const MaintenanceTicketStatus = {
  OPEN: 'OPEN',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_PART: 'WAITING_PART',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type MaintenanceTicketStatus =
  (typeof MaintenanceTicketStatus)[keyof typeof MaintenanceTicketStatus];

export const Priority = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const NightAuditStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type NightAuditStatus = (typeof NightAuditStatus)[keyof typeof NightAuditStatus];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INVITED: 'INVITED',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const NotificationChannel = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const OutboxStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

/** Domain events (README §67). */
export const DomainEventType = {
  RESERVATION_CREATED: 'reservation.created',
  RESERVATION_CONFIRMED: 'reservation.confirmed',
  RESERVATION_CANCELLED: 'reservation.cancelled',
  RESERVATION_NO_SHOW: 'reservation.no_show',
  GUEST_CHECKED_IN: 'checkin.completed',
  GUEST_CHECKED_OUT: 'checkout.completed',
  ROOM_CHANGED: 'room.changed',
  CHARGE_POSTED: 'charge.posted',
  CHARGE_VOIDED: 'charge.voided',
  PAYMENT_COMPLETED: 'payment.completed',
  REFUND_COMPLETED: 'refund.completed',
  INVOICE_FINALIZED: 'invoice.finalized',
  FNE_SUBMIT_REQUESTED: 'fne.submit_requested',
  FNE_CERTIFIED: 'invoice.certified',
  FNE_REJECTED: 'fne.rejected',
  HOUSEKEEPING_COMPLETED: 'housekeeping.completed',
  MAINTENANCE_CREATED: 'maintenance.created',
  MAINTENANCE_RESOLVED: 'maintenance.resolved',
  NIGHT_AUDIT_COMPLETED: 'night_audit.completed',
} as const;
export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];
