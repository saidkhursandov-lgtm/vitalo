import { Prisma } from '@prisma/client';
import { modeOpenFor, onlineModes, providerKeysPresent, type OnlineProvider } from '../online/online-providers';
import { paymeConfig } from './payme-config';

type Db = Prisma.TransactionClient | { products: Prisma.TransactionClient['products'] };
type StaffDb = { users: Prisma.TransactionClient['users']; staff_users: Prisma.TransactionClient['staff_users'] };

/** Why Payme cannot be chosen for an order: off = not «Работает» or no keys; ikpu = a product or delivery has no ИКПУ. */
export type PaymeUnavailable = 'off' | 'ikpu';

/** The customer's Telegram account is an active staff account (mode «Тест — только сотрудники»). */
export async function isStaffCustomer(db: StaffDb, userId: string): Promise<boolean> {
  const user = await db.users.findUnique({ where: { id: userId }, select: { telegram_user_id: true } });
  if (!user?.telegram_user_id) return false;
  return !!(await db.staff_users.findFirst({ where: { telegram_user_id: user.telegram_user_id, status: 'active' }, select: { id: true } }));
}

/** «Работает» (or «Тест» and the customer is staff) in Настройки → Оплата and both keys in .env (the module itself is always registered). */
export function paymeSwitchedOn(checkoutOptions: Parameters<typeof onlineModes>[0], staffCustomer: boolean): boolean {
  return onlineSwitchedOn('payme', checkoutOptions, staffCustomer);
}

/** The same for any system with a module (Payme, Click): its mode is open for this customer and its keys are in .env. */
export function onlineSwitchedOn(p: OnlineProvider, checkoutOptions: Parameters<typeof onlineModes>[0], staffCustomer: boolean): boolean {
  return modeOpenFor(onlineModes(checkoutOptions)[p], staffCustomer) && providerKeysPresent(p);
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
  staffCustomer: boolean,
  productIds: string[],
  deliveryCostUzs: number,
): Promise<PaymeUnavailable | null> {
  return onlineUnavailable('payme', db, checkoutOptions, staffCustomer, productIds, deliveryCostUzs);
}

/** Payme and Click send the same fiscal receipt: «off» — not switched on for this customer, «ikpu» — a code is missing. */
export async function onlineUnavailable(
  p: OnlineProvider,
  db: Db,
  checkoutOptions: Parameters<typeof onlineModes>[0],
  staffCustomer: boolean,
  productIds: string[],
  deliveryCostUzs: number,
): Promise<PaymeUnavailable | null> {
  if (!onlineSwitchedOn(p, checkoutOptions, staffCustomer)) return 'off';
  const gaps = await paymeReceiptGaps(db, productIds, deliveryCostUzs);
  return gaps.skus.length || gaps.delivery ? 'ikpu' : null;
}
