import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
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
  ) {}

  @Interval('reservation-expiry', 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const cancelled = await this.runOnce();
      if (cancelled) this.logger.log(`Cancelled ${cancelled} expired order(s)`);
      await this.prisma.idempotency_keys.deleteMany({ where: { expires_at: { lt: new Date() } } });
    } catch (e) {
      this.logger.error('Reservation expiry failed', e as Error);
    } finally {
      this.running = false;
    }
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
