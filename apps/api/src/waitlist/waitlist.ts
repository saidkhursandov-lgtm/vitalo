import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** Short name in the customer's language (the full name when there is no short one). */
export function productTitle(p: { name_ru: string; name_uz: string | null; short_name_ru: string | null; short_name_uz: string | null }, lang: 'ru' | 'uz'): string {
  return lang === 'uz' ? p.short_name_uz || p.short_name_ru || p.name_uz || p.name_ru : p.short_name_ru || p.name_ru;
}

/** Customers waiting for this product right now (not notified yet). */
export function waitingCount(db: Db, productId: string): Promise<number> {
  return db.product_waitlist.count({ where: { product_id: productId, notified_at: null } });
}
