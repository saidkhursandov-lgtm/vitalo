/**
 * Stage 2C: the life cycle of a physical unit and how it moves the quantity stock (inventory) of the main
 * warehouse, so that the Mini App and the admin panel keep seeing a correct «available».
 *
 * Counted in inventory.actual_qty («на полке»): IN_STOCK and ASSIGNED (reserved for a Yandex order, still on
 * the shelf). A Yandex reservation also counts in inventory.reserved_qty, next to the VITALO reservations
 * (by quantity, until stage 2E). So available = actual − reserved already includes the Yandex reservations,
 * and nobody can sell more than the shelf has: a unit is reserved only if one unit is still available.
 *
 * The allowed transitions are the same table as the database trigger (migration 20261010100000).
 */
import { ConflictException } from '@nestjs/common';
import { MovementType, PhysicalUnitStatus, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export const TRANSITIONS: readonly [PhysicalUnitStatus, PhysicalUnitStatus][] = [
  ['RECEIVED', 'IN_STOCK'],
  ['RECEIVED', 'VOIDED'],
  ['IN_STOCK', 'ASSIGNED'],
  ['ASSIGNED', 'IN_STOCK'],
  ['ASSIGNED', 'YANDEX_DELIVERY'],
  ['YANDEX_DELIVERY', 'YANDEX_SOLD'],
  ['YANDEX_DELIVERY', 'RETURNED'],
  ['YANDEX_SOLD', 'RETURNED'],
  ['RETURNED', 'IN_STOCK'],
  ['RETURNED', 'WRITTEN_OFF'],
  ['RETURNED', 'MISSING'],
  ['IN_STOCK', 'MISSING'],
  ['MISSING', 'IN_STOCK'],
  ['IN_STOCK', 'WRITTEN_OFF'],
  ['MISSING', 'WRITTEN_OFF'],
  ['WRITTEN_OFF', 'IN_STOCK'],
  ['WRITTEN_OFF', 'MISSING'],
];

export const canMove = (from: PhysicalUnitStatus, to: PhysicalUnitStatus) => TRANSITIONS.some(([a, b]) => a === from && b === to);

/** Statuses that are physically on the shelf and therefore in inventory.actual_qty. */
export const ON_SHELF: readonly PhysicalUnitStatus[] = ['IN_STOCK', 'ASSIGNED'];
export const onShelf = (s: PhysicalUnitStatus) => ON_SHELF.includes(s);

/** Admin correction («статус при явной ошибке»): only between these, never for units that belong to an order. */
export const CORRECTABLE_FROM: readonly PhysicalUnitStatus[] = ['IN_STOCK', 'MISSING', 'WRITTEN_OFF', 'RETURNED'];
export const CORRECTABLE_TO: readonly PhysicalUnitStatus[] = ['IN_STOCK', 'MISSING', 'WRITTEN_OFF'];

export const UNIT_STATUS_RU: Record<PhysicalUnitStatus, string> = {
  RECEIVED: 'Принята',
  IN_STOCK: 'На складе',
  ASSIGNED: 'Зарезервирована',
  YANDEX_DELIVERY: 'В доставке (Яндекс)',
  YANDEX_SOLD: 'Продана (Яндекс)',
  VITALO_DELIVERY: 'В доставке (VITALO)',
  VITALO_SOLD: 'Продана (VITALO)',
  RETURNED: 'Возврат на проверке',
  MISSING: 'Потеряна',
  WRITTEN_OFF: 'Списана',
  VOIDED: 'Отменена',
};

export interface UnitEvent {
  type: string;
  note?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  staffId: string | null;
}

/**
 * One unit from → to with its history event. The UPDATE is conditional on the current status, so a unit changed
 * by a parallel request is never moved twice (409 UNIT_STATUS_CHANGED).
 */
export async function moveUnit(tx: Tx, unitId: string, from: PhysicalUnitStatus, to: PhysicalUnitStatus, e: UnitEvent): Promise<void> {
  if (!canMove(from, to)) {
    throw new ConflictException({ code: 'UNIT_TRANSITION', message: `Нельзя перевести банку из «${UNIT_STATUS_RU[from]}» в «${UNIT_STATUS_RU[to]}»` });
  }
  const res = await tx.physical_units.updateMany({ where: { id: unitId, status: from }, data: { status: to } });
  if (res.count !== 1) throw new ConflictException({ code: 'UNIT_STATUS_CHANGED', message: 'Статус банки только что изменился — обновите страницу' });
  await tx.physical_unit_events.create({
    data: {
      physical_unit_id: unitId,
      type: e.type,
      from_status: from,
      to_status: to,
      reference_type: e.referenceType ?? null,
      reference_id: e.referenceId ?? null,
      note: e.note ?? null,
      created_by: e.staffId,
    },
  });
}

export interface StockMove {
  warehouseId: string;
  productId: string;
  referenceType: string;
  referenceId: string;
  reason?: string | null;
  staffId: string | null;
}

async function ensureRow(tx: Tx, m: StockMove) {
  await tx.inventory.upsert({
    where: { product_id_warehouse_id: { product_id: m.productId, warehouse_id: m.warehouseId } },
    create: { product_id: m.productId, warehouse_id: m.warehouseId },
    update: {},
  });
}

async function movement(tx: Tx, m: StockMove, type: MovementType, qty: number) {
  await tx.inventory_movements.create({
    data: {
      warehouse_id: m.warehouseId,
      product_id: m.productId,
      movement_type: type,
      qty,
      reference_type: m.referenceType,
      reference_id: m.referenceId,
      reason: m.reason ?? null,
      created_by: m.staffId,
    },
  });
}

/**
 * Reserves n units of the product for a Yandex order (reserved_qty += n) only if n are still available
 * (actual − reserved, which includes VITALO reservations). The conditional UPDATE locks the inventory row,
 * so parallel orders (Yandex and VITALO) queue on it and can never reserve more than the shelf has.
 */
export async function reserveStock(tx: Tx, m: StockMove, n: number): Promise<void> {
  await ensureRow(tx, m);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE inventory SET reserved_qty = reserved_qty + ${n}, updated_at = now()
    WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid AND actual_qty - reserved_qty >= ${n}
    RETURNING id`;
  if (!rows.length) {
    const [row] = await tx.$queryRaw<{ available: number }[]>`
      SELECT actual_qty - reserved_qty AS available FROM inventory
      WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid`;
    throw new ConflictException({
      code: 'INSUFFICIENT_STOCK',
      message: `Свободно только ${row?.available ?? 0} шт.: остальное в резерве заказов`,
      product_id: m.productId,
      requested: n,
      available: row?.available ?? 0,
    });
  }
  await movement(tx, m, 'reserve', n);
}

/** Cancel or swap: n reserved units go back to available. */
export async function releaseStock(tx: Tx, m: StockMove, n: number): Promise<void> {
  if (n <= 0) return;
  await tx.$executeRaw`
    UPDATE inventory SET reserved_qty = reserved_qty - ${n}, updated_at = now()
    WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid`;
  await movement(tx, m, 'release', n);
}

/** Handed to delivery: n reserved units leave the shelf (actual and reserved both go down). */
export async function deductStock(tx: Tx, m: StockMove, n: number): Promise<void> {
  if (n <= 0) return;
  await tx.$executeRaw`
    UPDATE inventory SET reserved_qty = reserved_qty - ${n}, actual_qty = actual_qty - ${n}, updated_at = now()
    WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid`;
  await movement(tx, m, 'deduct', n);
}

/**
 * A free unit appears on or disappears from the shelf (return accepted, found, missing, written off, corrected):
 * actual_qty += delta. Going down needs a free unit: if orders hold everything, 409 STOCK_RESERVED.
 */
export async function shiftShelf(tx: Tx, m: StockMove, delta: 1 | -1, type: MovementType): Promise<void> {
  await ensureRow(tx, m);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE inventory SET actual_qty = actual_qty + ${delta}, updated_at = now()
    WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid
      AND actual_qty + ${delta} >= reserved_qty AND actual_qty + ${delta} >= 0
    RETURNING id`;
  if (!rows.length) {
    throw new ConflictException({
      code: 'STOCK_RESERVED',
      message: 'Все банки этого товара в резерве заказов: сначала снимите резерв (отмените или пересоберите заказ)',
    });
  }
  await movement(tx, m, type, type === 'adjustment' ? delta : 1);
}
