import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { withParents } from '../compat/knowledge';
import { availableQty } from './product.mapper';
import { pickPair, ruleBetween, type PairProduct, type PairRule } from './pair';

const CACHE_MS = 5 * 60_000;
/** Bumped when an admin changes a product: the next card reads fresh data (no module import cycle). */
let generation = 0;
export function invalidatePairCache() {
  generation++;
}

interface PairData {
  at: number;
  generation: number;
  rules: PairRule[];
  /** every active product (the main one may be out of stock) */
  all: Map<string, PairProduct & { pair_product_id: string | null; pair_off: boolean }>;
  /** the products in stock: the pair is bought now, so it must be there */
  inStock: Set<string>;
}

/** 4.1 «Идеальная пара»: which product to show next to a product. The data is kept 5 minutes. */
@Injectable()
export class PairService {
  private cache: PairData | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** For tests and after the admin changes a pair. */
  reset() {
    this.cache = null;
  }

  private async data(now = Date.now()): Promise<PairData> {
    if (this.cache && this.cache.generation === generation && now - this.cache.at < CACHE_MS) return this.cache;
    const [subs, rules, products] = await Promise.all([
      this.prisma.substances.findMany({ select: { id: true, parent_id: true } }),
      this.prisma.compat_rules.findMany({
        where: { kind: 'synergy', status: 'approved', substance_a: { enabled: true }, substance_b: { enabled: true } },
        select: { substance_a_id: true, substance_b_id: true, text_ru: true, text_uz: true },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.products.findMany({
        where: { status: 'active', is_test: false },
        select: {
          id: true,
          audience: true,
          popularity_30d: true,
          price_uzs: true,
          pair_product_id: true,
          pair_off: true,
          inventory: { select: { actual_qty: true, reserved_qty: true } },
          substances: { select: { substance_id: true, in_label: true } },
        },
      }),
    ]);
    const parentOf = new Map(subs.map((s) => [s.id, s.parent_id]));
    const all = new Map(
      products.map((p) => [
        p.id,
        {
          id: p.id,
          audience: p.audience,
          substances: withParents(p.substances.map((s) => s.substance_id), parentOf),
          label: withParents(p.substances.filter((s) => s.in_label).map((s) => s.substance_id), parentOf),
          popularity: p.popularity_30d,
          price: Number(p.price_uzs),
          pair_product_id: p.pair_product_id,
          pair_off: p.pair_off,
        },
      ]),
    );
    this.cache = {
      at: now,
      generation,
      rules: rules.map((r) => ({ a: r.substance_a_id, b: r.substance_b_id, text_ru: r.text_ru, text_uz: r.text_uz })),
      all,
      inStock: new Set(products.filter((p) => availableQty(p.inventory) > 0).map((p) => p.id)),
    };
    return this.cache;
  }

  /**
   * The pair of a product: switched off → none; chosen by hand and in stock → that one (with the rule joining them,
   * if any); otherwise picked from the rules.
   */
  async pairOf(productId: string): Promise<{ product_id: string; why_ru: string | null; why_uz: string | null } | null> {
    const d = await this.data();
    const main = d.all.get(productId);
    if (!main || main.pair_off) return null;
    const manual = main.pair_product_id ? d.all.get(main.pair_product_id) : undefined;
    if (manual && manual.id !== main.id && d.inStock.has(manual.id)) {
      const rule = ruleBetween(main, manual, d.rules);
      return { product_id: manual.id, why_ru: rule?.text_ru ?? null, why_uz: rule?.text_uz ?? null };
    }
    const pick = pickPair(main, [...d.all.values()].filter((p) => d.inStock.has(p.id)), d.rules);
    return pick && { product_id: pick.product_id, why_ru: pick.rule?.text_ru ?? null, why_uz: pick.rule?.text_uz ?? null };
  }
}
