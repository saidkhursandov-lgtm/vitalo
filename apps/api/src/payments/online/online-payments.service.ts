import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OrderLifecycleService } from '../../orders/order-lifecycle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { isStaffCustomer, paymeReceiptGaps } from '../payme/payme-availability';
import {
  isOnlineProvider,
  modeOpenFor,
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

type Db = Prisma.TransactionClient | PrismaService;

/** Paid by hand, offered when enabled (bank_transfer is no longer offered at checkout, D-06). */
const MANUAL_CHOICES = ['card_transfer'] as const;

/** One way to pay an unpaid order; unavailable 'ikpu' — a product has no receipt codes for this system. */
export interface PayChoice {
  code: string;
  unavailable: 'ikpu' | null;
}

const PAY_CHOICE_INCLUDE = {
  items: { select: { product_id: true } },
  payments: { where: { status: 'payment_pending' }, orderBy: { created_at: 'desc' }, take: 1, include: { method: { select: { code: true } }, manual: { select: { customer_confirmed_at: true } } } },
} satisfies Prisma.ordersInclude;
type PayChoiceOrder = Prisma.ordersGetPayload<{ include: typeof PAY_CHOICE_INCLUDE }>;

/** Why the way to pay cannot be changed: not waiting (paid, cancelled, cash on delivery), time is over, the transfer was reported. */
export type ChangeBlocked = 'not_awaiting' | 'expired' | 'reported';
const CHANGE_BLOCKED_CODES: Record<ChangeBlocked, string> = {
  not_awaiting: 'ORDER_NOT_AWAITING_PAYMENT',
  expired: 'RESERVATION_EXPIRED',
  reported: 'PAYMENT_ALREADY_REPORTED',
};

function changeBlocked(o: PayChoiceOrder, now = new Date()): ChangeBlocked | null {
  if (o.status !== 'awaiting_payment' || o.payment_status !== 'payment_pending') return 'not_awaiting';
  if (o.reserved_until && o.reserved_until <= now) return 'expired';
  if (o.payments[0]?.manual.some((m) => m.customer_confirmed_at)) return 'reported';
  return null;
}

/**
 * Common part of every online payment system (D-20). The order of steps:
 *   1. start()    — create a payment row and ask the system for its payment page;
 *   2. the Mini App sends the customer to checkout_url;
 *   3. callback() — the system confirms (its module checks the signature and the amount);
 *   4. the order is marked paid (OrderLifecycleService.confirmOnlinePayment), exactly once.
 * Payme (Merchant API: POST /api/payments/payme) and Click (SHOP API: /api/payments/click/prepare, /complete) are
 * registered; Uzum is not, so for it start() and callback() answer «не подключено».
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

  /** «Работает» and «Тест» only with keys and a connected module; the message is shown in the admin panel as is. */
  assertModesAllowed(modes: Partial<OnlineModes>) {
    for (const p of ONLINE_PROVIDERS) {
      if ((modes[p] !== 'live' && modes[p] !== 'test') || this.connected(p)) continue;
      const missing = [!providerKeysPresent(p) && 'ключи в .env на сервере', !this.gateways.has(p) && 'модуль подключения'].filter(Boolean).join(' и ');
      throw new BadRequestException({
        code: 'ONLINE_PROVIDER_NOT_CONNECTED',
        message: `${PROVIDER_NAMES[p]} нельзя включить: нет ${missing}. Пока можно выбрать «Скрыта» или «Скоро».`,
        provider: p,
      });
    }
  }

  /** Step 1: create a payment for the customer's unpaid order and get the payment page link. */
  async start(userId: string, orderId: string, provider: string, lang: 'ru' | 'uz', returnTo?: 'site') {
    if (!isOnlineProvider(provider)) throw new NotFoundException('Unknown payment system');
    const gateway = this.gateways.get(provider);
    const mode = (await this.modes())[provider];
    if (!gateway || !this.connected(provider) || !modeOpenFor(mode, mode === 'test' && (await isStaffCustomer(this.prisma, userId)))) {
      throw new ConflictException({ code: 'ONLINE_PAYMENT_NOT_CONNECTED', message: `${PROVIDER_NAMES[provider]} is not connected yet` });
    }
    const order = await this.prisma.orders.findFirst({ where: { id: orderId, user_id: userId }, include: { items: { select: { product_id: true } } } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'awaiting_payment' || order.payment_status !== 'payment_pending') {
      throw new ConflictException({ code: 'ORDER_NOT_AWAITING_PAYMENT', message: 'Order does not wait for a payment' });
    }
    if (order.reserved_until && order.reserved_until <= new Date()) {
      throw new ConflictException({ code: 'RESERVATION_EXPIRED', message: 'Payment time is over; the order will be cancelled' });
    }
    // the order waits for another way to pay: first «Сменить способ» (changeMethod), so two systems never wait at once
    const pending = await this.prisma.payments.findFirst({ where: { order_id: order.id, status: 'payment_pending' }, orderBy: { created_at: 'desc' }, include: { method: { select: { code: true } } } });
    if (pending && pending.method.code !== provider) {
      throw new ConflictException({ code: 'PAYMENT_METHOD_MISMATCH', current: pending.method.code, message: 'The order waits for another payment method; change it first' });
    }
    const method = await this.prisma.payment_methods.findUnique({ where: { code: provider } });
    if (!method) throw new ConflictException({ code: 'ONLINE_PAYMENT_NOT_CONNECTED', message: 'Payment method row is missing' });
    // Payme and Click both send a fiscal receipt: every product needs ИКПУ (and a paid delivery its codes)
    if (provider === 'payme' || provider === 'click') {
      const gaps = await paymeReceiptGaps(this.prisma, order.items.map((i) => i.product_id), Number(order.delivery_cost_uzs));
      if (gaps.skus.length || gaps.delivery) {
        throw new ConflictException({ code: provider === 'click' ? 'CLICK_RECEIPT_INCOMPLETE' : 'PAYME_RECEIPT_INCOMPLETE', skus: gaps.skus, delivery: gaps.delivery, message: `${PROVIDER_NAMES[provider]} needs an IKPU code for every product` });
      }
    }

    // The order was placed with this method: its pending payment is reused, so «Оплатить» pressed again gives the
    // same payment and link (Payme then reports the money for the order number, not for a payment row).
    const payment =
      (await this.prisma.payments.findFirst({ where: { order_id: order.id, payment_method_id: method.id, status: 'payment_pending' }, orderBy: { created_at: 'desc' } })) ??
      (await this.prisma.payments.create({
        data: { order_id: order.id, payment_method_id: method.id, amount_uzs: order.total_uzs, attempts: { create: { attempt_no: 1 } } },
      }));
    const returnUrl = returnTo === 'site' ? siteOrderUrl(order.id) : null;
    const created = await gateway.createPayment({ paymentId: payment.id, orderNumber: order.order_number, amountUzs: Number(order.total_uzs), lang, returnUrl });
    await this.prisma.payments.update({
      where: { id: payment.id },
      data: {
        ...(created.providerPaymentId && { provider_payment_id: created.providerPaymentId }),
        checkout_url: created.checkoutUrl,
        expires_at: created.expiresAt ?? order.reserved_until ?? null,
      },
    });
    return { payment_id: payment.id, checkout_url: created.checkoutUrl, pay_until: order.reserved_until };
  }

  /**
   * «Сменить способ оплаты»: what an unpaid order can be paid with now. Online systems with a module (Payme, Click,
   * and Uzum once its module is registered) — when their mode is open for this customer and the keys are in .env;
   * `unavailable: 'ikpu'` — a product has no receipt codes. Then the card transfer, when it is enabled. Cash on delivery
   * is never offered here: it is a different order flow (no deadline, the manager confirms).
   * `blocked` says why nothing can be changed: not waiting for a payment, time is over, or «Я оплатил(а)» was pressed.
   */
  async methods(userId: string, orderId: string) {
    const order = await this.prisma.orders.findFirst({ where: { id: orderId, user_id: userId }, include: PAY_CHOICE_INCLUDE });
    if (!order) throw new NotFoundException('Order not found');
    const payment = order.payments[0];
    return {
      order_id: order.id,
      current: payment?.method.code ?? null,
      total_uzs: Number(order.total_uzs),
      reserved_until: order.reserved_until,
      blocked: changeBlocked(order),
      methods: await this.choices(this.prisma, userId, order),
    };
  }

  /**
   * The customer picks another way to pay an unpaid order. The amount and the reservation stay the same. Inside the
   * order lock: every system's waiting transaction is cancelled (a late confirmation is refused, the money goes back),
   * and the pending payment row gets the new method with a fresh attempt — so the order can be paid only once.
   */
  async changeMethod(userId: string, orderId: string, code: string) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lifecycle.lockOrder(tx, orderId);
      if (locked.user_id !== userId) throw new NotFoundException('Order not found');
      const order = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: PAY_CHOICE_INCLUDE });
      const blocked = changeBlocked(order);
      if (blocked) throw new ConflictException({ code: CHANGE_BLOCKED_CODES[blocked], message: 'The payment method of this order cannot be changed' });
      const payment = order.payments[0];
      if (payment?.method.code === code) return; // already this method: nothing to do

      const choice = (await this.choices(tx, userId, order)).find((m) => m.code === code);
      if (!choice) throw new UnprocessableEntityException({ code: 'PAYMENT_METHOD_UNAVAILABLE', message: `Payment method ${code} is not available` });
      if (choice.unavailable === 'ikpu') {
        throw new UnprocessableEntityException({ code: `${code.toUpperCase()}_RECEIPT_INCOMPLETE`, message: `${code} needs an IKPU code for every product` });
      }
      const method = await tx.payment_methods.findUniqueOrThrow({ where: { code } });

      const now = new Date();
      for (const g of this.gateways.values()) await g.abandon(tx, orderId, now);
      if (payment) {
        await tx.payment_attempts.updateMany({ where: { payment_id: payment.id, status: 'pending' }, data: { status: 'cancelled' } });
        const last = await tx.payment_attempts.aggregate({ where: { payment_id: payment.id }, _max: { attempt_no: true } });
        await tx.payments.update({
          where: { id: payment.id },
          data: {
            payment_method_id: method.id,
            provider_payment_id: null,
            checkout_url: null,
            expires_at: null,
            attempts: { create: { attempt_no: (last._max.attempt_no ?? 0) + 1, provider_response_json: { method_changed_from: payment.method.code, at: now.toISOString() } } },
          },
        });
      } else {
        await tx.payments.create({ data: { order_id: orderId, payment_method_id: method.id, amount_uzs: order.total_uzs, attempts: { create: { attempt_no: 1 } } } });
      }
    }, TX_OPTIONS);
    return this.methods(userId, orderId);
  }

  /** The ways to pay this order (see methods()). The current method is always listed, even when it is no longer offered. */
  private async choices(db: Db, userId: string, order: PayChoiceOrder): Promise<PayChoice[]> {
    const checkoutOptions = await this.settings.getOrDefault('checkout_options');
    const modes = onlineModes(checkoutOptions);
    const staff = await isStaffCustomer(db, userId);
    const current = order.payments[0]?.method.code ?? null;
    const productIds = order.items.map((i) => i.product_id);
    let gaps: boolean | null = null;
    const out: PayChoice[] = [];
    for (const p of ONLINE_PROVIDERS) {
      if (!this.connected(p) || !modeOpenFor(modes[p], staff)) continue;
      if (gaps === null) {
        const g = await paymeReceiptGaps(db, productIds, Number(order.delivery_cost_uzs));
        gaps = g.skus.length > 0 || g.delivery;
      }
      out.push({ code: p, unavailable: gaps ? 'ikpu' : null });
    }
    const manual = await db.payment_methods.findMany({ where: { code: { in: [...MANUAL_CHOICES] }, status: 'enabled' } });
    for (const m of manual) out.push({ code: m.code, unavailable: null });
    if (current && current !== 'cod' && !out.some((m) => m.code === current)) out.unshift({ code: current, unavailable: null });
    return out;
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

/** Release 6: the order page on the site (SITE_URL, https only); null — the gateway sends the customer to the bot. */
export function siteOrderUrl(orderId: string, site = process.env.SITE_URL): string | null {
  const base = site?.trim().replace(/\/$/, '');
  return base && /^https:\/\/[^\s/]+$/.test(base) ? `${base}/order/${orderId}` : null;
}
