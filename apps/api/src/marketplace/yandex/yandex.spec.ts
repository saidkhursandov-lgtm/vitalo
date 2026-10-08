import { YandexApiError, YandexMarketClient, type FetchLike } from './yandex-client';
import { minimizeYandexOrder, parseYandexOrder } from './yandex-order';
import { ipInNetworks } from './yandex-sync.controller';
import { scrubSecrets } from './yandex-sync';

/** A token that looks real; it must never appear in an error text. */
const KEY = 'ACMA:unitTestKey0123456789abcdef:12345678';

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | 'network' | 'timeout';

/** Fake fetch: answers from a list, records what was asked. */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const r = replies.shift() ?? { status: 200, body: { orders: [] } };
    if (r === 'network') throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
    if (r === 'timeout') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => r.text ?? JSON.stringify(r.body ?? null) };
  };
  return { fetch, calls };
}

const client = (replies: Reply[], apiKey: string | undefined = KEY) => {
  const f = fakeFetch(replies);
  return { c: new YandexMarketClient({ apiKey, fetch: f.fetch, retryDelaysMs: [0, 0, 0], sleep: async () => undefined }), calls: f.calls };
};

describe('Yandex client (read only)', () => {
  it('POST v1/businesses/{id}/orders with Api-Key, campaigns, update window, no test orders; all pages by pageToken', async () => {
    const { c, calls } = client([
      { status: 200, body: { orders: [{ orderId: 1 }], paging: { nextPageToken: 'p2' } }, headers: { 'X-RateLimit-Resource-Remaining': '9998', 'X-RateLimit-Resource-Limit': '10000' } },
      { status: 200, body: { orders: [{ orderId: 2 }], paging: {} } },
    ]);
    const orders = await c.businessOrders(216755072, { campaignIds: [149165806], updateDateFrom: '2026-10-01T00:00:00.000Z' });
    expect(orders).toEqual([{ orderId: 1 }, { orderId: 2 }]);
    expect(calls[0].url).toBe('https://api.partner.market.yandex.ru/v1/businesses/216755072/orders?limit=50');
    expect(calls[1].url).toContain('pageToken=p2');
    expect(calls[0].headers['Api-Key']).toBe(KEY);
    expect(calls[0].body).toEqual({ campaignIds: [149165806], dates: { updateDateFrom: '2026-10-01T00:00:00.000Z' }, fake: false });
    expect(c.lastRateLimit).toMatchObject({ limit: 10000, remaining: 9998 });
  });

  it('retries with a pause: network, timeout, 5xx and 420 (parallel limit); then succeeds', async () => {
    const { c, calls } = client(['network', 'timeout', { status: 420, body: { status: 'ERROR', errors: [{ code: 'TOO_MANY' }] }, headers: { 'X-RateLimit-Resource-Remaining': '50' } }, { status: 200, body: { orders: [] } }]);
    await expect(c.businessOrdersPage(1, { campaignIds: [1] })).resolves.toEqual({ orders: [], nextPageToken: null });
    expect(calls).toHaveLength(4);
    const five = client([{ status: 500 }, { status: 502 }, { status: 503 }, { status: 500 }]);
    await expect(five.c.businessOrdersPage(1, { campaignIds: [1] })).rejects.toMatchObject({ status: 500 });
    expect(five.calls).toHaveLength(4); // 1 + 3 retries, then the run reports the error
  });

  it('a spent resource limit (420, remaining 0) is not hammered: no retry, clear error', async () => {
    const { c, calls } = client([{ status: 420, body: { status: 'ERROR', errors: [{ code: 'LIMIT', message: 'Hit rate limit of 10000 points per 1 hour' }] }, headers: { 'X-RateLimit-Resource-Remaining': '0', 'X-RateLimit-Resource-Until': 'Sat, 10 Oct 2026 12:00:00 GMT' } }]);
    const e = (await c.businessOrdersPage(1, { campaignIds: [1] }).catch((x) => x)) as YandexApiError;
    expect(e).toMatchObject({ code: 'RATE_LIMIT', status: 420 });
    expect(e.message).toContain('лимит');
    expect(calls).toHaveLength(1);
  });

  it('4xx: understandable Russian error, never the token (even if Yandex echoes it)', async () => {
    const { c } = client([{ status: 401, body: { status: 'ERROR', errors: [{ code: 'UNAUTHORIZED', message: `Bad token ${KEY}` }] } }]);
    const e = (await c.businessOrdersPage(1, { campaignIds: [1] }).catch((x) => x)) as YandexApiError;
    expect(e.message).toContain('не принял токен');
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain('unitTestKey');
    expect(JSON.stringify(e)).not.toContain('unitTestKey');
  });

  it('no token: no request at all; a broken answer is an error', async () => {
    const none = client([], '');
    await expect(none.c.businessOrdersPage(1, { campaignIds: [1] })).rejects.toMatchObject({ code: 'NO_TOKEN' });
    expect(none.calls).toHaveLength(0);
    const broken = client([{ status: 200, text: '<html>oops' }]);
    await expect(broken.c.businessOrdersPage(1, { campaignIds: [1] })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    const noList = client([{ status: 200, body: { result: {} } }]);
    await expect(noList.c.businessOrdersPage(1, { campaignIds: [1] })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('parse a Yandex order', () => {
  const order = (patch: object = {}) => ({
    orderId: 51234567,
    campaignId: 149165806,
    status: 'PROCESSING',
    substatus: 'STARTED',
    creationDate: '2026-10-10T09:15:00+03:00',
    updateDate: '2026-10-10T09:20:00+03:00',
    fake: false,
    items: [{ id: 1, offerId: 'OZN-A001', offerName: 'Омега', count: 2, prices: { payment: { value: 300_000, currencyId: 'UZS' }, cashback: { value: 10_000, currencyId: 'UZS' }, subsidy: { value: 30_001, currencyId: 'UZS' } } }],
    ...patch,
  });

  it('price per unit = (payment + cashback + subsidy) / count — Yandex sends totals for all units', () => {
    const r = parseYandexOrder(order());
    expect(r).toMatchObject({ ok: true, order: { externalNumber: '51234567', campaignId: 149165806, status: 'PROCESSING', orderDate: '2026-10-10', items: [{ offerId: 'OZN-A001', count: 2, unitPrice: 170_001, currency: 'UZS' }] } });
  });

  it('broken data is reported per order, not thrown', () => {
    expect(parseYandexOrder(null)).toMatchObject({ ok: false });
    expect(parseYandexOrder(order({ orderId: 'x' }))).toMatchObject({ ok: false, externalNumber: null });
    expect(parseYandexOrder(order({ items: [] }))).toMatchObject({ ok: false, externalNumber: '51234567', reason: expect.stringContaining('нет товаров') });
    expect(parseYandexOrder(order({ items: [{ offerId: 'OZN-A001', count: 0 }] }))).toMatchObject({ ok: false });
    expect(parseYandexOrder(order({ items: [{ count: 1 }] }))).toMatchObject({ ok: false, reason: expect.stringContaining('offerId') });
    // no prices: allowed here, the card price is used later (or «Требует внимания»)
    expect(parseYandexOrder(order({ items: [{ offerId: 'OZN-A001', count: 1 }] }))).toMatchObject({ ok: true, order: { items: [{ unitPrice: null }] } });
  });
});

describe('personal data never stored (white list)', () => {
  it('keeps number, statuses, dates, flags, items with amounts and currency; drops buyer, delivery, notes and anything new', () => {
    const raw = {
      orderId: 5,
      campaignId: 149165806,
      programType: 'FBS',
      externalOrderId: 'ext-1',
      status: 'PROCESSING',
      substatus: 'STARTED',
      creationDate: '2026-10-10T09:00:00+03:00',
      updateDate: '2026-10-10T09:05:00+03:00',
      fake: false,
      cancelRequested: false,
      paymentType: 'PREPAID',
      paymentMethod: 'YANDEX',
      notes: 'Позвоните +998 90 123 45 67, Анвар',
      buyer: { firstName: 'Анвар', lastName: 'Каримов', phone: '+998901234567', email: 'anvar@example.com' },
      buyerType: 'PERSON',
      delivery: { address: { city: 'Ташкент', street: 'Амира Темура', house: '1', recipient: { name: 'Анвар' }, phone: '+998901234567' }, type: 'DELIVERY' },
      prices: { payment: { value: 300000, currencyId: 'UZS' }, delivery: { payment: { value: 1 } } },
      somethingNew: { phone: '+998' },
      items: [{ id: 1, offerId: 'OZN-A001', offerName: 'Омега', count: 2, prices: { payment: { value: 300000, currencyId: 'UZS' }, subsidy: { value: 1, currencyId: 'UZS' }, vat: 'NO_VAT' }, instances: [{ cis: 'x' }], tags: ['A'] }],
    };
    const min = minimizeYandexOrder(raw);
    expect(min).toEqual({
      orderId: 5,
      campaignId: 149165806,
      programType: 'FBS',
      status: 'PROCESSING',
      substatus: 'STARTED',
      creationDate: '2026-10-10T09:00:00+03:00',
      updateDate: '2026-10-10T09:05:00+03:00',
      fake: false,
      cancelRequested: false,
      paymentType: 'PREPAID',
      paymentMethod: 'YANDEX',
      prices: { payment: { value: 300000, currencyId: 'UZS' } },
      items: [{ id: 1, offerId: 'OZN-A001', offerName: 'Омега', count: 2, prices: { payment: { value: 300000, currencyId: 'UZS' }, subsidy: { value: 1, currencyId: 'UZS' }, vat: 'NO_VAT' } }],
    });
    const text = JSON.stringify(min);
    for (const pii of ['Анвар', 'Каримов', '998', 'example.com', 'Ташкент', 'Темура', 'buyer', 'delivery', 'notes', 'externalOrderId']) expect(text).not.toContain(pii);
    // the stored copy still parses to the same order
    expect(parseYandexOrder(min)).toMatchObject({ ok: true, order: { externalNumber: '5', items: [{ unitPrice: 150001 }] } });
    expect(minimizeYandexOrder('x')).toEqual({ invalid: true });
  });
});

describe('notifications: sender check and secrets', () => {
  it('only Yandex networks', () => {
    expect(ipInNetworks('5.45.207.10')).toBe(true);
    expect(ipInNetworks('141.8.142.127')).toBe(true);
    expect(ipInNetworks('::ffff:5.255.253.1')).toBe(true);
    expect(ipInNetworks('141.8.142.128')).toBe(false); // outside /25
    expect(ipInNetworks('127.0.0.1')).toBe(false);
    expect(ipInNetworks('::1')).toBe(false);
  });

  it('secrets are cut out of any text, order numbers stay', () => {
    const t = scrubSecrets(`order 51234567 failed with ${KEY} and webhook-secret-0123456789`, [KEY, 'webhook-secret-0123456789']);
    expect(t).toBe('order 51234567 failed with [скрыто] and [скрыто]');
    expect(scrubSecrets('key ACMA:abc:def', [])).toBe('key [скрыто]');
  });
});
