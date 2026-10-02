import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CUSTOMER_STATUS_TEMPLATES, type TemplateName } from './notification-templates';

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
    const template = CUSTOMER_STATUS_TEMPLATES[status as keyof typeof CUSTOMER_STATUS_TEMPLATES];
    if (!template) return;
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, include: { user: true } });
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

  /** Same message to every active admin and manager. */
  async toOrderStaff(db: Db, template: Extract<TemplateName, `staff.${string}`>, orderId: string): Promise<void> {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId } });
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
          lang: 'ru',
        },
      })),
    });
  }
}
