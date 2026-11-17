/**
 * 3.8: what VITALO AI knows about compatibility (D-45) — the dictionary of substances with synonyms and forms, the rules
 * between two substances and the starting proposals. No database access here: the service, the import script and the
 * tests use the same functions.
 */
import type { Lang, Verdict } from './compat';

export const SUBSTANCE_KINDS = ['substance', 'form', 'drug_group'] as const;
export type SubstanceKind = (typeof SUBSTANCE_KINDS)[number];

export const RULE_KINDS = ['synergy', 'spread', 'avoid', 'drug_caution'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const RULE_KIND_LABELS: Record<RuleKind, Record<Lang, string>> = {
  synergy: { ru: 'Синергия', uz: 'Sinergiya' },
  spread: { ru: 'Разнести по времени', uz: 'Vaqt boʻyicha ajratish' },
  avoid: { ru: 'Не сочетать', uz: 'Birga qabul qilmaslik' },
  drug_caution: { ru: 'Осторожно с лекарствами', uz: 'Dorilar bilan ehtiyot boʻling' },
};

export const RULE_STATUSES = ['draft', 'approved', 'off'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const WHEN = ['morning', 'day', 'evening', 'with_food', 'empty_stomach', 'any'] as const;
export type When = (typeof WHEN)[number];
export const WHEN_LABELS: Record<When, Record<Lang, string>> = {
  morning: { ru: 'Утро', uz: 'Ertalab' },
  day: { ru: 'День', uz: 'Kunduzi' },
  evening: { ru: 'Вечер', uz: 'Kechqurun' },
  with_food: { ru: 'С едой', uz: 'Ovqat bilan' },
  empty_stomach: { ru: 'Натощак', uz: 'Och qoringa' },
  any: { ru: 'Не важно', uz: 'Farqi yoʻq' },
};

/**
 * «Когда принимать» split in two (ветка 1 плана VITALO AI): the time of day and the meal, so «утром с жирной едой» can
 * be said. The old one-field `when_*` is kept in step for the master table and older code.
 */
export const TIMES = ['morning', 'day', 'evening', 'any'] as const;
export type TimeOfDay = (typeof TIMES)[number];
export const TIME_LABELS: Record<TimeOfDay, Record<Lang, string>> = {
  morning: { ru: 'Утро', uz: 'Ertalab' },
  day: { ru: 'День', uz: 'Kunduzi' },
  evening: { ru: 'Вечер', uz: 'Kechqurun' },
  any: { ru: 'Любое время', uz: 'Istalgan vaqt' },
};
export const MEALS = ['with_food', 'with_fat', 'empty_stomach', 'any'] as const;
export type Meal = (typeof MEALS)[number];
export const MEAL_LABELS: Record<Meal, Record<Lang, string>> = {
  with_food: { ru: 'С едой', uz: 'Ovqat bilan' },
  with_fat: { ru: 'С жирной едой', uz: 'Yogʻli ovqat bilan' },
  empty_stomach: { ru: 'Натощак', uz: 'Och qoringa' },
  any: { ru: 'Еда не важна', uz: 'Ovqatga bogʻliq emas' },
};

/** The old one-field value → the two new ones (`any` → nothing known). */
export function splitWhen(w: string | null | undefined): { time: TimeOfDay | null; meal: Meal | null } {
  if (w === 'morning' || w === 'day' || w === 'evening') return { time: w, meal: null };
  if (w === 'with_food' || w === 'empty_stomach') return { time: null, meal: w };
  return { time: null, meal: null };
}

/** The two new values → the old one field: the time when it is said, else the meal («с жирной» → «с едой»). */
export function joinWhen(time: string | null | undefined, meal: string | null | undefined): When | null {
  if (time && time !== 'any') return time as When;
  if (meal === 'with_fat') return 'with_food';
  if (meal && meal !== 'any') return meal as When;
  return time === 'any' || meal === 'any' ? 'any' : null;
}

/**
 * The columns to write with an old one-field `when_a / when_b` (the master table, the xlsx import). A side whose old
 * field did not change keeps its finer time and meal (`before`): «утро, с жирной едой» is not cut to «утро».
 */
export function whenColumns(
  whenA: string | null | undefined,
  whenB: string | null | undefined,
  before?: { when_a: string | null; when_b: string | null; time_a: string | null; time_b: string | null; meal_a: string | null; meal_b: string | null } | null,
) {
  const side = (w: string | null | undefined, old: string | null | undefined, time: string | null | undefined, meal: string | null | undefined) =>
    before && (w ?? null) === (old ?? null) && (time || meal) ? { time: (time ?? null) as TimeOfDay | null, meal: (meal ?? null) as Meal | null } : splitWhen(w);
  const a = side(whenA, before?.when_a, before?.time_a, before?.meal_a);
  const b = side(whenB, before?.when_b, before?.time_b, before?.meal_b);
  return { time_a: a.time, meal_a: a.meal, time_b: b.time, meal_b: b.meal };
}

/** Time and meal of a rule: the new columns, or the old field when the rule was written before them. */
export function ruleTiming(r: { when_a: string | null; when_b: string | null; time_a: string | null; time_b: string | null; meal_a: string | null; meal_b: string | null }) {
  const side = (w: string | null, time: string | null, meal: string | null) =>
    time || meal ? { time: (time as TimeOfDay | null) ?? null, meal: (meal as Meal | null) ?? null } : splitWhen(w);
  return { a: side(r.when_a, r.time_a, r.meal_a), b: side(r.when_b, r.time_b, r.meal_b) };
}

/** «Утро, с жирной едой» — for the model and the lists. */
export function timingText(t: { time: TimeOfDay | null; meal: Meal | null }, lang: Lang): string {
  const parts = [t.time && t.time !== 'any' ? TIME_LABELS[t.time][lang] : null, t.meal && t.meal !== 'any' ? MEAL_LABELS[t.meal][lang].toLowerCase() : null].filter(Boolean);
  const s = parts.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : '—';
}

/** Lower case, «ё» → «е», one space, quotes and brackets dropped: the form synonyms are compared in. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_CHAR = /[a-zа-яʻʼ'0-9]/i;

export interface DictEntry {
  code: string;
  synonyms: string[];
  name_ru: string;
  name_uz?: string;
}

/**
 * Codes of the substances named in a free text («Цитрат магния + Витамин B6» → magnesium, vitamin_b6). The longest
 * synonym wins and a matched piece is not matched again («витамин b6» is not also «b6»); a synonym must stand as a
 * whole word. The name itself counts as a synonym.
 */
export function matchSubstances(text: string, dict: DictEntry[]): string[] {
  const hay = normalizeText(text);
  const used = new Array<boolean>(hay.length).fill(false);
  const pairs = dict.flatMap((d) => [d.name_ru, d.name_uz ?? '', ...d.synonyms].map((s) => ({ code: d.code, s: normalizeText(s) })));
  pairs.sort((a, b) => b.s.length - a.s.length);
  const found: string[] = [];
  for (const { code, s } of pairs) {
    if (s.length < 2) continue;
    for (let at = hay.indexOf(s); at >= 0; at = hay.indexOf(s, at + 1)) {
      const end = at + s.length;
      if ((at > 0 && WORD_CHAR.test(hay[at - 1])) || (end < hay.length && WORD_CHAR.test(hay[end]))) continue;
      if (used.slice(at, end).some(Boolean)) continue;
      used.fill(true, at, end);
      if (!found.includes(code)) found.push(code);
    }
  }
  return found;
}

/** A substance and everything it is a form of (P-5-P → B6): the rules of the parent apply to the form. */
export function withParents(ids: Iterable<string>, parentOf: Map<string, string | null>): Set<string> {
  const out = new Set<string>();
  for (const start of ids) {
    let id: string | null | undefined = start;
    while (id && !out.has(id)) {
      out.add(id);
      id = parentOf.get(id);
    }
  }
  return out;
}

export interface RuleLike {
  id: string;
  substance_a_id: string;
  substance_b_id: string;
}

/**
 * Rules that concern a cart. With 2+ products a rule counts only when A and B are in **different** products (a
 * multivitamin with zinc and iron is one pill — its maker has already decided). With one product: every rule where it
 * has A or B (what goes well with it, what to keep apart).
 */
export function rulesForProducts<R extends RuleLike>(products: { id: string; substances: Set<string> }[], rules: R[]): R[] {
  if (products.length === 1) {
    const own = products[0].substances;
    return rules.filter((r) => own.has(r.substance_a_id) || own.has(r.substance_b_id));
  }
  return rules.filter((r) =>
    products.some((p) => products.some((q) => p.id !== q.id && p.substances.has(r.substance_a_id) && q.substances.has(r.substance_b_id))),
  );
}

/**
 * D-73, ветка 3: «синергия» rules whose two substances are in ONE product (D3 + K2 in one capsule, магний + B6). They do
 * not change the label — the answer praises the formula.
 */
export function innerSynergy<R extends RuleLike & { kind: string }>(products: { id: string; substances: Set<string> }[], rules: R[]): { product: string; rule: R }[] {
  const out: { product: string; rule: R }[] = [];
  for (const p of products) {
    for (const r of rules) if (r.kind === 'synergy' && p.substances.has(r.substance_a_id) && p.substances.has(r.substance_b_id)) out.push({ product: p.id, rule: r });
  }
  return out;
}

// ---------------- the sheet «Правила совместимости» (docs/content/VITALO_catalog.xlsx) ----------------

export const SHEET_RULE_KIND: Record<string, RuleKind> = {
  'синергия': 'synergy',
  'разнести по времени': 'spread',
  'не сочетать': 'avoid',
  'осторожно с лекарствами': 'drug_caution',
};

export const SHEET_WHEN: Record<string, When> = {
  'утро': 'morning',
  'день': 'day',
  'вечер': 'evening',
  'с едой': 'with_food',
  'натощак': 'empty_stomach',
  'не важно': 'any',
};

/** One substance from a cell of the sheet: «лекарства: антикоагулянты / разжижающие кровь» → drugs_anticoagulants. */
export function substanceOfCell(cell: string, dict: DictEntry[]): { code: string } | { error: string } {
  const text = cell.replace(/\(пример\)/i, '').replace(/^лекарства:\s*/i, '');
  const codes = matchSubstances(text, dict);
  if (codes.length === 1) return { code: codes[0] };
  return { error: codes.length ? `несколько веществ: ${codes.join(', ')}` : 'нет в справочнике веществ' };
}

export interface RuleDraft {
  a: string;
  b: string;
  kind: RuleKind;
  interval_hours: number | null;
  when_a: When | null;
  when_b: When | null;
  text_ru: string;
  text_uz: string;
  source: string | null;
}

/** One key for a pair of substances, whatever their order. */
export const pairKey = (a: string, b: string) => [a, b].sort().join('|');

const THYROID_RU = (what: string) =>
  `${what} может снижать усвоение L-тироксина. Обычно их разносят минимум на 4 часа; схему приёма при лечении гормонами щитовидной железы согласуйте с врачом или специалистом VITALO.`;
const THYROID_UZ = (what: string) =>
  `${what} L-tiroksin soʻrilishini kamaytirishi mumkin. Odatda ular kamida 4 soat farq bilan ichiladi; qalqonsimon bez gormonlari bilan davolanishda qabul sxemasini shifokor yoki VITALO mutaxassisi bilan kelishing.`;
const ANTIBIOTICS_RU = (what: string) =>
  `${what} может снижать усвоение некоторых антибиотиков (тетрациклины, фторхинолоны). Обычно их разносят минимум на 3 часа, но интервал зависит от препарата — уточните у врача или специалиста VITALO.`;
const ANTIBIOTICS_UZ = (what: string) =>
  `${what} baʼzi antibiotiklar (tetratsiklinlar, ftorxinolonlar) soʻrilishini kamaytirishi mumkin. Odatda ular kamida 3 soat farq bilan ichiladi, lekin oraliq doriga bogʻliq — shifokor yoki VITALO mutaxassisidan aniqlang.`;

/**
 * VITALO edits on top of the sheet «Правила совместимости» (by the pair of substances): softer wording by D-33 and the
 * medicine rules by D-45 — no «можно / нельзя» on behalf of AI, the usual interval in hours and a doctor or a VITALO
 * specialist named every time. They replace the sheet's text on import and with `--update-drafts`.
 */
export const SHEET_RULE_EDITS: Record<string, Partial<Pick<RuleDraft, 'interval_hours' | 'text_ru' | 'text_uz'>>> = {
  [pairKey('vitamin_d3', 'vitamin_k2')]: {
    text_ru: 'Витамин K2 (MK-7) помогает направлять усвоенный с помощью D3 кальций в костную ткань.',
    text_uz: 'K2 vitamini (MK-7) D3 yordamida soʻrilgan kalsiyni suyak toʻqimalariga yoʻnaltirishga yordam beradi.',
  },
  [pairKey('iron', 'vitamin_c')]: {
    text_ru: 'Витамин С переводит железо в более доступную для усвоения форму и заметно повышает его всасывание в кишечнике.',
    text_uz: 'C vitamini temirning ichakda soʻrilishini sezilarli darajada yaxshilaydi — ularni birga qabul qilish qulay.',
  },
  [pairKey('omega3', 'magnesium')]: {
    text_ru: 'Хорошо дополняют друг друга в поддержке нервной системы и сосудов: Омега-3 принимайте утром с едой, а Магний B6 — вечером.',
    text_uz: 'Asab tizimi va qon tomirlarni qoʻllab-quvvatlashda bir-birini yaxshi toʻldiradi: Omega-3 ni ertalab ovqat bilan, Magniy B6 ni esa kechqurun qabul qiling.',
  },
  [pairKey('creatine', 'protein')]: {
    text_ru: 'Хорошо сочетаются в спортивном курсе: белок и углеводы из коктейля вызывают мягкий инсулиновый отклик, который помогает транспорту креатина в мышцы.',
    text_uz: 'Sport kursida yaxshi mos keladi: protein kokteyli kreatinning mushak hujayralariga yetib borishiga va tiklanishga yordam beradi.',
  },
  [pairKey('omega3', 'drugs_anticoagulants')]: {
    interval_hours: null,
    text_ru: 'Высокие дозы Омега-3 могут усиливать действие препаратов, разжижающих кровь. Простой разнос по времени здесь вопрос не решает — при приёме антикоагулянтов обсудите Омега-3 с лечащим врачом или специалистом VITALO.',
    text_uz: 'Omega-3 ning yuqori dozalari qon suyultiruvchi dorilar taʼsirini kuchaytirishi mumkin. Bu holatda qabul vaqtini ajratish masalani hal qilmaydi — antikoagulyantlar qabul qilsangiz, Omega-3 ni davolovchi shifokoringiz yoki VITALO mutaxassisi bilan muhokama qiling.',
  },
  [pairKey('iodine', 'drugs_thyroid')]: {
    interval_hours: 4,
    text_ru: 'При приёме гормонов щитовидной железы добавки с йодом согласуют с эндокринологом. Обычно их разносят с утренним L-тироксином минимум на 4 часа — уточните схему у врача или специалиста VITALO.',
    text_uz: 'Qalqonsimon bez gormonlarini qabul qilsangiz, yodli qoʻshimchalar endokrinolog bilan kelishiladi. Odatda ular ertalabki L-tiroksindan kamida 4 soat farq bilan ichiladi — sxemani shifokor yoki VITALO mutaxassisidan aniqlang.',
  },
};

/**
 * Rules VITALO proposes in addition to the sheet (origin «vitalo»). Drafts, like the sheet's: VITALO AI sees a rule only
 * after an admin approves it.
 */
export const PROPOSED_RULES: RuleDraft[] = [
  {
    a: 'vitamin_d3',
    b: 'calcium',
    kind: 'synergy',
    interval_hours: null,
    when_a: 'morning',
    when_b: 'with_food',
    text_ru: 'Витамин D3 помогает кишечнику усваивать кальций, поэтому их часто принимают в одном курсе.',
    text_uz: 'D3 vitamini ichakda kalsiy soʻrilishiga yordam beradi, shuning uchun ular koʻpincha bitta kursda qabul qilinadi.',
    source: 'Предложение VITALO: классическая кофакторная пара',
  },
  {
    a: 'calcium',
    b: 'zinc',
    kind: 'spread',
    interval_hours: 2,
    when_a: 'evening',
    when_b: 'day',
    text_ru: 'Высокие дозы кальция мешают усвоению цинка — лучше принимать их с интервалом 2 часа и больше.',
    text_uz: 'Kalsiyning yuqori dozalari sink soʻrilishiga xalal beradi — ularni kamida 2 soat oraliq bilan qabul qilgan maʼqul.',
    source: 'Предложение VITALO: конкуренция минералов за всасывание',
  },
  {
    a: 'collagen',
    b: 'hyaluronic',
    kind: 'synergy',
    interval_hours: null,
    when_a: 'morning',
    when_b: 'morning',
    text_ru: 'Коллаген и гиалуроновая кислота дополняют друг друга в поддержке кожи и суставов — их удобно сочетать в утреннем приёме.',
    text_uz: 'Kollagen va gialuron kislotasi teri va boʻgʻimlarni qoʻllab-quvvatlashda bir-birini toʻldiradi — ertalabki qabulda birga ichish qulay.',
    source: 'Предложение VITALO: частое сочетание в составе товаров',
  },
  {
    a: 'calcium',
    b: 'drugs_thyroid',
    kind: 'drug_caution',
    interval_hours: 4,
    when_a: 'evening',
    when_b: 'empty_stomach',
    text_ru: THYROID_RU('Кальций'),
    text_uz: THYROID_UZ('Kalsiy'),
    source: 'Предложение VITALO: инструкции к препаратам L-тироксина',
  },
  {
    a: 'iron',
    b: 'drugs_thyroid',
    kind: 'drug_caution',
    interval_hours: 4,
    when_a: 'morning',
    when_b: 'empty_stomach',
    text_ru: THYROID_RU('Железо'),
    text_uz: THYROID_UZ('Temir'),
    source: 'Предложение VITALO: инструкции к препаратам L-тироксина',
  },
  {
    a: 'magnesium',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'evening',
    when_b: 'any',
    text_ru: ANTIBIOTICS_RU('Магний'),
    text_uz: ANTIBIOTICS_UZ('Magniy'),
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
  {
    a: 'calcium',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'evening',
    when_b: 'any',
    text_ru: ANTIBIOTICS_RU('Кальций'),
    text_uz: ANTIBIOTICS_UZ('Kalsiy'),
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
  {
    a: 'iron',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'morning',
    when_b: 'any',
    text_ru: ANTIBIOTICS_RU('Железо'),
    text_uz: ANTIBIOTICS_UZ('Temir'),
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
  {
    a: 'zinc',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'day',
    when_b: 'any',
    text_ru: ANTIBIOTICS_RU('Цинк'),
    text_uz: ANTIBIOTICS_UZ('Sink'),
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
];

/** Substances VITALO adds to the starting dictionary of the migration (the import adds a code that is missing). */
export const PROPOSED_SUBSTANCES: (DictEntry & { name_uz: string; kind: SubstanceKind; sort_order: number })[] = [
  {
    code: 'vitamin_k1',
    kind: 'substance',
    name_ru: 'Витамин K1',
    name_uz: 'K1 vitamini',
    synonyms: ['витамин k1', 'витамин к1', 'k1', 'к1', 'филлохинон', 'phylloquinone', 'vitamin k1', 'k1 vitamini'],
    sort_order: 21,
  },
];

/**
 * Starting substances of the products by SKU — from their composition (`label_composition_ru`). Filled once for a
 * product that has none yet; afterwards they are edited in the product card of the admin panel.
 */
export const PROPOSED_PRODUCT_SUBSTANCES: Record<string, string[]> = {
  'OZN-A001': ['collagen', 'vitamin_c', 'hyaluronic'],
  'OZN-A002': ['magnesium', 'vitamin_b6', 'omega3', 'vitamin_d3'],
  'OZN-A003': ['vitamin_d3'],
  // full composition: K is phylloquinone (K1, not K2); «кальция D-пантотенат» is vitamin B5, not a calcium supplement
  'OZN-A004': ['multivitamin', 'vitamin_a', 'vitamin_c', 'vitamin_d3', 'vitamin_e', 'vitamin_k1', 'b_complex', 'vitamin_b6', 'vitamin_b12', 'folate', 'zinc', 'iron', 'copper', 'selenium', 'iodine'],
  'OZN-A005': ['collagen', 'vitamin_c', 'hyaluronic'],
  'OZN-A006': ['omega3', 'vitamin_e'],
  'OZN-A007': ['creatine'],
  'OZN-A008': ['creatine'],
  'OZN-A009': ['collagen', 'vitamin_c', 'hyaluronic'],
  'OZN-A010': ['creatine'],
  'OZN-A011': ['collagen', 'vitamin_c', 'hyaluronic'],
  'OZN-A012': ['iodine'],
  'OZN-A013': ['collagen', 'vitamin_c'],
  'OZN-A014': ['magnesium', 'vitamin_b6'],
  'OZN-A015': ['vitamin_c'],
  // the premix of the sachet: A, C, D3, E, B1, B2, B6, B12, biotin, iron, zinc
  'OZN-A016': ['protein', 'vitamin_a', 'vitamin_c', 'vitamin_d3', 'vitamin_e', 'b_complex', 'vitamin_b6', 'vitamin_b12', 'iron', 'zinc'],
  'OZN-A017': ['multivitamin', 'vitamin_a', 'vitamin_c', 'vitamin_d3', 'vitamin_e', 'vitamin_k1', 'b_complex', 'vitamin_b6', 'vitamin_b12', 'folate', 'zinc', 'iron', 'copper', 'selenium', 'iodine'],
  // the label names «витамины группы B» without B12 / B9 separately
  'OZN-A018': ['multivitamin', 'vitamin_a', 'vitamin_c', 'vitamin_d3', 'vitamin_e', 'vitamin_k1', 'b_complex', 'zinc', 'magnesium', 'iron', 'copper', 'selenium', 'iodine'],
  'OZN-A019': ['magnesium', 'vitamin_b6'],
  'OZN-A020': ['magnesium', 'vitamin_b6'],
  'OZN-A021': ['vitamin_d3'],
  'OZN-A022': ['magnesium', 'vitamin_b6'],
  'OZN-A023': ['omega3'],
};

// ---------------- the same substance in different products (Overlap Check) ----------------

/**
 * Owner's decision 02.11.2026 (D-47): any substance in 2+ different products raises the label to at least yellow with
 * this line, whatever the model says. Red comes only from explicit compatibility rules.
 */
/** D-47 + D-73 (б): a repeated substance — fine for different members of a family, the total dose for one person. */
export const OVERLAP_TEXT: Record<Lang, string> = {
  ru: 'Одно вещество есть в нескольких товарах. Если они для разных членов семьи — всё в порядке; если для одного человека — проверьте суммарную дозировку или уточните у специалиста',
  uz: 'Bir modda bir nechta mahsulotda bor. Agar ular oilaning turli aʼzolari uchun boʻlsa — hammasi joyida; bitta odam uchun boʻlsa — umumiy dozani tekshiring yoki mutaxassisdan soʻrang',
};

/** A children's product in the cart: no advice on its doses or combinations (D-73 (б)). */
export const CHILD_TEXT: Record<Lang, string> = {
  ru: 'Детские товары принимают по этикетке или по совету педиатра',
  uz: 'Bolalar mahsulotlari yorliqqa koʻra yoki pediatr maslahati bilan qabul qilinadi',
};

const VERDICT_RANK: Record<Verdict, number> = { compatible: 0, spread: 1, consult: 2 };

export interface Overlap {
  substance: string;
  products: string[];
}

/**
 * Substances that 2+ **different** products of a cart have; a form counts as its substance (P-5-P and B6 are one).
 * Two jars of one product are not an overlap.
 */
export function overlapsForProducts(products: { id: string; substances: Iterable<string> }[], parentOf: Map<string, string | null>): Overlap[] {
  const holders = new Map<string, string[]>();
  for (const p of products) {
    for (const s of withParents(p.substances, parentOf)) {
      const list = holders.get(s) ?? [];
      if (!list.includes(p.id)) holders.set(s, [...list, p.id]);
    }
  }
  return [...holders].filter(([, ids]) => ids.length > 1).map(([substance, ids]) => ({ substance, products: ids }));
}

/** The label after the Overlap Check: any overlap makes it at least yellow; a red label is never lowered. */
export function applyOverlapFloor(verdict: Verdict, overlaps: Overlap[]): Verdict {
  return overlaps.length && VERDICT_RANK[verdict] < VERDICT_RANK.spread ? 'spread' : verdict;
}
