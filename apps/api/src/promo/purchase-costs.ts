import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** Units still in the shop: their real cost is the purchase cost of what we sell now. */
const ON_HAND = ['RECEIVED', 'IN_STOCK', 'ASSIGNED'] as const;

/**
 * D-39: the purchase cost of one jar = the larger of the cost in the product card and the dearest jar on hand;
 * null = unknown. The same number protects the margin of promo codes (3.3) and of sales (3.7).
 */
export async function purchaseCosts(db: Db, productIds: string[]): Promise<Map<string, number | null>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();
  const [products, units] = await Promise.all([
    db.products.findMany({ where: { id: { in: ids } }, select: { id: true, cost_uzs: true } }),
    db.physical_units.groupBy({ by: ['product_id'], where: { product_id: { in: ids }, status: { in: [...ON_HAND] } }, _max: { actual_cost_uzs: true } }),
  ]);
  return new Map(
    ids.map((id) => {
      const unitMax = units.find((u) => u.product_id === id)?._max.actual_cost_uzs;
      const costs = [products.find((p) => p.id === id)?.cost_uzs, unitMax].filter((c): c is bigint => c != null).map(Number);
      return [id, costs.length ? Math.max(...costs) : null];
    }),
  );
}
