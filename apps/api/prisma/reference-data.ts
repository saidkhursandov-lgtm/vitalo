/**
 * Reference data shared by the dev/test seed (prisma/seed.ts) and the production bootstrap
 * (prisma/bootstrap.ts): category trees, payment methods, placeholder bank requisites. No products, no people.
 */
import { createHash } from 'crypto';
import type { TreeType } from '@prisma/client';
import { NEED_TARGETS, TYPE_TARGETS } from '../src/catalog/stage22-transfer';

/** Deterministic UUID (v5-shaped) from a stable key. */
export function uid(key: string): string {
  const h = createHash('sha1').update(`vitalo-seed:${key}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface CategorySeed { slug: string; ru: string; uz: string; children?: CategorySeed[] }

/**
 * Stage 2.2: one level, «По потребности» (8) and «По типу» (7). The old trees with «Кожа», «Витамин D» … are kept
 * hidden on existing databases (npm run catalog:stage22); a fresh database gets only the new ones.
 */
export const CATEGORIES: Record<TreeType, CategorySeed[]> = {
  need: NEED_TARGETS,
  product_type: TYPE_TARGETS,
};

// Online providers stay disabled until the payments stage; timeouts per Master TZ §10.
export const PAYMENT_METHODS = [
  { code: 'card_transfer', name_ru: 'Перевод на карту', name_uz: 'Kartaga o‘tkazma', status: 'enabled' as const, timeout_minutes: 12 * 60 },
  { code: 'bank_transfer', name_ru: 'Банковский перевод', name_uz: 'Bank o‘tkazmasi', status: 'enabled' as const, timeout_minutes: 12 * 60 },
  { code: 'payme', name_ru: 'Payme', name_uz: 'Payme', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'click', name_ru: 'Click', name_uz: 'Click', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'uzum', name_ru: 'Uzum', name_uz: 'Uzum', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'cod', name_ru: 'Оплата при получении', name_uz: 'Qabul qilganda to‘lash', status: 'enabled' as const, timeout_minutes: 0 },
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
