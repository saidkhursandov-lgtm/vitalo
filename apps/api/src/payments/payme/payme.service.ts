import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PAYME_CANCELLED_REASON_CODE } from '../../notifications/notification-templates';
import { OrderLifecycleService } from '../../orders/order-lifecycle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PAYME_TX_TIMEOUT_MS, paymeConfig } from './payme-config';
import { PAYME_ERRORS, PaymeError, paymeErrors } from './payme-errors';
import { fiscalGaps, paymeReceipt, type FiscalOrder } from './payme-fiscal';

type Tx = Prisma.TransactionClient;
type PaymeTx = Prisma.payme_transactionsGetPayload<object>;

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** Payme transaction states. */
export const PAYME_STATE = { created: 1, performed: 2, cancelled: -1, cancelledAfterPerform: -2 } as const;
/** Payme's cancel reason «transaction timeout» (we cancel it ourselves after 12 hours). */
const REASON_TIMEOUT = 4;
/** After a payment the order can still be cancelled by Payme only before it is handed to delivery. */
const CANCELLABLE_AFTER_PAYMENT = ['paid', 'picking'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
}

type Params = Record<string, unknown>;

/** What a method decided: a result, or an error that must be answered after the transaction is committed. */
type Outcome = { result: unknown } | { error: PaymeError };

/**
 * Payme Merchant API (JSON-RPC 2.0, https://developer.help.paycom.uz): one-time payments for an order, the account is
 * `order_id` = the order number (VTL-…). Payme calls, in this order:
 *   CheckPerformTransaction (can this order be paid with this amount? + the fiscal receipt) →
 *   CreateTransaction (the money is held) → PerformTransaction (paid: the order becomes «Оплачен») —
 *   or CancelTransaction (before: the order keeps waiting; after: the order is cancelled, Payme returns the money).
 * Every method is idempotent: the same Payme `id` gets the same answer. The order row is locked for every change.
 */
@Injectable()
export class PaymeService {
  private readonly logger = new Logger(PaymeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  /** The whole JSON-RPC answer (always HTTP 200, as Payme expects). */
  async handle(authorization: string | undefined, body: unknown): Promise<object> {
    const req = (body && typeof body === 'object' ? body : {}) as JsonRpcRequest;
    const id = req.id ?? null;
    try {
      if (!this.authorized(authorization)) throw paymeErrors.unauthorized();
      if (typeof req.method !== 'string' || !req.params || typeof req.params !== 'object') throw paymeErrors.invalidRequest();
      const outcome = await this.call(req.method, req.params as Params);
      if ('error' in outcome) throw outcome.error;
      return { jsonrpc: '2.0', id, result: outcome.result };
    } catch (e) {
      if (e instanceof PaymeError) return { jsonrpc: '2.0', id, error: { code: e.code, message: e.text, ...(e.data && { data: e.data }) } };
      this.logger.error(`Payme ${String(req.method)} failed: ${(e as Error).message}`);
      return { jsonrpc: '2.0', id, error: { code: PAYME_ERRORS.internal, message: { ru: 'Системная ошибка', uz: 'Tizim xatosi', en: 'System error' } } };
    }
  }

  /** Authorization: Basic base64("Paycom:" + PAYME_KEY). No key in .env = nobody is let in. */
  authorized(header: string | undefined): boolean {
    const { key } = paymeConfig();
    if (!key || !header?.startsWith('Basic ')) return false;
    const got = Buffer.from(header.slice(6).trim(), 'base64');
    const want = Buffer.from(`Paycom:${key}`, 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private call(method: string, p: Params): Promise<Outcome> {
    switch (method) {
      case 'CheckPerformTransaction':
        return this.checkPerform(p);
      case 'CreateTransaction':
        return this.create(p);
      case 'PerformTransaction':
        return this.perform(p);
      case 'CancelTransaction':
        return this.cancel(p);
      case 'CheckTransaction':
        return this.check(p);
      case 'GetStatement':
        return this.statement(p);
      default:
        // ChangePassword included: the key lives only in .env on the server and is changed there by hand.
        throw paymeErrors.methodNotFound(method);
    }
  }

  // ───────────── methods ─────────────

  private async checkPerform(p: Params): Promise<Outcome> {
    const amount = this.amount(p);
    const orderNumber = this.orderNumber(p);
    const order = await this.prisma.orders.findUnique({ where: { order_number: orderNumber }, select: { id: true } });
    if (!order) throw paymeErrors.orderNotFound();
    const fiscal = await this.payable(this.prisma, order.id, amount);
    return { result: { allow: true, detail: paymeReceipt(fiscal, paymeConfig()) } };
  }

  private async create(p: Params): Promise<Outcome> {
    const paymeId = this.paymeId(p);
    const amount = this.amount(p);
    const time = this.number(p.time, 'time');
    const orderNumber = this.orderNumber(p);

    const existing = await this.prisma.payme_transactions.findUnique({ where: { payme_id: paymeId } });
    const orderId = existing?.order_id ?? (await this.prisma.orders.findUnique({ where: { order_number: orderNumber }, select: { id: true } }))?.id;
    if (!orderId) throw paymeErrors.orderNotFound();

    return this.prisma.$transaction(async (tx) => {
      await this.lifecycle.lockOrder(tx, orderId);
      const again = await tx.payme_transactions.findUnique({ where: { payme_id: paymeId } });
      if (again) {
        if (again.state !== PAYME_STATE.created) return { error: paymeErrors.cannotPerform() };
        if (await this.expireIfOld(tx, again)) return { error: paymeErrors.cannotPerform() };
        return { result: { create_time: Number(again.create_time), transaction: again.id, state: again.state } };
      }

      await this.payable(tx, orderId, amount);
      const busy = await tx.payme_transactions.findFirst({ where: { order_id: orderId, state: PAYME_STATE.created } });
      if (busy && !(await this.expireIfOld(tx, busy))) return { error: paymeErrors.orderBusy() };

      const payment = await this.pendingPayment(tx, orderId);
      const now = Date.now();
      const row = await tx.payme_transactions.create({
        data: {
          payme_id: paymeId,
          order_id: orderId,
          payment_id: payment?.id ?? null,
          amount_tiyin: BigInt(amount),
          state: PAYME_STATE.created,
          payme_time: BigInt(time),
          create_time: BigInt(now),
        },
      });
      if (payment) {
        await tx.payments.update({ where: { id: payment.id }, data: { provider_payment_id: paymeId } });
        await tx.payment_attempts.updateMany({ where: { payment_id: payment.id, status: 'pending' }, data: { provider_request_id: paymeId } });
      }
      return { result: { create_time: now, transaction: row.id, state: row.state } };
    }, TX_OPTIONS);
  }

  private async perform(p: Params): Promise<Outcome> {
    const row = await this.find(p);
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lockOrder(tx, row.order_id);
      const t = await tx.payme_transactions.findUniqueOrThrow({ where: { id: row.id } });
      if (t.state === PAYME_STATE.performed) return { result: { transaction: t.id, perform_time: Number(t.perform_time), state: t.state } };
      if (t.state !== PAYME_STATE.created) return { error: paymeErrors.cannotPerform() };
      if (await this.expireIfOld(tx, t)) return { error: paymeErrors.cannotPerform() };
      // cancelled meanwhile (the customer, the reservation, a manager) or paid another way: Payme then cancels
      if (order.status !== 'awaiting_payment' || order.payment_status !== 'payment_pending') return { error: paymeErrors.cannotPerform() };

      const payment = t.payment_id ? { id: t.payment_id } : await this.pendingPayment(tx, order.id);
      if (!payment) return { error: paymeErrors.cannotPerform() };
      await this.lifecycle.confirmOnlinePayment(tx, order, payment.id);
      const now = Date.now();
      await tx.payme_transactions.update({ where: { id: t.id }, data: { state: PAYME_STATE.performed, perform_time: BigInt(now), payment_id: payment.id } });
      return { result: { transaction: t.id, perform_time: now, state: PAYME_STATE.performed } };
    }, TX_OPTIONS);
  }

  private async cancel(p: Params): Promise<Outcome> {
    const row = await this.find(p);
    const reason = this.number(p.reason, 'reason');
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lockOrder(tx, row.order_id);
      const t = await tx.payme_transactions.findUniqueOrThrow({ where: { id: row.id } });
      const answer = (x: PaymeTx) => ({ result: { transaction: x.id, cancel_time: Number(x.cancel_time), state: x.state } });
      if (t.state === PAYME_STATE.cancelled || t.state === PAYME_STATE.cancelledAfterPerform) return answer(t);

      const now = Date.now();
      if (t.state === PAYME_STATE.created) {
        // the money was only held: the order keeps waiting, the customer may pay again or choose another way
        return answer(await tx.payme_transactions.update({ where: { id: t.id }, data: { state: PAYME_STATE.cancelled, cancel_time: BigInt(now), reason } }));
      }

      // performed: Payme returns the money to the customer; the order is cancelled like a paid order (stock back)
      if (!CANCELLABLE_AFTER_PAYMENT.includes(order.status)) return { error: paymeErrors.cannotCancel() };
      const sum = Number(t.amount_tiyin) / 100;
      await this.lifecycle.cancelPaid(tx, order, null, `Payme cancelled the payment (reason ${reason})`, {
        shownReason: PAYME_CANCELLED_REASON_CODE,
        refundNote: `Payme отменил оплату заказа ${order.order_number} (код причины ${reason}) и сам возвращает клиенту ${sum} сум. Заказ отменён, товар вернулся на склад. Проверьте возврат в кабинете Payme Business и закройте задачу.`,
      });
      if (t.payment_id) await tx.payments.update({ where: { id: t.payment_id }, data: { status: 'payment_cancelled' } });
      await tx.orders.update({ where: { id: order.id }, data: { payment_status: 'payment_cancelled' } });
      return answer(await tx.payme_transactions.update({ where: { id: t.id }, data: { state: PAYME_STATE.cancelledAfterPerform, cancel_time: BigInt(now), reason } }));
    }, TX_OPTIONS);
  }

  private async check(p: Params): Promise<Outcome> {
    const t = await this.find(p);
    return {
      result: {
        create_time: Number(t.create_time),
        perform_time: Number(t.perform_time ?? 0),
        cancel_time: Number(t.cancel_time ?? 0),
        transaction: t.id,
        state: t.state,
        reason: t.reason,
      },
    };
  }

  private async statement(p: Params): Promise<Outcome> {
    const from = this.number(p.from, 'from');
    const to = this.number(p.to, 'to');
    const rows = await this.prisma.payme_transactions.findMany({
      where: { payme_time: { gte: BigInt(from), lte: BigInt(to) } },
      include: { order: { select: { order_number: true } } },
      orderBy: { payme_time: 'asc' },
    });
    return {
      result: {
        transactions: rows.map((t) => ({
          id: t.payme_id,
          time: Number(t.payme_time),
          amount: Number(t.amount_tiyin),
          account: { order_id: t.order.order_number },
          create_time: Number(t.create_time),
          perform_time: Number(t.perform_time ?? 0),
          cancel_time: Number(t.cancel_time ?? 0),
          transaction: t.id,
          state: t.state,
          reason: t.reason,
          receivers: null,
        })),
      },
    };
  }

  // ───────────── checks ─────────────

  /**
   * The order can be paid with this amount right now: waits for a Payme payment, its reservation is not over, the
   * amount is the order total in tiyin, and every line has ИКПУ for the receipt. Returns the receipt data.
   */
  private async payable(db: Tx | PrismaService, orderId: string, amount: number): Promise<FiscalOrder> {
    const order = await db.orders.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { include: { product: { select: { ikpu_code: true, package_code: true } } }, orderBy: { id: 'asc' } },
        payments: { where: { status: 'payment_pending', method: { code: 'payme' } }, select: { id: true } },
      },
    });
    const activeTx = await db.payme_transactions.count({ where: { order_id: orderId, state: PAYME_STATE.created } });
    const timeOver = order.reserved_until !== null && order.reserved_until < new Date() && activeTx === 0;
    if (order.status !== 'awaiting_payment' || order.payment_status !== 'payment_pending' || !order.payments.length || timeOver) {
      throw paymeErrors.orderNotPayable();
    }
    if (BigInt(amount) !== order.total_uzs * 100n) throw paymeErrors.wrongAmount();

    const fiscal: FiscalOrder = {
      total_uzs: Number(order.total_uzs),
      delivery_cost_uzs: Number(order.delivery_cost_uzs),
      lines: order.items.map((i) => ({
        sku: i.sku_snapshot,
        title: i.name_ru_snapshot,
        qty: i.qty,
        unit_price_uzs: Number(i.unit_price_uzs),
        line_total_uzs: Number(i.line_total_uzs),
        paid_line_total_uzs: Number(i.paid_line_total_uzs),
        ikpu_code: i.product.ikpu_code,
        package_code: i.product.package_code,
      })),
    };
    if (!fiscalGaps(fiscal, paymeConfig()).ok) throw paymeErrors.orderNoFiscal();
    return fiscal;
  }

  /** Payme's 12-hour rule: an old created transaction is cancelled (reason 4). True = it was too old. */
  private async expireIfOld(tx: Tx, t: PaymeTx): Promise<boolean> {
    if (t.state !== PAYME_STATE.created || Date.now() - Number(t.create_time) <= PAYME_TX_TIMEOUT_MS) return false;
    await tx.payme_transactions.update({ where: { id: t.id }, data: { state: PAYME_STATE.cancelled, cancel_time: BigInt(Date.now()), reason: REASON_TIMEOUT } });
    return true;
  }

  private pendingPayment(tx: Tx, orderId: string) {
    return tx.payments.findFirst({ where: { order_id: orderId, status: 'payment_pending', method: { code: 'payme' } }, select: { id: true } });
  }

  private async find(p: Params): Promise<PaymeTx> {
    const t = await this.prisma.payme_transactions.findUnique({ where: { payme_id: this.paymeId(p) } });
    if (!t) throw paymeErrors.txNotFound();
    return t;
  }

  private paymeId(p: Params): string {
    if (typeof p.id !== 'string' || !p.id.trim() || p.id.length > 64) throw paymeErrors.invalidRequest('id');
    return p.id;
  }

  private amount(p: Params): number {
    const a = p.amount;
    if (typeof a !== 'number' || !Number.isInteger(a) || a <= 0) throw paymeErrors.wrongAmount();
    return a;
  }

  private number(v: unknown, field: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw paymeErrors.invalidRequest(field);
    return v;
  }

  private orderNumber(p: Params): string {
    const account = p.account as { order_id?: unknown } | undefined;
    const value = account?.order_id;
    if (typeof value !== 'string' && typeof value !== 'number') throw paymeErrors.orderNotFound();
    return String(value).trim().toUpperCase();
  }
}
