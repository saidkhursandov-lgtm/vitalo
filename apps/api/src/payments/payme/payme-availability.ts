import { Prisma } from '@prisma/client';
import { onlineModes, providerKeysPresent } from '../online/online-providers';
import { paymeConfig } from './payme-config';

type Db = Prisma.TransactionClient | { products: Prisma.TransactionClient['products'] };

/** Why Payme cannot be chosen for an order: off = not «Работает» or no keys; ikpu = a product or delivery has no ИКПУ. */
export type PaymeUnavailable = 'off' | 'ikpu';

/** «Работает» in Настройки → Оплата and both keys in .env (the module itself is always registered). */
export function paymeSwitchedOn(checkoutOptions: Parameters<typeof onlineModes>[0]): boolean {
  return onlineModes(checkoutOptions).payme === 'live' && providerKeysPresent('payme');
}

/**
 * Payme sends a fiscal receipt, so every product needs ИКПУ and the package code, and a paid delivery needs the
 * delivery codes from .env. Returns the SKUs without codes and whether the delivery codes are missing.
 */
export async function paymeReceiptGaps(db: Db, productIds: string[], deliveryCostUzs: number): Promise<{ skus: string[]; delivery: boolean }> {
  const rows = await db.products.findMany({ where: { id: { in: productIds } }, select: { sku: true, ikpu_code: true, package_code: true } });
  const skus = rows.filter((r) => !r.ikpu_code?.trim() || !r.package_code?.trim()).map((r) => r.sku);
  const cfg = paymeConfig();
  return { skus, delivery: deliveryCostUzs > 0 && (!cfg.deliveryIkpu || !cfg.deliveryPackageCode) };
}

export async function paymeUnavailable(
  db: Db,
  checkoutOptions: Parameters<typeof onlineModes>[0],
  productIds: string[],
  deliveryCostUzs: number,
): Promise<PaymeUnavailable | null> {
  if (!paymeSwitchedOn(checkoutOptions)) return 'off';
  const gaps = await paymeReceiptGaps(db, productIds, deliveryCostUzs);
  return gaps.skus.length || gaps.delivery ? 'ikpu' : null;
}
