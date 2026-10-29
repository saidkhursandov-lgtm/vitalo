import { Prisma } from '@prisma/client';
import { thumbSize } from '../storage/image-processing';

export const listInclude = {
  media: { where: { media_type: 'image' }, orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }], take: 1 },
  inventory: { select: { actual_qty: true, reserved_qty: true } },
} satisfies Prisma.productsInclude;

export const cardInclude = {
  media: { orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }] },
  inventory: { select: { actual_qty: true, reserved_qty: true } },
  categories: { include: { category: true } },
  brand_entry: { select: { slug: true } },
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
  /** 2.1: short name for the cart, checkout and orders (null = use the full name) */
  short_name_ru: string | null;
  short_name_uz: string | null;
  form: string | null;
  brand: string;
  price_uzs: number;
  old_price_uzs: number | null;
  /** Thumbnail (400 px) for lists; the main photo for old, not yet optimized uploads. */
  image_url: string | null;
  image: ListImage | null;
  in_stock: boolean;
}

/** WebP + JPEG fallback and the size, so the page does not jump while the picture loads. */
export interface ListImage {
  webp: string;
  jpeg: string | null;
  width: number | null;
  height: number | null;
}

type MediaRow = { media_type: string; url: string; url_jpeg?: string | null; thumb_url?: string | null; thumb_url_jpeg?: string | null; width?: number | null; height?: number | null };

export function listImage(m: MediaRow | undefined): ListImage | null {
  if (!m) return null;
  const size = thumbSize(m.width, m.height);
  return { webp: m.thumb_url ?? m.url, jpeg: m.thumb_url_jpeg ?? m.url_jpeg ?? null, width: size?.width ?? null, height: size?.height ?? null };
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
    short_name_ru: p.short_name_ru,
    short_name_uz: p.short_name_uz,
    form: p.form,
    brand: p.brand,
    price_uzs: Number(p.price_uzs),
    old_price_uzs: p.old_price_uzs == null ? null : Number(p.old_price_uzs),
    image_url: listImage(p.media.find((m) => m.media_type === 'image'))?.webp ?? null,
    image: listImage(p.media.find((m) => m.media_type === 'image')),
    in_stock: availableQty(p.inventory) > 0,
  };
}

export function toProductCard(p: ProductForCard) {
  const related = (type: 'similar' | 'also_bought') =>
    p.relations.filter((r) => r.relation_type === type).map((r) => toProductListItem(r.related));

  return {
    ...toProductListItem(p),
    available_qty: Math.min(availableQty(p.inventory), 99), // upper bound for the qty stepper
    /** 2.2: the brand page address (null = the brand is not in the dictionary) */
    brand_slug: p.brand_entry?.slug ?? null,
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
    media: p.media.map((m) => ({ type: m.media_type, url: m.url, url_jpeg: m.url_jpeg, thumb_url: m.thumb_url, width: m.width, height: m.height, title: m.title, is_main: m.is_main })),
    categories: p.categories
      .map((pc) => pc.category)
      .filter((c) => c.status === 'active')
      .map((c) => ({ id: c.id, slug: c.slug, tree_type: c.tree_type, name_ru: c.name_ru, name_uz: c.name_uz })),
    similar: related('similar'),
    also_bought: related('also_bought'),
  };
}
