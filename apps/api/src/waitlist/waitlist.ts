import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** Short name in the customer's language (the full name when there is no short one). */
export function productTitle(p: { name_ru: string; name_uz: string | null; short_name_ru: string | null; short_name_uz: string | null }, lang: 'ru' | 'uz'): string {
  return lang === 'uz' ? p.short_name_uz || p.short_name_ru || p.name_uz || p.name_ru : p.short_name_ru || p.name_ru;
}

/** An active subscription: not notified yet and not switched off by the customer (2.4 patch). */
export const ACTIVE = { notified_at: null, cancelled_at: null } as const;

/** Customers waiting for this product right now. */
export function waitingCount(db: Db, productId: string): Promise<number> {
  return db.product_waitlist.count({ where: { product_id: productId, ...ACTIVE } });
}
