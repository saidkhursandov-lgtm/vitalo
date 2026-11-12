import { lineHeadroom, PricingLine, PROMO_MAX_PRODUCT_DISCOUNT_PCT, PromoGuard, shownDiscountPct, splitWhole } from '../promo/pricing';

/**
 * 3.10-А (D-71): «Настройки → VITALO Bonus». Not inserted by a migration: the default is used until an admin saves one.
 * - cashback_pct: accrued from the goods really paid (no delivery, no bonuses), after «Доставлен» and payment;
 * - max_spend_pct: bonuses pay at most this share of the goods (delivery is always money);
 * - lifetime_days: the balance burns this many days after the last accrual; remind_days before — a message;
 * - review_uzs / review_photo_uzs: the bonus for a published review (3.10-Б).
 */
export interface BonusSettings {
  enabled: boolean;
  cashback_pct: number;
  max_spend_pct: number;
  lifetime_days: number;
  remind_days: number;
  review_uzs: number;
  review_photo_uzs: number;
}

export const BONUS_DEFAULT: BonusSettings = {
  enabled: true,
  cashback_pct: 3,
  max_spend_pct: 25,
  lifetime_days: 90,
  remind_days: 7,
  review_uzs: 3000,
  review_photo_uzs: 5000,
};

/** Bonuses are spent in whole hundreds (like promo discounts). */
export const BONUS_ROUNDING_UZS = 100;

/** Why bonuses cannot be spent on this order (null — they can). */
export type BonusBlock = 'disabled' | 'empty' | 'promo' | 'big_sale' | 'margin';

export interface BonusSpend {
  /** The most the customer may spend on this order now. */
  available_uzs: number;
  blocked: BonusBlock | null;
  /** Bonuses per line (product_id → sum) when `use` is the amount spent. */
  lines: Map<string, number>;
  used_uzs: number;
}

/**
 * How much of the balance may pay for these lines:
 * - never together with a promo code;
 * - a line with a visible discount (or a sale) above 15% takes no bonuses (like promo codes);
 * - at most max_spend_pct of the eligible goods, and never below the margin floor of a line (promo guard);
 * - rounded down to 100 sum; split over the lines by their room (no line goes below its floor).
 */
export function bonusSpend(input: { balance_uzs: number; lines: PricingLine[]; guard: PromoGuard; settings: BonusSettings; promoApplied: boolean; use: boolean }): BonusSpend {
  const none = (blocked: BonusBlock | null): BonusSpend => ({ available_uzs: 0, blocked, lines: new Map(), used_uzs: 0 });
  const s = input.settings;
  if (!s.enabled || s.max_spend_pct <= 0) return none('disabled');
  if (input.balance_uzs < BONUS_ROUNDING_UZS) return none('empty');
  if (input.promoApplied) return none('promo');
  const eligible = input.lines.filter((l) => shownDiscountPct(l) <= PROMO_MAX_PRODUCT_DISCOUNT_PCT);
  if (!eligible.length) return none('big_sale');

  const base = eligible.reduce((sum, l) => sum + l.unit_price_uzs * l.qty, 0);
  const room = eligible.map((l) => lineHeadroom(l, input.guard));
  const roomSum = room.reduce((a, b) => a + b, 0);
  const cap = Math.min(input.balance_uzs, Math.floor((base * Math.min(s.max_spend_pct, 100)) / 100), roomSum);
  const available = Math.floor(cap / BONUS_ROUNDING_UZS) * BONUS_ROUNDING_UZS;
  if (available <= 0) return none('margin');
  if (!input.use) return { available_uzs: available, blocked: null, lines: new Map(), used_uzs: 0 };

  const split = splitWhole(available, room);
  return { available_uzs: available, blocked: null, lines: new Map(eligible.map((l, i) => [l.product_id, split[i]])), used_uzs: available };
}

/** The cashback of an order: cashback_pct of the goods really paid, whole sum down. */
export function cashbackOf(goodsPaidUzs: number, pct: number): number {
  if (!(pct > 0) || goodsPaidUzs <= 0) return 0;
  return Math.floor((goodsPaidUzs * pct) / 100);
}

/** The settings as saved by an admin, with missing or broken values taken from the default. */
export function normalizeBonusSettings(v: Partial<BonusSettings> | null | undefined): BonusSettings {
  const n = (x: unknown, d: number, min: number, max: number) => (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : d);
  const d = BONUS_DEFAULT;
  return {
    enabled: typeof v?.enabled === 'boolean' ? v.enabled : d.enabled,
    cashback_pct: n(v?.cashback_pct, d.cashback_pct, 0, 10),
    max_spend_pct: n(v?.max_spend_pct, d.max_spend_pct, 0, 50),
    lifetime_days: n(v?.lifetime_days, d.lifetime_days, 30, 730),
    remind_days: n(v?.remind_days, d.remind_days, 1, 30),
    review_uzs: n(v?.review_uzs, d.review_uzs, 0, 100_000),
    review_photo_uzs: n(v?.review_photo_uzs, d.review_photo_uzs, 0, 100_000),
  };
}
