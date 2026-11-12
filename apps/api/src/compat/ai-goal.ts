/**
 * Шаг 0б (D-68, D-69; архитектура 3.3 и 3.6): «Задать вопрос VITALO AI по корзине» — «Поможет ли этот набор для моей
 * цели?». Only chips, no free text: the goal, how long, what exactly (А). The model gets the chosen chips and the cart —
 * products, substances and the approved «вещество → цель» rows of our base — and writes an honest answer per product (Б)
 * and general steps (В). The level of evidence comes from our base only; with no row the product is «данных немного».
 * The line about the doctor and the «Спросить специалиста VITALO» button are added by the app, not the model.
 * No database or network access here: the service, the tests and the model comparison (0в) use the same functions.
 * The instruction text is also in docs/releases/vitalo-ai-prompt.md — change it there first.
 */
import type { Lang } from './compat';
import { findForbidden, inLanguage } from './ai';

export const GOALS = ['sleep', 'stress', 'energy', 'joints', 'immunity', 'sport'] as const;
export type Goal = (typeof GOALS)[number];

export const DURATIONS = ['lt2w', '2to4w', 'gt1m'] as const;
export type Duration = (typeof DURATIONS)[number];

/** The second question (А): what exactly — three chips per goal. */
export const KINDS: Record<Goal, readonly string[]> = {
  sleep: ['fall_asleep', 'wake_night', 'not_rested'],
  stress: ['tension', 'irritability', 'restless'],
  energy: ['morning', 'afternoon', 'all_day'],
  joints: ['stiffness', 'after_load', 'support'],
  immunity: ['often_colds', 'season', 'recovery'],
  sport: ['strength', 'endurance', 'recovery'],
};

export const LEVELS = ['A', 'B', 'C'] as const;
export type Level = (typeof LEVELS)[number];

/** D-67: the customer sees the level in words, never the letter. */
export const LEVEL_LABELS: Record<Level, Record<Lang, string>> = {
  A: { ru: 'Подтверждено исследованиями', uz: 'Tadqiqotlar bilan tasdiqlangan' },
  B: { ru: 'Есть данные исследований', uz: 'Tadqiqot maʼlumotlari bor' },
  C: { ru: 'Мнение специалистов', uz: 'Mutaxassislar fikri' },
};

/** helps — может помочь; maybe — может помочь при условии; unlikely — скорее не поможет; no_data — данных немного. */
export const FITS = ['helps', 'maybe', 'unlikely', 'no_data'] as const;
export type Fit = (typeof FITS)[number];

/** (В) the fixed line under every answer, written by the app. */
export const DOCTOR_LINE: Record<Lang, string> = {
  ru: 'Если проблема держится дольше 3–4 недель — обратитесь к врачу.',
  uz: 'Agar muammo 3–4 haftadan uzoq davom etsa — shifokorga murojaat qiling.',
};

/** What the model reads for the chips (Russian: the instruction is Russian; the answer is in the customer's language). */
export const GOAL_TEXT: Record<Goal, string> = {
  sleep: 'сон',
  stress: 'стресс',
  energy: 'энергия',
  joints: 'суставы',
  immunity: 'иммунитет',
  sport: 'спорт',
};
export const DURATION_TEXT: Record<Duration, string> = { lt2w: 'меньше 2 недель', '2to4w': '2–4 недели', gt1m: 'дольше месяца' };
export const KIND_TEXT: Record<string, string> = {
  fall_asleep: 'трудно заснуть',
  wake_night: 'просыпаюсь ночью',
  not_rested: 'сплю, но не высыпаюсь',
  tension: 'напряжение после работы',
  irritability: 'раздражительность',
  restless: 'трудно расслабиться',
  morning: 'тяжело утром',
  afternoon: 'спад после обеда',
  all_day: 'усталость весь день',
  stiffness: 'скованность по утрам',
  after_load: 'дискомфорт после нагрузки',
  support: 'хочу поддержать суставы',
  often_colds: 'часто простываю',
  season: 'поддержка в сезон простуд',
  recovery: 'восстановление',
  strength: 'сила и масса',
  endurance: 'выносливость',
};

export const isGoal = (v: unknown): v is Goal => typeof v === 'string' && (GOALS as readonly string[]).includes(v);
export const isDuration = (v: unknown): v is Duration => typeof v === 'string' && (DURATIONS as readonly string[]).includes(v);
export const isKind = (goal: Goal, v: unknown): v is string => typeof v === 'string' && KINDS[goal].includes(v);

// ---------------- the instruction ----------------

export const SYSTEM_GOAL = `СЦЕНАРИЙ: «Поможет ли этот набор для моей цели?» — вопрос покупателя по товарам его корзины.

Покупатель ничего не писал: он выбрал кнопками цель, сколько длится проблема и что именно беспокоит. Его ответы и
товары корзины — в данных. У каждого товара — вещества и строки НАШЕЙ базы доказательности «вещество → цель»: уровень,
когда помогает, когда не поможет. Строк может не быть.

Что сделать:
1. products — для КАЖДОГО товара корзины одна запись:
   - fit:
     "helps" — по строкам базы вещество товара может помочь именно при этой цели и этом характере проблемы;
     "maybe" — может помочь, но только при условии из строки «когда помогает» (например, при дефиците);
     "unlikely" — по строке «когда не поможет» это не тот случай или товар не про эту цель;
     "no_data" — у товара нет строк базы для этой цели.
   - text — одно-два коротких предложения простыми словами, почему так. Опирайся ТОЛЬКО на строки базы. Если строк нет —
     только «Данных немного: может помочь, если …» по составу товара в общих словах, без выдуманных фактов и цифр.
     Не называй уровень доказательности и не пиши «исследования доказали» — уровень показывает приложение.
2. Честность: если для цели хватает меньшего числа товаров — так и скажи в summary: какие товары можно не брать для этой
   цели. Не предлагай докупить другие товары.
3. summary — 1–2 предложения: общий вывод по набору для этой цели.
4. steps — 2–3 коротких общих шага без добавок для этой цели (например, для сна — режим, свет, кофеин, гаджеты перед
   сном; для энергии — сон, вода, движение). Без лекарств и без дозировок.
5. Не называй и не перечисляй возможные болезни или причины-диагнозы («это может быть…»), не советуй анализы и лечение.
   Строку про врача и кнопку «Спросить специалиста» приложение добавит само — не пиши их.
6. Медицинские термины (верхний уровень, мг, МЕ) не используй — пиши простым языком.`;

export const GOAL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: { productId: { type: 'string' }, fit: { type: 'string', enum: [...FITS] }, text: { type: 'string' } },
        required: ['productId', 'fit', 'text'],
        additionalProperties: false,
      },
    },
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'products', 'steps'],
  additionalProperties: false,
} as const;

// ---------------- the data block ----------------

export interface GoalEvidenceLine {
  substance: string;
  level: Level;
  helps: string;
  not_helps: string;
}

export interface GoalProduct {
  /** the SKU: what the model calls the product */
  ref: string;
  name: string;
  substances: string[];
  form: string | null;
  evidence: GoalEvidenceLine[];
}

export interface GoalData {
  lang: Lang;
  goal: Goal;
  duration: Duration;
  kind: string;
  cart: GoalProduct[];
}

/** The <данные> block: the chips and the products, no customer data (D-45). */
export function goalDataBlock(d: GoalData): string {
  const out = [
    '<данные>',
    `язык: ${d.lang === 'uz' ? 'uz (узбекский, латиница)' : 'ru (русский)'}`,
    `цель: ${GOAL_TEXT[d.goal]}`,
    `сколько длится: ${DURATION_TEXT[d.duration]}`,
    `что беспокоит: ${KIND_TEXT[d.kind] ?? d.kind}`,
    'товары корзины:',
  ];
  for (const p of d.cart) {
    out.push(`- id ${p.ref} | ${p.name} | вещества: ${p.substances.join(', ') || '—'}${p.form ? ` | форма: ${p.form}` : ''}`);
    if (!p.evidence.length) out.push('  база для этой цели: нет строк');
    for (const e of p.evidence) out.push(`  база: ${e.substance} | уровень ${e.level} | когда помогает: ${e.helps} | когда не поможет: ${e.not_helps}`);
  }
  out.push('</данные>');
  return out.join('\n');
}

/** The best level of a product for the goal (A > B > C); null — no approved row. */
export function bestLevel(lines: GoalEvidenceLine[]): Level | null {
  for (const l of LEVELS) if (lines.some((x) => x.level === l)) return l;
  return null;
}

// ---------------- the answer ----------------

/** (В) no diseases named or listed (D-69): words a goal answer never has, on top of FORBIDDEN_WORDS. */
export const GOAL_FORBIDDEN = [
  'диагноз', 'заболеван', 'болезн', 'синдром', 'депресс', 'расстройств', 'анеми', 'гипотиреоз', 'артрит', 'артроз', 'диабет',
  'апноэ', 'дефицит железа', 'сдайте анализ', 'анализы', 'лечение',
  'tashxis', 'kasallik', 'sindrom', 'depressiya', 'kamqonlik', 'artrit', 'artroz', 'diabet', 'tahlil topshir', 'davolash',
];

/** D-68: no units on the screen — «мг», «мкг», «МЕ» as separate words. */
/** a dose is a number with a unit: «400 мг»; «комплекс Mg + D3» is magnesium, not a dose (Шаг 0в) */
const UNITS = /\d\s*(мг|мкг|ме|mg|mkg)(?=[^a-zа-яё]|$)/iu;

export function findGoalForbidden(text: string): string[] {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const found = [...findForbidden(text), ...GOAL_FORBIDDEN.filter((w) => t.includes(w))];
  if (UNITS.test(t)) found.push('units');
  return found;
}

export interface GoalAnswer {
  summary: string;
  products: { ref: string; fit: Fit; text: string }[];
  steps: string[];
}

const SUMMARY = [15, 500] as const;
const PRODUCT_TEXT = [10, 320] as const;
const STEP_MAX = 180;

/**
 * The model's JSON checked before the customer sees it: the format, every product of the cart once, the language, no
 * forbidden words and no diseases. A product with no approved row in our base is always «данных немного» — the model
 * cannot rate it itself (D-69).
 */
export function checkGoalAnswer(raw: unknown, d: GoalData): { ok: true; answer: GoalAnswer } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not_json' };
  const r = raw as Record<string, unknown>;
  const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (summary.length < SUMMARY[0] || summary.length > SUMMARY[1]) return { ok: false, error: 'text_length' };
  const byRef = new Map(d.cart.map((p) => [p.ref, p]));
  const products: GoalAnswer['products'] = [];
  for (const x of Array.isArray(r.products) ? r.products : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const ref = String(o.productId ?? '').trim();
    const text = String(o.text ?? '').trim();
    if (!byRef.has(ref) || products.some((p) => p.ref === ref)) return { ok: false, error: 'products' };
    if (!(FITS as readonly string[]).includes(String(o.fit))) return { ok: false, error: 'fit' };
    if (text.length < PRODUCT_TEXT[0] || text.length > PRODUCT_TEXT[1]) return { ok: false, error: 'text_length' };
    // only our base rates a product: no approved row — «данных немного», whatever the model chose
    const fit = byRef.get(ref)!.evidence.length ? (o.fit as Fit) : 'no_data';
    products.push({ ref, fit, text });
  }
  if (products.length !== byRef.size) return { ok: false, error: 'products' };
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!steps.length || steps.length > 4 || steps.some((s) => s.length > STEP_MAX)) return { ok: false, error: 'steps' };
  const all = [summary, ...products.map((p) => p.text), ...steps].join(' ');
  // the product names are ours: «Mg + D3», «Biotin 5000 mkg» are not a dose from the model (found in Шаг 0в)
  const scrubbed = d.cart.reduce((t, p) => t.split(p.name).join(' '), all);
  if (findGoalForbidden(scrubbed).length) return { ok: false, error: 'forbidden_words' };
  if (!inLanguage(all, d.lang)) return { ok: false, error: 'language' };
  return { ok: true, answer: { summary, products, steps } };
}
