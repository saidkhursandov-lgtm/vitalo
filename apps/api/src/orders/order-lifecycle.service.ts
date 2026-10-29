import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActorType, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { StockService } from '../inventory/stock.service';
import { COD_METHOD, CONFIRMABLE_PAYMENT_METHODS } from '../settings/settings.service';
import { EXPIRED_REASON_CODE } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { assertTransition, CUSTOMER_CANCELLABLE } from './order-state';
import { OrderUnitsService } from './order-units.service';

type Tx = Prisma.TransactionClient;

export interface Actor {
  type: ActorType;
  id: string | null;
}

interface LockedOrder {
  id: string;
  user_id: string;
  order_number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  reserved_until: Date | null;
}

/**
 * Status changes that touch stock and payments. Every method locks the order row first
 * (SELECT ... FOR UPDATE), so customer cancel, manager confirmation and the expiry job can run
 * at the same moment and the order is still settled exactly once.
 */
@Injectable()
export class OrderLifecycleService {
  constructor(
    private readonly stock: StockService,
    private readonly notifications: NotificationsService,
    private readonly units: OrderUnitsService,
  ) {}

  async lockOrder(tx: Tx, orderId: string): Promise<LockedOrder> {
    const [order] = await tx.$queryRaw<LockedOrder[]>`
      SELECT id, user_id, order_number, status::text AS status, payment_status::text AS payment_status, reserved_until
      FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Unpaid order -> Cancelled, reservation released. Already cancelled -> no-op (idempotent). */
  async cancelUnpaid(tx: Tx, order: LockedOrder, actor: Actor, reason: string): Promise<'cancelled' | 'already_cancelled'> {
    if (order.status === 'cancelled') return 'already_cancelled';
    if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
      throw new ConflictException({
        code: 'ORDER_NOT_CANCELLABLE',
        message: 'Paid orders cannot be cancelled by the customer; please contact support',
      });
    }
    assertTransition(order.status, 'cancelled');

    await this.stock.release(tx, order.id, actor.type === 'staff' ? actor.id ?? undefined : undefined);
    const now = new Date();
    await tx.orders.update({
      where: { id: order.id },
      data: { status: 'cancelled', payment_status: 'payment_cancelled', cancelled_at: now, reserved_until: null },
    });
    await tx.payment_attempts.updateMany({
      where: { payment: { order_id: order.id }, status: 'pending' },
      data: { status: 'cancelled' },
    });
    await tx.payments.updateMany({
      where: { order_id: order.id, status: 'payment_pending' },
      data: { status: 'payment_cancelled' },
    });
    await this.addHistory(tx, order.id, order.status, 'cancelled', actor, reason);
    return 'cancelled';
  }

  /**
   * Manager confirms a bank transfer: order -> Paid. Lines by quantity: reservation -> real write-off (as before).
   * Stage 2E, unit-tracked lines: the reservation stays and concrete units are reserved by FEFO; the write-off
   * happens at the handover. Not enough units never fails the payment (orders.units_attention + a staff message).
   * Already paid -> no-op (idempotent), so a double click never deducts stock or reserves units twice.
   * Release 1, «Оплата при получении»: the same step is the manager's confirmation of the order (the customer pays the
   * courier); the order becomes «Оплачен» («Подтверждён» for the customer) and goes to the warehouse like a transfer.
   */
  async confirmBankTransfer(tx: Tx, order: LockedOrder, staffId: string, comment?: string): Promise<'paid' | 'already_paid'> {
    if (order.payment_status === 'payment_success') return 'already_paid';
    if (order.status === 'cancelled') {
      throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Order is cancelled; its reservation was released' });
    }
    assertTransition(order.status, 'paid');

    const payment = await tx.payments.findFirst({
      where: { order_id: order.id, status: 'payment_pending', method: { code: { in: [...CONFIRMABLE_PAYMENT_METHODS] } } },
      include: { manual: true, method: { select: { code: true } } },
    });
    if (!payment) throw new ConflictException({ code: 'NO_BANK_TRANSFER_PAYMENT', message: 'Order has no pending bank transfer' });
    const cod = payment.method.code === COD_METHOD;

    const now = new Date();
    await this.stock.deduct(tx, order.id, staffId, await this.units.trackedProductIds(tx, order.id));
    await tx.payments.update({ where: { id: payment.id }, data: { status: 'payment_success', paid_at: now } });
    await tx.payment_attempts.updateMany({ where: { payment_id: payment.id, status: 'pending' }, data: { status: 'success' } });

    const confirmation = payment.manual[0];
    if (confirmation) {
      await tx.manual_payment_confirmations.update({
        where: { id: confirmation.id },
        data: { verified_by: staffId, verified_at: now, comment: comment ?? null },
      });
    } else {
      // The manager saw the money before the customer pressed "Я оплатил".
      await tx.manual_payment_confirmations.create({
        data: { payment_id: payment.id, verified_by: staffId, verified_at: now, comment: comment ?? null },
      });
    }

    await tx.orders.update({
      where: { id: order.id },
      data: { status: 'paid', payment_status: 'payment_success', paid_at: now, reserved_until: null },
    });
    await tx.manager_tasks.updateMany({
      where: { order_id: order.id, type: 'bank_transfer_check', status: { not: 'done' } },
      data: { status: 'done', done_at: now, assigned_to: staffId },
    });
    await this.addHistory(tx, order.id, order.status, 'paid', { type: 'staff', id: staffId }, cod ? 'Order confirmed by the manager (cash on delivery)' : 'Bank transfer confirmed');
    const units = await this.units.reserveOnPayment(tx, { id: order.id, order_number: order.order_number, status: 'paid' }, staffId);
    await tx.audit_logs.create({
      data: {
        staff_user_id: staffId,
        action: cod ? 'order.cod_confirmed' : 'order.bank_transfer_confirmed',
        entity_type: 'order',
        entity_id: order.id,
        before_json: { status: order.status, payment_status: order.payment_status },
        after_json: { status: 'paid', payment_status: 'payment_success', comment: comment ?? null, units_reserved: units.reserved, units_shortage: units.shortage },
      },
    });
    return 'paid';
  }

  /**
   * Staff cancels a paid order before handover. Lines by quantity (and legacy orders): what was written off returns
   * to stock. Stage 2E, unit-tracked lines: reserved units go back «На складе» and the held quantity is released
   * (nothing was written off for them yet). The order becomes
   * Cancelled and a refund task is created (refunds are manual, Master TZ §10). Payment status stays
   * payment_success: the money was received and is returned outside the system.
   */
  async cancelPaid(tx: Tx, order: LockedOrder, staffId: string, reason: string): Promise<void> {
    assertTransition(order.status, 'cancelled');
    await this.units.releaseOnCancel(tx, order, staffId, reason);
    await this.stock.release(tx, order.id, staffId);
    await this.stock.returnDeducted(tx, order.id, staffId);
    const full = await tx.orders.update({
      where: { id: order.id },
      data: { status: 'cancelled', cancelled_at: new Date(), reserved_until: null },
      include: { payments: { include: { method: { select: { code: true } } } } },
    });
    // Cash on delivery: the courier takes the money, so usually there is nothing to return.
    const cod = full.payments.some((p) => p.method.code === COD_METHOD);
    await tx.manager_tasks.create({
      data: {
        type: 'refund',
        order_id: order.id,
        note: cod
          ? `Заказ ${order.order_number} с оплатой при получении отменён после подтверждения. Если клиент уже отдал курьеру ${Number(full.total_uzs)} сум — вернуть, если нет — просто закройте задачу. Причина: ${reason}`
          : `Вернуть клиенту ${Number(full.total_uzs)} сум: оплаченный заказ ${order.order_number} отменён. Причина: ${reason}`,
      },
    });
    await this.addHistory(tx, order.id, order.status, 'cancelled', { type: 'staff', id: staffId }, reason);
  }

  /**
   * Every status change goes through here, so this is also where the customer's Telegram message is
   * queued (same transaction). Shown reason: staff text as written; automatic expiry as a localized
   * phrase; none when the customer cancelled themselves.
   */
  async addHistory(tx: Tx, orderId: string, from: OrderStatus | null, to: OrderStatus, actor: Actor, reason?: string, at = new Date()) {
    await tx.order_status_history.create({
      data: {
        order_id: orderId,
        from_status: from,
        to_status: to,
        reason: reason ?? null,
        changed_by_type: actor.type,
        changed_by_id: actor.id,
        created_at: at,
      },
    });
    const shownReason = actor.type === 'staff' ? reason : actor.type === 'system' ? EXPIRED_REASON_CODE : null;
    await this.notifications.orderStatusChanged(tx, orderId, to, shownReason);
  }
}
