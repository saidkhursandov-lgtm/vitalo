import { DOSE_PER, DOSE_UNITS, normalizeMatchForm } from '../iherb/iherb-fields';
import { matchOneToOne, PLATFORMS, type MatchResult, type MatchValues } from '../iherb/one-to-one';

/**
 * Генплан, этап 5, ветка admin-ai-analyst (D-57, узел 5): settings, prompts, the answer schema and the checks of the
 * admin AI analyst. The model only reads the owner's text; whether a competitor price is «1-в-1» is decided by our
 * code (matchOneToOne), never by the model, and nothing is written before the owner presses «Сохранить».
 */

export const SETTING_ADMIN_AI = 'admin_ai';
export const ADMIN_AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

export interface AdminAiSettings {
  enabled: boolean;
  model: string;
  monthly_budget_usd: number;
}

/** A stronger model than the customer one by default (plan, node 5); the owner may choose another one. */
export const DEFAULT_ADMIN_AI: AdminAiSettings = { enabled: true, model: 'claude-opus-5-5', monthly_budget_usd: 20 };

export function mergeAdminAiSettings(saved: unknown): AdminAiSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_ADMIN_AI.enabled,
    model: typeof s.model === 'string' && (ADMIN_AI_MODELS as readonly string[]).includes(s.model) ? s.model : DEFAULT_ADMIN_AI.model,
    monthly_budget_usd:
      typeof s.monthly_budget_usd === 'number' && Number.isFinite(s.monthly_budget_usd) && s.monthly_budget_usd >= 0 && s.monthly_budget_usd <= 10_000
        ? s.monthly_budget_usd
        : DEFAULT_ADMIN_AI.monthly_budget_usd,
  };
}

/** $ per 1M tokens (Anthropic first-party prices); a cache write costs 1.25× input, a cache read 0.1× input. */
export const ADMIN_MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

export function adminCostUsd(u: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  // a fallback model we do not know is counted at the dearest known price: the budget errs on the safe side
  const p = ADMIN_MODEL_PRICES[u.model] ?? ADMIN_MODEL_PRICES['claude-fable-5-1'];
  return (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.input * 0.1 + u.outputTokens * p.output) / 1_000_000;
}

// ---------------- «Загрузить данные»: reading the owner's text ----------------

export const FEED_KINDS = ['competitor_price', 'orders', 'bestseller_rank', 'note'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

const str = { type: ['string', 'null'] };
const int = { type: ['integer', 'null'] };

/** What the model returns for a pasted text: one row per fact. */
export const FEED_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'unclear'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'sku', 'platform', 'seller', 'title', 'url', 'price_uzs', 'observed_on', 'brand', 'match_form', 'dose_amount', 'dose_unit', 'dose_per', 'pack_count', 'orders_count', 'bestseller_rank', 'note'],
        properties: {
          kind: { type: 'string', enum: [...FEED_KINDS] },
          sku: str,
          platform: { type: ['string', 'null'], enum: [...PLATFORMS, null] },
          seller: str,
          title: str,
          url: str,
          price_uzs: int,
          observed_on: str,
          brand: str,
          match_form: str,
          dose_amount: { type: ['number', 'null'] },
          dose_unit: { type: ['string', 'null'], enum: [...DOSE_UNITS, null] },
          dose_per: { type: ['string', 'null'], enum: [...DOSE_PER, null] },
          pack_count: int,
          orders_count: int,
          bestseller_rank: int,
          note: str,
        },
      },
    },
    unclear: { type: 'array', items: { type: 'string' } },
  },
};

export const FEED_SYSTEM = `Ты — помощник закупщика интернет-магазина БАДов VITALO (Узбекистан). Владелец вставляет сырой текст: ответ ChatGPT, таблицу, заметки о ценах конкурентов, числе заказов на Uzum, месте товара в бестселлерах iHerb. Твоя задача — только аккуратно разобрать текст на факты. Ничего не выдумывай.

Правила:
- Одна строка rows — один факт. kind: competitor_price (цена у конкурента/поставщика в Узбекистане), orders (сколько заказов/продаж показывает конкурент), bestseller_rank (место в бестселлерах iHerb), note (другое полезное наблюдение, кратко в note).
- sku — артикул нашего товара из списка «Товары VITALO», только если в тексте явно тот же товар (бренд и название). Не уверен — null; не подбирай похожий.
- platform: uzum (Uzum Market), yandex_market, pharmacy (аптека), social (Instagram, Telegram), other (сайт магазина и прочее). seller — название магазина/аптеки.
- Бренд, химическую форму, дозу и количество в банке у конкурента бери ТОЛЬКО из текста о конкуренте. Не копируй их из нашего товара: если в тексте не сказано — null. Сверку «1-в-1» делает программа, а не ты.
- Доза: dose_amount + dose_unit (mg, mcg, iu, g, ml, cfu_bn — млрд КОЕ) + dose_per (capsule, tablet, softgel, serving, drop). Форма — как в тексте, по-русски, строчными (например «цитрат», «бисглицинат», «d3 холекальциферол»).
- price_uzs — цена в сумах целым числом. Цены в долларах или рублях не переводи: такой факт в unclear.
- observed_on — дата наблюдения YYYY-MM-DD, если указана; иначе null.
- orders_count и bestseller_rank — целые числа.
- Всё, что не удалось однозначно понять, кратко опиши в unclear по-русски.`;

/** Our products for the model to find the SKU by (no prices, no costs: it does not need them to read the text). */
export function feedContext(products: { sku: string; name_ru: string; brand: string; match_form: string | null; dose: string | null; pack_count: number | null }[], today: string): string {
  const lines = products.map((p) => [p.sku, p.brand, p.name_ru, p.match_form ?? '', p.dose ?? '', p.pack_count ?? ''].join(' | '));
  return `Сегодня: ${today}\n\nТовары VITALO (артикул | бренд | название | форма | доза | в банке):\n${lines.join('\n')}`;
}

/** One row of the model's answer, as the schema says (values are checked again: never trusted). */
export interface FeedRowRaw {
  kind: string;
  sku: string | null;
  platform: string | null;
  seller: string | null;
  title: string | null;
  url: string | null;
  price_uzs: number | null;
  observed_on: string | null;
  brand: string | null;
  match_form: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  dose_per: string | null;
  pack_count: number | null;
  orders_count: number | null;
  bestseller_rank: number | null;
  note: string | null;
}

export interface FeedProduct extends MatchValues {
  id: string;
  sku: string;
  name_ru: string;
}

/** A row after our checks: what the owner sees in the preview and what «Сохранить» writes. */
export interface FeedRow extends FeedRowRaw {
  index: number;
  kind: FeedKind;
  product: { id: string; sku: string; name_ru: string } | null;
  /** competitor_price only: the «1-в-1» match done by our code */
  match: MatchResult | null;
  /** why the row cannot be saved, in plain words; null = can be saved */
  problem: string | null;
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const intIn = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** Checks every row the model gave: our product by SKU, the date, the numbers, and the strict «1-в-1». */
export function checkFeedRows(raw: unknown, products: FeedProduct[], today: string): { rows: FeedRow[]; unclear: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { rows?: unknown; unclear?: unknown };
  const list = Array.isArray(r.rows) ? r.rows.slice(0, 200) : [];
  const unclear = Array.isArray(r.unclear) ? r.unclear.filter((u): u is string => typeof u === 'string').map((u) => u.slice(0, 300)).slice(0, 50) : [];
  const bySku = new Map(products.map((p) => [p.sku.trim().toLowerCase(), p]));
  const rows = list.map((x, index): FeedRow => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const kind = (FEED_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as FeedKind) : 'note';
    const sku = text(o.sku, 64);
    const p = sku ? bySku.get(sku.toLowerCase()) : undefined;
    const date = typeof o.observed_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.observed_on) && !Number.isNaN(Date.parse(o.observed_on)) ? o.observed_on : null;
    const doseAmount = typeof o.dose_amount === 'number' && Number.isFinite(o.dose_amount) && o.dose_amount > 0 && o.dose_amount < 100_000_000 ? Math.round(o.dose_amount * 1000) / 1000 : null;
    const row: FeedRow = {
      index,
      kind,
      sku: p?.sku ?? sku,
      platform: (PLATFORMS as readonly string[]).includes(o.platform as string) ? (o.platform as string) : null,
      seller: text(o.seller, 120),
      title: text(o.title, 300),
      url: text(o.url, 500),
      price_uzs: intIn(o.price_uzs, 1, 1_000_000_000),
      observed_on: date && date <= today ? date : today,
      brand: text(o.brand, 120),
      match_form: text(o.match_form, 80),
      dose_amount: doseAmount,
      dose_unit: (DOSE_UNITS as readonly string[]).includes(o.dose_unit as string) ? (o.dose_unit as string) : null,
      dose_per: (DOSE_PER as readonly string[]).includes(o.dose_per as string) ? (o.dose_per as string) : null,
      pack_count: intIn(o.pack_count, 1, 100_000),
      orders_count: intIn(o.orders_count, 0, 100_000_000),
      bestseller_rank: intIn(o.bestseller_rank, 1, 100_000),
      note: text(o.note, 1000),
      product: p ? { id: p.id, sku: p.sku, name_ru: p.name_ru } : null,
      match: null,
      problem: null,
    };
    // a dose without its unit or «на что» is no dose at all (the same rule as DOSE_INCOMPLETE in the form)
    if (!row.dose_unit || !row.dose_per) row.dose_amount = null;
    if (kind === 'competitor_price') {
      if (!p) row.problem = sku ? `товар с артикулом ${sku} не найден` : 'не понятно, какой это наш товар';
      else if (!row.platform) row.problem = 'не указано, где цена (площадка)';
      else if (row.price_uzs == null || row.price_uzs < 1000) row.problem = 'нет цены в сумах';
      if (p) {
        row.match = matchOneToOne(p, {
          brand: row.brand,
          match_form: row.match_form ? normalizeMatchForm(row.match_form) : null,
          dose_amount: row.dose_amount,
          dose_unit: row.dose_unit,
          dose_per: row.dose_per,
          pack_count: row.pack_count,
        });
      }
    } else if (kind === 'orders') {
      if (row.orders_count == null) row.problem = 'нет числа заказов';
    } else if (kind === 'bestseller_rank') {
      if (row.bestseller_rank == null) row.problem = 'нет места в бестселлерах';
      else if (!p) row.problem = 'не понятно, какой это наш товар';
    } else if (!row.note) {
      row.problem = 'пустая заметка';
    }
    return row;
  });
  return { rows, unclear };
}

// ---------------- the chat ----------------

export const CHAT_SYSTEM = `Ты — AI-аналитик закупок и цен интернет-магазина БАДов VITALO (Узбекистан). С тобой говорит владелец или администратор. Отвечай по-русски, коротко и по делу, простыми словами, без жаргона. Суммы — в сумах.

Опирайся только на данные ниже («Данные магазина» и «Память о бизнесе») и на вопрос. Если данных не хватает — так и скажи и подскажи, что загрузить (срез вишлиста iHerb, цены конкурентов, число заказов). Никогда не выдумывай цены, остатки и продажи.

Что важно владельцу:
- Закупка: когда выгодно выкупать с iHerb на склад (цена ниже средней за 30 дней — сигнал А), а когда выгоднее перехватить товар «1-в-1» в Ташкенте (сигнал Б). Сигналы и средние уже посчитаны программой — объясняй их и советуй, сколько и что брать, с учётом продаж за 30 дней и остатка.
- Цена продажи: маржа (наша цена − закупка), минимум рынка «1-в-1», риск, что конкурент дешевле.
- Учитывай решения владельца из памяти (kind=decision) и не советуй им противоречить без явной причины.
Цены конкурентов в данных — только прошедшие сверку «1-в-1» (бренд, форма, доза, количество в банке).
Ты не можешь сам менять цены, заказывать товар или писать в базу — только советуешь.`;

export const FACT_LABELS: Record<string, string> = {
  competitor_price: 'цена конкурента',
  orders: 'заказы у конкурента',
  bestseller_rank: 'место в бестселлерах iHerb',
  decision: 'решение владельца',
  note: 'заметка',
};
