/** Stage 2.2: brand addresses (slug) and brand names written in different ways («NOW» and «NOW Foods»). */

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

/** «NOW Foods» -> now-foods, «Эвалар» -> evalar; empty when nothing usable is left. */
export function slugify(name: string): string {
  return [...name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')]
    .map((ch) => CYR[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** A free address for a brand: the name's slug, then slug-2, slug-3 … */
export function uniqueSlug(name: string, taken: Set<string>, fallback = 'brand'): string {
  const base = slugify(name) || fallback;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Words a brand name often has or lacks: «NOW» vs «NOW Foods», «Solgar» vs «Solgar Vitamins». */
const NOISE = new Set(['foods', 'food', 'nutrition', 'labs', 'lab', 'laboratories', 'vitamins', 'pharma', 'pharm', 'inc', 'ltd', 'llc', 'co', 'company', 'health', 'natural', 'naturals', 'ооо', 'зао']);

export function brandKey(name: string): string {
  return slugify(name)
    .split('-')
    .filter((w) => w && !NOISE.has(w))
    .join('');
}

/**
 * Groups of brands that look like one brand: same name without spaces, case and «Foods / Labs / Nutrition …»,
 * or one name being the start of another. Only a list for the owner — nothing is merged automatically.
 */
export function similarBrandGroups<T extends { name_ru: string }>(brands: T[]): T[][] {
  const keyed = brands.map((b) => ({ b, key: brandKey(b.name_ru) || slugify(b.name_ru) }));
  const parent = keyed.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const [a, b] = [keyed[i].key, keyed[j].key];
      if (!a || !b) continue;
      const short = a.length <= b.length ? a : b;
      const long = a.length <= b.length ? b : a;
      if (a === b || (short.length >= 3 && long.startsWith(short))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, T[]>();
  keyed.forEach(({ b }, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), b]));
  return [...groups.values()].filter((g) => g.length > 1);
}
