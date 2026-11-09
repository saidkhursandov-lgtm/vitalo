/**
 * Генплан, этап 5, ветка iherb-2-prices (D-57, docs/plans/IHERB_PLAN.md «Автоцена»): the VITALO price from the iHerb price.
 *
 * new price = iHerb price × (1 + markup %), rounded to the NEAREST price_round_to (6а-В, D-62: 270 254 → 270 000,
 * 386 773 → 387 000; was «up»). Guards:
 *  (а) never below the purchase cost + the minimum markup of «Настройки → Промокоды» (the 3.3 rule);
 *  (б) a jump of more than 20% is applied at once (owner's decision) and only flagged;
 *  (в) the product is on our shelf and the mode is «freeze» — the price stays, only the chart moves;
 *  (г) iHerb has no stock — the price stays (a missing price is not a price).
 */

export const BIG_JUMP_PCT = 20;

export interface AutoPriceInput {
  iherb_price_uzs: number;
  iherb_in_stock: boolean;
  markup_percent: number;
  price_round_to: number;
  stock_price_mode: string;
  /** Jars a customer can buy now (on hand − reserved). */
  available: number;
  current_price_uzs: number;
  /** Purchase cost of one jar (the highest known), null = unknown. */
  cost_uzs: number | null;
  /** Minimum markup over the cost, % (promo_guard.min_markup_pct). */
  min_markup_pct: number;
}

export type AutoPriceSkip = 'iherb_out_of_stock' | 'in_stock_freeze' | 'no_change';

export interface AutoPriceResult {
  /** What the price would be by the formula (after the floor). */
  target_uzs: number;
  apply: boolean;
  skip_reason: AutoPriceSkip | null;
  floor_applied: boolean;
  big_jump: boolean;
}

/** Up to the next multiple of step (step ≥ 1). */
export const roundUp = (value: number, step: number) => {
  const s = Math.max(1, Math.floor(step));
  return Math.ceil(value / s) * s;
};

/** 6а-В: to the nearest multiple of step, a half goes up (270 254 → 270 000, 386 773 → 387 000, 270 500 → 271 000). */
export const roundNearest = (value: number, step: number) => {
  const s = Math.max(1, Math.floor(step));
  return Math.max(s, Math.round(value / s) * s);
};

export function autoPrice(i: AutoPriceInput): AutoPriceResult {
  // the floor below stays rounded UP: the price never falls under cost + the minimum markup
  let target = roundNearest((i.iherb_price_uzs * (100 + i.markup_percent)) / 100, i.price_round_to);
  let floor_applied = false;
  if (i.cost_uzs != null) {
    const floor = roundUp((i.cost_uzs * (100 + i.min_markup_pct)) / 100, i.price_round_to);
    if (target < floor) {
      target = floor;
      floor_applied = true;
    }
  }
  const big_jump = i.current_price_uzs > 0 && (Math.abs(target - i.current_price_uzs) * 100) / i.current_price_uzs > BIG_JUMP_PCT;
  const base = { target_uzs: target, floor_applied, big_jump };
  if (!i.iherb_in_stock) return { ...base, apply: false, skip_reason: 'iherb_out_of_stock' };
  if (i.available > 0 && i.stock_price_mode !== 'dynamic') return { ...base, apply: false, skip_reason: 'in_stock_freeze' };
  if (target === i.current_price_uzs) return { ...base, apply: false, skip_reason: 'no_change' };
  return { ...base, apply: true, skip_reason: null };
}

/** Plain words for the admin panel. */
export const SKIP_LABELS: Record<AutoPriceSkip, string> = {
  iherb_out_of_stock: 'на iHerb нет в наличии — цену не трогаем',
  in_stock_freeze: 'товар есть на складе, режим «Цену не менять»',
  no_change: 'цена уже такая',
};
