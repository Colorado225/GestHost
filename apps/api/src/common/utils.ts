/**
 * Helpers transverses : IDs ULID, dates hôtelières, montants entiers.
 */
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { ulid } from 'ulid';

export { ulid } from 'ulid';

export const newId = (): string => ulid();
export const uuid = (): string => randomUUID();

/** Correlation/request id (README §73 observabilité). */
export const newCorrelationId = (): string => randomUUID();

// ---------------------------------------------------------------------------
// Dates — conventions README §6 :
//  - timestamptz UTC pour les événements techniques
//  - DATE locale pour arrival/departure/business_date
// ---------------------------------------------------------------------------

/** Date du jour dans le fuseau de la propriété (Africa/Abidjan par défaut). */
export function todayInTimezone(timeZone = 'Africa/Abidjan', ref: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(ref); // YYYY-MM-DD
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nuits entre arrival et departure (check-out day non compté). */
export function nightsBetween(arrival: string, departure: string): number {
  const a = Date.parse(`${arrival}T00:00:00Z`);
  const b = Date.parse(`${departure}T00:00:00Z`);
  const n = Math.round((b - a) / 86400000);
  if (n <= 0) throw new Error('departure_date doit être strictement postérieure à arrival_date');
  return n;
}

/** Liste des nuits [arrival ; departure[ — chaque nuit appartient au stay. */
export function nightDates(arrival: string, departure: string): string[] {
  const n = nightsBetween(arrival, departure);
  return Array.from({ length: n }, (_, i) => addDays(arrival, i));
}

/** Chevauchement de périodes [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅ (inventaire). */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Montants — BIGINT FCFA entier, arrondi bancaire simple, jamais de float en sortie
// ---------------------------------------------------------------------------

/** Arrondi "half up" sur un nombre rationnel (num/den) sans float accumulé. */
export function roundDiv(num: number, den: number): number {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    // On reste en arithmétique entière : scale x1e6 si nécessaire.
    const s = 1e6;
    num = Math.round(num * s);
    den = Math.round(den * s);
  }
  const sign = num >= 0 ? 1 : -1;
  const abs = Math.abs(num);
  return sign * Math.floor((abs * 2 + den) / (2 * den));
}

/** Application d'un taux en basis points (x100) : 18% => 1800. */
export function applyRateBps(amount: number, rateBps: number): number {
  return roundDiv(amount * rateBps, 10000);
}

export function formatMoney(amount: number, currency = 'XOF'): string {
  return new Intl.NumberFormat('fr-FR', { style: 'decimal', maximumFractionDigits: 0 }).format(amount) +
    ` ${currency}`;
}

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmac(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

/** Masquage partiel des documents d'identité (README §14 données sensibles). */
export function maskDocumentNumber(num: string): string {
  if (num.length <= 4) return '****';
  return `${num.slice(0, 2)}${'*'.repeat(Math.min(8, num.length - 4))}${num.slice(-2)}`;
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
