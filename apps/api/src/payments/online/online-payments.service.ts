import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { OrderLifecycleService } from '../../orders/order-lifecycle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import {
  isOnlineProvider,
  ONLINE_GATEWAYS,
  ONLINE_PROVIDERS,
  onlineModes,
  PROVIDER_NAMES,
  providerKeysPresent,
  type OnlineModes,
  type OnlinePaymentGateway,
  type OnlineProvider,
} from './online-providers';

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/**
 * Common part of every online payment system (D-20). The order of steps:
 *   1. start()    — create a payment row and ask the system for its payment page;
 *   2. the Mini App sends the customer to checkout_url;
 *   3. callback() — the system confirms (its module checks the signature and the amount);
 *   4. the order is marked paid (OrderLifecycleService.confirmOnlinePayment), exactly once.
 * In 2.1 no system module is registered, so start() and callback() answer «не подключено».
 */
@Injectable()
export class OnlinePaymentsService {
  private readonly gateways = new Map<OnlineProvider, OnlinePaymentGateway>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly lifecycle: OrderLifecycleService,
    @Optional() @Inject(ONLINE_GATEWAYS) gateways: OnlinePaymentGateway[] = [],
  ) {
    for (const g of gateways ?? []) this.gateways.set(g.provider, g);
  }

  /** Keys in .env + a registered module = the system can work. */
  connected(p: OnlineProvider): boolean {
    return this.gateways.has(p) && providerKeysPresent(p);
  }

  /** For «Настройки → Оплата»: why «Работает» can or cannot be switched on (no key values, only yes/no). */
  providersStatus() {
    return Object.fromEntries(
      ONLINE_PROVIDERS.map((p) => [p, { keys_present: providerKeysPresent(p), module_ready: this.gateways.has(p), can_go_live: this.connected(p) }]),
    ) as Record<OnlineProvider, { keys_present: boolean; module_ready: boolean; can_go_live: boolean }>;
  }

  async modes(): Promise<OnlineModes> {
    return onlineModes(await this.settings.getOrDefault('checkout_options'));
  }

  /** «Работает» only with keys and a connected module; the message is shown in the admin panel as is. */
  assertModesAllowed(modes: Partial<OnlineModes>) {
    for (const p of ONLINE_PROVIDERS) {
      if (modes[p] !== 'live' || this.connected(p)) continue;
      const missing = [!providerKeysPresent(p) && 'ключи в .env на сервере', !this.gateways.has(p) && 'модуль подключения'].filter(Boolean).join(' и ');
      throw new BadRequestException({
        code: 'ONLINE_PROVIDER_NOT_CONNECTED',
        message: `${PROVIDER_NAMES[p]} нельзя включить: нет ${missing}. Пока можно выбрать «Скрыта» или «Скоро».`,
        provider: p,
      });
    }
  }

  /** Step 1: create a payment for the customer's unpaid order and get the payment page link. */
  async start(userId: string, orderId: string, provider: string, lang: 'ru' | 'uz') {
    if (!isOnlineProvider(provider)) throw new NotFoundException('Unknown payment system');
    const gateway = this.gateways.get(provider);
    if (!gateway || !this.connected(provider) || (await this.modes())[provider] !== 'live') {
      throw new ConflictException({ code: 'ONLINE_PAYMENT_NOT_CONNECTED', message: `${PROVIDER_NAMES[provider]} is not connected yet` });
    }
    const order = await this.prisma.orders.findFirst({ where: { id: orderId, user_id: userId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'awaiting_payment') throw new ConflictException({ code: 'ORDER_NOT_AWAITING_PAYMENT', message: 'Order does not wait for a payment' });
    const method = await this.prisma.payment_methods.findUnique({ where: { code: provider } });
    if (!method) throw new ConflictException({ code: 'ONLINE_PAYMENT_NOT_CONNECTED', message: 'Payment method row is missing' });

    const payment = await this.prisma.payments.create({
      data: { order_id: order.id, payment_method_id: method.id, amount_uzs: order.total_uzs, attempts: { create: { attempt_no: 1 } } },
    });
    const created = await gateway.createPayment({ paymentId: payment.id, orderNumber: order.order_number, amountUzs: Number(order.total_uzs), lang });
    await this.prisma.payments.update({
      where: { id: payment.id },
      data: { provider_payment_id: created.providerPaymentId, checkout_url: created.checkoutUrl, expires_at: created.expiresAt ?? null },
    });
    return { payment_id: payment.id, checkout_url: created.checkoutUrl };
  }

  /** Step 3: a confirmation from the payment system. Not connected -> 501 «не подключено», nothing is stored. */
  async callback(provider: string, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: Buffer }) {
    if (!isOnlineProvider(provider)) return { status: 404, body: { error: 'unknown_provider' } };
    const gateway = this.gateways.get(provider);
    if (!gateway || !this.connected(provider)) return { status: 501, body: { error: 'not_connected', message: `${PROVIDER_NAMES[provider]} is not connected` } };

    const reply = await gateway.handleCallback(input);
    const outcome = reply.outcome;
    if (outcome.kind === 'ignored') return reply;
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findFirst({ where: { provider_payment_id: outcome.providerPaymentId, method: { code: provider } } });
      if (!payment) return;
      if (outcome.kind === 'cancelled') {
        // the order keeps waiting: the customer may pay again or choose another method
        await tx.payments.updateMany({ where: { id: payment.id, status: 'payment_pending' }, data: { status: 'payment_cancelled' } });
        return;
      }
      const order = await this.lifecycle.lockOrder(tx, payment.order_id);
      await this.lifecycle.confirmOnlinePayment(tx, order, payment.id); // step 4
    }, TX_OPTIONS);
    return reply;
  }
}
