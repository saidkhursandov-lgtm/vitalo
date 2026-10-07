/**
 * Stage 2B «Сверка»: for every unit-tracked product, units IN_STOCK vs inventory.actual_qty. Read only.
 *
 * Until stage 2C an order lowers actual_qty (deduct) but not the units, so units − actual is expected to equal
 * what orders took since the product became unit-tracked (deduct − return_to_stock of orders after the opening
 * balance was completed). Anything else (an admin override, a lost write) is «не объясняется».
 */
import { PrismaService } from '../prisma/prisma.service';

export interface ReconcileRow {
  product_id: string;
  sku: string;
  name_ru: string;
  units_in_stock: number;
  actual_qty: number;
  reserved_qty: number;
  /** units_in_stock − actual_qty */
  difference: number;
  /** what orders took since tracking started (the part of the difference that is expected before 2C) */
  sold_by_orders: number;
  explained: boolean;
}

export const RECONCILE_HINT = 'До этапа 2C заказы уменьшают остаток, но не единицы: расхождение на проданное по заказам ожидаемо.';

export async function reconcileUnits(prisma: PrismaService): Promise<ReconcileRow[]> {
  const rows = await prisma.$queryRaw<{ product_id: string; sku: string; name_ru: string; in_stock: bigint; actual: bigint; reserved: bigint; sold: bigint }[]>`
    WITH tracked AS (SELECT id, sku, name_ru FROM products WHERE unit_tracking),
    u AS (
      SELECT product_id, count(*) AS in_stock FROM physical_units
      WHERE status = 'IN_STOCK' AND product_id IN (SELECT id FROM tracked) GROUP BY product_id
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
           coalesce(u.in_stock, 0) AS in_stock, coalesce(inv.actual, 0) AS actual,
           coalesce(inv.reserved, 0) AS reserved, coalesce(sold.sold, 0) AS sold
    FROM tracked t
    LEFT JOIN u ON u.product_id = t.id
    LEFT JOIN inv ON inv.product_id = t.id
    LEFT JOIN sold ON sold.product_id = t.id
    ORDER BY t.sku`;
  return rows.map((r) => {
    const units = Number(r.in_stock);
    const actual = Number(r.actual);
    const sold = Number(r.sold);
    return {
      product_id: r.product_id,
      sku: r.sku,
      name_ru: r.name_ru,
      units_in_stock: units,
      actual_qty: actual,
      reserved_qty: Number(r.reserved),
      difference: units - actual,
      sold_by_orders: sold,
      explained: units - actual === sold,
    };
  });
}

export function formatReconcile(rows: ReconcileRow[]): string {
  if (!rows.length) return 'Товаров с учётом по единицам пока нет.';
  const out = ['SKU | единиц IN_STOCK | остаток | резерв | разница | продано заказами | итог'];
  for (const r of rows) {
    out.push(`${r.sku} | ${r.units_in_stock} | ${r.actual_qty} | ${r.reserved_qty} | ${r.difference} | ${r.sold_by_orders} | ${r.explained ? 'ок' : 'НЕ ОБЪЯСНЯЕТСЯ'}`);
  }
  const bad = rows.filter((r) => !r.explained).length;
  out.push('', RECONCILE_HINT, bad ? `Не объясняется: ${bad} из ${rows.length}.` : `Все ${rows.length} товаров сходятся.`);
  return out.join('\n');
}
