/**
 * Stage 2D: one order of getBusinessOrders, checked and reduced to what the sync needs. Anything malformed is a
 * «битый ответ» (BAD_DATA) for this order only — it never breaks the other orders of the batch.
 */
import { tashkentDateString } from '../../common/tashkent';

export interface ParsedYandexItem {
  offerId: string; // = our SKU (OZN-A001)
  offerName: string | null;
  count: number;
  /**
   * Price per unit for us: (payment + cashback + subsidy) / count, whole UZS (S2D-2). Yandex gives the three
   * as totals for all units of the item. null when Yandex sent no prices.
   */
  unitPrice: number | null;
  /** currency of the prices; we accept only UZS */
  currency: string | null;
}

export interface ParsedYandexOrder {
  externalNumber: string;
  orderId: number;
  campaignId: number;
  status: string;
  substatus: string | null;
  orderDate: string; // YYYY-MM-DD
  updatedAt: Date | null;
  fake: boolean;
  cancelRequested: boolean;
  items: ParsedYandexItem[];
}

export type ParseResult =
  | { ok: true; order: ParsedYandexOrder }
  | { ok: false; reason: string; externalNumber: string | null; campaignId: number | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function money(v: unknown): { value: number; currency: string | null } | null {
  if (!isObj(v)) return null;
  const value = num(v.value);
  return value === null ? null : { value, currency: str(v.currencyId) };
}

export function parseYandexOrder(raw: unknown): ParseResult {
  if (!isObj(raw)) return { ok: false, reason: 'заказ — не объект', externalNumber: null, campaignId: null };
  const orderId = num(raw.orderId);
  const campaignId = num(raw.campaignId);
  const externalNumber = orderId !== null && Number.isInteger(orderId) && orderId > 0 ? String(orderId) : null;
  const bad = (reason: string): ParseResult => ({ ok: false, reason, externalNumber, campaignId });
  if (!externalNumber) return bad('нет номера заказа (orderId)');
  if (campaignId === null) return bad('нет кампании (campaignId)');
  const status = str(raw.status);
  if (!status) return bad('нет статуса');
  if (!Array.isArray(raw.items) || !raw.items.length) return bad('нет товаров (items)');

  const items: ParsedYandexItem[] = [];
  for (const it of raw.items) {
    if (!isObj(it)) return bad('товар — не объект');
    const offerId = str(it.offerId);
    const count = num(it.count);
    if (!offerId) return bad('у товара нет offerId (SKU)');
    if (count === null || !Number.isInteger(count) || count <= 0) return bad(`${offerId}: неверное количество`);
    const prices = isObj(it.prices) ? it.prices : null;
    const payment = prices ? money(prices.payment) : null;
    const parts = [payment, prices ? money(prices.cashback) : null, prices ? money(prices.subsidy) : null].filter((x): x is { value: number; currency: string | null } => !!x);
    const currencies = [...new Set(parts.map((p) => p.currency).filter(Boolean))];
    items.push({
      offerId,
      offerName: str(it.offerName),
      count,
      unitPrice: payment ? Math.round(parts.reduce((s, p) => s + p.value, 0) / count) : null,
      currency: currencies.length === 1 ? currencies[0] : currencies.length ? currencies.join('+') : null,
    });
  }

  const created = str(raw.creationDate);
  const updated = str(raw.updateDate);
  const updatedAt = updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated) : null;
  // the date part as Yandex wrote it (Moscow / Tashkent offsets keep the same day for our use)
  const orderDate = created && /^\d{4}-\d{2}-\d{2}/.test(created) ? created.slice(0, 10) : tashkentDateString(new Date());
  return {
    ok: true,
    order: {
      externalNumber,
      orderId: orderId!,
      campaignId,
      status,
      substatus: str(raw.substatus),
      orderDate,
      updatedAt,
      fake: raw.fake === true,
      cancelRequested: raw.cancelRequested === true,
      items,
    },
  };
}

/** Not confirmed yet: wait for the next poll (S2D-A). */
export const WAIT_STATUSES = ['PLACING', 'RESERVED', 'UNPAID', 'PENDING'];
/** The only status our order is created from (S2D-A). */
export const CREATE_STATUS = 'PROCESSING';
/** First seen in one of these: not created automatically, «Требует внимания» (S2D-A). */
export const LATE_STATUSES = ['DELIVERY', 'PICKUP', 'DELIVERED', 'CANCELLED', 'RETURNED', 'PARTIALLY_RETURNED'];
/** Yandex returns: shown, «Требует внимания», no automatic change (S2D-B). */
export const RETURN_STATUSES = ['RETURNED', 'PARTIALLY_RETURNED'];

export const YANDEX_STATUS_RU: Record<string, string> = {
  PLACING: 'Оформляется',
  RESERVED: 'Зарезервирован',
  UNPAID: 'Не оплачен',
  PENDING: 'Ожидает',
  PROCESSING: 'В обработке',
  DELIVERY: 'Передан в доставку',
  PICKUP: 'В пункте выдачи',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
  RETURNED: 'Возвращён',
  PARTIALLY_RETURNED: 'Частично возвращён',
  UNKNOWN: 'Неизвестно',
};

export const yandexStatusRu = (status: string, substatus?: string | null) =>
  `${YANDEX_STATUS_RU[status] ?? status}${substatus ? ` (${substatus})` : ''}`;

export const ATTENTION_KINDS = ['UNKNOWN_SKU', 'NOT_UNIT_TRACKED', 'NOT_ENOUGH_STOCK', 'FIRST_SEEN_LATE', 'RETURN', 'UNKNOWN_STATUS', 'BAD_DATA', 'CURRENCY'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_RU: Record<AttentionKind, string> = {
  UNKNOWN_SKU: 'Неизвестный SKU',
  NOT_UNIT_TRACKED: 'Товар без учёта по банкам',
  NOT_ENOUGH_STOCK: 'Не хватает остатка',
  FIRST_SEEN_LATE: 'Впервые увиден уже отгруженным или отменённым',
  RETURN: 'Возврат в Яндексе',
  UNKNOWN_STATUS: 'Неизвестный статус Яндекса',
  BAD_DATA: 'Битый ответ Яндекса',
  CURRENCY: 'Цена не в сумах',
};

/**
 * What of a Yandex order is ever stored (snapshot, run log): a WHITE LIST — the number, campaign, statuses, dates,
 * flags and the items with their amounts and currency. Everything else is dropped BEFORE saving, above all the
 * customer: `buyer`, `delivery` (address, recipient, phones), `notes` (free text of the buyer) and any field
 * Yandex may add later. Personal data never reaches the database, the run log or Telegram.
 */
export function minimizeYandexOrder(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) return { invalid: true };
  const pick = (src: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
  const amount = (v: unknown) => (isObj(v) ? pick(v, ['value', 'currencyId']) : undefined);
  const prices = (v: unknown) => {
    if (!isObj(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of ['payment', 'subsidy', 'cashback']) if (amount(v[k])) out[k] = amount(v[k]);
    if (typeof v.vat === 'string') out.vat = v.vat;
    return out;
  };
  return {
    ...pick(raw, ['orderId', 'campaignId', 'programType', 'status', 'substatus', 'creationDate', 'updateDate', 'fake', 'cancelRequested', 'paymentType', 'paymentMethod', 'sourcePlatform']),
    ...(isObj(raw.prices) && { prices: prices(raw.prices) }),
    items: Array.isArray(raw.items)
      ? raw.items.map((it) => (isObj(it) ? { ...pick(it, ['id', 'offerId', 'offerName', 'count']), ...(isObj(it.prices) && { prices: prices(it.prices) }) } : { invalid: true }))
      : raw.items === undefined
        ? undefined
        : { invalid: true },
  };
}
