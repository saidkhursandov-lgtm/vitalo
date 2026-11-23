import { createHash, timingSafeEqual } from 'crypto';

/**
 * Click settings (SHOP API + Merchant API). Everything comes from .env; the secret key never leaves it.
 *   CLICK_SERVICE_ID       — the service id from merchant.click.uz (in the payment link and in every Click request);
 *   CLICK_MERCHANT_ID      — the supplier id (in the payment link);
 *   CLICK_SECRET_KEY       — the secret key: checks Click's signature (sign_string) and signs our Merchant API calls;
 *   CLICK_MERCHANT_USER_ID — the Merchant API user: sends the fiscal receipt (ofd_data/submit_items);
 *   CLICK_FISCAL_TIN       — optional: ИНН for CommissionInfo of every receipt line (Click marks it required);
 *   CLICK_API_BASE         — optional, for tests: the Merchant API address (default https://api.click.uz/v2/merchant).
 * The receipt codes are the shop's own, shared with Payme: PAYME_DELIVERY_IKPU, PAYME_DELIVERY_PACKAGE_CODE, PAYME_VAT_PERCENT.
 */
export interface ClickConfig {
  serviceId: string;
  merchantId: string;
  secretKey: string;
  merchantUserId: string;
  fiscalTin: string | null;
  apiBase: string;
}

export const CLICK_PAY_URL = 'https://my.click.uz/services/pay';
export const CLICK_API_DEFAULT = 'https://api.click.uz/v2/merchant';

/** Click's Prepare → Complete is quick (the customer is on Click's page); the reservation waits this long for Complete. */
export const CLICK_PREPARE_HOLD_MS = 30 * 60_000;

export function clickConfig(env: NodeJS.ProcessEnv = process.env): ClickConfig {
  return {
    serviceId: env.CLICK_SERVICE_ID?.trim() ?? '',
    merchantId: env.CLICK_MERCHANT_ID?.trim() ?? '',
    secretKey: env.CLICK_SECRET_KEY?.trim() ?? '',
    merchantUserId: env.CLICK_MERCHANT_USER_ID?.trim() ?? '',
    fiscalTin: env.CLICK_FISCAL_TIN?.trim() || null,
    apiBase: (env.CLICK_API_BASE?.trim() || CLICK_API_DEFAULT).replace(/\/$/, ''),
  };
}

/** merchant_trans_id / transaction_param: the digits of the order number, as for Payme (VTL-20261103-0001 -> 202611030001). */
export const clickAccount = (orderNumber: string) => orderNumber.replace(/\D/g, '');

/** Click's amount format N.NN (сум). */
export const clickAmount = (uzs: number) => uzs.toFixed(2);

/**
 * The customer's payment page (docs.click.uz «Платежная ссылка»):
 * my.click.uz/services/pay?service_id&merchant_id&amount&transaction_param&return_url.
 */
export function clickPayUrl(cfg: Pick<ClickConfig, 'serviceId' | 'merchantId'>, p: { orderNumber: string; amountUzs: number; returnUrl?: string | null }): string {
  const q = new URLSearchParams({
    service_id: cfg.serviceId,
    merchant_id: cfg.merchantId,
    amount: clickAmount(p.amountUzs),
    transaction_param: clickAccount(p.orderNumber),
  });
  if (p.returnUrl) q.set('return_url', p.returnUrl);
  return `${CLICK_PAY_URL}?${q.toString()}`;
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** The fields of a Prepare / Complete request that the signature covers — exactly as Click sent them (strings). */
export interface ClickSignFields {
  click_trans_id: string;
  service_id: string;
  merchant_trans_id: string;
  merchant_prepare_id?: string; // Complete only
  amount: string;
  action: string;
  sign_time: string;
}

/**
 * Prepare:  md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)
 * Complete: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
 */
export function clickSign(f: ClickSignFields, secretKey: string): string {
  return md5(f.click_trans_id + f.service_id + secretKey + f.merchant_trans_id + (f.merchant_prepare_id ?? '') + f.amount + f.action + f.sign_time);
}

/** The signature is right (compared in constant time). No secret key in .env = nothing is accepted. */
export function clickSignValid(f: ClickSignFields, given: string, secretKey: string): boolean {
  if (!secretKey || !/^[0-9a-f]{32}$/i.test(given)) return false;
  const want = Buffer.from(clickSign(f, secretKey), 'utf8');
  const got = Buffer.from(given.toLowerCase(), 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Merchant API header Auth: merchant_user_id:sha1(timestamp + secret_key):timestamp (UNIX seconds). */
export function clickMerchantAuth(cfg: Pick<ClickConfig, 'merchantUserId' | 'secretKey'>, nowMs = Date.now()): string {
  const ts = Math.floor(nowMs / 1000);
  const digest = createHash('sha1').update(`${ts}${cfg.secretKey}`, 'utf8').digest('hex');
  return `${cfg.merchantUserId}:${digest}:${ts}`;
}
