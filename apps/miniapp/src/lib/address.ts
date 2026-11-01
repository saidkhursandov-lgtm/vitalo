import type { Lang } from './types';

/** 3.6: the parts of an address typed by hand next to the street (the street may come from the map). */
export interface AddressDetails {
  apartment: string;
  entrance: string;
  floor: string;
  landmark: string;
}

export const EMPTY_DETAILS: AddressDetails = { apartment: '', entrance: '', floor: '', landmark: '' };

const WORDS: Record<Lang, { apartment: string; entrance: string; floor: string; landmark: string }> = {
  ru: { apartment: 'кв.', entrance: 'подъезд', floor: 'этаж', landmark: 'Ориентир' },
  uz: { apartment: 'xonadon', entrance: 'podyezd', floor: 'qavat', landmark: 'Mo‘ljal' },
};

/**
 * One line for the order (staff, label, bot): «ул. Бунёдкор, 12, кв. 5, подъезд 2, этаж 3. Ориентир: школа №5».
 * Addresses saved before 3.6 have only the street line: it stays as it is.
 */
export function composeAddress(street: string, d: { [K in keyof AddressDetails]?: string | null } | null | undefined, lang: Lang): string {
  const w = WORDS[lang];
  const parts = [street.trim()];
  if (d?.apartment?.trim()) parts.push(`${w.apartment} ${d.apartment.trim()}`);
  if (d?.entrance?.trim()) parts.push(`${w.entrance} ${d.entrance.trim()}`);
  if (d?.floor?.trim()) parts.push(`${w.floor} ${d.floor.trim()}`);
  const line = parts.filter(Boolean).join(', ');
  const landmark = d?.landmark?.trim();
  return (landmark ? `${line}. ${w.landmark}: ${landmark}` : line).slice(0, 500);
}
