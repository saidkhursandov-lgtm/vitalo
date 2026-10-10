/**
 * Stage 2E, one-off: Mini App orders of unit-tracked products that were paid BEFORE stage 2E. They were written off
 * by quantity at payment and have no units, so «Сверка» shows them as «старые заказы без банок».
 *
 * - Not shipped yet (paid / picking): can be brought to the new model — the written-off quantity goes back on the
 *   shelf and into the order's reservation, and concrete units are reserved by FEFO (all or nothing per order).
 *   From then on the order is assembled and written off at the handover like any 2E order.
 * - Already shipped (handed to delivery / in transit / delivered): only listed. Which jars physically left is not
 *   known to the system; the admin marks them by hand (Склад → Единицы → «Списать» or «Корректировка»).
 *
 * The plan only reads. Used by scripts/attach-order-units.ts (dry run by default, *_dev / *_test only).
 */
import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderUnitsService } from './order-units.service';

export interface LegacyOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  lines: { product_id: string; sku: string; qty: number }[];
}

export interface LegacyPlan {
  /** paid / picking: units can be attached */
  attach: LegacyOrder[];
  /** already shipped: listed only */
  shipped: LegacyOrder[];
}

const OPEN: OrderStatus[] = ['paid', 'picking'];
const SHIPPED: OrderStatus[] = ['handed_to_delivery', 'in_transit', 'delivered'];

export async function planLegacyOrders(prisma: PrismaService, stock: StockService): Promise<LegacyPlan> {
  const orders = await prisma.orders.findMany({
    where: { status: { in: [...OPEN, ...SHIPPED] }, units_attention: null, item_units: { none: {} }, items: { some: { product: { unit_tracking: true } } } },
    orderBy: { created_at: 'asc' },
    include: { items: { where: { product: { unit_tracking: true } }, include: { product: { select: { sku: true } } } } },
  });
  const plan: LegacyPlan = { attach: [], shipped: [] };
  for (const o of orders) {
    const held = await stock.heldByProduct(prisma, o.id);
    // legacy = the order holds nothing of the product any more (it was written off at payment)
    const lines = o.items.filter((i) => (held.get(i.product_id) ?? 0) === 0).map((i) => ({ product_id: i.product_id, sku: i.product.sku, qty: i.qty }));
    if (!lines.length) continue;
    (OPEN.includes(o.status) ? plan.attach : plan.shipped).push({ id: o.id, order_number: o.order_number, status: o.status, lines });
  }
  return plan;
}

/** One order per transaction: either it gets all its units or nothing changes for it. */
export async function attachLegacyOrders(prisma: PrismaService, stock: StockService, units: OrderUnitsService, plan: LegacyPlan) {
  const done: { order_number: string; reserved: string[] }[] = [];
  const failed: { order_number: string; reason: string }[] = [];
  for (const o of plan.attach) {
    try {
      const reserved = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string; status: OrderStatus; order_number: string }[]>`
          SELECT id, status::text AS status, order_number FROM orders WHERE id = ${o.id}::uuid FOR UPDATE`;
        if (!locked || !OPEN.includes(locked.status)) throw new ConflictException({ message: 'статус заказа изменился' });
        const held = await stock.heldByProduct(tx, o.id);
        for (const l of o.lines) {
          if ((held.get(l.product_id) ?? 0) !== 0) continue; // already converted
          const inv = await tx.inventory.findFirst({ where: { product_id: l.product_id }, orderBy: { actual_qty: 'desc' } });
          if (!inv) throw new ConflictException({ message: `${l.sku}: нет строки остатка` });
          // back on the shelf and into the order's reservation: from now on written off at the handover
          await tx.$executeRaw`UPDATE inventory SET actual_qty = actual_qty + ${l.qty}, reserved_qty = reserved_qty + ${l.qty}, updated_at = now() WHERE id = ${inv.id}::uuid`;
          const base = { warehouse_id: inv.warehouse_id, product_id: l.product_id, qty: l.qty, reference_type: 'order', reference_id: o.id };
          await tx.inventory_movements.create({ data: { ...base, movement_type: 'return_to_stock', reason: 'Этап 2E: заказ переведён на учёт по банкам' } });
          await tx.inventory_movements.create({ data: { ...base, movement_type: 'reserve', reason: 'Этап 2E: заказ переведён на учёт по банкам' } });
        }
        const got = await units.reserveMissing(tx, locked, null);
        await tx.audit_logs.create({ data: { action: 'order.units_attached', entity_type: 'order', entity_id: o.id, after_json: { reserved: got, via: 'attach-order-units' } } });
        return got;
      });
      done.push({ order_number: o.order_number, reserved });
    } catch (e) {
      const message = e instanceof ConflictException ? ((e.getResponse() as { message?: string }).message ?? e.message) : (e as Error).message;
      failed.push({ order_number: o.order_number, reason: message });
    }
  }
  return { done, failed };
}

export function formatLegacyPlan(plan: LegacyPlan): string {
  const line = (o: LegacyOrder) => `  ${o.order_number} (${o.status}): ${o.lines.map((l) => `${l.sku} × ${l.qty}`).join(', ')}`;
  return [
    `Оплачены до 2E и ещё не отправлены — банки можно закрепить: ${plan.attach.length}`,
    ...plan.attach.map(line),
    `Уже отправлены — только список, банки отметьте вручную (Склад → Единицы): ${plan.shipped.length}`,
    ...plan.shipped.map(line),
  ].join('\n');
}
