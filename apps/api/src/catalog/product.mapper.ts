import { ratingAvg } from '../reviews/review-rules';
import { Prisma } from '@prisma/client';
import { SUPPLIER_TERMS_SELECT, underOrderOf, type SupplyTerms } from '../orders/cross-border';
import { thumbSize } from '../storage/image-processing';

/** D-60: the newest iHerb snapshot says whether «Под заказ из США» is possible now */
const lastIherb = { orderBy: { taken_at: 'desc' }, take: 1, select: { in_stock: true } } satisfies Prisma.products$iherb_snapshotsArgs;
/** D-61: «если на складе ноль — под заказ у …» with the supplier's terms */
const onZero = { select: SUPPLIER_TERMS_SELECT } as const;

/** D-61: what the shop shows about «под заказ»: «Под заказ из США • 7–14 дней» or «Под заказ • 1–2 дня». */
export interface UnderOrderView {
  kind: 'local' | 'foreign';
  from_ru: string | null;
  from_uz: string | null;
  days_min: number;
  days_max: number;
  guarantee_days: number;
}
export const underOrderView = (t: SupplyTerms): UnderOrderView => ({
  kind: t.kind, from_ru: t.from_ru, from_uz: t.from_uz, days_min: t.days_min, days_max: t.days_max, guarantee_days: t.guarantee_days,
});

export const listInclude = {
  media: { where: { media_type: 'image' }, orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }], take: 1 },
  inventory: { select: { actual_qty: true, reserved_qty: true } },
  iherb_snapshots: lastIherb,
  on_zero_supplier: onZero,
} satisfies Prisma.productsInclude;

export const cardInclude = {
  media: { orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }] },
  inventory: { select: { actual_qty: true, reserved_qty: true } },
  iherb_snapshots: lastIherb,
  on_zero_supplier: onZero,
  categories: { include: { category: true } },
  brand_entry: { select: { slug: true, name_ru: true, name_uz: true, why_vitalo_ru: true, why_vitalo_uz: true } },
  relations: {
    where: { related: { status: 'active' } },
    orderBy: { sort_order: 'asc' },
    include: { related: { include: listInclude } },
  },
} satisfies Prisma.productsInclude;

/** 2.3: Halal / VEGE (D-32): Halal only with a certificate, VEGE only from the label. */
export const HALAL_VEGE = ['halal', 'vege', 'halal_vege', 'none', 'unknown'] as const;
/** 6а-В (D-62): the manual label of an event or a status, chosen in the admin product card. */
export const PROMO_LABELS = ['eleven_eleven', 'black_friday', 'hit', 'new'] as const;
export type PromoLabel = (typeof PROMO_LABELS)[number];
const promoLabelOf = (v: string | null): PromoLabel | null => ((PROMO_LABELS as readonly string[]).includes(v ?? '') ? (v as PromoLabel) : null);
export type HalalVege = (typeof HALAL_VEGE)[number];

/** «Хватит на N дней» — only from 7 days on (shorter courses are not shown). */
export function courseDays(packCount: number | null, perDay: number | null): number | null {
  if (!packCount || !perDay) return null;
  const days = Math.floor(packCount / perDay);
  return days >= 7 ? days : null;
}

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
  /** 2.3: «Цитрат + B6» under the short name */
  substance_form_ru: string | null;
  substance_form_uz: string | null;
  /** 2.3: days the pack lasts (null = not filled or under 7) */
  course_days: number | null;
  brand: string;
  price_uzs: number;
  old_price_uzs: number | null;
  /** Thumbnail (400 px) for lists; the main photo for old, not yet optimized uploads. */
  image_url: string | null;
  image: ListImage | null;
  in_stock: boolean;
  /** D-60/D-61: nothing in Tashkent, but it can be ordered «под заказ» (from abroad — prepayment only) */
  cross_border: boolean;
  /** D-61: the supplier's kind and terms when cross_border, else null */
  under_order: UnderOrderView | null;
  /** 3.7: a running sale — price_uzs is then the sale price and old_price_uzs the regular one (CampaignsService.decorate) */
  campaign: ShopCampaign | null;
  /** 6а-В: «11.11», «Black Friday», «Хит», «Новинка» set by hand (a running sale's badge wins in the shop) */
  promo_label: PromoLabel | null;
  /** 3.10-Б: published reviews — the average (4.8) and the count; null while there are none */
  rating: { avg: number; count: number } | null;
}

/** 3.7: what the shop shows about a product's sale: the badge (skin, title, %) and the countdown. */
export interface ShopCampaign {
  id: string;
  slug: string;
  skin: 'none' | 'black_friday' | 'eleven_eleven' | 'sale';
  title_ru: string;
  title_uz: string | null;
  discount_pct: number;
  list_price_uzs: number;
  /** null = «без даты окончания» (no countdown) */
  ends_at: Date | null;
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
    substance_form_ru: p.substance_form_ru,
    substance_form_uz: p.substance_form_uz,
    course_days: courseDays(p.pack_count, p.servings_per_day),
    brand: p.brand,
    price_uzs: Number(p.price_uzs),
    old_price_uzs: p.old_price_uzs == null ? null : Number(p.old_price_uzs),
    image_url: listImage(p.media.find((m) => m.media_type === 'image'))?.webp ?? null,
    image: listImage(p.media.find((m) => m.media_type === 'image')),
    in_stock: availableQty(p.inventory) > 0,
    ...underOrderFields(p),
    campaign: null,
    promo_label: promoLabelOf(p.promo_label),
    rating: p.reviews_count > 0 ? { avg: ratingAvg(p.rating_sum, p.reviews_count) ?? 0, count: p.reviews_count } : null,
  };
}

function underOrderFields(p: ProductForList): { cross_border: boolean; under_order: UnderOrderView | null } {
  const t = availableQty(p.inventory) <= 0 ? underOrderOf(p) : null;
  return { cross_border: !!t, under_order: t && underOrderView(t) };
}

export function toProductCard(p: ProductForCard) {
  const related = (type: 'similar' | 'also_bought') =>
    p.relations.filter((r) => r.relation_type === type).map((r) => toProductListItem(r.related));

  return {
    ...toProductListItem(p),
    // upper bound for the qty stepper; D-60: from the USA — up to the line maximum
    available_qty: availableQty(p.inventory) <= 0 && underOrderOf(p) ? 99 : Math.min(availableQty(p.inventory), 99),
    /** 2.2: the brand page address (null = the brand is not in the dictionary) */
    brand_slug: p.brand_entry?.slug ?? null,
    // 2.3: «Почему [бренд] отобран в VITALO»
    brand_name_ru: p.brand_entry?.name_ru ?? null,
    brand_name_uz: p.brand_entry?.name_uz ?? null,
    brand_why_ru: p.brand_entry?.why_vitalo_ru ?? null,
    brand_why_uz: p.brand_entry?.why_vitalo_uz ?? null,
    // 2.3: expertise blocks; the Halal source, intake memo and staff note stay in the admin
    pack_count: p.pack_count,
    std_bioavailability: p.std_bioavailability,
    std_tested: p.std_tested,
    std_original: p.std_original,
    halal_vege: p.halal_vege as HalalVege | null,
    shell_ru: p.shell_ru,
    shell_uz: p.shell_uz,
    // D-67: плашка «На X% выгоднее Маркета» выключена везде — Яндекс Маркет закрыт (число в базе остаётся)
    market_advantage_percent: null,
    doctor_verdict_ru: p.doctor_verdict_ru,
    doctor_verdict_uz: p.doctor_verdict_uz,
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
