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
 * All stock changes for orders. Every change is an inventory_movements row with
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

  /** Payment confirmed: the reservation becomes a real write-off (actual and reserved both go down). */
  deduct(tx: Prisma.TransactionClient, orderId: string, staffId?: string): Promise<void> {
    return this.settle(tx, orderId, 'deduct', staffId);
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
  private async settle(tx: Prisma.TransactionClient, orderId: string, kind: 'release' | 'deduct', staffId?: string) {
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
      if (qty <= 0) continue;
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
