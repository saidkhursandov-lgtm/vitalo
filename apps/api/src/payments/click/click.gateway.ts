import { Injectable } from '@nestjs/common';
import { BotInfoService } from '../../orders/receipts';
import type { CallbackReply, CreatedOnlinePayment, OnlinePaymentGateway } from '../online/online-providers';
import { clickConfig, clickPayUrl } from './click-config';
import { ClickService } from './click.service';

/**
 * Click in the common online payment flow (OnlinePaymentsService): the payment link needs no call to Click — it is
 * built from service_id, merchant_id, the order number and the amount. Click's Prepare / Complete come to
 * /api/payments/click/prepare and /complete (ClickController); the common /payments/online/click/callback answers the same.
 */
@Injectable()
export class ClickGateway implements OnlinePaymentGateway {
  readonly provider = 'click' as const;

  constructor(
    private readonly click: ClickService,
    private readonly bot: BotInfoService,
  ) {}

  async createPayment(input: { paymentId: string; orderNumber: string; amountUzs: number; lang: 'ru' | 'uz'; returnUrl?: string | null }): Promise<CreatedOnlinePayment> {
    const username = input.returnUrl ? null : await this.bot.username();
    // after paying, Click sends the customer back to the site order page (paid on vitalo.uz) or to the shop bot
    const returnUrl = input.returnUrl ?? (username ? `https://t.me/${username}` : null);
    return { checkoutUrl: clickPayUrl(clickConfig(), { orderNumber: input.orderNumber, amountUzs: input.amountUzs, returnUrl }) };
  }

  async handleCallback(input: { body: unknown }): Promise<CallbackReply> {
    return { status: 200, body: await this.click.handle(input.body), outcome: { kind: 'ignored' } }; // ClickService did everything
  }
}
