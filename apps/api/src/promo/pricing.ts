/**
 * 3.3: the one discount calculation (D-39). Pure functions: no database, so every rule is covered by unit tests.
 * Order of the calculation: product price (already the selling price) → promo code → (bonuses, release 4) → delivery → total.
 */

/** D-09: a crossed-out price is shown only for discounts up to this many percent (D-28: up to 35% later, in a sale). */
export const MAX_SHOWN_DISCOUNT_PCT = 25;
/** D-39: a promo code never applies to a product whose VISIBLE discount is above this. */
export const PROMO_MAX_PRODUCT_DISCOUNT_PCT = 15;
/** Promo discounts are rounded DOWN to whole hundreds of sum. */
export const PROMO_ROUNDING_UZS = 100;

/** Margin protection («Настройки → Промокоды»). */
export interface PromoGuard {
  /** The line price after a discount stays at least purchase cost × (1 + this %). */
  min_markup_pct: number;
  /** A product without a purchase cost: the promo discount of its line is at most this %. */
  max_discount_pct: number;
}
export const PROMO_GUARD_DEFAULT: PromoGuard = { min_markup_pct: 10, max_discount_pct: 20 };

export interface PricingLine {
  product_id: string;
  brand_id: string | null;
  qty: number;
  unit_price_uzs: number;
  old_price_uzs: number | null;
  /** The purchase cost of one jar (the larger of the product cost and the dearest jar on stock), null = unknown. */
  cost_uzs: number | null;
  /** 3.7: in a running sale — the regular price (unit_price_uzs is then the sale price) and the sale's percent. */
  list_price_uzs?: number;
  campaign_pct?: number | null;
}

export type PromoKind = 'percent' | 'fixed' | 'free_delivery';

export interface PromoTargets {
  scope: 'order' | 'brand' | 'product';
  product_ids: string[];
  brand_ids: string[];
}

/** The discount the customer actually sees as a crossed-out price (same rule as the Mini App); null = none shown. */
export function visibleDiscountPct(price: number, oldPrice: number | null): number | null {
  if (!oldPrice || oldPrice <= price) return null;
  const pct = Math.round((1 - price / oldPrice) * 100);
  return pct > MAX_SHOWN_DISCOUNT_PCT ? null : pct;
}

/** The discount the customer sees on the line: the sale's percent (3.7), otherwise the crossed-out «old price». */
export function shownDiscountPct(l: Pick<PricingLine, 'unit_price_uzs' | 'old_price_uzs' | 'campaign_pct'>): number {
  return l.campaign_pct ?? visibleDiscountPct(l.unit_price_uzs, l.old_price_uzs) ?? 0;
}

/** The lines a promo code may touch: its targets, and never a product with a visible discount (or a sale) above 15%. */
export function eligibleLines(lines: PricingLine[], t: PromoTargets): PricingLine[] {
  return lines.filter((l) => {
    if (shownDiscountPct(l) > PROMO_MAX_PRODUCT_DISCOUNT_PCT) return false;
    if (t.scope === 'product') return t.product_ids.includes(l.product_id);
    if (t.scope === 'brand') return !!l.brand_id && t.brand_ids.includes(l.brand_id);
    return true;
  });
}

/**
 * The lowest price of one jar any discount may bring it to (whole sum, rounded up so the margin is never cut).
 * Without a cost the max discount counts from the REGULAR price, so a sale and a promo code together stay inside it.
 */
export function minUnitPrice(line: Pick<PricingLine, 'unit_price_uzs' | 'cost_uzs' | 'list_price_uzs'>, guard: PromoGuard): number {
  if (line.cost_uzs != null) return Math.ceil((line.cost_uzs * (100 + guard.min_markup_pct)) / 100);
  const list = line.list_price_uzs ?? line.unit_price_uzs;
  return list - Math.floor((list * guard.max_discount_pct) / 100);
}

/** How much a promo may take off a whole line (never negative). */
export function lineHeadroom(line: PricingLine, guard: PromoGuard): number {
  return Math.max(0, (line.unit_price_uzs - minUnitPrice(line, guard)) * line.qty);
}

export interface LineDiscount {
  product_id: string;
  discount_uzs: number;
  /** The margin protection cut this line's discount. */
  capped: boolean;
}

export interface GoodsDiscount {
  total_uzs: number;
  lines: LineDiscount[];
  /** The customer gets less than the code promises (margin protection). */
  capped: boolean;
}

/**
 * The promo discount on goods (percent or a fixed sum) over the eligible lines:
 * 1. each line wants its share: percent — its own %, fixed — the sum split by line totals;
 * 2. a line never goes below its margin floor (lineHeadroom);
 * 3. fixed: what one line could not take moves to lines that still have room;
 * 4. the total is rounded down to 100 sum and split back into whole sums by the largest remainder.
 */
export function goodsDiscount(kind: 'percent' | 'fixed', value: number, lines: PricingLine[], guard: PromoGuard): GoodsDiscount {
  const total = (l: PricingLine) => l.unit_price_uzs * l.qty;
  const base = lines.reduce((s, l) => s + total(l), 0);
  if (!lines.length || base <= 0 || value <= 0) return { total_uzs: 0, lines: lines.map((l) => ({ product_id: l.product_id, discount_uzs: 0, capped: false })), capped: false };

  const room = lines.map((l) => lineHeadroom(l, guard));
  const wanted = kind === 'percent' ? lines.map((l) => (total(l) * Math.min(value, 100)) / 100) : lines.map((l) => (Math.min(value, base) * total(l)) / base);
  const promised = wanted.reduce((s, w) => s + w, 0);
  const got = wanted.map((w, i) => Math.min(w, room[i]));

  if (kind === 'fixed') {
    // hand the leftover to lines that still have room, in proportion to that room
    for (let pass = 0; pass < lines.length; pass++) {
      const left = promised - got.reduce((s, g) => s + g, 0);
      const free = got.map((g, i) => room[i] - g);
      const freeSum = free.reduce((s, f) => s + f, 0);
      if (left < 1 || freeSum < 1) break;
      got.forEach((g, i) => (got[i] = g + Math.min(free[i], (left * free[i]) / freeSum)));
    }
  }

  const sum = got.reduce((s, g) => s + g, 0);
  const rounded = Math.floor(sum / PROMO_ROUNDING_UZS) * PROMO_ROUNDING_UZS;
  const split = splitWhole(rounded, got);
  return {
    total_uzs: rounded,
    lines: lines.map((l, i) => ({ product_id: l.product_id, discount_uzs: split[i], capped: wanted[i] > room[i] + 0.5 })),
    capped: Math.floor(promised / PROMO_ROUNDING_UZS) * PROMO_ROUNDING_UZS > rounded,
  };
}

/** Splits a whole amount by weights into whole parts (largest remainder; ties: the earlier line). */
export function splitWhole(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (amount * w) / sum);
  const parts = exact.map(Math.floor);
  let rest = amount - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    parts[i] += 1;
    rest -= 1;
  }
  return parts;
}

export interface MarginWarning {
  product_id: string;
  sku: string;
  name: string;
  wanted_uzs: number;
  allowed_uzs: number;
  reason: 'margin' | 'no_cost' | 'product_discount';
}

/**
 * Margin warning for the admin form: for each product the code may touch, what the code wants to take off one jar and
 * what the margin protection allows. Only products where the protection cuts the discount (or the product is excluded).
 */
export function marginWarnings(
  kind: PromoKind,
  value: number,
  products: (PricingLine & { sku: string; name: string })[],
  guard: PromoGuard,
): MarginWarning[] {
  if (kind === 'free_delivery') return [];
  return products.flatMap((p): MarginWarning[] => {
    const one = { ...p, qty: 1 };
    const wanted = kind === 'percent' ? Math.floor((p.unit_price_uzs * Math.min(value, 100)) / 100) : Math.min(value, p.unit_price_uzs);
    if (shownDiscountPct(p) > PROMO_MAX_PRODUCT_DISCOUNT_PCT) {
      return [{ product_id: p.product_id, sku: p.sku, name: p.name, wanted_uzs: wanted, allowed_uzs: 0, reason: 'product_discount' }];
    }
    const allowed = lineHeadroom(one, guard);
    return wanted > allowed ? [{ product_id: p.product_id, sku: p.sku, name: p.name, wanted_uzs: wanted, allowed_uzs: allowed, reason: p.cost_uzs == null ? 'no_cost' : 'margin' }] : [];
  });
}

/** Promo codes: Latin letters and digits; case and spaces at the edges do not matter (« vitalo10 » = VITALO10). */
export const PROMO_CODE_RE = /^[A-Z0-9]{3,32}$/;
export function normalizePromoCode(input: string): string {
  return input.trim().toUpperCase();
}
