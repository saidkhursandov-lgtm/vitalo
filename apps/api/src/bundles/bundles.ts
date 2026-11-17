/**
 * Release 4.3 «Сеты от врача»: 2–3 products with a doctor's text and a discount of their own (0–10%, D-75).
 * Pure functions (no database): the set discount in the cart and the margin of a set in the admin.
 */
import { lineHeadroom, PricingLine, PROMO_MAX_PRODUCT_DISCOUNT_PCT, PROMO_ROUNDING_UZS, PromoGuard, shownDiscountPct, splitWhole } from '../promo/pricing';

/** D-75: the discount of a set is 0–10%. */
export const BUNDLE_MAX_DISCOUNT_PCT = 10;
/** D-13 / D-75: a set is saved only with a margin of at least 30% after its discount. */
export const BUNDLE_MIN_MARGIN_PCT = 30;
export const BUNDLE_MIN_ITEMS = 2;
export const BUNDLE_MAX_ITEMS = 3;

export interface BundleRule {
  id: string;
  title_ru: string;
  title_uz: string | null;
  discount_pct: number;
  items: { product_id: string; qty: number }[];
}

export interface BundleApplied {
  bundle_id: string;
  title_ru: string;
  title_uz: string | null;
  /** how many full sets the cart holds */
  times: number;
  amount_uzs: number;
}

export interface BundleDiscount {
  total_uzs: number;
  /** product → the set discount of its line */
  lines: Map<string, number>;
  applied: BundleApplied[];
}

/**
 * The set discounts of a cart. A set counts while the cart holds all of its products (each in its quantity); two sets
 * never share a jar (the earlier set in the list takes it first). A jar in a sale above 15% gets no set discount; a
 * line never goes below its margin floor. Each set's sum is rounded down to 100 sum.
 */
export function bundleDiscount(lines: PricingLine[], bundles: BundleRule[], guard: PromoGuard): BundleDiscount {
  const free = new Map(lines.map((l) => [l.product_id, l.qty]));
  const room = new Map(lines.map((l) => [l.product_id, lineHeadroom(l, guard)]));
  const out = new Map<string, number>();
  const applied: BundleApplied[] = [];
  for (const b of bundles) {
    if (b.discount_pct <= 0 || b.items.length < BUNDLE_MIN_ITEMS) continue;
    const times = Math.min(...b.items.map((i) => Math.floor((free.get(i.product_id) ?? 0) / Math.max(1, i.qty))));
    if (!(times >= 1)) continue;
    const pct = Math.min(b.discount_pct, BUNDLE_MAX_DISCOUNT_PCT);
    const got = b.items.map((i) => {
      const l = lines.find((x) => x.product_id === i.product_id)!;
      if (shownDiscountPct(l) > PROMO_MAX_PRODUCT_DISCOUNT_PCT) return 0;
      return Math.min((l.unit_price_uzs * i.qty * times * pct) / 100, room.get(i.product_id) ?? 0);
    });
    const amount = Math.floor(got.reduce((s, g) => s + g, 0) / PROMO_ROUNDING_UZS) * PROMO_ROUNDING_UZS;
    for (const i of b.items) free.set(i.product_id, (free.get(i.product_id) ?? 0) - i.qty * times);
    if (amount <= 0) continue;
    const split = splitWhole(amount, got);
    b.items.forEach((i, k) => {
      out.set(i.product_id, (out.get(i.product_id) ?? 0) + split[k]);
      room.set(i.product_id, (room.get(i.product_id) ?? 0) - split[k]);
    });
    applied.push({ bundle_id: b.id, title_ru: b.title_ru, title_uz: b.title_uz, times, amount_uzs: amount });
  }
  return { total_uzs: applied.reduce((s, a) => s + a.amount_uzs, 0), lines: out, applied };
}

export interface BundleMargin {
  list_total_uzs: number;
  /** the price of the set after its discount (rounded down to 100 sum, like the cart) */
  sale_total_uzs: number;
  /** null: a product of the set has no purchase cost */
  cost_total_uzs: number | null;
  margin_pct: number | null;
  /** the margin after the discount is below 30% (or unknown): the set cannot be saved */
  too_low: boolean;
}

/** The admin form: the set price without and with the discount and its margin over the purchase cost. */
export function bundleMargin(items: { price_uzs: number; cost_uzs: number | null; qty: number }[], discountPct: number): BundleMargin {
  const list = items.reduce((s, i) => s + i.price_uzs * i.qty, 0);
  const off = Math.floor((list * Math.min(Math.max(discountPct, 0), BUNDLE_MAX_DISCOUNT_PCT)) / 100 / PROMO_ROUNDING_UZS) * PROMO_ROUNDING_UZS;
  const sale = list - off;
  const known = items.every((i) => i.cost_uzs != null);
  const cost = known ? items.reduce((s, i) => s + (i.cost_uzs ?? 0) * i.qty, 0) : null;
  const margin = cost == null || sale <= 0 ? null : Math.round(((sale - cost) / sale) * 1000) / 10;
  return { list_total_uzs: list, sale_total_uzs: sale, cost_total_uzs: cost, margin_pct: margin, too_low: margin == null || margin < BUNDLE_MIN_MARGIN_PCT };
}

/** «Хватит на X дней»: the shortest course of the set (jars × servings ÷ servings a day); null without the data. */
export function bundleDays(items: { qty: number; pack_count: number | null; servings_per_day: number | null }[]): number | null {
  const days = items.map((i) => (i.pack_count && i.servings_per_day ? Math.floor((i.qty * i.pack_count) / i.servings_per_day) : null));
  return days.some((d) => d == null) || !days.length ? null : Math.min(...(days as number[]));
}
