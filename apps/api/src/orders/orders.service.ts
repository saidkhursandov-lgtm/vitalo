import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { stableStringify } from '../common/stable-json';
import { formatUzs, tashkentDateString } from '../common/tashkent';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryQuote } from '../delivery/delivery-quote';
import { StockLine, StockService } from '../inventory/stock.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankTransferDetails, SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { formatOrderNumber } from './order-number';
import { OrderLifecycleService } from './order-lifecycle.service';
import { orderViewInclude, OrderView, toOrderView } from './order-view';
import { CreateOrderDto, OrderPreviewDto } from './orders.dto';

type Tx = Prisma.TransactionClient;

const PAGE_SIZE = 20;
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

interface PricedLine {
  product_id: string;
  sku: string;
  name_ru: string;
  qty: number;
  unit_price_uzs: number;
  line_total_uzs: number;
}

interface Totals {
  goods_total_uzs: number;
  discount_total_uzs: number;
  bonus_used_uzs: number;
  goods_paid_uzs: number;
  delivery_cost_uzs: number;
  total_uzs: number;
}

export interface CreateOrderResult {
  order: OrderView;
  replayed: boolean;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly delivery: DeliveryService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Confirmation screen: the same calculation as order creation, without reserving anything. */
  async preview(userId: string, dto: OrderPreviewDto) {
    const { lines, skipped } = await this.resolveLines(this.prisma, userId, dto);
    const priced = await this.priceLines(this.prisma, lines);
    const available = await this.stock.availability(lines.map((l) => l.product_id));
    const problems = lines
      .filter((l) => (available.get(l.product_id) ?? 0) < l.qty)
      .map((l) => ({ code: 'INSUFFICIENT_STOCK', product_id: l.product_id, requested: l.qty, available: available.get(l.product_id) ?? 0 }));
    await this.resolvePaymentMethod(this.prisma, dto.payment_method);
    const { totals, delivery } = await this.computeTotals(this.prisma, priced, dto);

    return { items: priced, skipped_unavailable: skipped, totals, delivery, problems, can_place: problems.length === 0 };
  }

  /**
   * Creates an order exactly once per Idempotency-Key:
   * - the key row is inserted first inside the order transaction; a concurrent duplicate blocks on the
   *   unique index until the first commits, then fails and replays the stored response;
   * - if the order transaction fails (e.g. no stock) the key is rolled back too, so a retry is allowed.
   */
  async create(userId: string, idempotencyKey: string, dto: CreateOrderDto): Promise<CreateOrderResult> {
    const key = `${userId}:${idempotencyKey}`;
    const requestHash = createHash('sha256').update(stableStringify(dto)).digest('hex');

    const existing = await this.prisma.idempotency_keys.findUnique({ where: { key } });
    if (existing) return this.replay(existing, requestHash);

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        await tx.idempotency_keys.create({
          data: { key, scope: 'order.create', request_hash: requestHash, expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS) },
        });
        const view = await this.createInTx(tx, userId, dto);
        await tx.idempotency_keys.update({ where: { key }, data: { response_json: view as unknown as Prisma.InputJsonValue } });
        return view;
      }, TX_OPTIONS);
      return { order, replayed: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await this.prisma.idempotency_keys.findUnique({ where: { key } });
        if (row) return this.replay(row, requestHash);
      }
      throw e;
    }
  }

  async list(userId: string, page: number) {
    const where = { user_id: userId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.orders.count({ where }),
      this.prisma.orders.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { _count: { select: { items: true } } },
      }),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        created_at: o.created_at,
        status: o.status,
        payment_status: o.payment_status,
        total_uzs: Number(o.total_uzs),
        items_count: o._count.items,
      })),
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.prisma.orders.findFirst({ where: { id: orderId, user_id: userId }, include: orderViewInclude });
    if (!order) throw new NotFoundException('Order not found');
    return toOrderView(order);
  }

  /** Last used recipient/address, to prefill checkout (Master TZ §7). */
  async checkoutDefaults(userId: string) {
    const last = await this.prisma.orders.findFirst({ where: { user_id: userId }, orderBy: { created_at: 'desc' } });
    if (!last) return null;
    return {
      recipient_name: last.recipient_name,
      recipient_phone: last.recipient_phone,
      region_id: last.region_id,
      city_id: last.city_id,
      address_text: last.address_text,
      latitude: last.latitude == null ? null : Number(last.latitude),
      longitude: last.longitude == null ? null : Number(last.longitude),
    };
  }

  async cancelByCustomer(userId: string, orderId: string, reason?: string): Promise<OrderView> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lockOrder(tx, orderId);
      if (order.user_id !== userId) throw new NotFoundException('Order not found');
      await this.lifecycle.cancelUnpaid(tx, order, { type: 'customer', id: userId }, reason || 'Cancelled by customer');
      return toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));
    }, TX_OPTIONS);
  }

  async bankTransferDetails(userId: string, orderId: string) {
    const order = await this.get(userId, orderId);
    if (order.payment?.method !== 'bank_transfer') {
      throw new ConflictException({ code: 'NOT_BANK_TRANSFER', message: 'Order is not paid by bank transfer' });
    }
    const details = await this.settings.get<BankTransferDetails>(SETTING_KEYS.bankTransferDetails);
    if (!details) throw new ServiceUnavailableException('Bank transfer details are not configured');

    const { purpose_template, ...requisites } = details;
    return {
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      amount_uzs: order.totals.total_uzs,
      purpose: purpose_template.replace('{order_number}', order.order_number),
      requisites,
      pay_until: order.reserved_until,
      customer_reported_paid_at: order.payment.customer_reported_paid_at,
    };
  }

  /** "Я оплатил": records the claim and creates a manager task. Repeated clicks change nothing. */
  async reportBankTransferPaid(userId: string, orderId: string, receiptUrl?: string): Promise<OrderView> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lockOrder(tx, orderId);
      if (order.user_id !== userId) throw new NotFoundException('Order not found');
      const view = async () => toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));

      if (order.payment_status === 'payment_success') return view();
      if (order.status === 'cancelled') throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Order is cancelled' });
      if (order.reserved_until && order.reserved_until <= new Date()) {
        throw new ConflictException({ code: 'RESERVATION_EXPIRED', message: 'Payment time is over; the order will be cancelled' });
      }

      const payment = await tx.payments.findFirst({
        where: { order_id: orderId, status: 'payment_pending', method: { code: 'bank_transfer' } },
        include: { manual: true },
      });
      if (!payment) throw new ConflictException({ code: 'NOT_BANK_TRANSFER', message: 'Order is not paid by bank transfer' });
      if (payment.manual.some((m) => m.customer_confirmed_at)) return view();

      await tx.manual_payment_confirmations.create({
        data: { payment_id: payment.id, customer_confirmed_at: new Date(), receipt_url: receiptUrl ?? null },
      });
      await tx.manager_tasks.create({
        data: {
          type: 'bank_transfer_check',
          order_id: orderId,
          note: `Клиент сообщил об оплате заказа ${order.order_number} на ${formatUzs(Number(payment.amount_uzs))} сум`,
        },
      });
      await this.notifications.toOrderStaff(tx, 'staff.customer_paid', orderId);
      return view();
    }, TX_OPTIONS);
  }

  private async createInTx(tx: Tx, userId: string, dto: CreateOrderDto): Promise<OrderView> {
    const { lines, cartId } = await this.resolveLines(tx, userId, dto);
    const method = await this.resolvePaymentMethod(tx, dto.payment_method);
    const orderId = randomUUID();

    // 1. Stock first: all-or-nothing, throws 409 INSUFFICIENT_STOCK and rolls the whole order back.
    await this.stock.reserve(tx, orderId, lines);

    // 2. Prices are read on the server, inside the transaction, and frozen into the order.
    const priced = await this.priceLines(tx, lines);
    const { totals } = await this.computeTotals(tx, priced, dto);
    if (dto.expected_total_uzs != null && dto.expected_total_uzs !== totals.total_uzs) {
      throw new ConflictException({
        code: 'PRICE_CHANGED',
        message: 'Prices or delivery changed; please review the order again',
        expected_total_uzs: dto.expected_total_uzs,
        actual_total_uzs: totals.total_uzs,
      });
    }

    const now = new Date();
    const orderNumber = await this.nextOrderNumber(tx, now);
    await tx.orders.create({
      data: {
        id: orderId,
        order_number: orderNumber,
        user_id: userId,
        status: 'awaiting_payment',
        payment_status: 'payment_pending',
        recipient_name: dto.recipient_name,
        recipient_phone: dto.recipient_phone,
        region_id: dto.region_id,
        city_id: dto.city_id,
        address_text: dto.address_text,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        customer_comment: dto.customer_comment ?? null,
        delivery_method: 'courier', // V1: courier everywhere; provider is not fixed in the architecture (TZ §9)
        delivery_cost_uzs: BigInt(totals.delivery_cost_uzs),
        goods_total_uzs: BigInt(totals.goods_total_uzs),
        discount_total_uzs: BigInt(totals.discount_total_uzs),
        bonus_used_uzs: BigInt(totals.bonus_used_uzs),
        goods_paid_uzs: BigInt(totals.goods_paid_uzs),
        total_uzs: BigInt(totals.total_uzs),
        created_at: now,
        reserved_until: new Date(now.getTime() + method.timeout_minutes * 60_000),
        items: {
          create: priced.map((l) => ({
            product_id: l.product_id,
            sku_snapshot: l.sku,
            name_ru_snapshot: l.name_ru,
            qty: l.qty,
            unit_price_uzs: BigInt(l.unit_price_uzs),
            line_total_uzs: BigInt(l.line_total_uzs),
            discount_uzs: 0n,
            paid_line_total_uzs: BigInt(l.line_total_uzs),
          })),
        },
        payments: {
          create: {
            payment_method_id: method.id,
            amount_uzs: BigInt(totals.total_uzs),
            attempts: { create: { attempt_no: 1 } },
          },
        },
      },
    });

    const customer = { type: 'customer' as const, id: userId };
    await this.lifecycle.addHistory(tx, orderId, null, 'new', customer, 'Order created', now);
    await this.lifecycle.addHistory(tx, orderId, 'new', 'awaiting_payment', customer, `Payment method: ${method.code}`, new Date(now.getTime() + 1));
    await this.notifications.toOrderStaff(tx, 'staff.new_order', orderId);

    // "Купить сейчас" never touches the cart; a cart checkout removes only the ordered lines.
    if (cartId) {
      await tx.cart_items.deleteMany({ where: { cart_id: cartId, product_id: { in: lines.map((l) => l.product_id) } } });
    }

    return toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));
  }

  /** Cart checkout takes sellable lines only; out-of-stock / archived lines stay in the cart (TZ §6). */
  private async resolveLines(db: Tx | PrismaService, userId: string, dto: OrderPreviewDto) {
    if (dto.source === 'buy_now') {
      return { lines: [{ product_id: dto.buy_now!.product_id, qty: dto.buy_now!.qty }] as StockLine[], skipped: [] as string[], cartId: null };
    }
    const cart = await db.carts.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { items: { include: { product: { select: { status: true } } } } },
    });
    const items = cart?.items ?? [];
    const available = await this.stock.availability(items.map((i) => i.product_id), db);
    const sellable = items.filter((i) => i.product.status === 'active' && (available.get(i.product_id) ?? 0) > 0);
    if (!sellable.length) {
      throw new UnprocessableEntityException({ code: 'EMPTY_ORDER', message: 'There is nothing available to order in the cart' });
    }
    return {
      lines: sellable.map((i) => ({ product_id: i.product_id, qty: i.qty })),
      skipped: items.filter((i) => !sellable.includes(i)).map((i) => i.product_id),
      cartId: cart!.id,
    };
  }

  private async priceLines(db: Tx | PrismaService, lines: StockLine[]): Promise<PricedLine[]> {
    const products = await db.products.findMany({ where: { id: { in: lines.map((l) => l.product_id) }, status: 'active' } });
    const byId = new Map(products.map((p) => [p.id, p]));
    return lines.map((l) => {
      const p = byId.get(l.product_id);
      if (!p) throw new ConflictException({ code: 'PRODUCT_UNAVAILABLE', message: 'Product is no longer sold', product_id: l.product_id });
      const price = Number(p.price_uzs);
      return { product_id: p.id, sku: p.sku, name_ru: p.name_ru, qty: l.qty, unit_price_uzs: price, line_total_uzs: price * l.qty };
    });
  }

  /** No promos/bonuses yet: discount = 0, bonus = 0. Free shipping uses goods after discounts (TZ §9). */
  private async computeTotals(db: Tx | PrismaService, lines: PricedLine[], dto: OrderPreviewDto): Promise<{ totals: Totals; delivery: DeliveryQuote }> {
    const goods = lines.reduce((s, l) => s + l.line_total_uzs, 0);
    const discount = 0;
    const bonus = 0;
    const delivery = await this.delivery.quote(dto.region_id, dto.city_id, goods - discount, db);
    const goodsPaid = goods - discount - bonus;
    return {
      totals: {
        goods_total_uzs: goods,
        discount_total_uzs: discount,
        bonus_used_uzs: bonus,
        goods_paid_uzs: goodsPaid,
        delivery_cost_uzs: delivery.cost_uzs,
        total_uzs: goodsPaid + delivery.cost_uzs,
      },
      delivery,
    };
  }

  private async resolvePaymentMethod(db: Tx | PrismaService, code: string) {
    const method = await db.payment_methods.findUnique({ where: { code } });
    if (!method || method.status !== 'enabled' || code !== 'bank_transfer') {
      // Online providers (Payme/Click/Uzum) come in the payments stage.
      throw new UnprocessableEntityException({ code: 'PAYMENT_METHOD_UNAVAILABLE', message: `Payment method ${code} is not available` });
    }
    return method;
  }

  /** Atomic per-day counter; part of the order transaction, so a rolled-back order leaves no gap. */
  private async nextOrderNumber(tx: Tx, at: Date): Promise<string> {
    const day = tashkentDateString(at);
    const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO order_number_counters (day, last) VALUES (${day}::date, 1)
      ON CONFLICT (day) DO UPDATE SET last = order_number_counters.last + 1
      RETURNING last`;
    return formatOrderNumber(day, Number(last));
  }

  private replay(row: { request_hash: string; response_json: Prisma.JsonValue }, requestHash: string): CreateOrderResult {
    if (row.request_hash !== requestHash) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used with a different request',
      });
    }
    if (!row.response_json) throw new ConflictException({ code: 'REQUEST_IN_PROGRESS', message: 'The same request is still being processed' });
    return { order: row.response_json as unknown as OrderView, replayed: true };
  }
}
