import { adminCostUsd, checkFeedRows, FEED_SCHEMA, mergeAdminAiSettings, type FeedProduct } from './admin-ai';

const ours: FeedProduct = { id: 'p1', sku: 'VTL-H001', name_ru: 'Магний', brand: 'NOW Foods', match_form: 'бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90 };
const row = (o: Record<string, unknown>) => ({
  kind: 'competitor_price',
  sku: 'VTL-H001',
  platform: 'uzum',
  seller: 'Fitvibe',
  title: null,
  url: null,
  price_uzs: 199_000,
  observed_on: null,
  brand: 'NOW Foods',
  match_form: 'Бисглицинат',
  dose_amount: 200,
  dose_unit: 'mg',
  dose_per: 'capsule',
  pack_count: 90,
  orders_count: 350,
  bestseller_rank: null,
  note: null,
  ...o,
});

describe('AI analyst: checking what the model read (D-57, узел 5)', () => {
  const today = '2026-11-09';

  it('a competitor price: our product by SKU, «1-в-1» by our code, today when no date', () => {
    const { rows } = checkFeedRows({ rows: [row({ sku: 'vtl-h001' })], unclear: [] }, [ours], today);
    expect(rows[0]).toMatchObject({ index: 0, sku: 'VTL-H001', product: { id: 'p1' }, observed_on: today, orders_count: 350, problem: null, match: { status: 'match', reasons: [] } });
  });

  it('not the same product: still shown, with the reason; a future date becomes today', () => {
    const { rows } = checkFeedRows({ rows: [row({ pack_count: 120, observed_on: '2027-01-01' })] }, [ours], today);
    expect(rows[0].match).toEqual({ status: 'mismatch', reasons: ['в банке: 90 / 120'] });
    expect(rows[0].observed_on).toBe(today);
  });

  it('what cannot be saved says why; a dose without a unit is no dose', () => {
    const { rows } = checkFeedRows(
      {
        rows: [
          row({ sku: 'NOPE' }),
          row({ sku: null }),
          row({ platform: 'ebay' }),
          row({ price_uzs: 12.5 }),
          row({ dose_unit: null }),
          { kind: 'orders', orders_count: null },
          { kind: 'bestseller_rank', bestseller_rank: 4, sku: null },
          { kind: 'note', note: '  ' },
          { kind: 'weird', note: 'Uzum поднял комиссию' },
        ],
        unclear: ['цена в долларах: $12', 7],
      },
      [ours],
      today,
    );
    expect(rows.map((r) => r.problem)).toEqual([
      'товар с артикулом NOPE не найден',
      'не понятно, какой это наш товар',
      'не указано, где цена (площадка)',
      'нет цены в сумах',
      null,
      'нет числа заказов',
      'не понятно, какой это наш товар',
      'пустая заметка',
      null,
    ]);
    expect(rows[4].dose_amount).toBeNull();
    expect(rows[4].match?.status).toBe('incomplete');
    expect(rows[8].kind).toBe('note');
  });

  it('garbage from the model does not break anything', () => {
    expect(checkFeedRows(null, [ours], today)).toEqual({ rows: [], unclear: [] });
    expect(checkFeedRows({ rows: 'x', unclear: [1, 'ok'] }, [ours], today)).toEqual({ rows: [], unclear: ['ok'] });
  });
});

describe('AI analyst: the answer schema', () => {
  it('an enum never sits under a type list (the API answers 400 «Enum value does not match declared type»)', () => {
    const bad: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (Array.isArray(o.enum) && Array.isArray(o.type)) bad.push(path);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(FEED_SCHEMA, 'schema');
    expect(bad).toEqual([]);
  });
});

describe('AI analyst: cost and settings', () => {
  it('cache writes cost 1.25× input, reads 0.1×', () => {
    // Opus 5.5: 4 $/M input, 20 $/M output
    expect(adminCostUsd({ model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000 })).toBeCloseTo((1000 * 4 + 2000 * 5 + 10_000 * 0.4 + 500 * 20) / 1e6, 10);
    // an unknown fallback model: counted at the dearest price
    expect(adminCostUsd({ model: 'claude-x', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(10);
  });

  it('settings: defaults for wrong values', () => {
    expect(mergeAdminAiSettings(null)).toEqual({ enabled: true, model: 'claude-opus-5-5', monthly_budget_usd: 20 });
    expect(mergeAdminAiSettings({ enabled: false, model: 'gpt', monthly_budget_usd: -1 })).toEqual({ enabled: false, model: 'claude-opus-5-5', monthly_budget_usd: 20 });
  });
});
