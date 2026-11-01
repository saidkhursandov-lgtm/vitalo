/**
 * 3.4: «Проверить совместимость у специалиста» — shared rules (D-40). No database access here: the service, the
 * notification texts and the tests use the same constants.
 */
export type Lang = 'ru' | 'uz';

export const VERDICTS = ['compatible', 'spread', 'consult'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Coloured label of an answer: green / yellow / red in the Mini App. */
export const VERDICT_LABELS: Record<Verdict, Record<Lang, string>> = {
  compatible: { ru: 'Совместимы', uz: 'Mos keladi' },
  spread: { ru: 'Разнести по времени', uz: 'Vaqt boʻyicha ajrating' },
  consult: { ru: 'Нужна консультация специалиста', uz: 'Mutaxassis maslahati kerak' },
};

export type CompatTemplates = Record<Verdict, Record<Lang, string>>;

/** Quick answers until an admin edits them («Совместимость → Шаблоны»; settings key compat_templates). */
export const DEFAULT_TEMPLATES: CompatTemplates = {
  compatible: {
    ru: 'Эти добавки можно принимать вместе. Соблюдайте дозировку, указанную на этикетке.',
    uz: 'Bu qoʻshimchalarni birga qabul qilish mumkin. Yorliqda koʻrsatilgan dozaga rioya qiling.',
  },
  spread: {
    ru: 'Добавки совместимы, но их лучше принимать в разное время — с интервалом 3–4 часа, чтобы они не мешали усвоению друг друга.',
    uz: 'Qoʻshimchalar mos keladi, lekin ularni turli vaqtda — 3–4 soat oraliq bilan qabul qilgan maʼqul, shunda ular bir-birining soʻrilishiga xalaqit bermaydi.',
  },
  consult: {
    ru: 'Для этого сочетания нужна индивидуальная консультация. Напишите нам в чат поддержки — специалист ответит подробно.',
    uz: 'Bu birikma uchun individual maslahat kerak. Qoʻllab-quvvatlash chatiga yozing — mutaxassis batafsil javob beradi.',
  },
};

export const SETTING_COMPAT_TEMPLATES = 'compat_templates';

/** Requests sent to a specialist per customer per Tashkent day (instant answers do not count). */
export const DAILY_LIMIT = 5;
/** The customer's comment may hold health data: its text is cleared after this many days (D-40). */
export const COMMENT_DAYS = 90;
export const COMMENT_MAX = 500;
export const ANSWER_MAX = 1000;

/** Same products in any order and quantity → the same key. */
export function setKeyOf(productIds: string[]): string {
  return [...new Set(productIds)].sort().join(',');
}

/** Saved templates merged over the defaults (a missing or empty text falls back to the default). */
export function mergeTemplates(saved: unknown): CompatTemplates {
  const out = structuredClone(DEFAULT_TEMPLATES);
  if (!saved || typeof saved !== 'object') return out;
  for (const v of VERDICTS) {
    const row = (saved as Record<string, unknown>)[v];
    if (!row || typeof row !== 'object') continue;
    for (const l of ['ru', 'uz'] as const) {
      const text = (row as Record<string, unknown>)[l];
      if (typeof text === 'string' && text.trim()) out[v][l] = text.trim();
    }
  }
  return out;
}

const TASHKENT_OFFSET_MS = 5 * 3600_000;
/** 00:00 Tashkent time of the day `at` falls on (UTC+5, no daylight saving). */
export function tashkentDayStart(at: Date): Date {
  const local = new Date(at.getTime() + TASHKENT_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TASHKENT_OFFSET_MS);
}

/** Callback data of the specialist's buttons in the bot: cp:<verdict code>:<request id> (under Telegram's 64 bytes). */
export const VERDICT_CODES: Record<Verdict, string> = { compatible: 'c', spread: 's', consult: 'k' };
