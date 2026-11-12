import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { stableStringify } from '../common/stable-json';
import { formatUzs, tashkentDateString } from '../common/tashkent';
import { DeliveryService } from '../delivery/delivery.service';
import { LegalService } from '../legal/legal.module';
import { DeliveryQuote } from '../delivery/delivery-quote';
import { StockLine, StockService } from '../inventory/stock.service';
import { intakeGuideItems, NotificationsService } from '../notifications/notifications.service';
import { INTAKE_FOOTER } from '../notifications/notification-templates';
import { PrismaService } from '../prisma/prisma.service';
import { listImage, listInclude, ShopCampaign } from '../catalog/product.mapper';
import { BankTransferDetails, COD_METHOD, MANUAL_PAYMENT_METHODS, SETTING_KEYS, SettingsService, type ManualPaymentMethod } from '../settings/settings.service';
import { formatOrderNumber } from './order-number';
import { CUSTOMER_CANCELLABLE } from './order-state';
import { combineTerms, underOrderMark, customerCancel, expectedWindow, guaranteeDate, isoDay, SUPPLIER_TERMS_SELECT, windowView, type SupplyTerms } from './cross-border';
import { cbMarkOf, crossBorderStageOf, orderTermsOf } from './order-view';
import { CB_CUSTOMER_CANCEL_REASON_CODE } from '../notifications/notification-templates';
import { MAX_LINE_QTY } from '../cart/cart-reconcile';
import { OrderLifecycleService } from './order-lifecycle.service';
import { orderViewInclude, OrderView, toOrderView } from './order-view';
import { CreateOrderDto, OrderPreviewDto } from './orders.dto';
import { AnalyticsService } from '../analytics/analytics.module';
import { BotInfoService } from './receipts';
import { CampaignsService, toShopCampaign } from '../promo/campaigns.service';
import { PromoCodesService } from '../promo/promo.service';
import { BonusService } from '../bonus/bonus.service';
import { isStaffCustomer, paymeReceiptGaps, paymeSwitchedOn, paymeUnavailable } from '../payments/payme/payme-availability';
import { onlineModes } from '../payments/online/online-providers';

const PAYME_METHOD = 'payme';

type Tx = Prisma.TransactionClient;

const isManualMethod = (code: string | undefined): code is ManualPaymentMethod =>
  (MANUAL_PAYMENT_METHODS as readonly string[]).includes(code ?? '');

const PAGE_SIZE = 20;
/** 3.2: unfinished orders for the home-screen plaque. */
const ACTIVE_STATUSES: OrderStatus[] = ['new', 'awaiting_payment', 'paid', 'picking', 'handed_to_delivery', 'in_transit'];
/** 3.2: the intake memo is shown once the order is paid (or confirmed for cash on delivery). */
const GUIDE_STATUSES: OrderStatus[] = ['paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'];
type GuideLine = { product_id: string; name: string; text: string };
export type IntakeGuide = { ru: GuideLine[]; uz: GuideLine[]; footer: Record<'ru' | 'uz', string> };
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

interface PricedLine {
  product_id: string;
  sku: string;
  name_ru: string;
  name_uz: string | null;
  short_name_ru: string | null;
  short_name_uz: string | null;
  form: string | null;
  image_url: string | null;
  qty: number;
  unit_price_uzs: number;
  line_total_uzs: number;
  /** 3.7: the regular price and the running sale (unit_price_uzs is then the sale price) */
  list_price_uzs: number;
  campaign: ShopCampaign | null;
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

/** D-61: the guarantee is counted from the payment or — payment on delivery — from the manager's confirmation. */
function cancelBase(o: { paid_at: Date | null; history: { to_status: string; created_at: Date }[] }): Date | null {
  return o.paid_at ?? o.history.find((h) => h.to_status === 'paid')?.created_at ?? null;
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
    private readonly legal: LegalService,
    private readonly analytics: AnalyticsService,
    private readonly botInfo: BotInfoService,
    private readonly promo: PromoCodesService,
    private readonly campaigns: CampaignsService,
    private readonly bonus: BonusService,
  ) {}

  /** Confirmation screen: the same calculation as order creation, without reserving anything. */
  async preview(userId: string, dto: OrderPreviewDto) {
    const { lines, skipped, cartId, cartPromo, cartBonus } = await this.resolveLines(this.prisma, userId, dto);
    const priced = await this.priceLines(this.prisma, lines);
    const available = await this.stock.orderable(lines.map((l) => l.product_id), MAX_LINE_QTY);
    const problems = lines
      .filter((l) => (available.get(l.product_id)?.qty ?? 0) < l.qty)
      .map((l) => ({ code: 'INSUFFICIENT_STOCK', product_id: l.product_id, requested: l.qty, available: available.get(l.product_id)?.qty ?? 0 }));
    // D-60/D-61: «под заказ» lines — the window is shown before the order is placed; from abroad — prepayment only
    const underTerms = lines.map((l) => available.get(l.product_id)?.terms).filter((t): t is SupplyTerms => !!t);
    const foreign = underTerms.some((t) => t.kind === 'foreign');
    await this.resolvePaymentMethod(this.prisma, dto.payment_method, userId);
    const code = this.promoCodeOf(dto, cartPromo);
    const calc = await this.promo.calculate(this.prisma, userId, priced, { address: dto, code, useBonus: this.useBonusOf(dto, cartBonus) });
    // the code saved in the cart stopped fitting: it is removed there too (the customer sees the hint)
    if (calc.promo_rejection && cartId && dto.promo_code === undefined) await this.prisma.carts.update({ where: { id: cartId }, data: { promo_code: null } });
    const totals = calc.totals;
    const cod = await this.codAvailable(this.prisma, dto.region_id, totals.total_uzs);
    // «Оплата при получении» is offered only when it is possible for this address and total (Tashkent, the limit).
    // Payme: only when «Работает» and every product (and a paid delivery) has ИКПУ for the fiscal receipt
    const checkoutOptions = await this.settings.getOrDefault('checkout_options');
    const payme = await paymeUnavailable(this.prisma, checkoutOptions, await this.paymeStaff(this.prisma, checkoutOptions, userId), lines.map((l) => l.product_id), totals.delivery_cost_uzs);
    const codWhy = foreign ? 'cross_border' : cod;
    const payment_options = { cod: codWhy === 'ok', cod_unavailable: codWhy === 'ok' ? null : codWhy, payme: payme === null, payme_unavailable: payme };
    const codBlocked = (dto.payment_method === COD_METHOD && codWhy !== 'ok') || (dto.payment_method === PAYME_METHOD && payme !== null);

    return {
      items: priced.map((l) => ({
        ...l,
        discount_uzs: calc.snapshot.lines.find((s) => s.product_id === l.product_id)?.promo_discount_uzs ?? 0,
        cross_border: !!available.get(l.product_id)?.cross_border,
        under_order: underOrderMark(available.get(l.product_id)?.terms),
      })),
      cross_border: windowView(underTerms),
      skipped_unavailable: skipped,
      totals,
      delivery: calc.delivery,
      promo: calc.promo,
      promo_rejection: calc.promo_rejection,
      bonus: calc.bonus,
      // 3.7: «Акция 11.11: −X сум», the same lines the order will freeze
      campaigns: calc.snapshot.campaigns ?? [],
      problems,
      payment_options,
      can_place: problems.length === 0 && !codBlocked,
    };
  }

  /** 3.3: the code of this checkout — sent by the app, else (cart checkout) the one saved in the cart; '' = none. */
  /** 3.10-А: «Списать бонусы» — sent by the app, else (cart checkout) the switch of the cart. */
  private useBonusOf(dto: OrderPreviewDto, cartBonus: boolean): boolean {
    if (dto.use_bonus !== undefined) return dto.use_bonus;
    return dto.source === 'cart' && cartBonus;
  }

  private promoCodeOf(dto: OrderPreviewDto, cartPromo: string | null): string | null {
    if (dto.promo_code !== undefined) return dto.promo_code.trim() || null;
    return dto.source === 'cart' ? cartPromo : null;
  }

  /**
   * Release 1: «Оплата при получении» — only for the city of Tashkent and up to the limit from the settings (none by
   * default). Returns 'ok' or why not: 'region' / 'limit' / 'off' (the payment method row is missing or disabled).
   */
  private async codAvailable(db: Tx | PrismaService, regionId: string, totalUzs: number): Promise<'ok' | 'region' | 'limit' | 'off'> {
    const method = await db.payment_methods.findUnique({ where: { code: COD_METHOD } });
    if (!method || method.status !== 'enabled') return 'off';
    if (!(await this.delivery.isTashkent(regionId, db))) return 'region';
    const max = (await this.settings.getOrDefault('checkout_options')).cod_max_total_uzs;
    if (max != null && totalUzs > max) return 'limit';
    return 'ok';
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
    await this.legal.assertAccepted(userId);

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        await tx.idempotency_keys.create({
          data: { key, scope: 'order.create', request_hash: requestHash, expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS) },
        });
        const view = await this.createInTx(tx, userId, dto);
        await tx.idempotency_keys.update({ where: { key }, data: { response_json: view as unknown as Prisma.InputJsonValue } });
        return view;
      }, TX_OPTIONS);
      await this.analytics.track(userId, 'order_created', { order_id: order.id, total_uzs: order.totals.total_uzs });
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
        include: {
          _count: { select: { items: true } },
          payments: { orderBy: { created_at: 'desc' }, include: { manual: true, method: { select: { code: true } } } },
          items: { select: { source: true, arrived_at: true, cross_border_batch: { select: { stage: true } }, supplier: { select: SUPPLIER_TERMS_SELECT } } },
        },
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
        payment_method: o.payments[0]?.method.code ?? null,
        // "Я оплатил(а)" pressed and not confirmed yet -> shown as "🔵 Оплата проверяется"
        payment_reported: o.payment_status === 'payment_pending' && o.payments.some((p) => p.manual.some((m) => m.customer_confirmed_at)),
        // D-60: a paid order waiting for the USA shows its stage («Отправлен из США») instead of «Оплачен»
        cross_border_stage: o.status === 'paid' ? crossBorderStageOf(o) : null,
        /** D-61: «Заказан в США» or «Заказан у поставщика» */
        cross_border_from: o.status === 'paid' ? cbMarkOf(o) : null,
      })),
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(userId: string, orderId: string) {
    const order = await this.prisma.orders.findFirst({ where: { id: orderId, user_id: userId }, include: orderViewInclude });
    if (!order) throw new NotFoundException('Order not found');
    const view = toOrderView(order);
    // D-60/D-61: a paid (or, with payment on delivery, confirmed) «под заказ» order — may the customer cancel it by
    // themselves now, and from which day by the guarantee of its supplier
    let crossBorderCancel: { allowed: boolean; reason: string | null; guarantee_date: string | null } | null = null;
    const since = cancelBase(order);
    if (view.cross_border && since) {
      const s = orderTermsOf(order);
      const rule = customerCancel({ status: order.status, paid_at: since, stage: view.cross_border.stage }, s);
      crossBorderCancel = { allowed: rule.allowed, reason: rule.allowed ? rule.reason : null, guarantee_date: isoDay(guaranteeDate(since, s)) };
    }
    // Current delivery term for the order's city (working days).
    return {
      ...view,
      can_cancel: view.can_cancel || !!crossBorderCancel?.allowed,
      cross_border_cancel: crossBorderCancel,
      delivery_eta: await this.delivery.eta(order.region_id, order.city_id),
      intake_guide: await this.intakeGuide(order),
    };
  }

  /**
   * 3.2: «Как принимать ваш заказ» in the order card — after the payment (or the cash-on-delivery confirmation),
   * the same lines the bot sends. null before that or when no product has a memo.
   */
  private async intakeGuide(order: { status: OrderStatus; items: { product_id: string }[] }): Promise<IntakeGuide | null> {
    if (!GUIDE_STATUSES.includes(order.status)) return null;
    const products = await this.prisma.products.findMany({
      where: { id: { in: order.items.map((i) => i.product_id) } },
      select: { id: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true, intake_memo_ru: true, intake_memo_uz: true },
    });
    const ru = intakeGuideItems(products, 'ru');
    return ru.length ? { ru, uz: intakeGuideItems(products, 'uz'), footer: INTAKE_FOOTER } : null;
  }

  /**
   * 3.2: the plaque on the home screen — the newest unfinished order and how many more there are.
   * delivery_eta: the delivery term of the order's district (working days).
   */
  async active(userId: string) {
    const where = { user_id: userId, status: { in: ACTIVE_STATUSES } };
    const [count, o] = await this.prisma.$transaction([
      this.prisma.orders.count({ where }),
      this.prisma.orders.findFirst({
        where,
        orderBy: { created_at: 'desc' },
        include: {
          payments: { orderBy: { created_at: 'desc' }, include: { manual: true, method: { select: { code: true } } } },
          items: { select: { source: true, arrived_at: true, cross_border_batch: { select: { stage: true } }, supplier: { select: SUPPLIER_TERMS_SELECT } } },
        },
      }),
    ]);
    if (!o) return { order: null, more: 0 };
    const reported = o.payment_status === 'payment_pending' && o.payments.some((p) => p.manual.some((m) => m.customer_confirmed_at));
    return {
      order: {
        id: o.id,
        order_number: o.order_number,
        status: o.status,
        payment_method: o.payments[0]?.method.code ?? null,
        payment_reported: reported,
        // «Оплатить / Отправить чек»: the order waits for a transfer and the customer has not reported it yet
        can_pay: o.status === 'awaiting_payment' && !reported,
        cross_border_stage: o.status === 'paid' ? crossBorderStageOf(o) : null,
        cross_border_from: o.status === 'paid' ? cbMarkOf(o) : null,
        expected_to: o.expected_to ? o.expected_to.toISOString().slice(0, 10) : null,
        delivery_eta: await this.delivery.eta(o.region_id, o.city_id),
      },
      more: count - 1,
    };
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
      const reported = await tx.manual_payment_confirmations.count({ where: { payment: { order_id: orderId }, customer_confirmed_at: { not: null } } });
      if (reported && CUSTOMER_CANCELLABLE.includes(order.status)) {
        throw new ConflictException({ code: 'PAYMENT_BEING_CHECKED', message: 'The payment is being checked; please contact support to cancel' });
      }
      if (order.status === 'paid') {
        await this.cancelCrossBorderPaid(tx, order, userId, reason);
        return toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));
      }
      await this.lifecycle.cancelUnpaid(tx, order, { type: 'customer', id: userId }, reason || 'Cancelled by customer');
      return toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));
    }, TX_OPTIONS);
  }

  /**
   * D-60: a paid order «из США» — the customer cancels it by themselves while nothing was ordered in the USA, or after
   * the guarantee term without the jars in Tashkent. The money is returned by staff (a refund task, as for any paid
   * order); any other paid order is cancelled only via support (409 ORDER_NOT_CANCELLABLE).
   */
  private async cancelCrossBorderPaid(tx: Tx, order: Awaited<ReturnType<OrderLifecycleService['lockOrder']>>, userId: string, reason?: string) {
    const full = await tx.orders.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        items: { select: { source: true, arrived_at: true, cross_border_batch: { select: { stage: true } }, supplier: { select: SUPPLIER_TERMS_SELECT } } },
        history: { where: { to_status: 'paid' }, select: { to_status: true, created_at: true }, take: 1 },
      },
    });
    const s = orderTermsOf(full);
    const since = cancelBase(full);
    const rule = customerCancel({ status: full.status, paid_at: since, stage: crossBorderStageOf(full) }, s);
    if (!rule.allowed) {
      throw new ConflictException({ code: 'ORDER_NOT_CANCELLABLE', message: 'Paid orders cannot be cancelled by the customer; please contact support' });
    }
    const where = s.foreign ? `${s.from_ru ?? 'из-за рубежа'}` : 'у поставщика';
    const why = rule.reason === 'guarantee' ? `прошло ${s.guarantee_days} дней, товара нет на складе (гарантия)` : `до заказа ${s.foreign ? 'за рубежом' : 'у поставщика'}`;
    await this.lifecycle.cancelPaid(tx, order, null, `Клиент отменил заказ под заказ (${where}): ${why}${reason ? `. Комментарий: ${reason}` : ''}`, {
      actor: { type: 'customer', id: userId },
      shownReason: CB_CUSTOMER_CANCEL_REASON_CODE,
      // payment on delivery (D-61, a local supplier): nothing was paid, nothing to return
      refundNote: full.paid_at
        ? `Вернуть клиенту ${formatUzs(Number(full.total_uzs))} сум: клиент сам отменил оплаченный заказ ${order.order_number} под заказ (${where}; ${why}). Payme — через кабинет Payme Business, перевод — переводом.`
        : undefined,
    });
  }

  /**
   * Payment instruction for a manual transfer: card number + recipient (card_transfer) or bank
   * requisites (bank_transfer), the amount and the hint; all from admin settings.
   */
  async bankTransferDetails(userId: string, orderId: string) {
    const order = await this.get(userId, orderId);
    const method = order.payment?.method;
    if (!isManualMethod(method)) {
      throw new ConflictException({ code: 'NOT_BANK_TRANSFER', message: 'Order is not paid by a manual transfer' });
    }
    const details = await this.settings.get<BankTransferDetails>(SETTING_KEYS.bankTransferDetails);
    if (method === 'bank_transfer' && !details) throw new ServiceUnavailableException('Bank transfer details are not configured');
    const purpose = (details?.purpose_template ?? 'Оплата заказа {order_number}').replace('{order_number}', order.order_number);
    const requisites = method === 'bank_transfer' && details ? (({ purpose_template: _, ...r }) => r)(details) : null;
    const card = method === 'card_transfer' ? await this.settings.getOrDefault('card_transfer_details') : null;
    // 3.1: «Отправить скриншот чека в бот» (card transfer only) and the last receipt's fate (a rejection shows its reason)
    const last = await this.prisma.payment_receipts.findFirst({ where: { order_id: orderId }, orderBy: { created_at: 'desc' } });

    return {
      method,
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      amount_uzs: order.totals.total_uzs,
      purpose,
      requisites,
      // Release 1: the card holder's name is never shown to customers, only the number.
      card: card && { card_number: card.card_number },
      hint: await this.settings.getOrDefault('payment_hint'),
      pay_until: order.reserved_until,
      customer_reported_paid_at: order.payment!.customer_reported_paid_at,
      delivery_eta: order.delivery_eta,
      receipt: {
        bot_url: method === 'card_transfer' ? await this.botInfo.receiptLink(orderId) : null,
        last: last && { status: last.status, reject_reason: last.reject_reason, created_at: last.created_at },
      },
    };
  }

  /** "Я оплатил": records the claim and creates a manager task. Repeated clicks change nothing. */
  async reportBankTransferPaid(userId: string, orderId: string, receiptUrl?: string, opts: { notifyStaff?: boolean } = {}): Promise<OrderView> {
    let marked = false;
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lockOrder(tx, orderId);
      if (order.user_id !== userId) throw new NotFoundException('Order not found');
      const view = async () => toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));

      if (order.payment_status === 'payment_success') return view();
      if (order.status === 'cancelled') throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Order is cancelled' });
      if (order.reserved_until && order.reserved_until <= new Date()) {
        throw new ConflictException({ code: 'RESERVATION_EXPIRED', message: 'Payment time is over; the order will be cancelled' });
      }

      const payment = await tx.payments.findFirst({
        where: { order_id: orderId, status: 'payment_pending', method: { code: { in: [...MANUAL_PAYMENT_METHODS] } } },
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
      // 3.1: a receipt sent to the bot reaches the staff with its own buttons, so no second text message
      if (opts.notifyStaff !== false) await this.notifications.toOrderStaff(tx, 'staff.customer_paid', orderId);
      marked = true;
      return view();
    }, TX_OPTIONS);
    if (marked) await this.analytics.track(userId, 'payment_marked', { order_id: orderId });
    return result;
  }

  private async createInTx(tx: Tx, userId: string, dto: CreateOrderDto): Promise<OrderView> {
    const { lines, cartId, cartPromo, cartBonus } = await this.resolveLines(tx, userId, dto);
    const method = await this.resolvePaymentMethod(tx, dto.payment_method, userId);
    const orderId = randomUUID();

    // D-60/D-61: a line with nothing in Tashkent and «под заказ» possible reserves nothing: its jars come from the supplier.
    const orderable = await this.stock.orderable(lines.map((l) => l.product_id), MAX_LINE_QTY, tx);
    const crossBorderIds = new Set(lines.filter((l) => orderable.get(l.product_id)?.cross_border).map((l) => l.product_id));
    const underTerms = lines.map((l) => orderable.get(l.product_id)?.terms).filter((t): t is SupplyTerms => !!t);

    // 1. Stock first: all-or-nothing, throws 409 INSUFFICIENT_STOCK and rolls the whole order back.
    await this.stock.reserve(tx, orderId, lines.filter((l) => !crossBorderIds.has(l.product_id)));

    // 2. Prices are read on the server, inside the transaction, and frozen into the order.
    //    3.3: the promo row is locked here, so parallel orders never exceed its limits.
    const priced = await this.priceLines(tx, lines);
    const code = this.promoCodeOf(dto, cartPromo);
    const calc = await this.promo.calculate(tx, userId, priced, { address: dto, code, lock: true, useBonus: this.useBonusOf(dto, cartBonus) });
    const totals = calc.totals;
    if (calc.promo_rejection) {
      const r = calc.promo_rejection;
      throw new ConflictException({ code: 'PROMO_REJECTED', promo_code: r.code, reason: r.reason, message_ru: r.message_ru, message_uz: r.message_uz, message: 'The promo code does not fit this order' });
    }
    if (dto.expected_total_uzs != null && dto.expected_total_uzs !== totals.total_uzs) {
      throw new ConflictException({
        code: 'PRICE_CHANGED',
        message: 'Prices or delivery changed; please review the order again',
        expected_total_uzs: dto.expected_total_uzs,
        actual_total_uzs: totals.total_uzs,
      });
    }

    // Cash on delivery: no transfer to wait for, so no payment deadline — the order waits for the manager's
    // confirmation in «Новый» («Ожидает подтверждения менеджером») and is never cancelled automatically.
    const cod = method.code === COD_METHOD;
    // D-61: from abroad — prepayment only; a local supplier allows payment on delivery
    if (cod && underTerms.some((t) => t.kind === 'foreign')) {
      throw new UnprocessableEntityException({ code: 'CROSS_BORDER_PREPAY_ONLY', message: 'Products from abroad are ordered with prepayment only' });
    }
    if (cod) {
      const why = await this.codAvailable(tx, dto.region_id, totals.total_uzs);
      if (why !== 'ok') {
        throw new UnprocessableEntityException({ code: 'COD_UNAVAILABLE', reason: why, message: 'Cash on delivery is available only in Tashkent (and up to the limit)' });
      }
    }
    if (method.code === PAYME_METHOD) {
      const gaps = await paymeReceiptGaps(tx, lines.map((l) => l.product_id), totals.delivery_cost_uzs);
      if (gaps.skus.length || gaps.delivery) {
        throw new UnprocessableEntityException({
          code: 'PAYME_RECEIPT_INCOMPLETE',
          skus: gaps.skus,
          delivery: gaps.delivery,
          message: 'Payme needs an IKPU code for every product of the order; choose another payment method',
        });
      }
    }

    const now = new Date();
    const orderNumber = await this.nextOrderNumber(tx, now);
    // D-60: the promised window (the longest supplier); counted again from the payment (CrossBorderService.onPaid)
    const terms = combineTerms(underTerms);
    const window = terms ? expectedWindow(now, terms) : null;
    await tx.orders.create({
      data: {
        id: orderId,
        order_number: orderNumber,
        user_id: userId,
        status: cod ? 'new' : 'awaiting_payment',
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
        // 3.10-А: the cashback percent is frozen with the prices (accrued after «Доставлен»)
        bonus_rate_snapshot: calc.bonus.cashback_pct > 0 ? new Prisma.Decimal(calc.bonus.cashback_pct).div(100) : null,
        goods_paid_uzs: BigInt(totals.goods_paid_uzs),
        total_uzs: BigInt(totals.total_uzs),
        promo_id: calc.applied?.promotion_id ?? null,
        promo_code: calc.promo?.code ?? null,
        pricing_json: calc.snapshot as unknown as Prisma.InputJsonValue,
        expected_from: window?.expected_from ?? null,
        expected_to: window?.expected_to ?? null,
        created_at: now,
        reserved_until: cod ? null : new Date(now.getTime() + method.timeout_minutes * 60_000),
        items: {
          create: priced.map((l) => {
            const s = calc.snapshot.lines.find((x) => x.product_id === l.product_id)!;
            return {
              product_id: l.product_id,
              sku_snapshot: l.sku,
              name_ru_snapshot: l.name_ru,
              qty: l.qty,
              unit_price_uzs: BigInt(l.unit_price_uzs),
              line_total_uzs: BigInt(l.line_total_uzs),
              discount_uzs: BigInt(s.promo_discount_uzs),
              // the basis of a refund: what the customer really paid for the line
              paid_line_total_uzs: BigInt(s.paid_line_total_uzs),
              source: crossBorderIds.has(l.product_id) ? 'cross_border' : 'local',
              supplier_id: orderable.get(l.product_id)?.terms?.supplier_id ?? null,
            };
          }),
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

    // 3.10-А: the spent bonuses leave the account with the order; a cancellation or a return gives them back
    await this.bonus.redeem(tx, userId, orderId, totals.bonus_used_uzs, orderNumber);

    // 3.3: the activation is held by the order; any cancellation gives it back (OrderLifecycleService.addHistory)
    if (calc.promo && calc.applied) {
      await tx.promotion_usages.create({
        data: { promotion_id: calc.applied.promotion_id, user_id: userId, order_id: orderId, discount_uzs: BigInt(calc.promo.discount_uzs), status: 'reserved' },
      });
    }

    const customer = { type: 'customer' as const, id: userId };
    if (cod) {
      await this.lifecycle.addHistory(tx, orderId, null, 'new', customer, `Order created. Payment method: ${method.code}`, now);
    } else {
      await this.lifecycle.addHistory(tx, orderId, null, 'new', customer, 'Order created', now);
      await this.lifecycle.addHistory(tx, orderId, 'new', 'awaiting_payment', customer, `Payment method: ${method.code}`, new Date(now.getTime() + 1));
    }
    await this.notifications.toOrderStaff(tx, 'staff.new_order', orderId);

    // "Купить сейчас" never touches the cart; a cart checkout removes only the ordered lines (and the used code).
    if (cartId) {
      await tx.cart_items.deleteMany({ where: { cart_id: cartId, product_id: { in: lines.map((l) => l.product_id) } } });
      if (calc.promo) await tx.carts.update({ where: { id: cartId }, data: { promo_code: null } });
    }

    return toOrderView(await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderViewInclude }));
  }

  /** Cart checkout takes sellable lines only; out-of-stock / archived lines stay in the cart (TZ §6). */
  private async resolveLines(db: Tx | PrismaService, userId: string, dto: OrderPreviewDto) {
    if (dto.source === 'buy_now') {
      return { lines: [{ product_id: dto.buy_now!.product_id, qty: dto.buy_now!.qty }] as StockLine[], skipped: [] as string[], cartId: null, cartPromo: null, cartBonus: false };
    }
    const cart = await db.carts.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { items: { include: { product: { select: { status: true } } } } },
    });
    const items = cart?.items ?? [];
    const available = await this.stock.orderable(items.map((i) => i.product_id), MAX_LINE_QTY, db);
    const sellable = items.filter((i) => i.product.status === 'active' && (available.get(i.product_id)?.qty ?? 0) > 0);
    if (!sellable.length) {
      throw new UnprocessableEntityException({ code: 'EMPTY_ORDER', message: 'There is nothing available to order in the cart' });
    }
    return {
      lines: sellable.map((i) => ({ product_id: i.product_id, qty: i.qty })),
      skipped: items.filter((i) => !sellable.includes(i)).map((i) => i.product_id),
      cartId: cart!.id,
      cartPromo: cart!.promo_code,
      cartBonus: cart!.use_bonus,
    };
  }

  /** 3.7: a product in a running sale is charged its sale price; the price is frozen into the order at this moment. */
  private async priceLines(db: Tx | PrismaService, lines: StockLine[]): Promise<PricedLine[]> {
    const products = await db.products.findMany({ where: { id: { in: lines.map((l) => l.product_id) }, status: 'active' }, include: { media: listInclude.media } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const sale = await this.campaigns.running(db, lines.map((l) => l.product_id));
    return lines.map((l) => {
      const p = byId.get(l.product_id);
      if (!p) throw new ConflictException({ code: 'PRODUCT_UNAVAILABLE', message: 'Product is no longer sold', product_id: l.product_id });
      const c = sale.get(p.id);
      const price = c ? c.price_uzs : Number(p.price_uzs);
      return {
        product_id: p.id,
        sku: p.sku,
        name_ru: p.name_ru,
        name_uz: p.name_uz,
        short_name_ru: p.short_name_ru,
        short_name_uz: p.short_name_uz,
        form: p.form,
        image_url: listImage(p.media[0])?.webp ?? null,
        qty: l.qty,
        unit_price_uzs: price,
        line_total_uzs: price * l.qty,
        list_price_uzs: c ? c.list_price_uzs : price,
        campaign: c ? toShopCampaign(c) : null,
      };
    });
  }

  /** Payme in «Тест — только сотрудники»: is this customer staff? Asked only in that mode. */
  private async paymeStaff(db: Tx | PrismaService, checkoutOptions: Parameters<typeof onlineModes>[0], userId: string) {
    return onlineModes(checkoutOptions).payme === 'test' && (await isStaffCustomer(db, userId));
  }

  private async resolvePaymentMethod(db: Tx | PrismaService, code: string, userId: string) {
    const method = await db.payment_methods.findUnique({ where: { code } });
    // Payme: its row stays as it is; the switch is «Работает» (or «Тест» for staff) in Настройки → Оплата (+ the keys in .env)
    if (method && code === PAYME_METHOD) {
      const checkoutOptions = await this.settings.getOrDefault('checkout_options');
      if (paymeSwitchedOn(checkoutOptions, await this.paymeStaff(db, checkoutOptions, userId))) return method;
    }
    if (!method || method.status !== 'enabled' || !(isManualMethod(code) || code === COD_METHOD)) {
      // Click / Uzum are not connected yet.
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
