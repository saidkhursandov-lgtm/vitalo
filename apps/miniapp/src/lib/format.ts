import type { Lang, Named, ShortNamed } from './types';

export const NBSP = ' ';

/** 89000 -> "89 000 сум" / "89 000 so‘m" (UZS has no fractional part). */
/** «2 330» — thousands split by a no-break space (6а-Б: also the tile's price per day). */
export const digits = (amount: number): string => String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

export function money(amount: number, lang: Lang): string {
  const n = digits(amount);
  return `${n}${NBSP}${lang === 'uz' ? 'so‘m' : 'сум'}`;
}

/** Dates are stored in UTC and always shown in Tashkent time. */
export function dateTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'uz' ? 'uz-Latn-UZ' : 'ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Uzbek name with Russian fallback (Master TZ §19). */
export function nameOf(item: Named, lang: Lang): string {
  return (lang === 'uz' && item.name_uz) || item.name_ru;
}

/** 2.4 patch: the mini-card line «На N дн. · Y сум/день»; null without course days or under 7 days. */
export function tileLine(price: number, courseDays: number | null | undefined): { days: number; perDay: number } | null {
  if (!courseDays || courseDays < 7) return null;
  return { days: courseDays, perDay: pricePerDay(price, courseDays) };
}

/** 2.3 fixes: price per day of the course, rounded down to tens: 98 000 / 30 → 3 260. */
export function pricePerDay(price: number, courseDays: number): number {
  return Math.floor(price / courseDays / 10) * 10;
}

/**
 * 2.1: the short name for the cart, checkout and orders; the full name stays on the card and in search.
 * Uzbek: short UZ, then the full UZ name, then the Russian ones.
 */
export function shortNameOf(item: ShortNamed, lang: Lang): string {
  if (lang === 'uz') return item.short_name_uz || item.name_uz || item.short_name_ru || item.name_ru;
  return item.short_name_ru || item.name_ru;
}

/**
 * Product form (products.form is stored in Russian only). Standard forms are shown in Uzbek in the UZ version;
 * a form that is not in the list is shown as it is. Lookup ignores case and extra spaces.
 */
const FORM_UZ: Record<string, string> = {
  'капсулы': 'Kapsula',
  'капсула': 'Kapsula',
  'мягкие капсулы': 'Yumshoq kapsula',
  'таблетки': 'Tabletka',
  'таблетка': 'Tabletka',
  'жевательные таблетки': 'Chaynaladigan tabletka',
  'шипучие таблетки': 'Eruvchan tabletka',
  'растворимые таблетки': 'Eruvchan tabletka',
  'таблетки для рассасывания': 'So‘riladigan tabletka',
  'пастилки': 'Pastilka',
  'жевательные пастилки': 'Chaynaladigan pastilka',
  'жевательный мармелад': 'Chaynaladigan marmelad',
  'мармелад': 'Marmelad',
  'жевательные': 'Chaynaladigan',
  'порошок': 'Kukun',
  'порошок (саше)': 'Kukun (sashe)',
  'саше': 'Sashe',
  'гранулы': 'Granula',
  'жидкость': 'Suyuqlik',
  'капли': 'Tomchi',
  'сироп': 'Sirop',
  'раствор': 'Eritma',
  'спрей': 'Sprey',
  'ампулы': 'Ampula',
  'гель': 'Gel',
  'крем': 'Krem',
  'чай': 'Choy',
  'батончик': 'Batonchik',
  'капсулы и таблетки (набор)': 'Kapsula va tabletka (to‘plam)',
  'набор': 'To‘plam',
};

export function formLabel(form: string, lang: Lang): string {
  if (lang !== 'uz') return form;
  return FORM_UZ[form.trim().toLowerCase().replace(/\s+/g, ' ')] ?? form;
}

/** Localized long text field (e.g. composition_ru / composition_uz) with Russian fallback. */
export function textOf<T extends object>(item: T, field: string, lang: Lang): string | null {
  const rec = item as Record<string, unknown>;
  const value = (lang === 'uz' && rec[`${field}_uz`]) || rec[`${field}_ru`];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** D-09: a crossed-out price and a percent are shown only for discounts up to this many percent. */
export const MAX_SHOWN_DISCOUNT = 25;

export function discountPercent(price: number, oldPrice: number | null): number | null {
  if (!oldPrice || oldPrice <= price) return null;
  const pct = Math.round((1 - price / oldPrice) * 100);
  return pct > MAX_SHOWN_DISCOUNT ? null : pct;
}

/** "90 123-45-67" / "+998 90 123 45 67" -> "+998901234567"; null when it is not an Uzbek mobile number. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return null;
}

/** "+998901234567" -> "+998 90 123 45 67" */
export function prettyPhone(phone: string): string {
  const m = phone.match(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

/** 3.5: an order number never breaks at its hyphens (VTL-20261101-0001): non-breaking hyphens, for display only. */
export const orderNo = (n: string) => n.replace(/-/g, '\u2011');
