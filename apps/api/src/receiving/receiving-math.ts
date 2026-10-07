/**
 * Stage 2B receiving: pure functions (no database). Expiry dates, how an accepted quantity is spread over the
 * purchase lines of a source, and the cost of every unit.
 */
import { unitCosts } from '../purchases/purchase-cost';

/** Expiry closer than this asks «Срок годности меньше 90 дней — принять?». */
export const SHORT_EXPIRY_DAYS = 90;

/** «31.12.2027» (as typed) or «2027-12-31» -> «2027-12-31»; null for anything that is not a real date. */
export function parseDay(input: string): string | null {
  const s = input.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (r) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** «2027-12-31» -> «31.12.2027» (how dates are shown and printed). */
export const ruDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Whole days from `today` to `day` (both YYYY-MM-DD). */
export const daysBetween = (today: string, day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

export interface ExpiryGroup {
  expiry: string; // YYYY-MM-DD
  qty: number;
}

export type ExpiryProblem = { code: 'EXPIRY_INVALID'; value: string } | { code: 'EXPIRY_IN_PAST'; expiry: string } | { code: 'EXPIRY_QTY_MISMATCH'; total: number };

/**
 * Checks the expiry groups of one accepted position: real dates, not in the past, Σ qty = the accepted quantity.
 * Same dates are merged; the groups come back sorted by date (the earliest first).
 */
export function checkExpiryGroups(
  groups: { expiry: string; qty: number }[],
  qty: number,
  today: string,
): { groups: ExpiryGroup[]; short: ExpiryGroup[] } | { problem: ExpiryProblem } {
  const merged = new Map<string, number>();
  for (const g of groups) {
    const day = parseDay(g.expiry);
    if (!day) return { problem: { code: 'EXPIRY_INVALID', value: g.expiry } };
    if (day < today) return { problem: { code: 'EXPIRY_IN_PAST', expiry: day } };
    merged.set(day, (merged.get(day) ?? 0) + g.qty);
  }
  const total = [...merged.values()].reduce((s, n) => s + n, 0);
  if (total !== qty) return { problem: { code: 'EXPIRY_QTY_MISMATCH', total } };
  const sorted = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([expiry, n]) => ({ expiry, qty: n }));
  return { groups: sorted, short: sorted.filter((g) => daysBetween(today, g.expiry) < SHORT_EXPIRY_DAYS) };
}

/** Expiry of every single unit, in order (groups sorted by date). */
export const unitExpiries = (groups: ExpiryGroup[]): string[] => groups.flatMap((g) => Array<string>(g.qty).fill(g.expiry));

/** Groups back from a list of unit expiries (for one session line). */
export function groupExpiries(days: string[]): ExpiryGroup[] {
  const m = new Map<string, number>();
  for (const d of days) m.set(d, (m.get(d) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([expiry, qty]) => ({ expiry, qty }));
}

export interface OpenLine {
  /** still expected on this line now: ordered − cancelled − received − units already accepted in open sessions */
  open: number;
}

/**
 * N accepted units of one SKU over the lines of the source (already sorted: purchase date from the oldest, then
 * position): each line gets up to what it still expects. What is above everything expected goes to the LAST line
 * as a discrepancy (more arrived than ordered).
 */
export function distribute(qty: number, lines: OpenLine[]): { index: number; qty: number; over: number }[] {
  if (!lines.length || qty <= 0) return [];
  const out: { index: number; qty: number; over: number }[] = [];
  let left = qty;
  lines.forEach((l, index) => {
    const take = Math.min(left, Math.max(0, l.open));
    if (take > 0) out.push({ index, qty: take, over: 0 });
    left -= take;
  });
  if (left > 0) {
    const last = lines.length - 1;
    const existing = out.find((o) => o.index === last);
    if (existing) {
      existing.qty += left;
      existing.over = left;
    } else out.push({ index: last, qty: left, over: left });
  }
  return out;
}

/** Whole-UZS average, rounded half up. */
const roundDiv = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);

/**
 * Cost of the units of one purchase line, in their order (by Physical ID number). The k-th unit gets the k-th of
 * unitCosts(allocated, ordered − cancelled), so when exactly that many arrive Σ = allocated_total_uzs exactly.
 * Units above that (more arrived than expected) get the rounded average cost of the line.
 */
export function lineUnitCosts(allocatedTotal: bigint, costQty: number, units: number): bigint[] {
  if (units <= 0) return [];
  if (costQty <= 0) return Array<bigint>(units).fill(0n);
  const exact = unitCosts(allocatedTotal, costQty);
  const avg = roundDiv(allocatedTotal, BigInt(costQty));
  return Array.from({ length: units }, (_, k) => (k < exact.length ? exact[k] : avg));
}
