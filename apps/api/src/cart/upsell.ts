/**
 * 3.1: «Добавьте ещё X сум — доставка бесплатна» + 2–3 products under it. Pure ranking, tested on its own.
 * The best product is the cheapest one that closes the gap (the delivery becomes free and the extra spend is small);
 * products below the gap come after them (they help, but do not reach the threshold). Expensive products are never
 * offered: at most the gap doubled, or the gap plus 100 000 sum when the gap is small.
 */
export const UPSELL_COUNT = 3;
export const UPSELL_MIN_COUNT = 2;

export interface UpsellCandidate {
  id: string;
  price_uzs: number;
}

export function priceCap(gap: number): number {
  return Math.max(gap * 2, gap + 100_000);
}

export function rankUpsell<T extends UpsellCandidate>(items: T[], gap: number, count = UPSELL_COUNT): T[] {
  const score = (p: T) => (p.price_uzs >= gap ? p.price_uzs - gap : 1_000_000_000 + (gap - p.price_uzs));
  return items
    .filter((p) => p.price_uzs > 0 && p.price_uzs <= priceCap(gap))
    .sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))
    .slice(0, count);
}

/** «Настройки → Корзина»: the block on/off and the optional hand-picked products (empty = picked automatically). */
export interface CartUpsellSettings {
  enabled: boolean;
  product_ids: string[];
}
export const CART_UPSELL_DEFAULT: CartUpsellSettings = { enabled: true, product_ids: [] };
