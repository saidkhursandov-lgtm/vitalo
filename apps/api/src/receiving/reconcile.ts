/**
 * «Сверка»: for every unit-tracked product, the units on the shelf vs inventory.actual_qty. Read only.
 *
 * On the shelf = IN_STOCK + ASSIGNED (stage 2C: reserved for a Yandex order, still physically there). Yandex
 * orders move the units and the stock together, so they never cause a difference. Until stage 2E a VITALO order
 * lowers actual_qty (deduct) but not the units, so units − actual may equal what VITALO orders took since the
 * product became unit-tracked: that is marked «только заказы VITALO (до 2E)», not an error. Anything else (an
 * admin override, a lost write) is «не объясняется».
 */
import { PrismaService } from '../prisma/prisma.service';

export type ReconcileState = 'ok' | 'vitalo_orders' | 'unexplained';

export interface ReconcileRow {
  product_id: string;
  sku: string;
  name_ru: string;
  /** IN_STOCK + ASSIGNED */
  units_in_stock: number;
  /** ASSIGNED: reserved for Yandex orders */
  units_reserved_yandex: number;
  actual_qty: number;
  reserved_qty: number;
  /** reserved_qty − units reserved for Yandex = what VITALO orders hold */
  reserved_vitalo: number;
  /** units_in_stock − actual_qty */
  difference: number;
  /** what VITALO orders took since tracking started (the part of the difference that is expected before 2E) */
  sold_by_orders: number;
  explained: boolean;
  state: ReconcileState;
}

export const RECONCILE_HINT =
  'Заказы Яндекса двигают банки и остаток вместе. До этапа 2E заказы VITALO уменьшают остаток, но не банки: такое расхождение помечено «только заказы VITALO» и ошибкой не считается.';

/**
 * ok: units on the shelf = stock. vitalo_orders: the difference is exactly what VITALO orders took (old mechanism
 * until 2E). unexplained: anything else, or fewer reserved than units reserved for Yandex (a broken write).
 */
export function reconcileState(r: { difference: number; assigned: number; reserved: number; sold: number }): ReconcileState {
  if (r.reserved < r.assigned) return 'unexplained';
  if (r.difference === 0) return 'ok';
  return r.difference === r.sold ? 'vitalo_orders' : 'unexplained';
}

export async function reconcileUnits(prisma: PrismaService): Promise<ReconcileRow[]> {
  const rows = await prisma.$queryRaw<{ product_id: string; sku: string; name_ru: string; in_stock: bigint; assigned: bigint; actual: bigint; reserved: bigint; sold: bigint }[]>`
    WITH tracked AS (SELECT id, sku, name_ru FROM products WHERE unit_tracking),
    u AS (
      SELECT product_id,
             count(*) FILTER (WHERE status IN ('IN_STOCK', 'ASSIGNED')) AS in_stock,
             count(*) FILTER (WHERE status = 'ASSIGNED') AS assigned
      FROM physical_units
      WHERE product_id IN (SELECT id FROM tracked) GROUP BY product_id
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
      SELECT m.product_id, sum(CASE WHEN m.movement_type = 'deduct' THEN m.qty ELSE -m.qty END) AS sold
      FROM inventory_movements m JOIN since s ON s.product_id = m.product_id
      WHERE m.reference_type = 'order' AND m.movement_type IN ('deduct', 'return_to_stock') AND m.created_at >= s.t
      GROUP BY m.product_id
    )
    SELECT t.id AS product_id, t.sku, t.name_ru,
           coalesce(u.in_stock, 0) AS in_stock, coalesce(u.assigned, 0) AS assigned, coalesce(inv.actual, 0) AS actual,
           coalesce(inv.reserved, 0) AS reserved, coalesce(sold.sold, 0) AS sold
    FROM tracked t
    LEFT JOIN u ON u.product_id = t.id
    LEFT JOIN inv ON inv.product_id = t.id
    LEFT JOIN sold ON sold.product_id = t.id
    ORDER BY t.sku`;
  return rows.map((r) => {
    const units = Number(r.in_stock);
    const assigned = Number(r.assigned);
    const actual = Number(r.actual);
    const reserved = Number(r.reserved);
    const sold = Number(r.sold);
    const difference = units - actual;
    const state = reconcileState({ difference, assigned, reserved, sold });
    return {
      product_id: r.product_id,
      sku: r.sku,
      name_ru: r.name_ru,
      units_in_stock: units,
      units_reserved_yandex: assigned,
      actual_qty: actual,
      reserved_qty: reserved,
      reserved_vitalo: reserved - assigned,
      difference,
      sold_by_orders: sold,
      explained: state !== 'unexplained',
      state,
    };
  });
}

const STATE_RU: Record<ReconcileState, string> = { ok: 'ок', vitalo_orders: 'только заказы VITALO (до 2E)', unexplained: 'НЕ ОБЪЯСНЯЕТСЯ' };

export function formatReconcile(rows: ReconcileRow[]): string {
  if (!rows.length) return 'Товаров с учётом по единицам пока нет.';
  const out = ['SKU | на полке (банки) | из них резерв Яндекса | остаток | резерв | разница | продано заказами VITALO | итог'];
  for (const r of rows) {
    out.push(`${r.sku} | ${r.units_in_stock} | ${r.units_reserved_yandex} | ${r.actual_qty} | ${r.reserved_qty} | ${r.difference} | ${r.sold_by_orders} | ${STATE_RU[r.state]}`);
  }
  const bad = rows.filter((r) => !r.explained).length;
  out.push('', RECONCILE_HINT, bad ? `Не объясняется: ${bad} из ${rows.length}.` : `Все ${rows.length} товаров сходятся.`);
  return out.join('\n');
}
