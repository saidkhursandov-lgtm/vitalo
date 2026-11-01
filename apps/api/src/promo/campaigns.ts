/**
 * 3.7: sales («Акции») — a part of the one discount module (D-39). Pure functions: no database, covered by unit tests.
 * A sale never changes products.price_uzs: while it runs, the shop shows the sale price and the regular price crossed
 * out; when it ends (or is switched off) the regular price is simply shown again.
 */
import { minUnitPrice, PromoGuard } from './pricing';

export const CAMPAIGN_SKINS = ['none', 'black_friday', 'eleven_eleven', 'sale'] as const;
export type CampaignSkinCode = (typeof CAMPAIGN_SKINS)[number];

/** D-28: up to 35% only inside a sale with an end date. */
export const CAMPAIGN_MAX_PCT = 35;
/** D-09: a sale without an end date keeps the usual limit. */
export const CAMPAIGN_MAX_PCT_OPEN = 25;
/** «Без даты окончания»: end_at is stored far away (the column is required). */
export const OPEN_END = new Date('2100-01-01T00:00:00.000Z');
/** A sale price from a percent is rounded UP to whole hundreds (the discount never exceeds the percent). */
export const CAMPAIGN_ROUNDING_UZS = 100;

/** One product of a sale: a discount in % or a sale price in sum (one of the two). */
export interface CampaignTarget {
  discount_pct: number | null;
  campaign_price_uzs: number | null;
}

/** The sale price of one jar (before the margin floor). */
export function targetPrice(list: number, t: CampaignTarget): number {
  if (t.campaign_price_uzs != null) return t.campaign_price_uzs;
  const pct = Math.min(Math.max(t.discount_pct ?? 0, 0), 100);
  return Math.ceil((list * (100 - pct)) / 100 / CAMPAIGN_ROUNDING_UZS) * CAMPAIGN_ROUNDING_UZS;
}

/** The percent the badge shows (whole, rounded). */
export function discountPctOf(list: number, price: number): number {
  return list > 0 ? Math.round((1 - price / list) * 100) : 0;
}

export type TargetProblem = 'bad_value' | 'no_discount' | 'too_big' | 'below_margin';

export interface TargetCheck {
  price_uzs: number;
  discount_pct: number;
  /** The lowest allowed price of one jar: cost × (1 + min markup), without a cost — the max discount from the settings. */
  floor_uzs: number;
  /** The biggest allowed discount for this sale (35% with an end date, 25% without). */
  max_pct: number;
  problem: TargetProblem | null;
}

/** The admin form and the save: what the product would cost in the sale and what is wrong with it. */
export function checkTarget(list: number, cost: number | null, t: CampaignTarget, guard: PromoGuard, openEnded: boolean): TargetCheck {
  const max_pct = openEnded ? CAMPAIGN_MAX_PCT_OPEN : CAMPAIGN_MAX_PCT;
  const floor_uzs = minUnitPrice({ unit_price_uzs: list, cost_uzs: cost }, guard);
  const bad = (t.discount_pct == null) === (t.campaign_price_uzs == null) || (t.discount_pct != null && (t.discount_pct < 1 || t.discount_pct > 90)) || (t.campaign_price_uzs != null && t.campaign_price_uzs < 100);
  const price_uzs = bad ? list : targetPrice(list, t);
  const res = { price_uzs, discount_pct: discountPctOf(list, price_uzs), floor_uzs, max_pct };
  if (bad || list <= 0) return { ...res, problem: 'bad_value' };
  if (price_uzs >= list) return { ...res, problem: 'no_discount' };
  // exact, not the rounded badge: 64 999 of 100 000 is already more than 35%
  if ((list - price_uzs) * 100 > list * max_pct) return { ...res, problem: 'too_big' };
  if (price_uzs < floor_uzs) return { ...res, problem: 'below_margin' };
  return { ...res, problem: null };
}

/**
 * The price the shop charges now. The form does not let a price below the margin floor be saved, but the purchase cost
 * may grow later (a new delivery): the floor then wins. No discount left — the product is sold at its regular price.
 */
export function effectivePrice(list: number, cost: number | null, t: CampaignTarget, guard: PromoGuard): { price_uzs: number; discount_pct: number } | null {
  if (list <= 0) return null;
  const price = Math.max(targetPrice(list, t), minUnitPrice({ unit_price_uzs: list, cost_uzs: cost }, guard));
  if (price >= list) return null;
  return { price_uzs: price, discount_pct: discountPctOf(list, price) };
}

/** Two sales share a moment ([start, end), the end itself is not inside). */
export function periodsOverlap(a: { start_at: Date; end_at: Date }, b: { start_at: Date; end_at: Date }): boolean {
  return a.start_at < b.end_at && b.start_at < a.end_at;
}

export type CampaignState = 'disabled' | 'scheduled' | 'running' | 'ended';

/** Switched on and inside its dates = running; the shop shows it by the clock, nothing has to switch it. */
export function campaignState(p: { status: string; start_at: Date; end_at: Date }, now: Date): CampaignState {
  if (p.status !== 'active') return 'disabled';
  if (p.start_at > now) return 'scheduled';
  if (p.end_at <= now) return 'ended';
  return 'running';
}
