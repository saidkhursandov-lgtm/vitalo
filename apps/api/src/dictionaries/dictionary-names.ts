/**
 * Stage 1 dictionaries: brands, manufacturers, countries, forms. The product keeps its text columns
 * (brand / manufacturer / country / form) for the Mini App; *_id links them to a dictionary value.
 */
export const DICTIONARY_KINDS = ['brands', 'manufacturers', 'countries', 'forms'] as const;
export type DictionaryKind = (typeof DICTIONARY_KINDS)[number];

/** Product columns of each dictionary: the copied name and the link. */
export const DICTIONARY_COLUMNS = {
  brands: { text: 'brand', id: 'brand_id', label: 'бренд' },
  manufacturers: { text: 'manufacturer', id: 'manufacturer_id', label: 'производитель' },
  countries: { text: 'country', id: 'country_id', label: 'страна' },
  forms: { text: 'form', id: 'form_id', label: 'форма' },
} as const satisfies Record<DictionaryKind, { text: string; id: string; label: string }>;

export const isDictionaryKind = (k: string): k is DictionaryKind => (DICTIONARY_KINDS as readonly string[]).includes(k);

/** A name as stored: trimmed, inner whitespace collapsed to one space. */
export const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Two names are «the same value» when they differ only in case, extra spaces or ё/е.
 * (The database unique index ignores case and spaces; ё/е is checked by the application.)
 */
export const matchKey = (s: string) => cleanName(s).toLowerCase().replace(/ё/g, 'е');

/** Looser key for the «possible duplicates» report: also without quotes, punctuation and legal forms. */
export function looseKey(s: string): string {
  return matchKey(s)
    .replace(/["'«»„“”`]/g, '')
    .replace(/\b(ооо|оао|зао|пао|ао|ип|llc|ltd|inc|gmbh|co)\b\.?/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Small edit distance (for «похожие названия»): Levenshtein, stops early above max. */
export function closeEnough(a: string, b: string, max = 2): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin > max) return false;
  }
  return prev[b.length] <= max;
}
