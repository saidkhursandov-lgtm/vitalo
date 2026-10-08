/**
 * Stage 2D: Yandex Market Partner API client — READ ONLY (S2D-3). The only method used is
 * POST /v1/businesses/{businessId}/orders (getBusinessOrders: a read despite POST; the campaign-level
 * GET v2/campaigns/{id}/orders is deprecated and switched off on 12.04.2027).
 *
 * - Auth: header `Api-Key: <token>`. The token is never part of an error text, a log line or a stored answer.
 * - Timeout per request, retries with a pause on network errors, 5xx and 420 (parallel limit); a spent resource
 *   limit (420 with X-RateLimit-Resource-Remaining: 0) is not retried, the run stops with a clear error.
 * - Errors: Yandex answers { status: "ERROR", errors: [{ code, message }] }.
 */

export const YANDEX_API_BASE = 'https://api.partner.market.yandex.ru';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class YandexApiError extends Error {
  constructor(
    /** HTTP status, or 0 for a network error / timeout */
    public readonly status: number,
    /** Yandex error code (e.g. UNAUTHORIZED) or ours: NO_TOKEN, RATE_LIMIT, TIMEOUT, NETWORK, BAD_RESPONSE */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'YandexApiError';
  }
}

export interface BusinessOrdersFilter {
  campaignIds: number[];
  /** ISO date-time: orders changed since then (creation, status, cancellation) */
  updateDateFrom?: string;
  orderIds?: number[];
  /** test orders of Yandex are not taken (they would reserve real units) */
  fake?: boolean;
}

export interface BusinessOrdersPage {
  orders: unknown[];
  nextPageToken: string | null;
}

export interface YandexClientOptions {
  apiKey: string | undefined;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** pauses before the 2nd, 3rd … attempt */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const PAGE_LIMIT = 50; // the maximum of the method
const MAX_PAGES = 100; // 5 000 orders per run: far above what a poll of a few days returns

export class YandexMarketClient {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly delays: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  /** From the last answer: what is left of the resource limit (shown on the sync screen) */
  lastRateLimit: { limit: number | null; remaining: number | null; until: string | null } | null = null;

  constructor(private readonly opts: YandexClientOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
    this.baseUrl = (opts.baseUrl ?? YANDEX_API_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.delays = opts.retryDelaysMs ?? [2_000, 10_000, 30_000];
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One page of orders of the business, filtered by campaigns and the update date. */
  async businessOrdersPage(businessId: number, filter: BusinessOrdersFilter, pageToken?: string | null): Promise<BusinessOrdersPage> {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(pageToken && { pageToken }) });
    const body = {
      campaignIds: filter.campaignIds,
      ...(filter.orderIds?.length && { orderIds: filter.orderIds }),
      ...(filter.updateDateFrom && { dates: { updateDateFrom: filter.updateDateFrom } }),
      fake: filter.fake ?? false,
    };
    const json = await this.request('POST', `/v1/businesses/${businessId}/orders?${query}`, body);
    const res = json as { orders?: unknown; paging?: { nextPageToken?: unknown } };
    if (!res || !Array.isArray(res.orders)) throw new YandexApiError(200, 'BAD_RESPONSE', 'Яндекс вернул ответ без списка orders');
    const next = res.paging?.nextPageToken;
    return { orders: res.orders, nextPageToken: typeof next === 'string' && next ? next : null };
  }

  /** Every page (pageToken), at most MAX_PAGES. */
  async businessOrders(businessId: number, filter: BusinessOrdersFilter): Promise<unknown[]> {
    const all: unknown[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.businessOrdersPage(businessId, filter, token);
      all.push(...res.orders);
      if (!res.nextPageToken) return all;
      token = res.nextPageToken;
    }
    throw new YandexApiError(200, 'TOO_MANY_PAGES', `Больше ${MAX_PAGES} страниц заказов за один запуск — уменьшите период опроса`);
  }

  private async request(method: string, path: string, body: object): Promise<unknown> {
    if (!this.opts.apiKey) throw new YandexApiError(0, 'NO_TOKEN', 'Токен Яндекса не задан (переменная YANDEX_API_KEY в apps/api/.env)');
    let last: YandexApiError | null = null;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      if (attempt > 0) await this.sleep(this.delays[attempt - 1]);
      try {
        return await this.once(method, path, body);
      } catch (e) {
        if (!(e instanceof YandexApiError)) throw e;
        last = e;
        const retry = e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.status >= 500 || (e.status === 420 && e.code !== 'RATE_LIMIT');
        if (!retry) throw e;
      }
    }
    throw last!;
  }

  private async once(method: string, path: string, body: object): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Api-Key': this.opts.apiKey!, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      // never the original error text: it could contain request details
      throw new YandexApiError(0, aborted ? 'TIMEOUT' : 'NETWORK', aborted ? `Яндекс не ответил за ${Math.round(this.timeoutMs / 1000)} с` : 'Нет связи с api.partner.market.yandex.ru');
    } finally {
      clearTimeout(timer);
    }
    const limit = res.headers.get('X-RateLimit-Resource-Limit');
    const remaining = res.headers.get('X-RateLimit-Resource-Remaining');
    if (limit !== null || remaining !== null) {
      this.lastRateLimit = { limit: limit === null ? null : Number(limit), remaining: remaining === null ? null : Number(remaining), until: res.headers.get('X-RateLimit-Resource-Until') };
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 200 && res.status < 300) {
      if (json === null) throw new YandexApiError(res.status, 'BAD_RESPONSE', 'Яндекс вернул не JSON');
      return json;
    }
    const err = (json as { errors?: { code?: unknown; message?: unknown }[] } | null)?.errors?.[0];
    const code = typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`;
    const message = this.scrub(typeof err?.message === 'string' ? err.message : '');
    if (res.status === 420 && remaining === '0') {
      throw new YandexApiError(420, 'RATE_LIMIT', `Исчерпан лимит запросов Яндекса${this.lastRateLimit?.until ? ` до ${this.lastRateLimit.until}` : ''}`);
    }
    const human: Record<number, string> = {
      400: 'Яндекс отклонил запрос',
      401: 'Яндекс не принял токен (проверьте YANDEX_API_KEY)',
      403: 'У токена нет доступа к этому кабинету или методу (нужен доступ на чтение заказов)',
      404: 'Кабинет или кампания не найдены (проверьте YANDEX_BUSINESS_ID и YANDEX_CAMPAIGN_IDS)',
      420: 'Слишком много запросов к Яндексу одновременно',
    };
    throw new YandexApiError(res.status, code, `${human[res.status] ?? `Ошибка Яндекса, HTTP ${res.status}`}${message ? `: ${message}` : ''} [${code}]`);
  }

  /** Whatever Yandex says, the token never goes further. */
  private scrub(text: string): string {
    const key = this.opts.apiKey;
    const s = key ? text.split(key).join('[скрыто]') : text;
    return s.replace(/ACMA:[A-Za-z0-9:_-]+/g, '[скрыто]').slice(0, 300);
  }
}
