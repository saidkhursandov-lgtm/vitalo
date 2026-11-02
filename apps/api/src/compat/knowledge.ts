/**
 * 3.8: what VITALO AI knows about compatibility (D-45) — the dictionary of substances with synonyms and forms, the rules
 * between two substances and the starting proposals. No database access here: the service, the import script and the
 * tests use the same functions.
 */
import type { Lang } from './compat';

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
    text_ru: 'Коллаген и гиалуроновая кислота дополняют друг друга в поддержке кожи и суставов — их можно принимать вместе.',
    text_uz: 'Kollagen va gialuron kislotasi teri va boʻgʻimlarni qoʻllab-quvvatlashda bir-birini toʻldiradi — ularni birga qabul qilish mumkin.',
    source: 'Предложение VITALO: частое сочетание в составе товаров',
  },
  {
    a: 'calcium',
    b: 'drugs_thyroid',
    kind: 'drug_caution',
    interval_hours: 4,
    when_a: 'evening',
    when_b: 'empty_stomach',
    text_ru: 'Кальций снижает усвоение L-тироксина — при приёме гормонов щитовидной железы согласуйте добавку с врачом и разносите их минимум на 4 часа.',
    text_uz: 'Kalsiy L-tiroksin soʻrilishini kamaytiradi — qalqonsimon bez gormonlarini qabul qilsangiz, qoʻshimchani shifokor bilan kelishing va kamida 4 soat oraliq qiling.',
    source: 'Предложение VITALO: инструкции к препаратам L-тироксина',
  },
  {
    a: 'iron',
    b: 'drugs_thyroid',
    kind: 'drug_caution',
    interval_hours: 4,
    when_a: 'morning',
    when_b: 'empty_stomach',
    text_ru: 'Железо снижает усвоение L-тироксина — при приёме гормонов щитовидной железы согласуйте добавку с врачом и разносите их минимум на 4 часа.',
    text_uz: 'Temir L-tiroksin soʻrilishini kamaytiradi — qalqonsimon bez gormonlarini qabul qilsangiz, qoʻshimchani shifokor bilan kelishing va kamida 4 soat oraliq qiling.',
    source: 'Предложение VITALO: инструкции к препаратам L-тироксина',
  },
  {
    a: 'magnesium',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'evening',
    when_b: 'any',
    text_ru: 'Магний может снижать действие некоторых антибиотиков — при их приёме уточните у врача, как разнести время приёма.',
    text_uz: 'Magniy baʼzi antibiotiklar taʼsirini kamaytirishi mumkin — ularni qabul qilsangiz, vaqtni qanday ajratishni shifokordan soʻrang.',
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
  {
    a: 'calcium',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'evening',
    when_b: 'any',
    text_ru: 'Кальций может снижать действие некоторых антибиотиков — при их приёме уточните у врача, как разнести время приёма.',
    text_uz: 'Kalsiy baʼzi antibiotiklar taʼsirini kamaytirishi mumkin — ularni qabul qilsangiz, vaqtni qanday ajratishni shifokordan soʻrang.',
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
  {
    a: 'iron',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'morning',
    when_b: 'any',
    text_ru: 'Железо может снижать действие некоторых антибиотиков — при их приёме уточните у врача, как разнести время приёма.',
    text_uz: 'Temir baʼzi antibiotiklar taʼsirini kamaytirishi mumkin — ularni qabul qilsangiz, vaqtni qanday ajratishni shifokordan soʻrang.',
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
  },
  {
    a: 'zinc',
    b: 'drugs_antibiotics',
    kind: 'drug_caution',
    interval_hours: 3,
    when_a: 'day',
    when_b: 'any',
    text_ru: 'Цинк может снижать действие некоторых антибиотиков — при их приёме уточните у врача, как разнести время приёма.',
    text_uz: 'Sink baʼzi antibiotiklar taʼsirini kamaytirishi mumkin — ularni qabul qilsangiz, vaqtni qanday ajratishni shifokordan soʻrang.',
    source: 'Предложение VITALO: тетрациклины и фторхинолоны связываются с минералами',
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
  'OZN-A004': ['multivitamin', 'vitamin_a', 'vitamin_c', 'vitamin_d3', 'vitamin_e', 'b_complex', 'zinc', 'iron', 'selenium', 'iodine'],
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
  'OZN-A016': ['protein'],
  'OZN-A017': ['multivitamin', 'vitamin_a', 'vitamin_c', 'vitamin_d3', 'vitamin_e', 'b_complex', 'zinc', 'iron'],
  'OZN-A018': ['multivitamin', 'zinc', 'magnesium', 'selenium', 'b_complex', 'vitamin_d3'],
  'OZN-A019': ['magnesium', 'vitamin_b6'],
  'OZN-A020': ['magnesium', 'vitamin_b6'],
  'OZN-A021': ['vitamin_d3'],
  'OZN-A022': ['magnesium', 'vitamin_b6'],
  'OZN-A023': ['omega3'],
};
