import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CUSTOMER_STATUS_TEMPLATES, type CentreCategory, type Lang, type TemplateName, type TemplatePayload } from './notification-templates';
import { tashkentDateTime } from '../common/tashkent';
import { SETTING_DEFAULTS, SETTING_KEYS, supportLink } from '../settings/settings.service';
import { productTitle } from '../waitlist/waitlist';
import { campaignsOf, cbPayloadOf, promoOf } from '../orders/order-view';
import { SUPPLIER_TERMS_SELECT } from '../orders/cross-border';
import { yandexMapsLink } from '../maps/maps-match';

/** 3.2: «Как принимать ваш заказ» lines — one per product with a memo in the language (Russian as a fallback), no repeats. */
export function intakeGuideItems(
  products: { id: string; name_ru: string; name_uz: string | null; short_name_ru: string | null; short_name_uz: string | null; intake_memo_ru: string | null; intake_memo_uz: string | null }[],
  lang: Lang,
): { product_id: string; name: string; text: string }[] {
  const seen = new Set<string>();
  const out: { product_id: string; name: string; text: string }[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const text = ((lang === 'uz' ? p.intake_memo_uz : null) || p.intake_memo_ru || '').trim();
    if (text) out.push({ product_id: p.id, name: productTitle(p, lang), text });
  }
  return out;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * 6а-А: the Mini App screen a «Оплатить» button opens — the same rule as `payPath` in the Mini App: Payme has its own
 * screen; card / bank transfer — the transfer screen; any other method (Click, Uzum later) — the order itself.
 */
export function payOpenPath(orderId: string, method: string | null | undefined): string {
  if (method === 'payme') return `/orders/${orderId}/payme`;
  if (method === 'card_transfer' || method === 'bank_transfer') return `/orders/${orderId}/pay`;
  return `/orders/${orderId}`;
}

/** Roles that get operational messages about orders and payments. */
const ORDER_STAFF_ROLES = ['admin', 'manager'] as const;

/**
 * Puts messages into the `notifications` queue. Called inside the same DB transaction as the change
 * itself (outbox pattern): if the order change rolls back, no message is queued; if it commits, the
 * worker will deliver it even if Telegram is down right now.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 3.2: one customer message per order status — a bot message and an entry in the Mini App centre (the same row),
   * in the customer's language, with «Открыть заказ». A repeated status is skipped (dedup_key). Other statuses are ignored.
   */
  async orderStatusChanged(db: Db, orderId: string, status: OrderStatus, reason?: string | null): Promise<void> {
    let template: TemplateName | undefined = CUSTOMER_STATUS_TEMPLATES[status as keyof typeof CUSTOMER_STATUS_TEMPLATES];
    if (!template) return;
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { user: true, payments: { orderBy: { created_at: 'asc' }, include: { method: { select: { code: true } } } } } });
    const cod = order.payments.some((p) => p.method.code === 'cod');
    // A card order is «new» only for a moment: it gets «Ожидает оплаты» right after.
    if (status === 'new' && !cod) return;
    // Release 1: cash on delivery is not «Оплачен» when the manager confirms it — the customer pays the courier.
    if (status === 'paid' && cod) template = 'order.cod_confirmed';
    const lang = order.user.language;
    const payload: TemplatePayload = { order_number: order.order_number, total_uzs: Number(order.total_uzs), reason: reason ?? null, lang, open_path: `/orders/${order.id}`, promo: promoOf(order), campaigns: campaignsOf(order) };
    // D-60/D-61: «под заказ» lines — «заказываем из США / у поставщика» with the promised window instead of «скоро
    // начнём сборку»; payment on delivery (a local supplier) — the same line under «Заказ подтверждён»
    if (status === 'paid') {
      const items = await db.order_items.findMany({ where: { order_id: orderId }, select: { source: true, supplier: { select: SUPPLIER_TERMS_SELECT } } });
      if (items.some((i) => i.source === 'cross_border')) {
        if (!cod) template = 'order.cb_paid';
        Object.assign(payload, cbPayloadOf({ items }));
        payload.expected_from = order.expected_from?.toISOString().slice(0, 10) ?? null;
        payload.expected_to = order.expected_to?.toISOString().slice(0, 10) ?? null;
      }
    }
    if (status === 'awaiting_payment') {
      payload.open_path = payOpenPath(order.id, order.payments.at(-1)?.method.code);
      payload.open_button = 'pay';
      if (order.reserved_until) payload.until = tashkentDateTime(order.reserved_until);
    }
    await this.toCustomer(db, { userId: order.user_id, chatId: order.user.telegram_user_id, orderId: order.id, template, payload, dedupKey: `order:${order.id}:${status}` });
    if (status === 'paid') await this.intakeGuide(db, order.id);
  }

  /**
   * 3.2: «Как принимать ваш заказ» — once per order, after the payment (or the cash-on-delivery confirmation).
   * Only products with a filled intake memo; nothing is sent when no product has one.
   */
  async intakeGuide(db: Db, orderId: string): Promise<boolean> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { user: true, items: { include: { product: true } } } });
    const lang: Lang = order.user.language === 'uz' ? 'uz' : 'ru';
    const guide = intakeGuideItems(order.items.map((i) => i.product), lang);
    if (!guide.length) return false;
    const support = (await db.settings.findUnique({ where: { key: SETTING_KEYS.supportContact } }))?.value as string | undefined;
    const payload: TemplatePayload = {
      order_number: order.order_number,
      lang,
      guide,
      open_path: `/orders/${order.id}`,
      support_url: supportLink(support ?? SETTING_DEFAULTS.support_contact),
    };
    const queued = await this.toCustomer(db, { userId: order.user_id, chatId: order.user.telegram_user_id, orderId: order.id, template: 'order.intake_guide', payload, dedupKey: `order:${order.id}:intake` });
    if (queued) await db.analytics_events.create({ data: { user_id: order.user_id, event: 'intake_guide_sent', props: { order_id: order.id, products: guide.length } } });
    return queued;
  }

  /** "Заказ №… ждёт оплаты до …" with a button that opens the payment screen (D3). */
  async paymentReminder(db: Db, orderId: string): Promise<void> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { user: true, payments: { orderBy: { created_at: 'asc' }, include: { method: { select: { code: true } } } } } });
    if (!order.reserved_until) return;
    await this.toCustomer(db, {
      userId: order.user_id,
      chatId: order.user.telegram_user_id,
      orderId: order.id,
      template: 'order.payment_reminder',
      payload: { order_number: order.order_number, until: tashkentDateTime(order.reserved_until), open_path: payOpenPath(order.id, order.payments.at(-1)?.method.code), open_button: 'pay', lang: order.user.language },
    });
  }

  /**
   * 3.2: the one way a customer message about an order or a product is queued: the row is the bot message and the
   * centre entry at once. With a dedup key a second identical event is skipped. Returns false when skipped.
   */
  async toCustomer(
    db: Db,
    m: { userId: string; chatId: bigint; template: TemplateName; payload: TemplatePayload; orderId?: string; productId?: string; category?: CentreCategory; kind?: 'service' | 'marketing'; dedupKey?: string; at?: Date },
  ): Promise<boolean> {
    const res = await db.notifications.createMany({
      data: [
        {
          user_id: m.userId,
          chat_id: m.chatId,
          kind: m.kind ?? 'service',
          template: m.template,
          payload: m.payload as unknown as Prisma.InputJsonObject,
          order_id: m.orderId ?? null,
          product_id: m.productId ?? null,
          category: m.category ?? (m.orderId ? 'order' : null),
          dedup_key: m.dedupKey ?? null,
          ...(m.at && { created_at: m.at }),
        },
      ],
      skipDuplicates: true,
    });
    return res.count > 0;
  }

  /**
   * Stage 0.2: «Я оплатил(а)» is waiting for a manager too long. Every active admin and manager gets the order
   * number, the amount, the hours waited and a button to the order in the admin panel; no customer data.
   */
  async paymentCheckOverdue(db: Db, orderId: string, hours: number): Promise<void> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId } });
    const staff = await db.staff_users.findMany({ where: { status: 'active', role: { in: [...ORDER_STAFF_ROLES] } } });
    if (!staff.length) return;
    await db.notifications.createMany({
      data: staff.map((s) => ({
        staff_user_id: s.id,
        chat_id: s.telegram_user_id,
        kind: 'service',
        template: 'staff.payment_check_overdue',
        payload: { order_number: order.order_number, total_uzs: Number(order.total_uzs), hours, admin_path: `/orders/${order.id}`, lang: 'ru' },
      })),
    });
  }

  /** Release 1 (D-18): a «Оплата при получении» order is still not confirmed after N hours -> admins and managers (no customer data). */
  async codConfirmOverdue(db: Db, orderId: string, hours: number): Promise<void> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId } });
    const staff = await db.staff_users.findMany({ where: { status: 'active', role: { in: [...ORDER_STAFF_ROLES] } } });
    if (!staff.length) return;
    await db.notifications.createMany({
      data: staff.map((s) => ({
        staff_user_id: s.id,
        chat_id: s.telegram_user_id,
        kind: 'service',
        template: 'staff.cod_confirm_overdue',
        payload: { order_number: order.order_number, total_uzs: Number(order.total_uzs), hours, admin_path: `/orders/${order.id}`, lang: 'ru' },
      })),
    });
  }

  /**
   * Stage 2D: one message to every active employee with one of the roles (Yandex orders: warehouse and admin for a
   * new order, admin for a problem). Never to customers: only staff_users are read here.
   */
  async toStaffRoles(db: Db, roles: StaffRole[], template: Extract<TemplateName, `staff.${string}`>, payload: TemplatePayload): Promise<number> {
    const staff = await db.staff_users.findMany({ where: { status: 'active', role: { in: roles } } });
    if (!staff.length) return 0;
    await db.notifications.createMany({
      data: staff.map((s) => ({ staff_user_id: s.id, chat_id: s.telegram_user_id, kind: 'service', template, payload: { ...payload, lang: 'ru' } as Prisma.InputJsonObject })),
    });
    return staff.length;
  }

  /** Same message to every active admin and manager. */
  async toOrderStaff(db: Db, template: Extract<TemplateName, `staff.${string}`>, orderId: string): Promise<void> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { orderBy: { created_at: 'desc' }, take: 1, include: { method: { select: { code: true } } } } } });
    const staff = await db.staff_users.findMany({ where: { status: 'active', role: { in: [...ORDER_STAFF_ROLES] } } });
    if (!staff.length) return;
    await db.notifications.createMany({
      data: staff.map((s) => ({
        staff_user_id: s.id,
        chat_id: s.telegram_user_id,
        kind: 'service',
        template,
        payload: {
          order_number: order.order_number,
          total_uzs: Number(order.total_uzs),
          customer: order.recipient_name,
          phone: order.recipient_phone,
          payment: order.payments[0]?.method.code,
          promo: promoOf(order),
          campaigns: campaignsOf(order),
          // 3.5: «Комментарий к заказу» from the checkout — only in the new-order message
          ...(template === 'staff.new_order' && order.customer_comment ? { comment: order.customer_comment } : {}),
          // 3.6: the point chosen on the map — the button «Открыть в Яндекс Картах»
          ...(template === 'staff.new_order' && order.latitude != null && order.longitude != null
            ? { map_url: yandexMapsLink(Number(order.latitude), Number(order.longitude)) }
            : {}),
          lang: 'ru',
        },
      })),
    });
  }
}
