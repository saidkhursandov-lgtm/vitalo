import type { OrderStatus } from '@prisma/client';
import { tashkentDateString } from '../common/tashkent';

/**
 * «Под заказ» (D-60, generalised by D-61): pure rules (no database) — supplier terms, stages, the promised dates,
 * when the customer may cancel.
 *
 * A line goes «под заказ» when the Tashkent stock is zero and the product card says «если ноль — под заказ у …»
 * (products.on_zero_supplier_id, chosen by the owner). Such a line reserves nothing: its jars come with a delivery
 * from that supplier and are attached to the order when it is received (or earlier from the Tashkent stock).
 * A foreign supplier (iHerb, later Amazon…): «Под заказ из США», prepayment only, full tracking. A local one
 * (Glorious Healthy Nutrition): «Под заказ • 1–2 дня», payment on delivery allowed, short tracking.
 */

/**
 * The owner's SKUs (09.11.2026): bought on iHerb — «VTL-H001…»; also in the Glorious Healthy Nutrition list —
 * «VTL-GH001…». Since D-61 only a suggestion for a NEW product (the card decides), see AdminProductsController.
 */
export const IHERB_SKU = /^VTL-G?H\d/i;
export const isIherbSku = (sku: string | null | undefined): boolean => !!sku && IHERB_SKU.test(sku);
export const isGloriousSku = (sku: string | null | undefined): boolean => !!sku && /^VTL-GH\d/i.test(sku);

export type SupplierKind = 'ozon' | 'local' | 'foreign';
export const SUPPLIER_KINDS: SupplierKind[] = ['ozon', 'local', 'foreign'];

/** The supplier columns the «под заказ» rules read (a Prisma select). */
export const SUPPLIER_TERMS_SELECT = {
  id: true, name: true, code: true, kind: true, status: true, from_ru: true, from_uz: true, days_min: true, days_max: true, guarantee_days: true,
} as const;
export interface SupplierRow {
  id: string;
  name: string;
  code: string | null;
  kind: string;
  status: string;
  from_ru: string | null;
  from_uz: string | null;
  days_min: number | null;
  days_max: number | null;
  guarantee_days: number | null;
}

/** «Под заказ у этого поставщика»: its kind, «из США» and the terms (empty fields → the defaults of its kind). */
export interface SupplyTerms extends CrossBorderSettings {
  supplier_id: string;
  name: string;
  code: string | null;
  kind: 'local' | 'foreign';
  from_ru: string | null;
  from_uz: string | null;
}

export function supplierTerms(s: SupplierRow | null | undefined): SupplyTerms | null {
  if (!s || s.status !== 'active' || (s.kind !== 'local' && s.kind !== 'foreign')) return null;
  const t = mergeCrossBorderSettings({ days_min: s.days_min, days_max: s.days_max, guarantee_days: s.guarantee_days }, s.kind === 'local' ? LOCAL_DEFAULTS : CROSS_BORDER_DEFAULTS);
  return { ...t, supplier_id: s.id, name: s.name, code: s.code, kind: s.kind, from_ru: s.kind === 'foreign' ? s.from_ru : null, from_uz: s.kind === 'foreign' ? s.from_uz : null };
}

/**
 * May this product be ordered «под заказ» now: on sale, «если ноль — под заказ у …» set to an active local or foreign
 * supplier, and for iHerb the newest iHerb snapshot is not «нет в наличии» (no snapshot yet counts as available).
 */
export function underOrderOf(p: { status: string; on_zero_supplier?: SupplierRow | null; iherb_snapshots?: { in_stock: boolean }[] }): SupplyTerms | null {
  if (p.status !== 'active') return null;
  const t = supplierTerms(p.on_zero_supplier);
  if (!t) return null;
  if (t.code === 'iherb' && p.iherb_snapshots?.[0]?.in_stock === false) return null;
  return t;
}

/** D-61: what the shop writes next to a «под заказ» line: «Из США» (foreign, its «из …») or «Под заказ» (local). */
export interface UnderOrderMark {
  kind: 'local' | 'foreign';
  from_ru: string | null;
  from_uz: string | null;
}
export const underOrderMark = (t: SupplyTerms | null | undefined): UnderOrderMark | null => (t ? { kind: t.kind, from_ru: t.from_ru, from_uz: t.from_uz } : null);

/** The terms of an order with several «под заказ» suppliers: the longest of each; foreign if any line is foreign. */
export function combineTerms(list: SupplyTerms[]): (CrossBorderSettings & { foreign: boolean }) | null {
  if (!list.length) return null;
  return {
    days_min: Math.max(...list.map((t) => t.days_min)),
    days_max: Math.max(...list.map((t) => t.days_max)),
    guarantee_days: Math.max(...list.map((t) => t.guarantee_days)),
    foreign: list.some((t) => t.kind === 'foreign'),
  };
}

export const CB_STAGES = ['paid', 'ordered', 'shipped', 'arrived_uz', 'in_stock'] as const;
export type CbStage = (typeof CB_STAGES)[number];
/** D-61: a local supplier — nothing is shipped from abroad */
export const LOCAL_CB_STAGES: CbStage[] = ['paid', 'ordered', 'in_stock'];
/** Stages of a parcel; «received» = every line of it got its jars. */
export const BATCH_STAGES = ['ordered', 'shipped', 'arrived_uz', 'received'] as const;
export type BatchStage = (typeof BATCH_STAGES)[number];
/** What staff may set on a parcel by hand («received» comes from the receiving). */
export const BATCH_MANUAL_STAGES = ['shipped', 'arrived_uz'] as const;

export const CB_STAGE_LABELS: Record<'ru' | 'uz', Record<CbStage, string>> = {
  ru: { paid: 'Оплачен', ordered: 'Заказан в США', shipped: 'Отправлен из США', arrived_uz: 'Прибыл в Узбекистан', in_stock: 'На складе VITALO' },
  uz: { paid: 'To‘langan', ordered: 'AQSHda buyurtma qilindi', shipped: 'AQSHdan jo‘natildi', arrived_uz: 'O‘zbekistonga yetib keldi', in_stock: 'VITALO omborida' },
};
export const BATCH_STAGE_LABELS: Record<BatchStage, string> = { ordered: 'Заказана в США', shipped: 'Отправлена из США', arrived_uz: 'Прибыла в Узбекистан', received: 'Принята на складе' };

export const stageIndex = (s: CbStage) => CB_STAGES.indexOf(s);

export interface CrossBorderSettings {
  /** «Под заказ из США • 7–14 дней»: the promised window from the payment */
  days_min: number;
  days_max: number;
  /** no jars in Tashkent this many days after the payment → the customer may cancel and get the money back */
  guarantee_days: number;
}
export const CROSS_BORDER_SETTINGS_KEY = 'cross_border';
export const CROSS_BORDER_DEFAULTS: CrossBorderSettings = { days_min: 7, days_max: 14, guarantee_days: 21 };
/** D-61: a local supplier without its own terms: «Под заказ • 1–2 дня», money back after 7 days */
export const LOCAL_DEFAULTS: CrossBorderSettings = { days_min: 1, days_max: 2, guarantee_days: 7 };

/** Saved settings over the defaults; a wrong value falls back to the default; max ≥ min, guarantee ≥ max. */
export function mergeCrossBorderSettings(saved: unknown, defaults: CrossBorderSettings = CROSS_BORDER_DEFAULTS): CrossBorderSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const n = (k: keyof CrossBorderSettings, min: number, max: number) => {
    const v = s[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : defaults[k];
  };
  const days_min = n('days_min', 1, 90);
  const days_max = Math.max(days_min, n('days_max', 1, 120));
  const guarantee_days = Math.max(days_max, n('guarantee_days', 1, 180));
  return { days_min, days_max, guarantee_days };
}

/** Tashkent calendar day + n days, as a Date at 00:00 UTC (a Prisma @db.Date value). */
export function addDays(from: Date, days: number): Date {
  const d = new Date(`${tashkentDateString(from)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function expectedWindow(from: Date, s: CrossBorderSettings): { expected_from: Date; expected_to: Date } {
  return { expected_from: addDays(from, s.days_min), expected_to: addDays(from, s.days_max) };
}

export const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** The cart / checkout notice: «Ожидаемая доставка: 18–25 ноября»; foreign → «Товары из США», prepayment only. */
export interface WindowView {
  expected_from: string;
  expected_to: string;
  guarantee_days: number;
  foreign: boolean;
  from_ru: string | null;
  from_uz: string | null;
}
export function windowView(terms: SupplyTerms[], from = new Date()): WindowView | null {
  const c = combineTerms(terms);
  if (!c) return null;
  const w = expectedWindow(from, c);
  const f = terms.find((t) => t.kind === 'foreign');
  return { expected_from: isoDay(w.expected_from)!, expected_to: isoDay(w.expected_to)!, guarantee_days: c.guarantee_days, foreign: c.foreign, from_ru: f?.from_ru ?? null, from_uz: f?.from_uz ?? null };
}

/** The stage of one cross-border line: jars attached → in stock; in a parcel → the parcel's stage; else paid. */
export function lineStage(l: { arrived_at: Date | null; batch_stage: string | null }): CbStage {
  if (l.arrived_at) return 'in_stock';
  const b = l.batch_stage as BatchStage | null;
  if (!b) return 'paid';
  return b === 'received' ? 'arrived_uz' : b; // «received» but this line got no jar yet: still waiting at the warehouse
}

/** The order is as far as its slowest line from the USA; null — no such lines or not paid yet. */
export function orderStage(paid: boolean, lines: { arrived_at: Date | null; batch_stage: string | null }[]): CbStage | null {
  if (!paid || !lines.length) return null;
  return lines.map(lineStage).reduce((a, b) => (stageIndex(b) < stageIndex(a) ? b : a));
}

/** Statuses where the cross-border part still matters (after it the order goes the usual way). */
const WAITING: OrderStatus[] = ['paid'];

export type CustomerCancel = { allowed: false } | { allowed: true; reason: 'not_ordered' | 'guarantee' };

/**
 * D-60: the customer cancels a PAID order with lines from the USA by themselves while nothing was ordered in the USA
 * yet, or when the guarantee term passed and the jars are still not in Tashkent. Otherwise only via the manager.
 */
export function customerCancel(o: { status: OrderStatus; paid_at: Date | null; stage: CbStage | null }, s: CrossBorderSettings, now = new Date()): CustomerCancel {
  if (!WAITING.includes(o.status) || !o.stage || !o.paid_at) return { allowed: false };
  if (o.stage === 'paid') return { allowed: true, reason: 'not_ordered' };
  if (o.stage !== 'in_stock' && now.getTime() >= addDays(o.paid_at, s.guarantee_days).getTime()) return { allowed: true, reason: 'guarantee' };
  return { allowed: false };
}

/** The date when the guarantee lets the customer cancel (shown in the order). */
export const guaranteeDate = (paidAt: Date, s: CrossBorderSettings) => addDays(paidAt, s.guarantee_days);

/** Staff reminder: the promised last day passed, the jars are not in Tashkent, and nobody was told for this date. */
export function isOverdue(o: { status: OrderStatus; stage: CbStage | null; expected_to: Date | null; overdue_for: Date | null }, now = new Date()): boolean {
  if (!WAITING.includes(o.status) || !o.stage || o.stage === 'in_stock' || !o.expected_to) return false;
  if (o.overdue_for && o.overdue_for.getTime() === o.expected_to.getTime()) return false;
  return addDays(now, 0).getTime() > o.expected_to.getTime();
}

/** The saved «Под заказ из США» settings (defaults when nothing is saved). */
export async function loadCrossBorderSettings(db: { settings: { findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null> } }): Promise<CrossBorderSettings> {
  return mergeCrossBorderSettings((await db.settings.findUnique({ where: { key: CROSS_BORDER_SETTINGS_KEY } }))?.value);
}
