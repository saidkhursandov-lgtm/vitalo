/**
 * Stage 2.1: online payment systems (D-20). Nothing is connected yet: every system is shown as «Скоро» or hidden.
 * A system can be switched to «Работает» only when BOTH are true:
 *   1) its keys are in the server .env (names below; values never leave .env);
 *   2) its module (an OnlinePaymentGateway) is registered in OnlinePaymentsModule.
 */
export const ONLINE_PROVIDERS = ['payme', 'click', 'uzum'] as const;
export type OnlineProvider = (typeof ONLINE_PROVIDERS)[number];

/** hidden = not shown at checkout; soon = shown, a tap explains it is coming; live = a real payment method. */
export const ONLINE_MODES = ['hidden', 'soon', 'live'] as const;
export type OnlineMode = (typeof ONLINE_MODES)[number];
export type OnlineModes = Record<OnlineProvider, OnlineMode>;

/** D-20: until an admin saves the switches, all three are shown as «Скоро». */
export const ONLINE_MODES_DEFAULT: OnlineModes = { payme: 'soon', click: 'soon', uzum: 'soon' };

export const PROVIDER_NAMES: Record<OnlineProvider, string> = { payme: 'Payme', click: 'Click', uzum: 'Uzum' };

/** .env keys each system needs (empty fields in .env.example). */
export const PROVIDER_ENV_KEYS: Record<OnlineProvider, readonly string[]> = {
  payme: ['PAYME_MERCHANT_ID', 'PAYME_KEY'],
  click: ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY'],
  uzum: ['UZUM_SERVICE_ID', 'UZUM_SECRET'],
};

export const isOnlineProvider = (v: string): v is OnlineProvider => (ONLINE_PROVIDERS as readonly string[]).includes(v);

/** Only says whether every key is filled in; never returns the values. */
export function providerKeysPresent(p: OnlineProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  return PROVIDER_ENV_KEYS[p].every((k) => !!env[k]?.trim());
}

/**
 * Old setting (release 1) had one switch show_online_soon; 2.1 keeps a mode per system in checkout_options.online.
 * A value saved before 2.1 has no `online` -> the D-20 default (all «Скоро»).
 */
export function onlineModes(saved: { online?: Partial<OnlineModes> | null } | null | undefined): OnlineModes {
  const out = { ...ONLINE_MODES_DEFAULT };
  for (const p of ONLINE_PROVIDERS) {
    const m = saved?.online?.[p];
    if (m && (ONLINE_MODES as readonly string[]).includes(m)) out[p] = m;
  }
  return out;
}

/** What a system module returns when a payment is created: the page the customer is sent to. */
export interface CreatedOnlinePayment {
  /** Payme: unknown until Payme creates its transaction (CreateTransaction) */
  providerPaymentId?: string;
  checkoutUrl: string;
  expiresAt?: Date;
}

/** A confirmation (callback) from a payment system, already checked (signature, amount) by its module. */
export type CallbackOutcome =
  | { kind: 'paid'; providerPaymentId: string }
  | { kind: 'cancelled'; providerPaymentId: string }
  | { kind: 'ignored' };

export interface CallbackReply {
  /** HTTP status and body exactly as the payment system expects them */
  status: number;
  body: unknown;
  outcome: CallbackOutcome;
}

/**
 * One module per payment system (Payme, Click, Uzum) implements this. The order of steps is the same for all:
 * create a payment -> send the customer to checkoutUrl -> accept the system's confirmation -> mark the order paid.
 */
export interface OnlinePaymentGateway {
  readonly provider: OnlineProvider;
  createPayment(input: { paymentId: string; orderNumber: string; amountUzs: number; lang: 'ru' | 'uz' }): Promise<CreatedOnlinePayment>;
  /** Checks the signature and the amount; must not trust anything in the request before that. */
  handleCallback(input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: Buffer }): Promise<CallbackReply>;
}

/** DI token: the list of registered system modules (Payme). */
export const ONLINE_GATEWAYS = Symbol('ONLINE_GATEWAYS');
