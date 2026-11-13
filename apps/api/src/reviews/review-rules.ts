/**
 * 3.10-Б «Проверенные отзывы»: what a review may hold and how it is shown.
 * Only a product of the customer's delivered order; one review per product of an order; premoderation.
 */

export const REVIEW_TAGS = ['effect', 'easy', 'quality', 'price', 'no_effect', 'hard'] as const;
export type ReviewTag = (typeof REVIEW_TAGS)[number];

/** Why a moderator rejects a review; the customer gets the text in their language. */
export const REVIEW_REJECT_REASONS = {
  spam: { ru: 'реклама или не по теме', uz: 'reklama yoki mavzuga aloqasiz' },
  rude: { ru: 'грубые слова', uz: 'qo‘pol so‘zlar' },
  empty: { ru: 'в отзыве нет рассказа о товаре', uz: 'sharhda mahsulot haqida hikoya yo‘q' },
  medical: { ru: 'обещания лечения: для БАД так писать нельзя', uz: 'davolash va’dalari: BAD uchun bunday yozish mumkin emas' },
  other: { ru: 'не соответствует правилам отзывов', uz: 'sharh qoidalariga mos emas' },
} as const;
export type ReviewRejectReason = keyof typeof REVIEW_REJECT_REASONS;

export const REVIEW_TEXT_MIN = 10;
export const REVIEW_TEXT_MAX = 1000;
export const REVIEW_PHOTOS_MAX = 2;
export const REVIEW_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const REVIEW_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** The bot asks «Как вам …?» this many days after the delivery, and only within the window (no spam about old orders). */
export const REVIEW_ASK_AFTER_DAYS = 3;
export const REVIEW_ASK_WITHIN_DAYS = 14;

/** «Саидкомол Х.» — the first name and the first letter of the last name; or «Покупатель VITALO». */
export function authorName(user: { first_name: string; last_name: string | null }, show: boolean, lang: 'ru' | 'uz'): string {
  const anonymous = lang === 'uz' ? 'VITALO xaridori' : 'Покупатель VITALO';
  if (!show) return anonymous;
  const first = user.first_name.trim().split(/\s+/)[0] ?? '';
  const last = (user.last_name ?? '').trim();
  if (!first) return anonymous;
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

/**
 * Words that look like a promise to cure (D-71: for a dietary supplement it is forbidden advertising). Only a hint for
 * the moderator — the decision is theirs.
 */
const MEDICAL_RE =
  /(вылечи|излечи|исцели|вместо\s+(лекарств|таблеток|препарат)|отменил[аи]?\s+(лекарств|таблетк|препарат)|бросил[аи]?\s+(лекарств|таблетк)|прошл[аио]\s+(диабет|гипертон|рак|онколог)|davola(b|di|ndi)|tuzal(di|ib)|dori\s+o[‘'`]?rniga)/i;
export const looksMedical = (text: string | null | undefined): boolean => !!text && MEDICAL_RE.test(text);

/** The bonus for a published review: with a photo — the bigger amount (D-71: 3 000 / 5 000). */
export const reviewBonus = (s: { enabled: boolean; review_uzs: number; review_photo_uzs: number }, photos: number): number =>
  !s.enabled ? 0 : photos > 0 ? s.review_photo_uzs : s.review_uzs;

/** Average stars with one decimal (4.8); null when there are no reviews. */
export const ratingAvg = (sum: number, count: number): number | null => (count > 0 ? Math.round((sum / count) * 10) / 10 : null);
