import { Injectable, NotFoundException } from '@nestjs/common';
import { BonusSettings, normalizeBonusSettings } from '../bonus/bonus-rules';
import { customerModes, onlineModes } from '../payments/online/online-providers';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from '../promo/campaigns.service';
import { DeliveryService } from '../delivery/delivery.service';
import { manifestOrDefault } from '../settings/home-content';
import { SettingsService, supportLink } from '../settings/settings.service';
import { underOrderOf, SUPPLIER_TERMS_SELECT } from '../orders/cross-border';
import { buildCategoryTrees, CategoryTrees, collectDescendantIds, pruneEmpty } from './category-tree';
import { ListProductsQuery, ProductSort, SearchQuery } from './catalog.dto';
import { availableQty, cardInclude, listInclude, ProductListItem, toProductCard, toProductListItem } from './product.mapper';

export const PAGE_SIZE = 24;
/** 6а-Б: how many cards a home strip shows */
export const HOME_STRIP = 10;

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

export interface BrandCardView {
  id: string;
  slug: string;
  name: string;
  name_uz: string | null;
  logo_url: string | null;
  product_count: number;
}

export interface BrandPageView extends BrandCardView {
  country_ru: string | null;
  country_uz: string | null;
  why_vitalo_ru: string | null;
  why_vitalo_uz: string | null;
}

function toBrandCard(b: { id: string; slug: string | null; name_ru: string; name_uz: string | null; logo_url: string | null }, count: number): BrandCardView {
  return { id: b.id, slug: b.slug!, name: b.name_ru, name_uz: b.name_uz, logo_url: b.logo_url, product_count: count };
}

function toPage<T>(items: T[], total: number, page: number): Page<T> {
  return { items, page, page_size: PAGE_SIZE, total, total_pages: Math.ceil(total / PAGE_SIZE) };
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly delivery: DeliveryService,
    private readonly campaigns: CampaignsService,
  ) {}

  /** Both trees; every node carries product_count = products available to customers in it or below it. */
  /** Customers get only categories with products; includeEmpty = all of them (admin product card). */
  async getCategoryTrees(includeEmpty = false): Promise<CategoryTrees> {
    const [rows, links] = await Promise.all([
      this.prisma.categories.findMany({ where: { status: 'active' } }),
      this.prisma.product_categories.findMany({ where: { product: { status: 'active' } }, select: { category_id: true, product_id: true } }),
    ]);
    const productsByCategory = new Map<string, Set<string>>();
    for (const l of links) {
      if (!productsByCategory.has(l.category_id)) productsByCategory.set(l.category_id, new Set());
      productsByCategory.get(l.category_id)!.add(l.product_id);
    }
    const trees = buildCategoryTrees(rows, productsByCategory);
    return includeEmpty ? trees : pruneEmpty(trees);
  }

  /** Same filters as the list, only the number (for the "Показать N товаров" button). */
  async countProducts(q: ListProductsQuery): Promise<{ total: number }> {
    const { where, inStock } = await this.filterWhere(q);
    return { total: await this.prisma.products.count({ where: q.in_stock ? { AND: [where, inStock] } : where }) };
  }

  /** Checkout switches for the Mini App: the online modes are always filled in (2.1); show_online_soon mirrors them. */
  private async checkoutForApp() {
    const saved = await this.settings.getOrDefault('checkout_options');
    const online = customerModes(onlineModes(saved)); // «Тест» = «Скоро» for customers; staff see Payme in the preview
    return { cod_max_total_uzs: saved.cod_max_total_uzs, first_order_free_delivery: saved.first_order_free_delivery, online, show_online_soon: Object.values(online).includes('soon') };
  }

  private async bonusRules() {
    const s = normalizeBonusSettings(await this.settings.get<Partial<BonusSettings>>('bonus'));
    return { enabled: s.enabled, cashback_pct: s.enabled ? s.cashback_pct : 0, max_spend_pct: s.max_spend_pct };
  }

  /** Everything the Mini App shows from settings: texts, support contact, payment hours, delivery terms. */
  async texts() {
    const support = await this.settings.getOrDefault('support_contact');
    return {
      product_disclaimer: await this.settings.getOrDefault('product_disclaimer'),
      support_contact: support,
      support_url: supportLink(support),
      payment_check_hours: await this.settings.getOrDefault('payment_check_hours'),
      delivery_days_label: await this.settings.getOrDefault('delivery_days_label'),
      delivery_terms: await this.delivery.terms(),
      home_content: await this.settings.getOrDefault('home_content'),
      bonus_teaser: await this.settings.getOrDefault('bonus_teaser'),
      // 3.10-А: «+N сум на бонусный счёт» on the product card (the server counts the real cashback after the delivery)
      bonus: await this.bonusRules(),
      manifest: manifestOrDefault(await this.settings.get('home_manifest')),
      // Release 1: what checkout and the home page may show (the server re-checks everything on order creation)
      checkout: await this.checkoutForApp(),
    };
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

  /**
   * An active category by its address. A hidden old one («Кожа», «Витамин D» …, 2.2) leads to the category that
   * replaced it, so old links and banners keep working; a hidden one without a replacement is «not found».
   */
  async resolveCategory(slug: string): Promise<{ id: string; slug: string }> {
    let cat = await this.prisma.categories.findUnique({ where: { slug }, select: { id: true, slug: true, status: true, merged_into_id: true } });
    for (let hops = 0; cat && cat.status !== 'active' && cat.merged_into_id && hops < 5; hops++) {
      cat = await this.prisma.categories.findUnique({ where: { id: cat.merged_into_id }, select: { id: true, slug: true, status: true, merged_into_id: true } });
    }
    if (!cat || cat.status !== 'active') throw new NotFoundException('Category not found');
    return { id: cat.id, slug: cat.slug };
  }

  /**
   * «Проверенные бренды» (2.2): brands switched on for the showcase that have at least one product in stock,
   * in the order set in the admin panel.
   */
  async brandShowcase(): Promise<BrandCardView[]> {
    const brands = await this.prisma.brands.findMany({
      where: { status: 'active', show_in_showcase: true, slug: { not: null } },
      orderBy: [{ sort_order: 'asc' }, { name_ru: 'asc' }],
      include: {
        products: {
          where: { status: 'active' },
          select: {
            status: true,
            inventory: { select: { actual_qty: true, reserved_qty: true } },
            on_zero_supplier: { select: SUPPLIER_TERMS_SELECT },
            iherb_snapshots: { orderBy: { taken_at: 'desc' }, take: 1, select: { in_stock: true } },
          },
        },
      },
    });
    // 6а-Б: a brand whose products can be ordered «Под заказ из США» (stock zero) is shown too
    return brands
      .map((b) => ({ b, inStock: b.products.filter((p) => availableQty(p.inventory) > 0 || underOrderOf(p)).length }))
      .filter(({ inStock }) => inStock > 0)
      .map(({ b }) => toBrandCard(b, b.products.length));
  }

  /** The brand page: by address, or by the exact name (banners made before 2.2 link to a brand by its name). */
  async brandPage(slugOrName: string): Promise<BrandPageView> {
    const b =
      (await this.prisma.brands.findUnique({ where: { slug: slugOrName } })) ??
      (await this.prisma.brands.findFirst({ where: { name_ru: { equals: slugOrName, mode: 'insensitive' } } }));
    if (!b || b.status !== 'active' || !b.slug) throw new NotFoundException('Brand not found');
    const count = await this.prisma.products.count({ where: { status: 'active', brand_id: b.id } });
    return { ...toBrandCard(b, count), country_ru: b.country_ru, country_uz: b.country_uz, why_vitalo_ru: b.why_vitalo_ru, why_vitalo_uz: b.why_vitalo_uz };
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

  private async filterWhere(q: ListProductsQuery): Promise<{ where: Prisma.productsWhereInput; inStock: Prisma.productsWhereInput }> {
    const where: Prisma.productsWhereInput = { status: 'active' };

    if (q.category) {
      const root = await this.resolveCategory(q.category);
      const cats = await this.prisma.categories.findMany({
        where: { status: 'active' },
        select: { id: true, parent_id: true, slug: true },
      });
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
    const inStock: Prisma.productsWhereInput = {
      inventory: { some: { actual_qty: { gt: this.prisma.inventory.fields.reserved_qty } } },
    };
    return { where, inStock };
  }

  async listProducts(q: ListProductsQuery): Promise<Page<ProductListItem>> {
    const { where, inStock } = await this.filterWhere(q);
    // Out-of-stock products always go after in-stock ones (any sort): the list is two segments glued together.
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
    // 3.7: a product in a running sale is shown at its sale price (the sort stays by the regular price)
    return toPage(await this.campaigns.decorate(rows.map(toProductListItem)), totalIn + totalOut, q.page);
  }

  /**
   * 6а-Б (D-62): the two product strips of the home page in one answer.
   * «Популярное» — hits on the Tashkent shelf (stock > 0) by sales; «Новинки» — the newest products that can be bought
   * now: in stock or «под заказ» (from the USA / a supplier), without the ones already in «Популярное».
   */
  async home(): Promise<{ popular: ProductListItem[]; fresh: ProductListItem[] }> {
    const { where, inStock } = await this.filterWhere({} as ListProductsQuery);
    const popularRows = await this.prisma.products.findMany({ where: { AND: [where, inStock] }, orderBy: ORDER_BY[ProductSort.popular], take: HOME_STRIP, include: listInclude });
    const shown = new Set(popularRows.map((p) => p.id));
    const underOrder: Prisma.productsWhereInput = { on_zero_supplier: { status: 'active', kind: { in: ['local', 'foreign'] } } };
    const freshRows = (
      await this.prisma.products.findMany({
        where: { AND: [where, { id: { notIn: [...shown] } }, { OR: [inStock, underOrder] }] },
        orderBy: ORDER_BY[ProductSort.new],
        take: HOME_STRIP * 3, // an iHerb product «нет в наличии» is dropped below, so take a few more
        include: listInclude,
      })
    )
      .filter((p) => availableQty(p.inventory) > 0 || underOrderOf(p))
      .slice(0, HOME_STRIP);
    const [popular, fresh] = await Promise.all([this.campaigns.decorate(popularRows.map(toProductListItem)), this.campaigns.decorate(freshRows.map(toProductListItem))]);
    return { popular, fresh };
  }

  async getProduct(id: string) {
    const product = await this.prisma.products.findFirst({ where: { id, status: 'active' }, include: cardInclude });
    if (!product) throw new NotFoundException('Product not found');
    const card = await this.campaigns.decorateCard(toProductCard(product));
    // D-60/D-61: «Под заказ из США • 7–14 дней» / «Под заказ • 1–2 дня» and the guarantee, from the supplier
    return { ...card, cross_border_terms: card.under_order };
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
    return toPage(await this.campaigns.decorate(items), total, q.page);
  }
}
