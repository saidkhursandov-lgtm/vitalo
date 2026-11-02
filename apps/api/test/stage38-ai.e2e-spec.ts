import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { AI_MODEL, type AiCompletion, type AiModel } from '../src/compat/ai-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

/** The Claude API stand-in: answers what the test tells it and remembers what it was sent. */
class FakeModel implements AiModel {
  key = true;
  calls: { model: string; system: string; data: string }[] = [];
  reply: (data: string) => unknown = () => ({});
  ready() {
    return this.key;
  }
  async complete(input: { model: string; system: string; data: string }): Promise<AiCompletion> {
    this.calls.push(input);
    return { json: this.reply(input.data), inputTokens: 1500, outputTokens: 300, outcome: 'ok' };
  }
}

/** 3.8: VITALO AI checks the cart (D-45, D-47) — with a fake model, never the real API. */
describe('Stage 3.8 VITALO AI cart check (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeModel();
  const tokens: Record<string, string> = {};
  let tg = 838_200_000;
  const run = Date.now().toString(36);
  const http = () => request(app.getHttpServer());
  const p: Record<string, { id: string; sku: string }> = {};
  const s: Record<string, string> = {};

  async function customer(consent = true) {
    const telegram = ++tg;
    const token = await loginCustomer(app, telegram);
    await prisma.users.update({ where: { telegram_user_id: BigInt(telegram) }, data: { language: 'ru', ...(consent && { ai_consent_at: new Date() }) } });
    return token;
  }
  const add = (token: string, productId: string) => http().post('/api/cart/items').set(bearer(token)).send({ product_id: productId, qty: 1 }).expect(201);
  const check = (token: string) => http().post('/api/compat/ai/check').set(bearer(token));
  /** a correct answer for every product of the cart block */
  const goodReply = (verdict = 'compatible', productIds: string[] = []) => (data: string) => {
    const skus = [...data.split('можно предложить')[0].matchAll(/- id (\S+) \|/g)].map((m) => m[1]);
    return { verdict, text: 'Эти добавки хорошо сочетаются, если принимать их в разное время дня.', timing: skus.map((id) => ({ productId: id, when: 'Утро, с едой' })), productIds };
  };

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(AI_MODEL).useValue(fake));
    prisma = app.get(PrismaService);
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);

    for (const code of ['x', 'y', 'z', 'w']) {
      s[code] = (await prisma.substances.create({ data: { code: `ai_${code}_${run}`, name_ru: `Вещество ${code.toUpperCase()} ${run}`, name_uz: `Modda ${code.toUpperCase()}`, synonyms: [] } })).id;
    }
    const drug = await prisma.substances.findFirstOrThrow({ where: { kind: 'drug_group' }, orderBy: { code: 'asc' } });
    const rule = (a: string, b: string, kind: string, text: string, status = 'approved') =>
      prisma.compat_rules.create({ data: { substance_a_id: a, substance_b_id: b, kind, text_ru: text, text_uz: text, status, origin: 'admin' } });
    await rule(s.x, s.y, 'spread', 'Разнесите X и Y на 2 часа.');
    await rule(s.x, s.w, 'synergy', 'X и W хорошо дополняют друг друга.');
    await rule(s.x, drug.id, 'drug_caution', `X и лекарства ${run}: согласуйте с врачом.`);
    await rule(s.y, s.w, 'avoid', 'Черновик не виден AI.', 'draft');

    const product = async (key: string, subs: string[], stock = 5) => {
      const row = await createTestProduct(prisma, { price: 50_000, stock, name: `AI ${key} ${run}` });
      await prisma.product_substances.createMany({ data: subs.map((id) => ({ product_id: row.id, substance_id: id })) });
      p[key] = row;
    };
    await product('a', [s.x, s.z]);
    await product('b', [s.y, s.z]);
    await product('c', [s.y]);
    await product('d', [s.w]);
    await product('e', [s.w], 0); // out of stock: never offered
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    await prisma.home_banners.deleteMany({ where: { kind: 'ai' } }); // test database only: other suites expect the seeded two
    await prisma.compat_rules.updateMany({ where: { OR: [{ substance_a_id: { in: Object.values(s) } }, { substance_b_id: { in: Object.values(s) } }] }, data: { status: 'off' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('works only after «Я согласен»', async () => {
    const token = await customer(false);
    await add(token, p.a.id);
    expect((await http().get('/api/compat/ai').set(bearer(token)).expect(200)).body).toMatchObject({ available: true, consent: false, left_today: 1, answer: null });
    expect((await check(token).expect(403)).body.code).toBe('CONSENT_REQUIRED');
    expect((await http().post('/api/compat/ai/consent').set(bearer(token)).expect(200)).body.consent).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it('a new answer: products and approved rules only, the label raised by rules and overlaps, logged with its cost', async () => {
    const token = await customer();
    await add(token, p.a.id);
    await add(token, p.b.id);
    fake.reply = goodReply('compatible');
    const res = (await check(token).expect(200)).body;
    expect(res.result).toBe('ai');

    const sent = fake.calls.at(-1)!;
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.data).toContain(`id ${p.a.sku}`);
    expect(sent.data).toContain('Разнесите X и Y на 2 часа.');
    expect(sent.data).toContain(`X и лекарства ${run}`);
    expect(sent.data).not.toContain('Черновик');
    expect(sent.data).toMatch(new RegExp(`Вещество Z ${run} — ${p.a.sku}, ${p.b.sku}|Вещество Z ${run} — ${p.b.sku}, ${p.a.sku}`));
    expect(sent.data).not.toContain(String(tg)); // nothing about the customer

    // «compatible» from the model, but a spread rule and the overlap of Z make it yellow
    expect(res.answer).toMatchObject({ verdict: 'spread', overlaps: [`Вещество Z ${run}`], overlap_text: expect.stringContaining('суммарную дозировку'), drugs: [`X и лекарства ${run}: согласуйте с врачом.`] });
    expect(res.answer.timing).toHaveLength(2);
    expect(res.left_today).toBe(0);
    const log = await prisma.ai_requests.findFirstOrThrow({ where: { set_key: [p.a.id, p.b.id].sort().join(',') }, orderBy: { created_at: 'desc' } });
    expect(log).toMatchObject({ status: 'ok', scenario: 'cart', input_tokens: 1500, output_tokens: 300 });
    expect(Number(log.cost_usd)).toBeCloseTo((1500 * 0.1 + 300 * 0.5) / 1e6, 8);
    expect(await prisma.compat_requests.findFirst({ where: { ai_answer_id: res.answer.answer_id } })).toMatchObject({ source: 'ai', status: 'answered', verdict: 'spread' });

    // the daily limit (1) is spent: a different cart is not sent to the model
    await add(token, p.c.id);
    expect((await check(token).expect(429)).body.code).toBe('AI_DAILY_LIMIT');
  });

  it('the same set for another customer comes from the cache without a call', async () => {
    const token = await customer();
    await add(token, p.b.id);
    await add(token, p.a.id);
    const before = fake.calls.length;
    const res = (await check(token).expect(200)).body;
    expect(res.result).toBe('ai_cache');
    expect(fake.calls).toHaveLength(before);
    expect(res.left_today).toBe(1); // a cached answer does not use the limit
    expect((await prisma.ai_compat_answers.findUniqueOrThrow({ where: { id: res.answer.answer_id } })).used_count).toBe(2);
  });

  it('one product: up to 3 suggestions in stock, linked by «синергия»', async () => {
    const token = await customer();
    await add(token, p.a.id);
    fake.reply = (data) => ({ ...(goodReply('compatible')(data) as object), productIds: [p.d.sku, p.e.sku, 'NOPE'] });
    const res = (await check(token).expect(200)).body;
    const sent = fake.calls.at(-1)!.data;
    expect(sent).toContain(`можно предложить`);
    expect(sent).toContain(`id ${p.d.sku}`);
    expect(sent).not.toContain(`id ${p.e.sku}`);
    expect(res.answer.suggestions).toEqual([{ product_id: p.d.id, name: `AI d ${run}` }]);
    expect(res.answer.overlaps).toEqual([]);
  });

  it('a bad answer is never shown: the cart goes to the specialist', async () => {
    const token = await customer();
    await add(token, p.c.id);
    await add(token, p.d.id);
    fake.reply = (data) => ({ ...(goodReply('compatible')(data) as object), text: 'Этот набор лечит всё и гарантирует результат.' });
    const res = (await check(token).expect(200)).body;
    expect(res).toMatchObject({ result: 'specialist', reason: 'invalid', answer: null });
    const set = [p.c.id, p.d.id].sort().join(',');
    expect(await prisma.compat_requests.findFirst({ where: { set_key: set, status: 'pending' }, orderBy: { created_at: 'desc' } })).toMatchObject({ source: 'ai_fallback' });
    expect(await prisma.ai_requests.findFirst({ where: { set_key: set }, orderBy: { created_at: 'desc' } })).toMatchObject({ status: 'invalid', error: 'forbidden_words' });
    expect(await prisma.ai_compat_answers.count({ where: { set_key: set } })).toBe(0);
  });

  it('no key or a spent budget: the specialist answers, the model is not called', async () => {
    const before = fake.calls.length;
    fake.key = false;
    let token = await customer();
    await add(token, p.b.id);
    await add(token, p.d.id);
    expect((await check(token).expect(200)).body).toMatchObject({ result: 'specialist', reason: 'no_key' });
    fake.key = true;

    await http().put('/api/staff/ai/settings').set(bearer(tokens.manager)).send({ settings: { monthly_budget_usd: 0 } }).expect(403);
    const saved = (await http().put('/api/staff/ai/settings').set(bearer(tokens.admin)).send({ settings: { monthly_budget_usd: 0, model: 'gpt-x' } }).expect(200)).body;
    expect(saved).toMatchObject({ key_set: true, settings: { monthly_budget_usd: 0, model: 'claude-haiku-5-5' } });
    expect(saved.month.cost_usd).toBeGreaterThan(0);
    token = await customer();
    await add(token, p.c.id);
    await add(token, p.a.id);
    expect((await check(token).expect(200)).body).toMatchObject({ result: 'specialist', reason: 'budget' });
    expect(fake.calls).toHaveLength(before);
  });

  it('the home banner has the VITALO AI slide after the built-in ones (migration 20261110100000, safe to repeat)', async () => {
    // the test database is truncated and seeded before the run: the migration's own SQL is applied here, twice
    const sql = readFileSync(join(__dirname, '../prisma/migrations/20261110100000_stage38_ai_banner/migration.sql'), 'utf8');
    await prisma.$executeRawUnsafe(sql);
    await prisma.$executeRawUnsafe(sql);
    expect(await prisma.home_banners.count({ where: { kind: 'ai' } })).toBe(1);
    const list = (await http().get('/api/catalog/banners?lang=ru').expect(200)).body as { id: string; kind: string }[];
    const ai = list.find((b) => b.kind === 'ai');
    expect(ai).toMatchObject({ id: '00000000-0000-4000-8000-00000000b003' });
    expect(list.findIndex((b) => b.kind === 'ai')).toBeGreaterThan(list.findIndex((b) => b.kind === 'doctor'));
  });
});
