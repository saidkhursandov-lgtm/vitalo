/**
 * «Сверка»: for every unit-tracked product, the units on the shelf vs inventory.actual_qty. Read only.
 *
 * On the shelf = IN_STOCK + ASSIGNED (reserved for a Yandex or a Mini App order, still physically there). Since
 * stage 2E both channels move the units and the stock together (write-off at the handover), so they never cause a
 * difference. reserved_qty = units reserved for Yandex + units reserved for Mini App + reservations by quantity
 * (unpaid Mini App orders, paid ones waiting for units).
 *
 * The only expected difference left: «старые заказы без банок» — Mini App orders paid BEFORE stage 2E, written off
 * by quantity at payment with no units attached (see scripts/attach-order-units.ts). Anything else (an admin
 * override, a lost write) is «не объясняется».
 */
import { PrismaService } from '../prisma/prisma.service';

export type ReconcileState = 'ok' | 'legacy_orders' | 'unexplained';

export interface ReconcileRow {
  product_id: string;
  sku: string;
  name_ru: string;
  /** IN_STOCK + ASSIGNED */
  units_in_stock: number;
  /** ASSIGNED for Yandex orders */
  units_reserved_yandex: number;
  /** ASSIGNED for Mini App orders (stage 2E) */
  units_reserved_vitalo: number;
  actual_qty: number;
  reserved_qty: number;
  /** reserved_qty − all reserved units = reservations by quantity (unpaid Mini App orders, paid ones without units yet) */
  reserved_vitalo: number;
  /** units_in_stock − actual_qty */
  difference: number;
  /** written off by Mini App orders that have no units (paid before 2E) since the product became unit-tracked */
  sold_by_orders: number;
  explained: boolean;
  state: ReconcileState;
}

export const RECONCILE_HINT =
  'Заказы Яндекса и Mini App двигают банки и остаток вместе: банок на полке должно быть столько же, сколько в остатке. Расхождение из-за заказов Mini App, оплаченных до перехода на банки, помечено «старые заказы без банок».';

/**
 * ok: units on the shelf = stock. legacy_orders: the difference is exactly what Mini App orders without units (paid
 * before 2E) took. unexplained: anything else, or fewer reserved than units reserved for orders (a broken write).
 */
export function reconcileState(r: { difference: number; assigned: number; reserved: number; sold: number }): ReconcileState {
  if (r.reserved < r.assigned) return 'unexplained';
  if (r.difference === 0) return 'ok';
  return r.difference === r.sold ? 'legacy_orders' : 'unexplained';
}

export async function reconcileUnits(prisma: PrismaService): Promise<ReconcileRow[]> {
  const rows = await prisma.$queryRaw<{ product_id: string; sku: string; name_ru: string; in_stock: bigint; yandex: bigint; vitalo: bigint; actual: bigint; reserved: bigint; sold: bigint }[]>`
    WITH tracked AS (SELECT id, sku, name_ru FROM products WHERE unit_tracking),
    u AS (
      SELECT pu.product_id,
             count(*) FILTER (WHERE pu.status IN ('IN_STOCK', 'ASSIGNED')) AS in_stock,
             count(*) FILTER (WHERE pu.status = 'ASSIGNED' AND EXISTS (SELECT 1 FROM marketplace_order_units a WHERE a.physical_unit_id = pu.id AND a.released_at IS NULL)) AS yandex,
             count(*) FILTER (WHERE pu.status = 'ASSIGNED' AND EXISTS (SELECT 1 FROM order_item_units a WHERE a.physical_unit_id = pu.id AND a.released_at IS NULL)) AS vitalo
      FROM physical_units pu
      WHERE pu.product_id IN (SELECT id FROM tracked) GROUP BY pu.product_id
    ),
    inv AS (
      SELECT product_id, sum(actual_qty) AS actual, sum(reserved_qty) AS reserved FROM inventory
      WHERE product_id IN (SELECT id FROM tracked) GROUP BY product_id
    ),
    since AS (
      SELECT pu.product_id, min(rs.completed_at) AS t
      FROM physical_units pu JOIN receiving_sessions rs ON rs.id = pu.receiving_session_id
      WHERE rs.type = 'OPENING_BALANCE' AND rs.status = 'COMPLETED' AND pu.product_id IN (SELECT id FROM tracked)
      GROUP BY pu.product_id
    ),
    sold AS (
      -- only orders WITHOUT units of this product: with units the write-off moves the units too
      SELECT m.product_id, sum(CASE WHEN m.movement_type = 'deduct' THEN m.qty ELSE -m.qty END) AS sold
      FROM inventory_movements m JOIN since s ON s.product_id = m.product_id
      WHERE m.reference_type = 'order' AND m.movement_type IN ('deduct', 'return_to_stock') AND m.created_at >= s.t
        AND NOT EXISTS (
          SELECT 1 FROM order_item_units a JOIN physical_units pu ON pu.id = a.physical_unit_id
          WHERE a.order_id = m.reference_id AND pu.product_id = m.product_id
        )
      GROUP BY m.product_id
    )
    SELECT t.id AS product_id, t.sku, t.name_ru,
           coalesce(u.in_stock, 0) AS in_stock, coalesce(u.yandex, 0) AS yandex, coalesce(u.vitalo, 0) AS vitalo,
           coalesce(inv.actual, 0) AS actual, coalesce(inv.reserved, 0) AS reserved, coalesce(sold.sold, 0) AS sold
    FROM tracked t
    LEFT JOIN u ON u.product_id = t.id
    LEFT JOIN inv ON inv.product_id = t.id
    LEFT JOIN sold ON sold.product_id = t.id
    ORDER BY t.sku`;
  return rows.map((r) => {
    const units = Number(r.in_stock);
    const yandex = Number(r.yandex);
    const vitalo = Number(r.vitalo);
    const actual = Number(r.actual);
    const reserved = Number(r.reserved);
    const sold = Number(r.sold);
    const difference = units - actual;
    const state = reconcileState({ difference, assigned: yandex + vitalo, reserved, sold });
    return {
      product_id: r.product_id,
      sku: r.sku,
      name_ru: r.name_ru,
      units_in_stock: units,
      units_reserved_yandex: yandex,
      units_reserved_vitalo: vitalo,
      actual_qty: actual,
      reserved_qty: reserved,
      reserved_vitalo: reserved - yandex - vitalo,
      difference,
      sold_by_orders: sold,
      explained: state !== 'unexplained',
      state,
    };
  });
}

const STATE_RU: Record<ReconcileState, string> = { ok: 'ок', legacy_orders: 'старые заказы без банок', unexplained: 'НЕ ОБЪЯСНЯЕТСЯ' };

export function formatReconcile(rows: ReconcileRow[]): string {
  if (!rows.length) return 'Товаров с учётом по единицам пока нет.';
  const out = ['SKU | на полке (банки) | резерв Яндекса | резерв Mini App | остаток | резерв всего | разница | списано старыми заказами без банок | итог'];
  for (const r of rows) {
    out.push(`${r.sku} | ${r.units_in_stock} | ${r.units_reserved_yandex} | ${r.units_reserved_vitalo} | ${r.actual_qty} | ${r.reserved_qty} | ${r.difference} | ${r.sold_by_orders} | ${STATE_RU[r.state]}`);
  }
  const bad = rows.filter((r) => !r.explained).length;
  out.push('', RECONCILE_HINT, bad ? `Не объясняется: ${bad} из ${rows.length}.` : `Все ${rows.length} товаров сходятся.`);
  return out.join('\n');
}
