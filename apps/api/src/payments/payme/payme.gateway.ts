import { Injectable } from '@nestjs/common';
import { BotInfoService } from '../../orders/receipts';
import type { CallbackReply, CreatedOnlinePayment, OnlinePaymentGateway } from '../online/online-providers';
import { paymeCheckoutUrl, paymeConfig } from './payme-config';
import { PaymeService } from './payme.service';

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

  async createPayment(input: { paymentId: string; orderNumber: string; amountUzs: number; lang: 'ru' | 'uz' }): Promise<CreatedOnlinePayment> {
    const username = await this.bot.username();
    // after paying, Payme sends the customer back to the shop bot (it also brings the «Оплачен» message)
    const returnUrl = username ? `https://t.me/${username}` : null;
    return { checkoutUrl: paymeCheckoutUrl(paymeConfig(), { orderNumber: input.orderNumber, amountUzs: input.amountUzs, lang: input.lang, returnUrl }) };
  }

  async handleCallback(input: { headers: Record<string, string | string[] | undefined>; body: unknown }): Promise<CallbackReply> {
    const auth = input.headers.authorization;
    const body = await this.payme.handle(Array.isArray(auth) ? auth[0] : auth, input.body);
    return { status: 200, body, outcome: { kind: 'ignored' } }; // PaymeService has already done everything
  }
}
