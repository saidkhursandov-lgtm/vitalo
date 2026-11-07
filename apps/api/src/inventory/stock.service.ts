import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface StockLine {
  product_id: string;
  qty: number;
}

export interface Shortage {
  product_id: string;
  requested: number;
  available: number;
}

/**
 * All stock changes for orders (and, since stage 2B, for receiving: receiveUnits / setActualQty, whose
 * movements point to the receiving session). Every order change is an inventory_movements row with
 * reference_type='order', so what an order still holds is always derivable:
 * held = reserve - release - deduct (per warehouse and product).
 */
@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Units that can be sold right now, per product: the best single warehouse (an order line is
   * reserved in one warehouse). Products without inventory rows get 0.
   */
  async availability(productIds: string[], db: Db = this.prisma): Promise<Map<string, number>> {
    const rows = await db.inventory.findMany({
      where: { product_id: { in: productIds } },
      select: { product_id: true, actual_qty: true, reserved_qty: true },
    });
    const result = new Map(productIds.map((id) => [id, 0]));
    for (const r of rows) {
      result.set(r.product_id, Math.max(result.get(r.product_id) ?? 0, r.actual_qty - r.reserved_qty));
    }
    return result;
  }

  /**
   * Atomically reserves every line or throws 409 INSUFFICIENT_STOCK (the caller's transaction then
   * rolls back all lines). The conditional UPDATE re-checks availability under a row lock, so parallel
   * orders queue on the inventory row and can never push reserved above actual (also guarded by a CHECK).
   */
  async reserve(tx: Prisma.TransactionClient, orderId: string, lines: StockLine[]): Promise<void> {
    const shortages: Shortage[] = [];
    // Fixed lock order (by product id) -> two orders with the same products cannot deadlock.
    for (const line of [...lines].sort((a, b) => a.product_id.localeCompare(b.product_id))) {
      const warehouseId = await this.reserveLine(tx, line);
      if (!warehouseId) {
        const available = (await this.availability([line.product_id], tx)).get(line.product_id) ?? 0;
        shortages.push({ product_id: line.product_id, requested: line.qty, available });
        continue;
      }
      await tx.inventory_movements.create({
        data: {
          warehouse_id: warehouseId,
          product_id: line.product_id,
          movement_type: 'reserve',
          qty: line.qty,
          reference_type: 'order',
          reference_id: orderId,
        },
      });
    }
    if (shortages.length) {
      throw new ConflictException({ code: 'INSUFFICIENT_STOCK', message: 'Not enough stock', items: shortages });
    }
  }

  /** Cancel/expiry: return everything the order still holds to available stock. */
  release(tx: Prisma.TransactionClient, orderId: string, staffId?: string): Promise<void> {
    return this.settle(tx, orderId, 'release', staffId);
  }

  /**
   * Payment confirmed: the reservation becomes a real write-off (actual and reserved both go down).
   * Stage 2E: `skipProductIds` — unit-tracked products keep their reservation at payment (their units are reserved
   * instead) and are written off at the handover by deductProducts, so nothing is deducted twice.
   */
  deduct(tx: Prisma.TransactionClient, orderId: string, staffId?: string, skipProductIds: string[] = []): Promise<void> {
    return this.settle(tx, orderId, 'deduct', staffId, (productId) => !skipProductIds.includes(productId));
  }

  /** Stage 2E, handed to delivery: what the order still holds of these (unit-tracked) products leaves the shelf. */
  deductProducts(tx: Prisma.TransactionClient, orderId: string, productIds: string[], staffId?: string): Promise<void> {
    return this.settle(tx, orderId, 'deduct', staffId, (productId) => productIds.includes(productId));
  }

  /** What the order still holds in reservation per product (reserve − release − deduct). */
  async heldByProduct(tx: Prisma.TransactionClient, orderId: string): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<{ product_id: string; held: bigint }[]>`
      SELECT product_id, SUM(CASE WHEN movement_type = 'reserve' THEN qty ELSE -qty END) AS held
      FROM inventory_movements
      WHERE reference_type = 'order' AND reference_id = ${orderId}::uuid AND movement_type IN ('reserve', 'release', 'deduct')
      GROUP BY product_id`;
    return new Map(rows.map((r) => [r.product_id, Number(r.held)]));
  }

  /**
   * A paid order is cancelled by staff: units already written off go back to stock
   * (return_to_stock movements). Call under the order row lock; repeated calls return nothing more.
   */
  async returnDeducted(tx: Prisma.TransactionClient, orderId: string, staffId: string | null): Promise<void> {
    const rows = await tx.$queryRaw<{ warehouse_id: string; product_id: string; qty: bigint }[]>`
      SELECT warehouse_id, product_id,
             SUM(CASE WHEN movement_type = 'deduct' THEN qty ELSE -qty END) AS qty
      FROM inventory_movements
      WHERE reference_type = 'order' AND reference_id = ${orderId}::uuid
        AND movement_type IN ('deduct', 'return_to_stock')
      GROUP BY warehouse_id, product_id
      ORDER BY product_id, warehouse_id`;
    for (const r of rows) {
      const qty = Number(r.qty);
      if (qty <= 0) continue;
      await tx.$executeRaw`
        UPDATE inventory SET actual_qty = actual_qty + ${qty}, updated_at = now()
        WHERE product_id = ${r.product_id}::uuid AND warehouse_id = ${r.warehouse_id}::uuid`;
      await tx.inventory_movements.create({
        data: {
          warehouse_id: r.warehouse_id,
          product_id: r.product_id,
          movement_type: 'return_to_stock',
          qty,
          reference_type: 'order',
          reference_id: orderId,
          reason: 'Paid order cancelled',
          created_by: staffId,
        },
      });
    }
  }

  /**
   * Stage 2B: the warehouse that receives units — the only active one, or the only Tashkent one among several
   * (the same rule as the product import).
   */
  async mainWarehouseId(db: Db = this.prisma): Promise<string> {
    const active = await db.warehouses.findMany({ where: { status: 'active' }, orderBy: { name: 'asc' } });
    const tashkent = active.filter((w) => /ташкент|toshkent|tashkent/i.test(`${w.name} ${w.address ?? ''}`));
    const pick = active.length === 1 ? active[0] : tashkent.length === 1 ? tashkent[0] : null;
    if (!pick) throw new ConflictException({ code: 'NO_MAIN_WAREHOUSE', message: 'Не удалось определить основной склад (Ташкент)' });
    return pick.id;
  }

  /**
   * Stage 2B: received units go on stock (actual_qty += qty) with a receipt movement that points to the
   * receiving session. Call inside the transaction that moves the units to IN_STOCK.
   */
  async receiveUnits(
    tx: Prisma.TransactionClient,
    m: { warehouseId: string; productId: string; qty: number; referenceType: string; referenceId: string; reason: string; staffId: string | null },
  ): Promise<void> {
    if (m.qty <= 0) return;
    await tx.inventory.upsert({
      where: { product_id_warehouse_id: { product_id: m.productId, warehouse_id: m.warehouseId } },
      create: { product_id: m.productId, warehouse_id: m.warehouseId },
      update: {},
    });
    await tx.$executeRaw`
      UPDATE inventory SET actual_qty = actual_qty + ${m.qty}, updated_at = now()
      WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid`;
    await tx.inventory_movements.create({
      data: {
        warehouse_id: m.warehouseId,
        product_id: m.productId,
        movement_type: 'receipt',
        qty: m.qty,
        reference_type: m.referenceType,
        reference_id: m.referenceId,
        reason: m.reason,
        created_by: m.staffId,
      },
    });
  }

  /**
   * Stage 2B opening balance: actual_qty becomes `target` with one adjustment movement (signed difference).
   * Refuses (409 STOCK_RESERVED) when orders hold more than that. Returns the quantities before and after.
   */
  async setActualQty(
    tx: Prisma.TransactionClient,
    m: { warehouseId: string; productId: string; target: number; referenceType: string; referenceId: string; reason: string; staffId: string | null },
  ): Promise<{ before: number; after: number; reserved: number; delta: number }> {
    await tx.inventory.upsert({
      where: { product_id_warehouse_id: { product_id: m.productId, warehouse_id: m.warehouseId } },
      create: { product_id: m.productId, warehouse_id: m.warehouseId },
      update: {},
    });
    const [row] = await tx.$queryRaw<{ actual_qty: number; reserved_qty: number }[]>`
      SELECT actual_qty, reserved_qty FROM inventory
      WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid
      FOR UPDATE`;
    if (m.target < row.reserved_qty) {
      throw new ConflictException({
        code: 'STOCK_RESERVED',
        message: `Заказы держат в резерве ${row.reserved_qty} шт., а единиц ${m.target}: остаток нельзя сделать меньше резерва`,
        reserved_qty: row.reserved_qty,
        target: m.target,
        product_id: m.productId,
      });
    }
    const delta = m.target - row.actual_qty;
    if (delta !== 0) {
      await tx.$executeRaw`
        UPDATE inventory SET actual_qty = ${m.target}, updated_at = now()
        WHERE product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid`;
      await tx.inventory_movements.create({
        data: {
          warehouse_id: m.warehouseId,
          product_id: m.productId,
          movement_type: 'adjustment',
          qty: delta,
          reference_type: m.referenceType,
          reference_id: m.referenceId,
          reason: m.reason,
          created_by: m.staffId,
        },
      });
    }
    return { before: row.actual_qty, after: m.target, reserved: row.reserved_qty, delta };
  }

  private async reserveLine(tx: Prisma.TransactionClient, { product_id, qty }: StockLine): Promise<string | null> {
    // A row can stop qualifying while we wait for its lock; one retry re-reads fresh data.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rows = await tx.$queryRaw<{ warehouse_id: string }[]>`
        WITH target AS (
          SELECT id FROM inventory
          WHERE product_id = ${product_id}::uuid AND actual_qty - reserved_qty >= ${qty}
          ORDER BY actual_qty - reserved_qty DESC, warehouse_id
          LIMIT 1
          FOR UPDATE
        )
        UPDATE inventory i
        SET reserved_qty = i.reserved_qty + ${qty}, updated_at = now()
        FROM target
        WHERE i.id = target.id AND i.actual_qty - i.reserved_qty >= ${qty}
        RETURNING i.warehouse_id`;
      if (rows.length) return rows[0].warehouse_id;
    }
    return null;
  }

  /** Must be called while holding the order row lock, so an order is never settled twice. */
  private async settle(tx: Prisma.TransactionClient, orderId: string, kind: 'release' | 'deduct', staffId?: string, only: (productId: string) => boolean = () => true) {
    const held = await tx.$queryRaw<{ warehouse_id: string; product_id: string; held: bigint }[]>`
      SELECT warehouse_id, product_id,
             SUM(CASE WHEN movement_type = 'reserve' THEN qty ELSE -qty END) AS held
      FROM inventory_movements
      WHERE reference_type = 'order' AND reference_id = ${orderId}::uuid
        AND movement_type IN ('reserve', 'release', 'deduct')
      GROUP BY warehouse_id, product_id
      ORDER BY product_id, warehouse_id`;

    for (const h of held) {
      const qty = Number(h.held);
      if (qty <= 0 || !only(h.product_id)) continue;
      if (kind === 'deduct') {
        await tx.$executeRaw`
          UPDATE inventory SET reserved_qty = reserved_qty - ${qty}, actual_qty = actual_qty - ${qty}, updated_at = now()
          WHERE product_id = ${h.product_id}::uuid AND warehouse_id = ${h.warehouse_id}::uuid`;
      } else {
        await tx.$executeRaw`
          UPDATE inventory SET reserved_qty = reserved_qty - ${qty}, updated_at = now()
          WHERE product_id = ${h.product_id}::uuid AND warehouse_id = ${h.warehouse_id}::uuid`;
      }
      await tx.inventory_movements.create({
        data: {
          warehouse_id: h.warehouse_id,
          product_id: h.product_id,
          movement_type: kind,
          qty,
          reference_type: 'order',
          reference_id: orderId,
          created_by: staffId ?? null,
        },
      });
    }
  }
}
