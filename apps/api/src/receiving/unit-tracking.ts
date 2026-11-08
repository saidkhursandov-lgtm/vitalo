/**
 * Unit tracking (products.unit_tracking): from then on the product's stock goes through its units (Physical ID) and
 * Yandex orders reserve them. Set by «Завершить» of the opening balance (S2B-3) and, since S2B-10, by «Завершить» of
 * a receiving by purchase — only when the stock equals the units on the shelf afterwards (a product with an old stock
 * without units still needs the opening balance, otherwise the stock and the units would never match).
 */
import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/** Physically on the shelf: in stock or reserved for an order (as in «Сверка»). */
export const ON_SHELF = ['IN_STOCK', 'ASSIGNED'] as const;

export interface TrackingState {
  product_id: string;
  sku: string;
  unit_tracking: boolean;
  /** Σ inventory.actual_qty */
  actual: number;
  /** units IN_STOCK + ASSIGNED */
  on_shelf: number;
  /** the product has units in an open opening balance session */
  open_opening: boolean;
}

export async function trackingStates(db: Db, productIds: string[]): Promise<TrackingState[]> {
  if (!productIds.length) return [];
  const [products, stock, shelf, opening] = await Promise.all([
    db.products.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, unit_tracking: true }, orderBy: { sku: 'asc' } }),
    db.inventory.groupBy({ by: ['product_id'], where: { product_id: { in: productIds } }, _sum: { actual_qty: true } }),
    db.physical_units.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, status: { in: [...ON_SHELF] } }, _count: { _all: true } }),
    db.physical_units.findMany({
      where: { product_id: { in: productIds }, status: 'RECEIVED', receiving_session: { type: 'OPENING_BALANCE', status: 'OPEN' } },
      select: { product_id: true },
      distinct: ['product_id'],
    }),
  ]);
  return products.map((p) => ({
    product_id: p.id,
    sku: p.sku,
    unit_tracking: p.unit_tracking,
    actual: stock.find((s) => s.product_id === p.id)?._sum.actual_qty ?? 0,
    on_shelf: shelf.find((s) => s.product_id === p.id)?._count._all ?? 0,
    open_opening: opening.some((o) => o.product_id === p.id),
  }));
}

/** May the product switch to unit tracking right now: the stock is exactly its units on the shelf. */
export const canStartTracking = (s: TrackingState) => !s.unit_tracking && s.on_shelf > 0 && s.actual === s.on_shelf && !s.open_opening;

/** Why a product is not unit-tracked and what to do — for the Yandex order screens, the sync and the receiving. */
export function notTrackedReason(s: TrackingState): string {
  const base = `${s.sku} не переведён на учёт по банкам (банок на полке: ${s.on_shelf}, остаток: ${s.actual})`;
  if (s.open_opening) return `${base} — начальный остаток по нему не завершён: завершите его в «Склад → Приёмка»`;
  if (s.on_shelf === 0) return `${base} — банок нет: примите товар через «Склад → Приёмка»`;
  if (s.on_shelf !== s.actual) return `${base} — остаток не равен числу банок: нужен начальный остаток (пересчёт) по этому товару`;
  return `${base} — остаток равен числу банок, но учёт не включён (банки приняты до решения S2B-10): администратор включает его кнопкой «Включить учёт по банкам» в «Склад → Сверка»`;
}
