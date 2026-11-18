/**
 * «Добавить из iHerb» (D-78): the model reads the text of an iHerb product page and drafts the VITALO card in Russian
 * and Uzbek (Latin): names, description, composition, directions, warnings, form, pack size, servings per day, shipping
 * weight and size, categories. Only a draft: a person checks it in the product editor and presses «Создать товар».
 * No database or network access here.
 */
import { DOSE_PER, type DosePer } from './iherb-fields';

export interface CardLists {
  /** active categories: the model answers with the keys «c1», «c2» … (shorter than ids) */
  categories: { key: string; id: string; name_ru: string; tree: string }[];
  brands: string[];
  countries: string[];
  forms: string[];
}

export const CARD_SYSTEM = `Ты — редактор каталога магазина БАДов VITALO (Узбекистан). Тебе дан текст страницы товара iHerb (на любом
языке). Составь по нему карточку товара VITALO на русском и узбекском языке.
Правила:
1. Пиши только то, что есть на странице. Не выдумывай дозы, свойства, сертификаты и страну. Чего нет — null.
2. Узбекский — современный, ЛАТИНИЦЕЙ (никакой кириллицы), на «siz», простыми словами; числа, единицы, названия брендов
   и товаров не переводи.
3. name_ru: «<что это по-русски>, <главная доза>, <количество> <форма>» с брендом латиницей в начале, например
   «NOW Foods, Магний цитрат, 200 мг, 100 таблеток». name_uz — то же по-узбекски. short_name_ru / short_name_uz — до 40
   символов, без бренда: «Магний цитрат 200 мг, 100 таб.».
4. short_description: 2–4 предложения, спокойно и по делу: что это и для чего обычно принимают. Без обещаний лечения
   («лечит», «излечивает», «гарантирует»), без рекламных преувеличений. Это БАД, не лекарство.
5. composition: сначала действующие вещества с дозой на порцию строго по таблице Supplement Facts, каждое с новой
   строки: «Витамин D3 (холекальциферол) — 125 мкг (5000 МЕ)». В первой строке — размер порции: «Размер порции:
   1 капсула». Затем строка «Прочие ингредиенты: …». Перевод названий веществ — общепринятый.
6. directions — способ применения как на этикетке (Suggested Use), без добавлений. warnings — предупреждения этикетки
   (Warnings) и условия хранения, если есть.
7. brand — как на странице латиницей; если бренд есть в списке брендов — ровно как в списке. manufacturer — компания-
   производитель (обычно как бренд). country — страна производства по-русски, только если она написана на странице
   (например «Made in USA» → «США»); если есть в списке стран — ровно как в списке. form — из списка форм, если подходит.
8. pack_count — количество капсул/таблеток/порций в банке (для порошка — порций). servings_per_day — сколько ТЕХ ЖЕ
   единиц, что в pack_count, принимают в день по способу применения (дни курса = pack_count / servings_per_day):
   «по 2 капсулы в день» → 2, «по 2 таблетки 2 раза в день» → 4, «1 мерная ложка в день» → 1; если написан
   диапазон — меньшее число. dose_per — к чему относится доза в составе:
   capsule, tablet, softgel, serving, drop.
9. match_form — химическая форма главного вещества строчными буквами по-русски («цитрат», «бисглицинат»,
   «холекальциферол»), если она написана; иначе null.
10. shipping_weight_g — вес с упаковкой в граммах (Shipping Weight / вес в упаковке; 0.25 kg → 250, 0.5 lb → 227).
    Размеры упаковки в миллиметрах, если написаны (Dimensions: 6.4 x 6.4 x 12.2 cm → 64, 64, 122).
11. price_uzs — цена товара в сумах, если она явно написана на странице для ЭТОГО товара (не для рекомендованных);
    иначе null. in_stock — false, если написано «нет в наличии» / «out of stock», иначе true или null.
12. category_keys — 1–3 ключа подходящих категорий из списка: «по потребности» и РОВНО ОДНА «по типу товара».
13. shell_ru / shell_uz — оболочка капсулы, если написана («говяжий желатин», «растительная (HPMC)»).
14. actives — все действующие вещества состава (без вспомогательных): название по-русски, по-узбекски и по-английски,
    как на странице.
15. search_keywords — 5–12 слов через запятую для поиска (английское название, синонимы, частые ошибки).
16. note — одно-два коротких предложения по-русски для сотрудника: что на странице неясно или противоречиво; иначе
    пустая строка.
Отвечай строго по схеме JSON.`;

const s = { type: 'string' } as const;
const sn = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const intn = { anyOf: [{ type: 'integer' }, { type: 'null' }] } as const;

export const CARD_FIELDS_TEXT = [
  'name_ru',
  'name_uz',
  'short_name_ru',
  'short_name_uz',
  'brand',
  'manufacturer',
  'short_description_ru',
  'short_description_uz',
  'composition_ru',
  'composition_uz',
  'directions_ru',
  'directions_uz',
  'warnings_ru',
  'warnings_uz',
] as const;
const CARD_FIELDS_NULLABLE = ['country', 'form', 'match_form', 'shell_ru', 'shell_uz', 'search_keywords'] as const;
const CARD_FIELDS_INT = ['pack_count', 'servings_per_day', 'shipping_weight_g', 'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'price_uzs'] as const;

export const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...CARD_FIELDS_TEXT, ...CARD_FIELDS_NULLABLE, ...CARD_FIELDS_INT, 'dose_per', 'in_stock', 'category_keys', 'actives', 'note'],
  properties: {
    ...Object.fromEntries(CARD_FIELDS_TEXT.map((k) => [k, s])),
    ...Object.fromEntries(CARD_FIELDS_NULLABLE.map((k) => [k, sn])),
    ...Object.fromEntries(CARD_FIELDS_INT.map((k) => [k, intn])),
    dose_per: { anyOf: [{ type: 'string', enum: [...DOSE_PER] }, { type: 'null' }] },
    in_stock: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    category_keys: { type: 'array', items: s },
    actives: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name_ru', 'name_uz', 'name_en'], properties: { name_ru: s, name_uz: s, name_en: s } },
    },
    note: s,
  },
} as const;

/** What the model reads: the lists to choose from, then the page. */
export function cardDataBlock(pageText: string, lists: CardLists, url: string): string {
  return [
    `Ссылка: ${url}`,
    '',
    `Бренды: ${lists.brands.join('; ')}`,
    `Страны: ${lists.countries.join('; ')}`,
    `Формы: ${lists.forms.join('; ')}`,
    '<категории>',
    ...lists.categories.map((c) => `${c.key} | ${c.tree === 'need' ? 'по потребности' : 'по типу товара'} | ${c.name_ru}`),
    '</категории>',
    '',
    '<страница>',
    pageText,
    '</страница>',
  ].join('\n');
}

export interface CardActive {
  name_ru: string;
  name_uz: string;
  name_en: string;
}

export interface CardDraft {
  name_ru: string;
  name_uz: string | null;
  short_name_ru: string | null;
  short_name_uz: string | null;
  brand: string;
  manufacturer: string;
  country: string | null;
  form: string | null;
  short_description_ru: string | null;
  short_description_uz: string | null;
  composition_ru: string | null;
  composition_uz: string | null;
  directions_ru: string | null;
  directions_uz: string | null;
  warnings_ru: string | null;
  warnings_uz: string | null;
  search_keywords: string | null;
  shell_ru: string | null;
  shell_uz: string | null;
  match_form: string | null;
  pack_count: number | null;
  servings_per_day: number | null;
  dose_per: DosePer | null;
  shipping_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  /** read by the model — used only when the page's data block has no price */
  price_uzs: number | null;
  in_stock: boolean | null;
  category_ids: string[];
  actives: CardActive[];
  note: string;
}

/** Field lengths of ProductInput (admin-products.ts): a longer text would be refused on «Создать товар». */
const MAX: Record<string, number> = {
  name_ru: 200,
  name_uz: 200,
  short_name_ru: 60,
  short_name_uz: 60,
  brand: 100,
  manufacturer: 200,
  country: 100,
  form: 100,
  short_description_ru: 1000,
  short_description_uz: 1000,
  composition_ru: 5000,
  composition_uz: 5000,
  directions_ru: 5000,
  directions_uz: 5000,
  warnings_ru: 5000,
  warnings_uz: 5000,
  search_keywords: 1000,
  shell_ru: 100,
  shell_uz: 100,
  match_form: 80,
};
const CYRILLIC = /[А-Яа-яЁё]/;

const text = (v: unknown, key: string): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t ? t.slice(0, MAX[key] ?? 1000).trim() : null;
};
const int = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** The model's answer → a clean draft; null when the answer has no name or brand (nothing to show). */
export function checkCardAnswer(json: unknown, lists: CardLists): { ok: true; card: CardDraft; problems: string[] } | { ok: false; error: string } {
  if (!json || typeof json !== 'object') return { ok: false, error: 'not_object' };
  const a = json as Record<string, unknown>;
  const name_ru = text(a.name_ru, 'name_ru');
  const brand = text(a.brand, 'brand');
  if (!name_ru || !brand) return { ok: false, error: 'empty' };
  const problems: string[] = [];
  const t = (k: string) => text(a[k], k);
  const uz = (k: string) => {
    const v = t(k);
    if (v && CYRILLIC.test(v)) problems.push(`«${k}»: в узбекском тексте есть кириллица — проверьте`);
    return v;
  };
  const exact = (v: string | null, list: string[]) => (v ? (list.find((x) => x.toLowerCase() === v.toLowerCase()) ?? v) : null);
  const byKey = new Map(lists.categories.map((c) => [c.key, c]));
  // a product has only one «по типу» category (ONE_PRODUCT_TYPE): the model's first one is kept
  let typeTaken = false;
  const category_ids = [...new Set((Array.isArray(a.category_keys) ? a.category_keys : []).map((k) => byKey.get(String(k).trim())).filter((x) => !!x))]
    .filter((c) => c!.tree !== 'product_type' || (!typeTaken && (typeTaken = true)))
    .map((c) => c!.id)
    .slice(0, 3);
  const actives = (Array.isArray(a.actives) ? a.actives : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).name_ru === 'string')
    .map((x) => ({ name_ru: String(x.name_ru).trim().slice(0, 120), name_uz: String(x.name_uz ?? '').trim().slice(0, 120), name_en: String(x.name_en ?? '').trim().slice(0, 120) }))
    .filter((x) => x.name_ru.length >= 2)
    .slice(0, 40);
  const card: CardDraft = {
    name_ru,
    name_uz: uz('name_uz'),
    short_name_ru: t('short_name_ru'),
    short_name_uz: uz('short_name_uz'),
    brand: exact(brand, lists.brands)!,
    manufacturer: t('manufacturer') ?? brand,
    country: exact(t('country'), lists.countries),
    form: exact(t('form'), lists.forms),
    short_description_ru: t('short_description_ru'),
    short_description_uz: uz('short_description_uz'),
    composition_ru: t('composition_ru'),
    composition_uz: uz('composition_uz'),
    directions_ru: t('directions_ru'),
    directions_uz: uz('directions_uz'),
    warnings_ru: t('warnings_ru'),
    warnings_uz: uz('warnings_uz'),
    search_keywords: t('search_keywords'),
    shell_ru: t('shell_ru'),
    shell_uz: uz('shell_uz'),
    match_form: t('match_form')?.toLowerCase() ?? null,
    pack_count: int(a.pack_count, 1, 10000),
    servings_per_day: int(a.servings_per_day, 1, 50),
    dose_per: (DOSE_PER as readonly string[]).includes(a.dose_per as string) ? (a.dose_per as DosePer) : null,
    shipping_weight_g: int(a.shipping_weight_g, 1, 30000),
    shipping_length_mm: int(a.shipping_length_mm, 1, 2000),
    shipping_width_mm: int(a.shipping_width_mm, 1, 2000),
    shipping_height_mm: int(a.shipping_height_mm, 1, 2000),
    price_uzs: int(a.price_uzs, 1000, 1_000_000_000),
    in_stock: typeof a.in_stock === 'boolean' ? a.in_stock : null,
    category_ids,
    actives,
    note: typeof a.note === 'string' ? a.note.trim().slice(0, 400) : '',
  };
  if (!card.composition_ru) problems.push('AI не нашёл состав на странице — заполните по этикетке');
  if (!card.pack_count) problems.push('Не указано количество в банке — без него не работает напоминание о конце курса');
  if (!card.servings_per_day) problems.push('Не указано порций в день — без него не работает напоминание о конце курса');
  if (!card.shipping_weight_g) problems.push('Нет веса для доставки');
  if (!category_ids.length) problems.push('AI не подобрал категорию — выберите вручную');
  return { ok: true, card, problems };
}
