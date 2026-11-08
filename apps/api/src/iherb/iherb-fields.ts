/**
 * Генплан, этап 5, ветка iherb-1-fields (D-57, docs/plans/IHERB_PLAN.md): the iHerb link of a product and the
 * values of the «1-в-1» match with competitors (brand + chemical form + dose per capsule/serving + pack count).
 */

/** Units of a dose: мг, мкг, МЕ, г, мл, млрд КОЕ (probiotics). */
export const DOSE_UNITS = ['mg', 'mcg', 'iu', 'g', 'ml', 'cfu_bn'] as const;
export type DoseUnit = (typeof DOSE_UNITS)[number];
/** What the dose is given for. */
export const DOSE_PER = ['capsule', 'tablet', 'softgel', 'serving', 'drop'] as const;
export type DosePer = (typeof DOSE_PER)[number];
/** What auto pricing does while the product is on our shelf (D-57). */
export const STOCK_PRICE_MODES = ['freeze', 'dynamic'] as const;

/** iHerb product link: uz.iherb.com / www.iherb.com / iherb.com, …/pr/<slug>/<number>. */
const IHERB_URL = /^https:\/\/(?:[a-z]{2}\.|www\.)?iherb\.com\/pr\/(?:[^/?#]+\/)?(\d{2,10})(?:[/?#].*)?$/i;

/**
 * Normalizes a pasted iHerb link: drops ?query and #anchor (tracking codes), keeps the product path.
 * Returns null for anything that is not an iHerb product page.
 */
export function parseIherbUrl(raw: string): { url: string; productId: string } | null {
  const s = raw.trim();
  const m = IHERB_URL.exec(s);
  if (!m) return null;
  const url = s.replace(/[?#].*$/, '').replace(/\/$/, '');
  return { url, productId: m[1] };
}

/** «Цитрат», « бисглицинат  » → «цитрат», «бисглицинат»: one spelling, so the match compares like with like. */
export const normalizeMatchForm = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
