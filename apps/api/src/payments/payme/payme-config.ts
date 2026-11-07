/**
 * Payme (Merchant API) settings. Everything comes from .env; the key never leaves it (not in the DB, logs or answers).
 *   PAYME_MERCHANT_ID — the cash desk id from Payme Business (it is also in the customer's payment link);
 *   PAYME_KEY         — the cash desk key: the test key while PAYME_TEST_MODE=true, the live key after;
 *   PAYME_TEST_MODE   — true: links go to the Payme sandbox (test.paycom.uz, as in Payme docs «Песочница»);
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
/** Payme docs («Песочница»): «URL отправки чека в песочницу: https://test.paycom.uz» (checkout.test.paycom.uz answers «Поставщик не найден»). */
export const PAYME_CHECKOUT_TEST = 'https://test.paycom.uz';

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
 * Payme's account field `order_id` takes digits only (as agreed with Payme): VTL-20261103-0001 -> 202611030001,
 * the same digits the customer sees in the order number.
 */
export const paymeAccount = (orderNumber: string) => orderNumber.replace(/\D/g, '');

/** Back from Payme: 202611030001 -> VTL-20261103-0001; the full number is accepted too. Null = not an order number. */
export function orderNumberFromAccount(value: string): string | null {
  const v = value.trim().toUpperCase();
  const digits = /^(\d{8})(\d{4,})$/.exec(v);
  if (digits) return `VTL-${digits[1]}-${digits[2]}`;
  return /^VTL-\d{8}-\d{4,}$/.test(v) ? v : null;
}

/**
 * The customer's payment page: base + base64("m=…;ac.order_id=…;a=…;l=…;c=…"). The amount is in tiyin (сум × 100);
 * c = where Payme sends the customer back after paying (the order screen of the Mini App).
 */
export function paymeCheckoutUrl(
  cfg: Pick<PaymeConfig, 'merchantId' | 'checkoutBase'>,
  p: { orderNumber: string; amountUzs: number; lang: 'ru' | 'uz'; returnUrl?: string | null },
): string {
  const parts = [`m=${cfg.merchantId}`, `ac.order_id=${paymeAccount(p.orderNumber)}`, `a=${Math.round(p.amountUzs * 100)}`, `l=${p.lang}`];
  if (p.returnUrl) parts.push(`c=${p.returnUrl}`);
  return `${cfg.checkoutBase}/${Buffer.from(parts.join(';'), 'utf8').toString('base64')}`;
}
