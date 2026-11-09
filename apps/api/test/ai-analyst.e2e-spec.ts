import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_AI_MODEL, type AdminAiAnswer, type AdminAiCall, type AdminAiModel } from '../src/ai-analyst/admin-ai-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff, TEST_BRAND } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;

/** A fake Claude: answers what the test tells it and remembers what it was asked. Never a real request. */
class FakeModel implements AdminAiModel {
  key = true;
  next: Partial<AdminAiAnswer> = {};
  calls: AdminAiCall[] = [];
  ready() {
    return this.key;
  }
  async ask(call: AdminAiCall): Promise<AdminAiAnswer> {
    this.calls.push(call);
    return { model: call.model, text: '', json: null, outcome: 'ok', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0, ...this.next };
  }
}

/**
 * Генплан, этап 5 (D-57, узел 5 и решение владельца 09.11): purchase signals A and B, every seller as its own bar,
 * the best-seller place and competitor orders, the AI analyst (data feed with preview → «Сохранить», memory, chat, budget).
 */
describe('AI analyst and purchase signals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  let productId: string;
  let sku: string;
  const fake = new FakeModel();
  const http = () => request(app.getHttpServer());
  const iherbId = String(800_000 + (Date.now() % 100_000));
  const same = { brand: TEST_BRAND, match_form: 'бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90 };
  const priceRow = (seller: string, price: number, extra: object = {}) => ({
    kind: 'competitor_price',
    sku,
    platform: 'other',
    seller,
    title: null,
    url: null,
    price_uzs: price,
    observed_on: null,
    ...same,
    orders_count: null,
    bestseller_rank: null,
    note: null,
    ...extra,
  });

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(ADMIN_AI_MODEL).useValue(fake));
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, MANAGER_TG);
    const p = await createTestProduct(prisma, { price: 240_000, stock: 0 });
    productId = p.id;
    const row = await prisma.products.update({ where: { id: p.id }, data: { ...same, iherb_url: `https://uz.iherb.com/pr/x/${iherbId}`, iherb_product_id: iherbId } });
    sku = row.sku;
    await prisma.settings.deleteMany({ where: { key: { in: ['iherb_prices', 'admin_ai'] } } });
  });

  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: { in: ['iherb_prices', 'admin_ai'] } } });
    await prisma.products.update({ where: { id: productId }, data: { iherb_url: null, iherb_product_id: null } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('only the admin; no key / switched off = a clear message, no call', async () => {
    await http().get('/api/staff/ai-analyst/status').set(bearer(manager)).expect(403);
    await http().post('/api/staff/ai-analyst/feed').set(bearer(manager)).send({ text: 'x' }).expect(403);
    const st = (await http().get('/api/staff/ai-analyst/status').set(bearer(admin)).expect(200)).body;
    expect(st).toMatchObject({ key_set: true, settings: { enabled: true, model: 'claude-opus-5-5', monthly_budget_usd: 20 } });
    fake.key = false;
    expect((await http().post('/api/staff/ai-analyst/feed').set(bearer(admin)).send({ text: 'x' }).expect(409)).body.code).toBe('ADMIN_AI_NO_KEY');
    fake.key = true;
    await http().put('/api/staff/ai-analyst/settings').set(bearer(admin)).send({ enabled: false }).expect(200);
    expect((await http().post('/api/staff/ai-analyst/chat').set(bearer(admin)).send({ question: 'x' }).expect(409)).body.code).toBe('ADMIN_AI_DISABLED');
    await http().put('/api/staff/ai-analyst/settings').set(bearer(admin)).send({ enabled: true }).expect(200);
    expect(fake.calls).toHaveLength(0);
  });

  it('«Проверить»: the model reads, our code checks «1-в-1»; nothing but the feed and the log is written', async () => {
    fake.next = {
      json: {
        rows: [
          priceRow('Fitvibe', 199_000, { orders_count: 350 }),
          priceRow('BioBox', 250_000),
          priceRow('vitaminki.uz', 392_000),
          priceRow('Другой', 150_000, { pack_count: 60 }),
          { ...priceRow('', 0), kind: 'orders', price_uzs: null, platform: 'uzum', seller: 'Fitvibe', orders_count: 1200 },
          { ...priceRow('', 0), kind: 'bestseller_rank', price_uzs: null, platform: null, seller: null, bestseller_rank: 4 },
          { ...priceRow('', 0), sku: 'NO-SUCH', price_uzs: 100_000 },
        ],
        unclear: ['цена в долларах: $12'],
      },
    };
    const res = (await http().post('/api/staff/ai-analyst/feed').set(bearer(admin)).send({ text: 'Fitvibe 199 000, BioBox 250 000 …' }).expect(200)).body;
    fake.next = {};
    expect(res.rows.map((r: { match: { status: string } | null; problem: string | null }) => [r.match?.status ?? null, r.problem])).toEqual([
      ['match', null],
      ['match', null],
      ['match', null],
      ['mismatch', null],
      [null, null],
      [null, null],
      [null, 'товар с артикулом NO-SUCH не найден'],
    ]);
    expect(res.unclear).toEqual(['цена в долларах: $12']);
    expect(res.cost_usd).toBeCloseTo((1000 * 4 + 5000 * 0.4 + 200 * 20) / 1e6, 6);
    // the model got our products, no prices or costs
    expect(fake.calls[0].context).toContain(sku);
    expect(fake.calls[0].schema).toBeDefined();
    expect(await prisma.competitor_prices.count({ where: { product_id: productId } })).toBe(0);
    expect(await prisma.admin_ai_feed.count({ where: { id: res.id, status: 'parsed' } })).toBe(1);
    expect(await prisma.admin_ai_requests.count({ where: { scenario: 'feed', outcome: 'ok' } })).toBeGreaterThanOrEqual(1);

    // «Сохранить» the chosen rows: prices with source «ai», facts into the memory; a row with a problem is skipped
    const saved = (await http().post(`/api/staff/ai-analyst/feed/${res.id}/save`).set(bearer(admin)).send({ indexes: [0, 1, 2, 3, 4, 5, 6] }).expect(200)).body;
    expect(saved).toMatchObject({ competitor_prices: 4, facts: 2 });
    const prices = await prisma.competitor_prices.findMany({ where: { product_id: productId }, orderBy: { price_uzs: 'asc' } });
    expect(prices.map((p) => [p.seller, Number(p.price_uzs), p.source, p.match_status, p.orders_count])).toEqual([
      ['Другой', 150_000, 'ai', 'mismatch', null],
      ['Fitvibe', 199_000, 'ai', 'match', 350],
      ['BioBox', 250_000, 'ai', 'match', null],
      ['vitaminki.uz', 392_000, 'ai', 'match', null],
    ]);
    const mem = (await http().get(`/api/staff/ai-analyst/memory?product_id=${productId}`).set(bearer(admin)).expect(200)).body;
    expect(mem.map((m: { kind: string; value_num: number }) => [m.kind, m.value_num]).sort()).toEqual([
      ['bestseller_rank', 4],
      ['orders', 1200],
    ]);
    expect((await http().post(`/api/staff/ai-analyst/feed/${res.id}/save`).set(bearer(admin)).send({ indexes: [0] }).expect(409)).body.code).toBe('FEED_NOT_OPEN');
    const feeds = (await http().get('/api/staff/ai-analyst/feed').set(bearer(admin)).expect(200)).body;
    expect(feeds[0]).toMatchObject({ id: res.id, status: 'saved', saved: { competitor_prices: 4, facts: 2 } });
  });

  it('every seller is its own bar; landed cost, 30-day average and signals A and B', async () => {
    let hist = (await http().get(`/api/staff/iherb/products/${productId}/history`).set(bearer(admin)).expect(200)).body;
    expect(hist.competitors_latest.map((c: { seller: string }) => c.seller).sort()).toEqual(['BioBox', 'Fitvibe', 'vitaminki.uz']);
    expect(hist.iherb_landed_uzs).toBeNull();

    // iHerb history: 260 000 three days ago … today 200 000; 0.2 kg
    const up = await prisma.iherb_uploads.create({ data: { items_total: 1, items_matched: 1, prices_changed: 0 } });
    const day = (n: number) => new Date(Date.now() - n * 86400_000);
    await prisma.iherb_price_snapshots.createMany({
      data: [5, 4, 3, 0].map((n) => ({ upload_id: up.id, product_id: productId, iherb_product_id: iherbId, price_uzs: BigInt(n ? 250_000 : 200_000), weight_kg: 0.2, in_stock: true, bestseller_rank: n ? null : 7, taken_at: day(n) })),
    });
    // free delivery: landed 200 000; avg (250×3 + 200)/4 = 237 500 → −15.8% = strong; Fitvibe 199 000 ≤ 200 000 = urgent
    hist = (await http().get(`/api/staff/iherb/products/${productId}/history`).set(bearer(admin)).expect(200)).body;
    expect(hist).toMatchObject({ iherb_landed_uzs: 200_000, avg30_uzs: 237_500, avg_days: 4, shipping_rate_per_kg_uzs: 0 });
    expect(hist.signals.map((s: { kind: string }) => s.kind)).toEqual(['iherb_strong', 'local_urgent']);
    expect(hist.signals[1].text).toContain('Fitvibe');

    // 50 000 сум/kg: landed 210 000; Fitvibe still cheaper; signal A lower bar 20% → no A
    const bad = await http().put('/api/staff/iherb/settings').set(bearer(admin)).send({ signal_a_pct: 20, signal_a_strong_pct: 15 }).expect(400);
    expect(bad.body.code).toBe('SIGNAL_STRONG_BELOW_A');
    const s = (await http().put('/api/staff/iherb/settings').set(bearer(admin)).send({ shipping_rate_per_kg_uzs: 50_000, signal_a_pct: 20, signal_a_strong_pct: 25 }).expect(200)).body;
    expect(s).toEqual({ reminders: false, shipping_rate_per_kg_uzs: 50_000, signal_a_pct: 20, signal_a_strong_pct: 25, signal_b_pct: 7 });
    const list = (await http().get('/api/staff/iherb/products').set(bearer(admin)).expect(200)).body.find((p: { id: string }) => p.id === productId);
    expect(list).toMatchObject({ iherb_landed_uzs: 210_000, market_min_uzs: 199_000, last_snapshot: { bestseller_rank: 7 } });
    expect(list.signals.map((x: { kind: string }) => x.kind)).toEqual(['local_urgent']);
  });

  it('chat: shop data, signals and memory go to the model; earlier answers too; a decision is remembered', async () => {
    await http().post('/api/staff/ai-analyst/memory').set(bearer(admin)).send({ kind: 'decision', product_id: productId, text: 'Магний берём в Ташкенте, пока Fitvibe дешевле' }).expect(201);
    fake.next = { text: 'Берите 10 банок у Fitvibe.' };
    const a = (await http().post('/api/staff/ai-analyst/chat').set(bearer(admin)).send({ question: 'Что закупать?' }).expect(200)).body;
    expect(a).toMatchObject({ question: 'Что закупать?', answer: 'Берите 10 банок у Fitvibe.', outcome: 'ok' });
    const call = fake.calls[fake.calls.length - 1];
    expect(call.context).toContain(sku);
    expect(call.context).toContain('Срочно брать в Ташкенте');
    expect(call.context).toContain('Магний берём в Ташкенте');
    expect(call.context).toContain('заказы у конкурента');
    expect(call.schema).toBeUndefined();
    fake.next = { text: 'Да.' };
    await http().post('/api/staff/ai-analyst/chat').set(bearer(admin)).send({ question: 'Точно?' }).expect(200);
    fake.next = {};
    expect(fake.calls[fake.calls.length - 1].messages).toEqual([
      { role: 'user', content: 'Что закупать?' },
      { role: 'assistant', content: 'Берите 10 банок у Fitvibe.' },
      { role: 'user', content: 'Точно?' },
    ]);
    const history = (await http().get('/api/staff/ai-analyst/chat').set(bearer(admin)).expect(200)).body;
    expect(history.slice(-2).map((h: { question: string }) => h.question)).toEqual(['Что закупать?', 'Точно?']);

    // «Убрать» a fact: it stops counting, stays in the database
    const facts = (await http().get(`/api/staff/ai-analyst/memory?product_id=${productId}`).set(bearer(admin))).body;
    const decision = facts.find((f: { kind: string }) => f.kind === 'decision');
    await http().delete(`/api/staff/ai-analyst/memory/${decision.id}`).set(bearer(admin)).expect(200);
    await http().delete(`/api/staff/ai-analyst/memory/${decision.id}`).set(bearer(admin)).expect(404);
    expect(await prisma.admin_business_memory.count({ where: { id: decision.id, active: false } })).toBe(1);
  });

  it('the log counts the cost; a spent budget stops the calls', async () => {
    const log = (await http().get('/api/staff/ai-analyst/requests').set(bearer(admin)).expect(200)).body;
    expect(log.month.requests).toBeGreaterThanOrEqual(3);
    expect(log.month.cost_usd).toBeGreaterThan(0);
    await http().put('/api/staff/ai-analyst/settings').set(bearer(admin)).send({ monthly_budget_usd: 0 }).expect(200);
    const n = fake.calls.length;
    expect((await http().post('/api/staff/ai-analyst/chat').set(bearer(admin)).send({ question: 'Ещё?' }).expect(409)).body.code).toBe('ADMIN_AI_BUDGET');
    expect(fake.calls).toHaveLength(n);
    await http().put('/api/staff/ai-analyst/settings').set(bearer(admin)).send({ monthly_budget_usd: 20, model: 'gpt-4' }).expect(400);
  });
});
