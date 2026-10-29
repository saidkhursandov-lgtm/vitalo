import type { Lang, Named } from './types';

const NBSP = ' ';

/** 89000 -> "89 000 сум" / "89 000 so‘m" (UZS has no fractional part). */
export function money(amount: number, lang: Lang): string {
  const n = String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
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
