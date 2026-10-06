import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemErrorsService } from '../notifications/system-errors';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { OrderLifecycleService } from './order-lifecycle.service';

const BATCH = 100;

/**
 * Background job (every minute): cancels unpaid orders whose reservation expired and releases stock.
 * Orders where the customer pressed "Я оплатил" are NOT auto-cancelled: money may already be on the
 * way, so they wait for the manager (the open bank_transfer_check task).
 * Safe to run on several API instances at once: each order is re-checked under its row lock.
 */
@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly errors: SystemErrorsService,
  ) {}

  @Interval('reservation-expiry', 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const reminded = await this.remindOnce();
      if (reminded) this.logger.log(`Payment reminder for ${reminded} order(s)`);
      const overdue = await this.remindStaffOnce();
      if (overdue) this.logger.log(`Payment check overdue: staff reminded about ${overdue} order(s)`);
      const cancelled = await this.runOnce();
      if (cancelled) this.logger.log(`Cancelled ${cancelled} expired order(s)`);
      await this.prisma.idempotency_keys.deleteMany({ where: { expires_at: { lt: new Date() } } });
    } catch (e) {
      this.logger.error('Reservation expiry failed', e as Error);
      await this.errors.record({ level: 'error', service: 'orders', message: `Reservation job failed: ${(e as Error).message}`, context: { job: 'reservation-expiry' } });
    } finally {
      this.running = false;
    }
  }

  /**
   * D3: "Заказ №… ждёт оплаты до …" N hours (settings, default 3) before the automatic cancellation.
   * Only unpaid orders without «Я оплатил(а)», at most once per order (payment_reminder_sent_at).
   * Returns how many reminders were queued. Exposed for tests and manual runs.
   */
  async remindOnce(now = new Date()): Promise<number> {
    const hours = Number(await this.settings.getOrDefault('payment_reminder_hours')) || 3;
    const until = new Date(now.getTime() + hours * 3600_000);
    const candidates = await this.prisma.orders.findMany({
      where: {
        status: { in: ['new', 'awaiting_payment'] },
        payment_status: 'payment_pending',
        payment_reminder_sent_at: null,
        reserved_until: { gt: now, lte: until },
        payments: { none: { manual: { some: { customer_confirmed_at: { not: null } } } } },
      },
      select: { id: true },
      orderBy: { reserved_until: 'asc' },
      take: BATCH,
    });
    let sent = 0;
    for (const { id } of candidates) {
      const queued = await this.prisma.$transaction(async (tx) => {
        const order = await this.lifecycle.lockOrder(tx, id);
        const reported = await tx.manual_payment_confirmations.count({ where: { payment: { order_id: id }, customer_confirmed_at: { not: null } } });
        const fresh = await tx.orders.findUniqueOrThrow({ where: { id }, select: { payment_reminder_sent_at: true } });
        const due =
          (order.status === 'new' || order.status === 'awaiting_payment') &&
          order.payment_status === 'payment_pending' &&
          !fresh.payment_reminder_sent_at &&
          reported === 0;
        if (!due) return false;
        await this.notifications.paymentReminder(tx, id);
        await tx.orders.update({ where: { id }, data: { payment_reminder_sent_at: now } });
        return true;
      });
      if (queued) sent++;
    }
    return sent;
  }

  /**
   * Stage 0.2: the customer pressed «Я оплатил(а)», and the payment is still unconfirmed after N hours
   * (settings, default 3) -> one message to admins and managers. The order is not cancelled and its
   * reservation is not touched. At most once per order (payment_check_reminder_sent_at), re-checked under the
   * order row lock, so repeated runs and several API instances never queue it twice.
   * Returns how many orders got a reminder. Exposed for tests and manual runs.
   */
  async remindStaffOnce(now = new Date()): Promise<number> {
    const hours = Number(await this.settings.getOrDefault('payment_check_reminder_hours')) || 3;
    const reportedBefore = new Date(now.getTime() - hours * 3600_000);
    const candidates = await this.prisma.orders.findMany({
      where: {
        status: { in: ['new', 'awaiting_payment'] },
        payment_status: 'payment_pending',
        payment_check_reminder_sent_at: null,
        payments: { some: { status: 'payment_pending', manual: { some: { customer_confirmed_at: { lte: reportedBefore } } } } },
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: BATCH,
    });
    let sent = 0;
    for (const { id } of candidates) {
      const queued = await this.prisma.$transaction(async (tx) => {
        const order = await this.lifecycle.lockOrder(tx, id);
        const fresh = await tx.orders.findUniqueOrThrow({ where: { id }, select: { payment_check_reminder_sent_at: true } });
        const first = await tx.manual_payment_confirmations.findFirst({
          where: { payment: { order_id: id, status: 'payment_pending' }, customer_confirmed_at: { not: null } },
          orderBy: { customer_confirmed_at: 'asc' },
          select: { customer_confirmed_at: true },
        });
        const reportedAt = first?.customer_confirmed_at ?? null;
        const due =
          (order.status === 'new' || order.status === 'awaiting_payment') &&
          order.payment_status === 'payment_pending' &&
          !fresh.payment_check_reminder_sent_at &&
          reportedAt !== null &&
          reportedAt <= reportedBefore;
        if (!due) return false;
        await this.notifications.paymentCheckOverdue(tx, id, Math.floor((now.getTime() - reportedAt.getTime()) / 3600_000));
        await tx.orders.update({ where: { id }, data: { payment_check_reminder_sent_at: now } });
        return true;
      });
      if (queued) sent++;
    }
    return sent;
  }

  /** Returns how many orders were cancelled. Exposed for tests and manual runs. */
  async runOnce(now = new Date()): Promise<number> {
    const candidates = await this.prisma.orders.findMany({
      where: {
        status: { in: ['new', 'awaiting_payment'] },
        payment_status: 'payment_pending',
        reserved_until: { lt: now },
        payments: { none: { manual: { some: { customer_confirmed_at: { not: null } } } } },
      },
      select: { id: true },
      orderBy: { reserved_until: 'asc' },
      take: BATCH,
    });

    let cancelled = 0;
    for (const { id } of candidates) {
      const result = await this.prisma.$transaction(async (tx) => {
        const order = await this.lifecycle.lockOrder(tx, id);
        // Re-check under the lock: it may have been paid, cancelled or reported as paid meanwhile.
        const reported = await tx.manual_payment_confirmations.count({
          where: { payment: { order_id: id }, customer_confirmed_at: { not: null } },
        });
        const stillExpired =
          (order.status === 'new' || order.status === 'awaiting_payment') &&
          order.payment_status === 'payment_pending' &&
          order.reserved_until !== null &&
          order.reserved_until < now &&
          reported === 0;
        if (!stillExpired) return 'skipped';
        return this.lifecycle.cancelUnpaid(tx, order, { type: 'system', id: null }, 'Reservation expired: not paid in time');
      });
      if (result === 'cancelled') cancelled++;
    }
    return cancelled;
  }
}
