import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActorType, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { StockService } from '../inventory/stock.service';
import { assertTransition, CUSTOMER_CANCELLABLE } from './order-state';

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
  constructor(private readonly stock: StockService) {}

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
   * Manager confirms a bank transfer: reservation -> real write-off, order -> Paid.
   * Already paid -> no-op (idempotent), so a double click never deducts stock twice.
   */
  async confirmBankTransfer(tx: Tx, order: LockedOrder, staffId: string, comment?: string): Promise<'paid' | 'already_paid'> {
    if (order.payment_status === 'payment_success') return 'already_paid';
    if (order.status === 'cancelled') {
      throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Order is cancelled; its reservation was released' });
    }
    assertTransition(order.status, 'paid');

    const payment = await tx.payments.findFirst({
      where: { order_id: order.id, status: 'payment_pending', method: { code: 'bank_transfer' } },
      include: { manual: true },
    });
    if (!payment) throw new ConflictException({ code: 'NO_BANK_TRANSFER_PAYMENT', message: 'Order has no pending bank transfer' });

    const now = new Date();
    await this.stock.deduct(tx, order.id, staffId);
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
    await this.addHistory(tx, order.id, order.status, 'paid', { type: 'staff', id: staffId }, 'Bank transfer confirmed');
    await tx.audit_logs.create({
      data: {
        staff_user_id: staffId,
        action: 'order.bank_transfer_confirmed',
        entity_type: 'order',
        entity_id: order.id,
        before_json: { status: order.status, payment_status: order.payment_status },
        after_json: { status: 'paid', payment_status: 'payment_success', comment: comment ?? null },
      },
    });
    return 'paid';
  }

  /**
   * Staff cancels a paid order before handover: written-off units return to stock, the order becomes
   * Cancelled and a refund task is created (refunds are manual, Master TZ §10). Payment status stays
   * payment_success: the money was received and is returned outside the system.
   */
  async cancelPaid(tx: Tx, order: LockedOrder, staffId: string, reason: string): Promise<void> {
    assertTransition(order.status, 'cancelled');
    await this.stock.returnDeducted(tx, order.id, staffId);
    const full = await tx.orders.update({
      where: { id: order.id },
      data: { status: 'cancelled', cancelled_at: new Date(), reserved_until: null },
    });
    await tx.manager_tasks.create({
      data: {
        type: 'refund',
        order_id: order.id,
        note: `Вернуть клиенту ${Number(full.total_uzs)} сум: оплаченный заказ ${order.order_number} отменён. Причина: ${reason}`,
      },
    });
    await this.addHistory(tx, order.id, order.status, 'cancelled', { type: 'staff', id: staffId }, reason);
  }

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
  }
}
