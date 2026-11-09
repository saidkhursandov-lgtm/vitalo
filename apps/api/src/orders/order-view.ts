import { Prisma } from '@prisma/client';
import { listImage, listInclude } from '../catalog/product.mapper';
import type { CampaignLine, PricingSnapshot } from '../promo/promo.service';
import { CUSTOMER_CANCELLABLE } from './order-state';
import { CB_STAGES, isoDay, lineStage, orderStage, type CbStage } from './cross-border';

export const orderViewInclude = {
  items: {
    orderBy: { name_ru_snapshot: 'asc' },
    include: {
      product: { select: { name_uz: true, short_name_ru: true, short_name_uz: true, form: true, media: listInclude.media } },
      cross_border_batch: { select: { stage: true } },
    },
  },
  cross_border_events: { orderBy: { created_at: 'asc' } },
  region: true,
  city: true,
  history: { orderBy: { created_at: 'asc' } },
  payments: { orderBy: { created_at: 'desc' }, include: { method: true, manual: true } },
} satisfies Prisma.ordersInclude;

export type OrderForView = Prisma.ordersGetPayload<{ include: typeof orderViewInclude }>;

const num = (v: bigint) => Number(v);

export function toOrderView(o: OrderForView) {
  const payment = o.payments[0];
  const reported = payment?.manual.find((m) => m.customer_confirmed_at);
  const verified = payment?.manual.find((m) => m.verified_at);
  const snapLines = (o.pricing_json as unknown as PricingSnapshot | null)?.lines ?? [];

  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    payment_status: o.payment_status,
    created_at: o.created_at,
    reserved_until: o.reserved_until,
    paid_at: o.paid_at,
    cancelled_at: o.cancelled_at,
    recipient: { name: o.recipient_name, phone: o.recipient_phone },
    delivery: {
      method: o.delivery_method,
      region: { id: o.region.id, name_ru: o.region.name_ru, name_uz: o.region.name_uz },
      city: { id: o.city.id, name_ru: o.city.name_ru, name_uz: o.city.name_uz },
      address_text: o.address_text,
      latitude: o.latitude == null ? null : Number(o.latitude),
      longitude: o.longitude == null ? null : Number(o.longitude),
      cost_uzs: num(o.delivery_cost_uzs),
    },
    customer_comment: o.customer_comment,
    items: o.items.map((i) => ({
      product_id: i.product_id,
      sku: i.sku_snapshot,
      name_ru: i.name_ru_snapshot,
      name_uz: i.product.name_uz, // current Uzbek name (the order keeps only the Russian snapshot)
      short_name_ru: i.product.short_name_ru,
      short_name_uz: i.product.short_name_uz,
      form: i.product.form,
      image_url: listImage(i.product.media[0])?.webp ?? null,
      qty: i.qty,
      unit_price_uzs: num(i.unit_price_uzs),
      // 3.7: the regular price when the line was bought in a sale (from the frozen calculation)
      list_price_uzs: snapLines.find((s) => s.product_id === i.product_id)?.list_price_uzs ?? num(i.unit_price_uzs),
      line_total_uzs: num(i.line_total_uzs),
      discount_uzs: num(i.discount_uzs),
      paid_line_total_uzs: num(i.paid_line_total_uzs),
      /** D-60: «Под заказ из США» */
      cross_border: i.source === 'cross_border',
    })),
    cross_border: crossBorderOf(o),
    totals: {
      goods_list_total_uzs: num(o.goods_total_uzs) + campaignsOf(o).reduce((s, c) => s + c.amount_uzs, 0),
      campaign_discount_uzs: campaignsOf(o).reduce((s, c) => s + c.amount_uzs, 0),
      goods_total_uzs: num(o.goods_total_uzs),
      discount_total_uzs: num(o.discount_total_uzs),
      bonus_used_uzs: num(o.bonus_used_uzs),
      goods_paid_uzs: num(o.goods_paid_uzs),
      delivery_cost_uzs: num(o.delivery_cost_uzs),
      total_uzs: num(o.total_uzs),
    },
    promo: promoOf(o),
    campaigns: campaignsOf(o),
    payment: payment
      ? {
          method: payment.method.code,
          status: payment.status,
          amount_uzs: num(payment.amount_uzs),
          customer_reported_paid_at: reported?.customer_confirmed_at ?? null,
          verified_at: verified?.verified_at ?? null,
        }
      : null,
    // After "Я оплатил(а)" the payment is being checked: only support can cancel.
    can_cancel: CUSTOMER_CANCELLABLE.includes(o.status) && !reported,
    history: o.history.map((h) => ({
      from_status: h.from_status,
      to_status: h.to_status,
      reason: h.reason,
      changed_by_type: h.changed_by_type,
      created_at: h.created_at,
    })),
  };
}

export type OrderView = ReturnType<typeof toOrderView>;

const cbLines = (o: OrderForView) =>
  o.items.filter((i) => i.source === 'cross_border').map((i) => ({ arrived_at: i.arrived_at, batch_stage: i.cross_border_batch?.stage ?? null }));

/**
 * D-60: the tracking of an order with lines from the USA — the stage it is at (null before the payment), every stage
 * with its date (from the history), the promised window and the moves of the date with reasons. null — no such lines.
 */
export function crossBorderOf(o: OrderForView) {
  const lines = cbLines(o);
  if (!lines.length) return null;
  const paid = !!o.paid_at && o.status !== 'new' && o.status !== 'awaiting_payment';
  // after the jars are in Tashkent the order goes the usual way (picking, courier…): the tracking shows it as done
  const stage: CbStage | null = orderStage(paid, lines) ?? (paid ? 'paid' : null);
  const reached = (s: CbStage) => o.cross_border_events.find((e) => e.type === 'stage' && e.stage === s)?.created_at ?? null;
  return {
    stage,
    lines_waiting: lines.filter((l) => lineStage(l) !== 'in_stock').length,
    expected_from: isoDay(o.expected_from),
    expected_to: isoDay(o.expected_to),
    steps: CB_STAGES.map((s) => ({
      stage: s,
      done: !!stage && CB_STAGES.indexOf(s) <= CB_STAGES.indexOf(stage),
      at: s === 'paid' ? (paid ? o.paid_at : null) : reached(s),
    })),
    delays: o.cross_border_events.filter((e) => e.type === 'delay').map((e) => ({ at: e.created_at, expected_to: isoDay(e.expected_to), reason: e.reason })),
  };
}

/** The same stage from the item rows only (lists, jobs). */
export function crossBorderStageOf(o: { paid_at: Date | null; status: string; items: { source: string; arrived_at: Date | null; cross_border_batch: { stage: string } | null }[] }): CbStage | null {
  const lines = o.items.filter((i) => i.source === 'cross_border').map((i) => ({ arrived_at: i.arrived_at, batch_stage: i.cross_border_batch?.stage ?? null }));
  const paid = !!o.paid_at && o.status !== 'new' && o.status !== 'awaiting_payment';
  return orderStage(paid, lines);
}

/** 3.7: «Акция 11.11: −X сум» lines of the order, from its frozen calculation (older orders: none). */
export function campaignsOf(o: { pricing_json: Prisma.JsonValue | null }): CampaignLine[] {
  return (o.pricing_json as unknown as PricingSnapshot | null)?.campaigns ?? [];
}

/** 3.3: the order's promo code from its frozen calculation: «Промокод VITALO10: −20 000 сум» / free delivery. */
export function promoOf(o: { promo_code: string | null; pricing_json: Prisma.JsonValue | null }): { code: string; discount_uzs: number; free_delivery: boolean } | null {
  if (!o.promo_code) return null;
  const d = (o.pricing_json as unknown as PricingSnapshot | null)?.discounts?.find((x) => x.kind === 'promo');
  return { code: o.promo_code, discount_uzs: d?.amount_uzs ?? 0, free_delivery: d?.type === 'free_delivery' };
}
