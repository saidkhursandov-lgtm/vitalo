/**
 * 3.1: search in the region / district picker. One query finds a place by its Russian or Uzbek (Latin) name,
 * in any case, by any part of a word, and across scripts: «чилан», «Chilon», «chilanzar» → Чиланзарский район.
 */

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

/** Lower case, «ё» → «е», Uzbek apostrophes (oʻ, gʻ, ʼ) dropped, extra spaces removed. */
export function normalizePlace(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[ʻʼ‘’`'´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cyrillic → the Latin spelling Uzbek uses (Чиланзар → chilanzar, Шайхантахур → shayxantaxur). */
export function toLatin(s: string): string {
  return [...normalizePlace(s)].map((c) => CYR_TO_LAT[c] ?? c).join('');
}

/** Letters spelt differently in Russian and Uzbek transliteration are folded together: x/h, q/k. */
const fold = (s: string) => s.replace(/x/g, 'h').replace(/q/g, 'k');

/** Does the query match this place (Russian and Uzbek names)? An empty query matches everything. */
export function matchesPlace(query: string, place: { name_ru: string; name_uz?: string | null }): boolean {
  const q = normalizePlace(query);
  if (!q) return true;
  const ru = normalizePlace(place.name_ru);
  const uz = normalizePlace(place.name_uz ?? '');
  if (ru.includes(q) || uz.includes(q)) return true;
  const ql = fold(toLatin(q));
  return fold(toLatin(ru)).includes(ql) || fold(uz).includes(ql);
}

/** Matches first by how early the query appears in the name (prefix first), then alphabetically. */
export function rankPlaces<T extends { name_ru: string; name_uz?: string | null }>(items: T[], query: string, label: (x: T) => string, locale: string): T[] {
  const q = normalizePlace(query);
  const pos = (x: T) => {
    if (!q) return 0;
    const i = Math.min(...[normalizePlace(x.name_ru).indexOf(q), normalizePlace(x.name_uz ?? '').indexOf(q)].map((n) => (n < 0 ? 999 : n)));
    return i === 999 ? 500 : i;
  };
  return items
    .filter((x) => matchesPlace(query, x))
    .sort((a, b) => pos(a) - pos(b) || label(a).localeCompare(label(b), locale));
}
