/**
 * Payme (Merchant API) settings. Everything comes from .env; the key never leaves it (not in the DB, logs or answers).
 *   PAYME_MERCHANT_ID — the cash desk id from Payme Business (it is also in the customer's payment link);
 *   PAYME_KEY         — the cash desk key: the test key while PAYME_TEST_MODE=true, the live key after;
 *   PAYME_TEST_MODE   — true: links go to the Payme sandbox (checkout.test.paycom.uz);
 *   PAYME_DELIVERY_IKPU, PAYME_DELIVERY_PACKAGE_CODE — the receipt line «Доставка» (ИКПУ of the delivery service);
 *   PAYME_VAT_PERCENT — VAT in the receipt for every line (0 when the shop does not pay VAT).
 */
export interface PaymeConfig {
  merchantId: string;
  key: string;
  testMode: boolean;
  checkoutBase: string;
  deliveryIkpu: string | null;
  deliveryPackageCode: string | null;
  vatPercent: number;
}

export const PAYME_CHECKOUT_LIVE = 'https://checkout.paycom.uz';
export const PAYME_CHECKOUT_TEST = 'https://checkout.test.paycom.uz';

/** Payme's rule: a created transaction that was not performed within 12 hours is cancelled (reason 4). */
export const PAYME_TX_TIMEOUT_MS = 12 * 3600_000;

const yes = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
const opt = (v: string | undefined) => v?.trim() || null;

export function paymeConfig(env: NodeJS.ProcessEnv = process.env): PaymeConfig {
  const testMode = yes(env.PAYME_TEST_MODE);
  const vat = Number(env.PAYME_VAT_PERCENT ?? 0);
  return {
    merchantId: env.PAYME_MERCHANT_ID?.trim() ?? '',
    key: env.PAYME_KEY?.trim() ?? '',
    testMode,
    checkoutBase: testMode ? PAYME_CHECKOUT_TEST : PAYME_CHECKOUT_LIVE,
    deliveryIkpu: opt(env.PAYME_DELIVERY_IKPU),
    deliveryPackageCode: opt(env.PAYME_DELIVERY_PACKAGE_CODE),
    vatPercent: Number.isFinite(vat) && vat >= 0 && vat <= 100 ? vat : 0,
  };
}

/**
 * The customer's payment page: base + base64("m=…;ac.order_id=…;a=…;l=…;c=…"). The amount is in tiyin (сум × 100);
 * c = where Payme sends the customer back after paying (the order screen of the Mini App).
 */
export function paymeCheckoutUrl(
  cfg: Pick<PaymeConfig, 'merchantId' | 'checkoutBase'>,
  p: { orderNumber: string; amountUzs: number; lang: 'ru' | 'uz'; returnUrl?: string | null },
): string {
  const parts = [`m=${cfg.merchantId}`, `ac.order_id=${p.orderNumber}`, `a=${Math.round(p.amountUzs * 100)}`, `l=${p.lang}`];
  if (p.returnUrl) parts.push(`c=${p.returnUrl}`);
  return `${cfg.checkoutBase}/${Buffer.from(parts.join(';'), 'utf8').toString('base64')}`;
}
