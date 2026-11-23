import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { OrderLifecycleService } from '../../orders/order-lifecycle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { orderNumberFromAccount, paymeConfig } from '../payme/payme-config';
import { fiscalGaps, type FiscalOrder } from '../payme/payme-fiscal';
import { clickConfig, clickMerchantAuth, clickSignValid, type ClickSignFields } from './click-config';
import { CLICK_ERRORS, CLICK_STATE, type ClickStatus } from './click-errors';
import { clickFiscalItems, type ClickFiscalBody } from './click-fiscal';

type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };
/** A fiscal receipt Click did not accept is sent again (every 10 minutes) up to this many times. */
const FISCAL_MAX_ATTEMPTS = 10;

/** The answer to Click: always HTTP 200 with this JSON. */
export type ClickReply = Record<string, string | number>;

interface Parsed {
  sign: ClickSignFields;
  signString: string;
  clickTransId: bigint;
  clickPaydocId: bigint;
  serviceId: string;
  merchantTransId: string;
  amountTiyin: bigint;
  action: number;
  error: number;
  errorNote: string;
  prepareId?: number;
}

/**
 * Click SHOP API (docs.click.uz): Click calls our server twice for one payment, form-urlencoded, answer JSON:
 *   Prepare  (action 0) POST /api/payments/click/prepare  — can this order be paid with this amount? We store the
 *            transaction and answer merchant_prepare_id (the row id);
 *   Complete (action 1) POST /api/payments/click/complete — the money is taken (error 0): the order becomes «Оплачен»;
 *            or Click failed (error < 0): the transaction is cancelled, the order keeps waiting.
 * Every request is signed: sign_string = md5(… + SECRET_KEY + …). Repeated calls get the same answer (the same
 * click_trans_id → the same row). After a payment the fiscal receipt goes to Click (Merchant API ofd_data/submit_items).
 */
@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  async prepare(body: unknown): Promise<ClickReply> {
    return this.safely(body, 0, (p) => this.doPrepare(p));
  }

  async complete(body: unknown): Promise<ClickReply> {
    const reply = await this.safely(body, 1, (p) => this.doComplete(p));
    if (reply.error === 0 && typeof reply.merchant_confirm_id === 'number') void this.sendFiscal(reply.merchant_confirm_id);
    return reply;
  }

  /** Both actions through one address (the common /payments/online/click/callback): by `action`. */
  async handle(body: unknown): Promise<ClickReply> {
    const action = String((body as Body | null)?.action ?? '');
    if (action === '0') return this.prepare(body);
    if (action === '1') return this.complete(body);
    return { ...CLICK_ERRORS.actionNotFound };
  }

  /** Checks the request and the signature first, then runs the action; nothing unexpected reaches Click. */
  private async safely(body: unknown, action: 0 | 1, run: (p: Parsed) => Promise<ClickReply>): Promise<ClickReply> {
    const b = (body && typeof body === 'object' ? body : {}) as Body;
    const echo = { click_trans_id: str(b.click_trans_id), merchant_trans_id: str(b.merchant_trans_id) };
    try {
      const p = this.parse(b, action);
      if (!('sign' in p)) return { ...echo, ...p };
      return await run(p);
    } catch (e) {
      this.logger.error(`Click ${action === 0 ? 'Prepare' : 'Complete'} failed: ${(e as Error).message}`);
      return { ...echo, ...CLICK_ERRORS.updateFailed };
    }
  }

  private parse(b: Body, action: 0 | 1): Parsed | ClickStatus {
    const cfg = clickConfig();
    const f = {
      click_trans_id: str(b.click_trans_id),
      service_id: str(b.service_id),
      click_paydoc_id: str(b.click_paydoc_id),
      merchant_trans_id: str(b.merchant_trans_id),
      merchant_prepare_id: str(b.merchant_prepare_id),
      amount: str(b.amount),
      action: str(b.action),
      error: str(b.error),
      sign_time: str(b.sign_time),
      sign_string: str(b.sign_string),
    };
    const required = ['click_trans_id', 'service_id', 'click_paydoc_id', 'merchant_trans_id', 'amount', 'action', 'error', 'sign_time', 'sign_string'] as const;
    if (required.some((k) => !f[k]) || (action === 1 && !f.merchant_prepare_id)) return CLICK_ERRORS.badRequest;
    if (!/^\d+$/.test(f.click_trans_id) || !/^\d+$/.test(f.click_paydoc_id) || !/^-?\d+$/.test(f.error)) return CLICK_ERRORS.badRequest;

    const sign: ClickSignFields = {
      click_trans_id: f.click_trans_id,
      service_id: f.service_id,
      merchant_trans_id: f.merchant_trans_id,
      ...(action === 1 && { merchant_prepare_id: f.merchant_prepare_id }),
      amount: f.amount,
      action: f.action,
      sign_time: f.sign_time,
    };
    if (!clickSignValid(sign, f.sign_string, cfg.secretKey)) return CLICK_ERRORS.signFailed;
    if (f.action !== String(action)) return CLICK_ERRORS.actionNotFound;
    if (f.service_id !== cfg.serviceId) return CLICK_ERRORS.badRequest;

    const amount = Number(f.amount);
    if (!/^\d+(\.\d{1,2})?$/.test(f.amount) || !Number.isFinite(amount) || amount <= 0) return CLICK_ERRORS.wrongAmount;
    if (action === 1 && !/^\d+$/.test(f.merchant_prepare_id)) return CLICK_ERRORS.txNotFound;
    return {
      sign,
      signString: f.sign_string,
      clickTransId: BigInt(f.click_trans_id),
      clickPaydocId: BigInt(f.click_paydoc_id),
      serviceId: f.service_id,
      merchantTransId: f.merchant_trans_id,
      amountTiyin: BigInt(Math.round(amount * 100)),
      action,
      error: Number(f.error),
      errorNote: str(b.error_note).slice(0, 500),
      prepareId: action === 1 ? Number(f.merchant_prepare_id) : undefined,
    };
  }

  // ───────────── Prepare ─────────────

  private async doPrepare(p: Parsed): Promise<ClickReply> {
    const echo = { click_trans_id: p.sign.click_trans_id, merchant_trans_id: p.merchantTransId };
    const answer = (s: ClickStatus, prepareId?: number): ClickReply => ({ ...echo, ...(prepareId !== undefined && { merchant_prepare_id: prepareId }), ...s });

    const orderNumber = orderNumberFromAccount(p.merchantTransId);
    const order = orderNumber ? await this.prisma.orders.findUnique({ where: { order_number: orderNumber }, select: { id: true } }) : null;
    if (!order) return answer(CLICK_ERRORS.orderNotFound);
    // Click itself says the payment failed before it reached us: nothing to prepare
    if (p.error < 0) return answer(CLICK_ERRORS.cancelled);

    return this.prisma.$transaction(async (tx) => {
      const o = await this.lifecycle.lockOrder(tx, order.id);
      const again = await tx.click_transactions.findUnique({ where: { click_trans_id: p.clickTransId } });
      if (again) {
        // the same Prepare again: the same answer
        if (again.order_id !== o.id) return answer(CLICK_ERRORS.badRequest);
        if (again.amount_tiyin !== p.amountTiyin) return answer(CLICK_ERRORS.wrongAmount);
        if (again.state === CLICK_STATE.completed) return answer(CLICK_ERRORS.alreadyPaid);
        if (again.state === CLICK_STATE.cancelled) return answer(CLICK_ERRORS.cancelled);
        return answer(CLICK_ERRORS.success, again.id);
      }

      if (o.payment_status === 'payment_success') return answer(CLICK_ERRORS.alreadyPaid);
      // cancelled, or its payment time is over: Click is told «cancelled»
      const timeOver = o.reserved_until !== null && o.reserved_until < new Date();
      if (o.status !== 'awaiting_payment' || o.payment_status !== 'payment_pending' || timeOver) return answer(CLICK_ERRORS.cancelled);
      const payment = await this.pendingPayment(tx, o.id);
      if (!payment) return answer(CLICK_ERRORS.orderNotFound); // the order does not wait for a Click payment
      const { total_uzs } = await tx.orders.findUniqueOrThrow({ where: { id: o.id }, select: { total_uzs: true } });
      if (p.amountTiyin !== total_uzs * 100n) return answer(CLICK_ERRORS.wrongAmount);
      if (!fiscalGaps(await this.fiscalOrder(tx, o.id), paymeConfig()).ok) return answer(CLICK_ERRORS.updateFailed);

      const row = await tx.click_transactions.create({
        data: {
          click_trans_id: p.clickTransId,
          click_paydoc_id: p.clickPaydocId,
          order_id: o.id,
          payment_id: payment.id,
          amount_tiyin: p.amountTiyin,
          state: CLICK_STATE.prepared,
          sign_time: p.sign.sign_time,
        },
      });
      await tx.payment_attempts.updateMany({ where: { payment_id: payment.id, status: 'pending' }, data: { provider_request_id: p.sign.click_trans_id } });
      return answer(CLICK_ERRORS.success, row.id);
    }, TX_OPTIONS);
  }

  // ───────────── Complete ─────────────

  private async doComplete(p: Parsed): Promise<ClickReply> {
    const echo = { click_trans_id: p.sign.click_trans_id, merchant_trans_id: p.merchantTransId };
    const answer = (s: ClickStatus, confirmId?: number): ClickReply => ({ ...echo, ...(confirmId !== undefined && { merchant_confirm_id: confirmId }), ...s });

    const row = await this.prisma.click_transactions.findUnique({ where: { id: p.prepareId! } });
    if (!row || row.click_trans_id !== p.clickTransId) return answer(CLICK_ERRORS.txNotFound);
    const order = await this.prisma.orders.findUnique({ where: { id: row.order_id }, select: { order_number: true } });
    if (!order || orderNumberFromAccount(p.merchantTransId) !== order.order_number) return answer(CLICK_ERRORS.orderNotFound);

    return this.prisma.$transaction(async (tx) => {
      const o = await this.lifecycle.lockOrder(tx, row.order_id);
      const t = await tx.click_transactions.findUniqueOrThrow({ where: { id: row.id } });
      if (t.state === CLICK_STATE.completed) return answer(CLICK_ERRORS.alreadyPaid, t.id);
      if (t.state === CLICK_STATE.cancelled) return answer(CLICK_ERRORS.cancelled);
      if (t.amount_tiyin !== p.amountTiyin) return answer(CLICK_ERRORS.wrongAmount);

      const cancel = (why: { error?: number; note?: string }) =>
        tx.click_transactions.update({
          where: { id: t.id },
          data: { state: CLICK_STATE.cancelled, cancelled_at: new Date(), click_error: why.error ?? null, click_error_note: why.note ?? null },
        });

      // Click could not take the money (error < 0): the order keeps waiting, the customer may pay again
      if (p.error < 0) {
        await cancel({ error: p.error, note: p.errorNote || undefined });
        return answer(CLICK_ERRORS.cancelled);
      }
      // paid meanwhile another way (Payme, a transfer confirmed by a manager)
      if (o.payment_status === 'payment_success') {
        await cancel({ note: 'order already paid' });
        return answer(CLICK_ERRORS.alreadyPaid);
      }
      // cancelled meanwhile (the customer, a manager): Click is told «cancelled» and returns the money (SHOP API: -9)
      if (o.status !== 'awaiting_payment' || o.payment_status !== 'payment_pending') {
        await cancel({ note: `order ${o.status}` });
        return answer(CLICK_ERRORS.cancelled);
      }

      const payment = t.payment_id ? { id: t.payment_id } : await this.pendingPayment(tx, o.id);
      if (!payment) {
        await cancel({ note: 'no pending Click payment' });
        return answer(CLICK_ERRORS.cancelled);
      }
      // one payment row per order: the Click transaction that paid is its provider id
      await tx.payments.update({ where: { id: payment.id }, data: { provider_payment_id: p.sign.click_trans_id } });
      await this.lifecycle.confirmOnlinePayment(tx, o, payment.id);
      await tx.click_transactions.update({ where: { id: t.id }, data: { state: CLICK_STATE.completed, completed_at: new Date(), payment_id: payment.id } });
      return answer(CLICK_ERRORS.success, t.id);
    }, TX_OPTIONS);
  }

  // ───────────── fiscal receipt ─────────────

  /**
   * Sends the receipt of a paid Click transaction to Click (Merchant API ofd_data/submit_items); Click passes it on
   * to the tax office. Never throws: a failure is stored (fiscal_status = failed) and sent again by retryFiscal.
   */
  async sendFiscal(txId: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    try {
      const cfg = clickConfig();
      const t = await this.prisma.click_transactions.findUnique({ where: { id: txId } });
      if (!t || t.state !== CLICK_STATE.completed || t.fiscal_status === 'sent') return false;
      if (!cfg.merchantUserId || !cfg.secretKey) return this.fiscalFailed(txId, 'CLICK_MERCHANT_USER_ID / CLICK_SECRET_KEY are empty');

      const { items, total } = clickFiscalItems(await this.fiscalOrder(this.prisma, t.order_id), paymeConfig(), cfg.fiscalTin);
      const body: ClickFiscalBody = {
        service_id: Number(cfg.serviceId),
        payment_id: Number(t.click_trans_id),
        items,
        received_ecash: 0,
        received_cash: 0,
        received_card: total,
      };
      const res = await fetchImpl(`${cfg.apiBase}/payment/ofd_data/submit_items`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Auth: clickMerchantAuth(cfg) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const answer = (await res.json().catch(() => null)) as { error_code?: number; error_note?: string } | null;
      if (!res.ok || answer?.error_code !== 0) return this.fiscalFailed(txId, `HTTP ${res.status}: ${answer?.error_code ?? '-'} ${answer?.error_note ?? ''}`.trim());
      await this.prisma.click_transactions.update({
        where: { id: txId },
        data: { fiscal_status: 'sent', fiscal_sent_at: new Date(), fiscal_error: null, fiscal_attempts: { increment: 1 } },
      });
      return true;
    } catch (e) {
      return this.fiscalFailed(txId, (e as Error).message);
    }
  }

  /** Receipts Click did not accept yet: sent again every 10 minutes (up to FISCAL_MAX_ATTEMPTS times). */
  @Interval('click-fiscal-retry', 10 * 60_000)
  async retryFiscal(): Promise<number> {
    const rows = await this.prisma.click_transactions.findMany({
      where: { state: CLICK_STATE.completed, fiscal_status: 'failed', fiscal_attempts: { lt: FISCAL_MAX_ATTEMPTS } },
      select: { id: true },
      take: 20,
    });
    let sent = 0;
    for (const r of rows) if (await this.sendFiscal(r.id)) sent++;
    return sent;
  }

  private async fiscalFailed(txId: number, why: string): Promise<false> {
    this.logger.warn(`Click fiscal receipt for transaction ${txId} not sent: ${why}`);
    await this.prisma.click_transactions
      .update({ where: { id: txId }, data: { fiscal_status: 'failed', fiscal_error: why.slice(0, 500), fiscal_attempts: { increment: 1 } } })
      .catch(() => undefined);
    return false;
  }

  // ───────────── helpers ─────────────

  private pendingPayment(tx: Tx, orderId: string) {
    return tx.payments.findFirst({ where: { order_id: orderId, status: 'payment_pending', method: { code: 'click' } }, select: { id: true } });
  }

  private async fiscalOrder(db: Tx | PrismaService, orderId: string): Promise<FiscalOrder> {
    const order = await db.orders.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { include: { product: { select: { ikpu_code: true, package_code: true } } }, orderBy: { id: 'asc' } } },
    });
    return {
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
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
