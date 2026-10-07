/**
 * Stage 2A.3: cost of a purchase spread over its lines. Pure functions, whole UZS, no rounding drift.
 *
 * Line base = (ordered - cancelled) × unit price. When the final actual total (what was really paid) is set,
 * every line gets final × base / Σbases, rounded down; the UZS left over go one by one to the lines with the
 * largest remainders (ties: the earlier line). So Σ allocated = final exactly. Without a final total the
 * allocated total is the base. Lines with nothing left (everything cancelled) get 0.
 * If all bases are 0 (free goods) but something is still ordered, the final total is spread by quantity.
 */

export interface CostLineInput {
  ordered_qty: number;
  cancelled_qty: number;
  unit_price_original_uzs: number | bigint;
}

/** Units a line still brings (the cost is spread over them): ordered minus cancelled. */
export const costQty = (l: Pick<CostLineInput, 'ordered_qty' | 'cancelled_qty'>) => Math.max(0, l.ordered_qty - l.cancelled_qty);

export const lineBase = (l: CostLineInput): bigint => BigInt(costQty(l)) * BigInt(l.unit_price_original_uzs);

/** Largest remainder: shares of `total` proportional to `weights` (whole numbers, Σ = total exactly). */
export function largestRemainder(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const floors = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - floors.reduce((s, f) => s + f, 0n);
  remainders.sort((a, b) => (b.r === a.r ? a.i - b.i : b.r > a.r ? 1 : -1));
  for (const { i } of remainders) {
    if (left <= 0n) break;
    if (weights[i] === 0n) continue;
    floors[i] += 1n;
    left -= 1n;
  }
  return floors;
}

/** allocated_total_uzs per line (same order as `lines`). */
export function allocateLineTotals(lines: CostLineInput[], finalActualTotal: number | bigint | null | undefined): bigint[] {
  const bases = lines.map(lineBase);
  if (finalActualTotal == null) return bases;
  const total = BigInt(finalActualTotal);
  if (total < 0n) throw new RangeError('final actual total must not be negative');
  if (bases.some((b) => b > 0n)) return largestRemainder(total, bases);
  // All prices are 0: spread by the units still expected (lines with nothing left get 0).
  return largestRemainder(total, lines.map((l) => BigInt(costQty(l))));
}

/**
 * Cost of every single unit of a line (stage 2B gives them to physical units): floor(total / qty);
 * the remaining UZS go +1 to the first units, so Σ = total exactly.
 */
export function unitCosts(allocatedTotal: number | bigint, qty: number): bigint[] {
  if (qty <= 0) return [];
  const total = BigInt(allocatedTotal);
  const q = BigInt(qty);
  const base = total / q;
  const extra = Number(total % q);
  return Array.from({ length: qty }, (_, i) => (i < extra ? base + 1n : base));
}

/** For screens: cheapest and dearest unit of a line (they differ by at most 1 UZS). */
export function unitCostRange(allocatedTotal: number | bigint | null, qty: number): { min: number; max: number } | null {
  if (allocatedTotal == null || qty <= 0) return null;
  const units = unitCosts(allocatedTotal, qty);
  return { min: Number(units[units.length - 1]), max: Number(units[0]) };
}

export interface ProgressLine {
  ordered_qty: number;
  cancelled_qty: number;
  received_qty: number;
}

/** Still expected = max(0, ordered - cancelled - received). */
export const remainingQty = (l: ProgressLine) => Math.max(0, l.ordered_qty - l.cancelled_qty - l.received_qty);

/** «получено / заказано» and the computed «отменена полностью». */
export function purchaseProgress(lines: ProgressLine[]) {
  const ordered = lines.reduce((s, l) => s + l.ordered_qty, 0);
  const cancelled = lines.reduce((s, l) => s + l.cancelled_qty, 0);
  const received = lines.reduce((s, l) => s + l.received_qty, 0);
  return {
    ordered,
    cancelled,
    received,
    expected: Math.max(0, ordered - cancelled), // what should arrive after the cancellations
    remaining: lines.reduce((s, l) => s + remainingQty(l), 0),
    fully_cancelled: lines.length > 0 && lines.every((l) => l.cancelled_qty >= l.ordered_qty),
  };
}

/** RECEIVED once nothing is expected any more and something arrived; otherwise EXPECTED (only two statuses). */
export function derivePurchaseStatus(lines: ProgressLine[]): 'EXPECTED' | 'RECEIVED' {
  const p = purchaseProgress(lines);
  return lines.length > 0 && p.remaining === 0 && p.received > 0 ? 'RECEIVED' : 'EXPECTED';
}
