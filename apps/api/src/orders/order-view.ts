import { Prisma } from '@prisma/client';
import { listImage, listInclude } from '../catalog/product.mapper';
import { CUSTOMER_CANCELLABLE } from './order-state';

export const orderViewInclude = {
  items: {
    orderBy: { name_ru_snapshot: 'asc' },
    include: { product: { select: { name_uz: true, short_name_ru: true, short_name_uz: true, form: true, media: listInclude.media } } },
  },
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
      line_total_uzs: num(i.line_total_uzs),
      discount_uzs: num(i.discount_uzs),
      paid_line_total_uzs: num(i.paid_line_total_uzs),
    })),
    totals: {
      goods_total_uzs: num(o.goods_total_uzs),
      discount_total_uzs: num(o.discount_total_uzs),
      bonus_used_uzs: num(o.bonus_used_uzs),
      goods_paid_uzs: num(o.goods_paid_uzs),
      delivery_cost_uzs: num(o.delivery_cost_uzs),
      total_uzs: num(o.total_uzs),
    },
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
