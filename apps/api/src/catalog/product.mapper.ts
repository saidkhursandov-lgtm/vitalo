import { Prisma } from '@prisma/client';

export const listInclude = {
  media: { where: { media_type: 'image' }, orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }], take: 1 },
  inventory: { select: { actual_qty: true, reserved_qty: true } },
} satisfies Prisma.productsInclude;

export const cardInclude = {
  media: { orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }] },
  inventory: { select: { actual_qty: true, reserved_qty: true } },
  categories: { include: { category: true } },
  relations: {
    where: { related: { status: 'active' } },
    orderBy: { sort_order: 'asc' },
    include: { related: { include: listInclude } },
  },
} satisfies Prisma.productsInclude;

type ProductForList = Prisma.productsGetPayload<{ include: typeof listInclude }>;
type ProductForCard = Prisma.productsGetPayload<{ include: typeof cardInclude }>;

export interface ProductListItem {
  id: string;
  sku: string;
  name_ru: string;
  name_uz: string | null;
  brand: string;
  price_uzs: number;
  old_price_uzs: number | null;
  image_url: string | null;
  in_stock: boolean;
}

/**
 * available = actual - reserved (never stored, see constraints), taken from the best warehouse:
 * an order line is reserved in a single warehouse (StockService.reserve).
 */
export function availableQty(inventory: { actual_qty: number; reserved_qty: number }[]): number {
  return inventory.reduce((best, i) => Math.max(best, i.actual_qty - i.reserved_qty), 0);
}

// Prices are BigInt in DB; UZS amounts stay far below 2^53, so plain JSON numbers are safe.
export function toProductListItem(p: ProductForList): ProductListItem {
  return {
    id: p.id,
    sku: p.sku,
    name_ru: p.name_ru,
    name_uz: p.name_uz,
    brand: p.brand,
    price_uzs: Number(p.price_uzs),
    old_price_uzs: p.old_price_uzs == null ? null : Number(p.old_price_uzs),
    image_url: p.media.find((m) => m.media_type === 'image')?.url ?? null,
    in_stock: availableQty(p.inventory) > 0,
  };
}

export function toProductCard(p: ProductForCard) {
  const related = (type: 'similar' | 'also_bought') =>
    p.relations.filter((r) => r.relation_type === type).map((r) => toProductListItem(r.related));

  return {
    ...toProductListItem(p),
    available_qty: Math.min(availableQty(p.inventory), 99), // upper bound for the qty stepper
    manufacturer: p.manufacturer,
    country: p.country,
    form: p.form,
    short_description_ru: p.short_description_ru,
    short_description_uz: p.short_description_uz,
    composition_ru: p.composition_ru,
    composition_uz: p.composition_uz,
    nutrition_ru: p.nutrition_ru,
    nutrition_uz: p.nutrition_uz,
    directions_ru: p.directions_ru,
    directions_uz: p.directions_uz,
    warnings_ru: p.warnings_ru,
    warnings_uz: p.warnings_uz,
    media: p.media.map((m) => ({ type: m.media_type, url: m.url, title: m.title, is_main: m.is_main })),
    categories: p.categories
      .map((pc) => pc.category)
      .filter((c) => c.status === 'active')
      .map((c) => ({ id: c.id, slug: c.slug, tree_type: c.tree_type, name_ru: c.name_ru, name_uz: c.name_uz })),
    similar: related('similar'),
    also_bought: related('also_bought'),
  };
}
