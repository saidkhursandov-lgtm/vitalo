/**
 * Reference data shared by the dev/test seed (prisma/seed.ts) and the production bootstrap
 * (prisma/bootstrap.ts): category trees, payment methods, placeholder bank requisites. No products, no people.
 */
import { createHash } from 'crypto';
import type { TreeType } from '@prisma/client';

/** Deterministic UUID (v5-shaped) from a stable key. */
export function uid(key: string): string {
  const h = createHash('sha1').update(`vitalo-seed:${key}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface CategorySeed { slug: string; ru: string; uz: string; children?: CategorySeed[] }

export const CATEGORIES: Record<TreeType, CategorySeed[]> = {
  need: [
    { slug: 'immunity', ru: 'Иммунитет', uz: 'Immunitet' },
    { slug: 'beauty', ru: 'Красота', uz: 'Go‘zallik', children: [
      { slug: 'beauty-skin', ru: 'Кожа', uz: 'Teri' },
      { slug: 'beauty-hair', ru: 'Волосы и ногти', uz: 'Soch va tirnoqlar' },
    ] },
    { slug: 'joints', ru: 'Суставы и кости', uz: 'Bo‘g‘imlar va suyaklar' },
    { slug: 'energy', ru: 'Энергия', uz: 'Energiya' },
    { slug: 'sleep', ru: 'Сон и стресс', uz: 'Uyqu va stress' },
    { slug: 'heart', ru: 'Сердце и сосуды', uz: 'Yurak va qon tomirlar' },
    { slug: 'memory', ru: 'Память и концентрация', uz: 'Xotira va diqqat' },
    { slug: 'women', ru: 'Женское здоровье', uz: 'Ayollar salomatligi' },
    { slug: 'men', ru: 'Мужское здоровье', uz: 'Erkaklar salomatligi' },
    { slug: 'sport', ru: 'Спорт и восстановление', uz: 'Sport va tiklanish' },
  ],
  product_type: [
    { slug: 'vitamins', ru: 'Витамины', uz: 'Vitaminlar', children: [
      { slug: 'vitamin-d', ru: 'Витамин D', uz: 'D vitamini' },
      { slug: 'vitamin-c', ru: 'Витамин C', uz: 'C vitamini' },
      { slug: 'vitamin-b', ru: 'Витамины группы B', uz: 'B guruhi vitaminlari' },
      { slug: 'vitamin-k', ru: 'Витамин K', uz: 'K vitamini' },
    ] },
    { slug: 'minerals', ru: 'Минералы', uz: 'Minerallar', children: [
      { slug: 'magnesium', ru: 'Магний', uz: 'Magniy' },
      { slug: 'zinc', ru: 'Цинк', uz: 'Rux' },
    ] },
    { slug: 'omega', ru: 'Омега-3', uz: 'Omega-3' },
    { slug: 'collagen', ru: 'Коллаген', uz: 'Kollagen' },
    { slug: 'probiotics', ru: 'Пробиотики', uz: 'Probiotiklar' },
    { slug: 'other', ru: 'Другие добавки', uz: 'Boshqa qo‘shimchalar' },
  ],
};

// Online providers stay disabled until the payments stage; timeouts per Master TZ §10.
export const PAYMENT_METHODS = [
  { code: 'card_transfer', name_ru: 'Перевод на карту', name_uz: 'Kartaga o‘tkazma', status: 'enabled' as const, timeout_minutes: 12 * 60 },
  { code: 'bank_transfer', name_ru: 'Банковский перевод', name_uz: 'Bank o‘tkazmasi', status: 'enabled' as const, timeout_minutes: 12 * 60 },
  { code: 'payme', name_ru: 'Payme', name_uz: 'Payme', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'click', name_ru: 'Click', name_uz: 'Click', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'uzum', name_ru: 'Uzum', name_uz: 'Uzum', status: 'disabled' as const, timeout_minutes: 30 },
];

// Clearly fake requisites for dev/test; real ones are entered by the admin.
export const BANK_TRANSFER_DETAILS = {
  recipient: 'ООО «VITALO» (ТЕСТОВЫЕ РЕКВИЗИТЫ)',
  bank_name: 'Тестовый банк',
  account: '20208000000000000001',
  mfo: '00000',
  inn: '000000000',
  purpose_template: 'Оплата заказа {order_number}',
};
