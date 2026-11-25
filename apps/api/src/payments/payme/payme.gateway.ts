import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BotInfoService } from '../../orders/receipts';
import type { CallbackReply, CreatedOnlinePayment, OnlinePaymentGateway } from '../online/online-providers';
import { paymeCheckoutUrl, paymeConfig } from './payme-config';
import { PAYME_STATE, PaymeService } from './payme.service';

/** Payme's cancel reason 3 «ошибка выполнения транзакции»: we cancel it ourselves when the customer picks another way to pay. */
export const PAYME_REASON_METHOD_CHANGED = 3;

/**
 * Payme in the common online payment flow (OnlinePaymentsService): the payment link needs no call to Payme — it is
 * built from the merchant id, the order number and the amount. Confirmations come to POST /api/payments/payme
 * (PaymeController); the common address /payments/online/payme/callback answers the same way.
 */
@Injectable()
export class PaymeGateway implements OnlinePaymentGateway {
  readonly provider = 'payme' as const;

  constructor(
    private readonly payme: PaymeService,
    private readonly bot: BotInfoService,
  ) {}

  async createPayment(input: { paymentId: string; orderNumber: string; amountUzs: number; lang: 'ru' | 'uz'; returnUrl?: string | null }): Promise<CreatedOnlinePayment> {
    const username = input.returnUrl ? null : await this.bot.username();
    // after paying, Payme sends the customer back to the site order page (paid on vitalo.uz) or to the shop bot
    const returnUrl = input.returnUrl ?? (username ? `https://t.me/${username}` : null);
    return { checkoutUrl: paymeCheckoutUrl(paymeConfig(), { orderNumber: input.orderNumber, amountUzs: input.amountUzs, lang: input.lang, returnUrl }) };
  }

  async handleCallback(input: { headers: Record<string, string | string[] | undefined>; body: unknown }): Promise<CallbackReply> {
    const auth = input.headers.authorization;
    const body = await this.payme.handle(Array.isArray(auth) ? auth[0] : auth, input.body);
    return { status: 200, body, outcome: { kind: 'ignored' } }; // PaymeService has already done everything
  }

  /**
   * Another way to pay: a created (not yet performed) Payme transaction is cancelled with reason 3 — a late
   * PerformTransaction then gets −31008 and Payme releases the held money.
   */
  async abandon(tx: Prisma.TransactionClient, orderId: string, at: Date): Promise<number> {
    const r = await tx.payme_transactions.updateMany({
      where: { order_id: orderId, state: PAYME_STATE.created },
      data: { state: PAYME_STATE.cancelled, cancel_time: BigInt(at.getTime()), reason: PAYME_REASON_METHOD_CHANGED },
    });
    return r.count;
  }
}
