import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildCategoryTrees, CategoryTrees, collectDescendantIds } from './category-tree';
import { ListProductsQuery, ProductSort, SearchQuery } from './catalog.dto';
import { cardInclude, listInclude, ProductListItem, toProductCard, toProductListItem } from './product.mapper';

export const PAGE_SIZE = 24;

/** pg_trgm word_similarity threshold for the `<%` operator: lower = more typo-tolerant, noisier. */
const SEARCH_SIMILARITY = 0.45;

const ORDER_BY: Record<ProductSort, Prisma.productsOrderByWithRelationInput[]> = {
  [ProductSort.popular]: [{ popularity_30d: 'desc' }, { created_at: 'desc' }, { id: 'asc' }],
  [ProductSort.price_asc]: [{ price_uzs: 'asc' }, { id: 'asc' }],
  [ProductSort.price_desc]: [{ price_uzs: 'desc' }, { id: 'asc' }],
  [ProductSort.new]: [{ created_at: 'desc' }, { id: 'asc' }],
};

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

function toPage<T>(items: T[], total: number, page: number): Page<T> {
  return { items, page, page_size: PAGE_SIZE, total, total_pages: Math.ceil(total / PAGE_SIZE) };
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async getCategoryTrees(): Promise<CategoryTrees> {
    const rows = await this.prisma.categories.findMany({ where: { status: 'active' } });
    return buildCategoryTrees(rows);
  }

  async listBrands(): Promise<{ brand: string; count: number }[]> {
    const rows = await this.prisma.products.groupBy({
      by: ['brand'],
      where: { status: 'active' },
      _count: { _all: true },
      orderBy: { brand: 'asc' },
    });
    return rows.map((r) => ({ brand: r.brand, count: r._count._all }));
  }

  async listForms(): Promise<{ form: string; count: number }[]> {
    const rows = await this.prisma.products.groupBy({
      by: ['form'],
      where: { status: 'active', form: { not: null } },
      _count: { _all: true },
      orderBy: { form: 'asc' },
    });
    return rows.map((r) => ({ form: r.form!, count: r._count._all }));
  }

  async listProducts(q: ListProductsQuery): Promise<Page<ProductListItem>> {
    const where: Prisma.productsWhereInput = { status: 'active' };

    if (q.category) {
      const cats = await this.prisma.categories.findMany({
        where: { status: 'active' },
        select: { id: true, parent_id: true, slug: true },
      });
      const root = cats.find((c) => c.slug === q.category);
      if (!root) throw new NotFoundException('Category not found');
      where.categories = { some: { category_id: { in: collectDescendantIds(cats, root.id) } } };
    }
    if (q.brand?.length) where.brand = { in: q.brand };
    if (q.form?.length) where.form = { in: q.form };
    if (q.price_min != null || q.price_max != null) {
      where.price_uzs = {
        ...(q.price_min != null && { gte: BigInt(q.price_min) }),
        ...(q.price_max != null && { lte: BigInt(q.price_max) }),
      };
    }

    // Out-of-stock products always go after in-stock ones (any sort): the list is two segments glued together.
    const inStock: Prisma.productsWhereInput = {
      inventory: { some: { actual_qty: { gt: this.prisma.inventory.fields.reserved_qty } } },
    };
    const whereIn: Prisma.productsWhereInput = { AND: [where, inStock] };
    const whereOut: Prisma.productsWhereInput = q.in_stock ? { id: { in: [] } } : { AND: [where, { NOT: inStock }] };

    const [totalIn, totalOut] = await this.prisma.$transaction([
      this.prisma.products.count({ where: whereIn }),
      this.prisma.products.count({ where: whereOut }),
    ]);
    const skip = (q.page - 1) * PAGE_SIZE;
    const rows = [];
    if (skip < totalIn) {
      rows.push(...(await this.prisma.products.findMany({ where: whereIn, orderBy: ORDER_BY[q.sort], skip, take: PAGE_SIZE, include: listInclude })));
    }
    if (rows.length < PAGE_SIZE && totalOut > 0) {
      rows.push(
        ...(await this.prisma.products.findMany({
          where: whereOut,
          orderBy: ORDER_BY[q.sort],
          skip: Math.max(0, skip - totalIn),
          take: PAGE_SIZE - rows.length,
          include: listInclude,
        })),
      );
    }
    return toPage(rows.map(toProductListItem), totalIn + totalOut, q.page);
  }

  async getProduct(id: string) {
    const product = await this.prisma.products.findFirst({ where: { id, status: 'active' }, include: cardInclude });
    if (!product) throw new NotFoundException('Product not found');
    return toProductCard(product);
  }

  /**
   * Typo-tolerant, transliteration-aware search.
   * Both the query and product text go through the DB function vitalo_norm() (migration
   * *_search_normalization), which maps Cyrillic/Uzbek/Latin spellings to one phonetic Latin form:
   * "Коллаген" / "collagen" / "колаген" -> "kolagen". pg_trgm then absorbs the remaining typos.
   * Ranking: exact substring hits first, then by trigram word similarity, then popularity.
   */
  async search(q: SearchQuery): Promise<Page<ProductListItem>> {
    const { ids, total } = await this.prisma.$transaction(async (tx) => {
      const [{ nq }] = await tx.$queryRaw<{ nq: string }[]>`SELECT vitalo_norm(${q.q}::text) AS nq`;
      if (nq.length < 2) return { ids: [] as string[], total: 0 };

      await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(SEARCH_SIMILARITY)}, true)`;
      // Must match the expression of index products_search_doc_trgm exactly, so the index is used.
      const doc = Prisma.sql`vitalo_product_doc(p.name_ru, p.name_uz, p.brand, p.search_keywords)`;
      const like = `%${nq}%`; // nq contains only [a-z0-9 ] -> no LIKE wildcards to escape
      const match = Prisma.sql`p.status = 'active' AND (${doc} LIKE ${like} OR ${nq}::text <% ${doc})`;

      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM products p WHERE ${match}`;
      const hits = await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM products p
        WHERE ${match}
        ORDER BY (${doc} LIKE ${like}) DESC, word_similarity(${nq}::text, ${doc}) DESC, p.popularity_30d DESC, p.id
        LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`;
      return { ids: hits.map((h) => h.id), total: Number(count) };
    });

    const products = await this.prisma.products.findMany({ where: { id: { in: ids } }, include: listInclude });
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = ids.flatMap((id) => {
      const p = byId.get(id);
      return p ? [toProductListItem(p)] : [];
    });
    return toPage(items, total, q.page);
  }
}
