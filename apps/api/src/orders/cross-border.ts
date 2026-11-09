import type { OrderStatus } from '@prisma/client';
import { tashkentDateString } from '../common/tashkent';

/**
 * D-60, «Под заказ из США»: pure rules (no database) — stages, the promised dates, when the customer may cancel.
 *
 * A line is «from the USA» when its product comes from iHerb (SKU VTL-H001… or VTL-GH001…, see IHERB_SKU) or is
 * switched on in the card (cross_border_eligible), iHerb has it and the
 * Tashkent stock cannot cover the whole line. Such a line reserves nothing: its jars come with a parcel
 * («Посылка из США») and are attached to the order when the parcel is received (or earlier from the Tashkent stock).
 */

/** The customer's stages after the payment, in order. */
/**
 * The owner's SKUs (09.11.2026): a product bought on iHerb is «VTL-H001…»; one that is also in the Glorious Health
 * Nutrition list is «VTL-GH001…». Such products go «Под заказ из США» by themselves, without the card checkbox.
 * The same pattern is in StockService.crossBorderOk (SQL).
 */
export const IHERB_SKU = /^VTL-G?H\d/i;
export const isIherbSku = (sku: string | null | undefined): boolean => !!sku && IHERB_SKU.test(sku);

/** «Под заказ из США • 7–14 дней»: a product row with its newest iHerb snapshot (taken 1, newest first). */
export function crossBorderOkRow(p: { sku: string; cross_border_eligible: boolean; status: string; iherb_snapshots?: { in_stock: boolean }[] }): boolean {
  return (p.cross_border_eligible || isIherbSku(p.sku)) && p.status === 'active' && (p.iherb_snapshots?.[0]?.in_stock ?? true);
}

export const CB_STAGES =['paid', 'ordered', 'shipped', 'arrived_uz', 'in_stock'] as const;
export type CbStage = (typeof CB_STAGES)[number];
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

/** Saved settings over the defaults; a wrong value falls back to the default; max ≥ min, guarantee ≥ max. */
export function mergeCrossBorderSettings(saved: unknown): CrossBorderSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const n = (k: keyof CrossBorderSettings, min: number, max: number) => {
    const v = s[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : CROSS_BORDER_DEFAULTS[k];
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
