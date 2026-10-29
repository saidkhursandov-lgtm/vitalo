import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CUSTOMER_STATUS_TEMPLATES, type TemplateName, type TemplatePayload } from './notification-templates';
import { tashkentDateTime } from '../common/tashkent';

type Db = Prisma.TransactionClient | PrismaService;

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

  /** Customer message for an order status change, in the customer's language. Other statuses are ignored. */
  async orderStatusChanged(db: Db, orderId: string, status: OrderStatus, reason?: string | null): Promise<void> {
    let template: TemplateName | undefined = CUSTOMER_STATUS_TEMPLATES[status as keyof typeof CUSTOMER_STATUS_TEMPLATES];
    if (!template) return;
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { user: true, payments: { include: { method: { select: { code: true } } } } } });
    // Release 1: cash on delivery is not «Оплачен» when the manager confirms it — the customer pays the courier.
    if (status === 'paid' && order.payments.some((p) => p.method.code === 'cod')) template = 'order.cod_confirmed';
    await db.notifications.create({
      data: {
        user_id: order.user_id,
        chat_id: order.user.telegram_user_id,
        kind: 'service',
        template,
        payload: { order_number: order.order_number, total_uzs: Number(order.total_uzs), reason: reason ?? null, lang: order.user.language },
      },
    });
  }

  /** "Заказ №… ждёт оплаты до …" with a button that opens the payment screen (D3). */
  async paymentReminder(db: Db, orderId: string): Promise<void> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { user: true } });
    if (!order.reserved_until) return;
    await db.notifications.create({
      data: {
        user_id: order.user_id,
        chat_id: order.user.telegram_user_id,
        kind: 'service',
        template: 'order.payment_reminder',
        payload: { order_number: order.order_number, until: tashkentDateTime(order.reserved_until), open_path: `/orders/${order.id}/pay`, lang: order.user.language },
      },
    });
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
          lang: 'ru',
        },
      })),
    });
  }
}
