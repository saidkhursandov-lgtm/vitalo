import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AI_MODEL, type AiCompletion, type AiModel } from '../src/compat/ai-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

class FakeModel implements AiModel {
  key = true;
  calls: { model: string; system: string; data: string }[] = [];
  reply: (data: string) => unknown = () => ({});
  ready() {
    return this.key;
  }
  async complete(input: { model: string; system: string; data: string }): Promise<AiCompletion> {
    this.calls.push(input);
    return { json: this.reply(input.data), inputTokens: 900, outputTokens: 250, outcome: 'ok' };
  }
}

/** Шаг 0б (D-69): «Задать вопрос VITALO AI по корзине» and «База знаний AI → Цели» — with a fake model, never the real API. */
describe('Шаг 0б: вопрос VITALO AI по корзине (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeModel();
  const tokens: Record<string, string> = {};
  let tg = 839_100_000;
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
  const ask = (token: string, body: object = { goal: 'sleep', duration: '2to4w', kind: 'fall_asleep' }) => http().post('/api/compat/ai/goal').set(bearer(token)).send(body);
  /** a correct answer for every product of the data block; the model says «helps» for all */
  const goodReply = (data: string) => {
    const skus = [...data.matchAll(/- id (\S+) \|/g)].map((m) => m[1]);
    return {
      summary: 'Для сна в этом наборе может помочь магний, второй товар для этой цели можно не брать.',
      products: skus.map((id) => ({ productId: id, fit: 'helps', text: 'Может помочь, если сон мешает напряжение после дня.' })),
      steps: ['Ложитесь в одно и то же время.', 'Уберите телефон за час до сна.'],
    };
  };

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(AI_MODEL).useValue(fake));
    prisma = app.get(PrismaService);
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);
    for (const code of ['mg', 'd3', 'form']) {
      s[code] = (await prisma.substances.create({ data: { code: `goal_${code}_${run}`, name_ru: `Вещество ${code} ${run}`, name_uz: `Modda ${code}`, synonyms: [] } })).id;
    }
    // a form counts for its substance: the row of «mg» applies to a product with «form»
    await prisma.substances.update({ where: { id: s.form }, data: { kind: 'form', parent_id: s.mg } });
    const product = async (key: string, subs: string[]) => {
      const row = await createTestProduct(prisma, { price: 50_000, stock: 5, name: `Goal ${key} ${run}` });
      await prisma.product_substances.createMany({ data: subs.map((id) => ({ product_id: row.id, substance_id: id })) });
      p[key] = row;
    };
    await product('mag', [s.form]);
    await product('d3', [s.d3]);
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    await prisma.goal_evidence.updateMany({ where: { substance_id: { in: Object.values(s) } }, data: { status: 'off' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('«Цели»: a manager looks, a specialist role adds, only an admin approves; an edit is audited', async () => {
    const row = { substance_id: s.mg, goal: 'sleep', level: 'B', helps_ru: 'при напряжении и дефиците магния', helps_uz: 'zoʻriqish va magniy yetishmasligida', not_helps_ru: 'если мешают кофеин и гаджеты', not_helps_uz: 'agar kofein va gadjetlar xalaqit bersa', source: 'обзор' };
    await http().post('/api/staff/compat/goals').set(bearer(tokens.manager)).send(row).expect(403);
    const list = (await http().post('/api/staff/compat/goals').set(bearer(tokens.admin)).send(row).expect(201)).body as { id: string; status: string; level: string }[];
    const mine = list.find((r) => (r as unknown as { substance: { id: string } }).substance.id === s.mg)!;
    expect(mine).toMatchObject({ status: 'draft', level: 'B' });
    await http().post('/api/staff/compat/goals').set(bearer(tokens.admin)).send(row).expect(409);
    await http().post('/api/staff/compat/goals').set(bearer(tokens.admin)).send({ ...row, level: 'D' }).expect(400);
    expect((await http().get('/api/staff/compat/goals').set(bearer(tokens.manager)).expect(200)).body.length).toBeGreaterThan(0);
    // a draft row is not seen by VITALO AI
    const token = await customer();
    await add(token, p.mag.id);
    fake.reply = goodReply;
    const draft = (await ask(token).expect(200)).body;
    expect(draft.products[0]).toMatchObject({ fit: 'no_data', level: null, level_text: null });
    expect(fake.calls.at(-1)!.data).toContain('база для этой цели: нет строк');

    await http().post(`/api/staff/compat/goals/${mine.id}/status`).set(bearer(tokens.manager)).send({ status: 'approved' }).expect(403);
    await http().post(`/api/staff/compat/goals/${mine.id}/status`).set(bearer(tokens.admin)).send({ status: 'approved' }).expect(200);
    await http().patch(`/api/staff/compat/goals/${mine.id}`).set(bearer(tokens.admin)).send({ source: 'обзор 2025' }).expect(200);
    expect(await prisma.goal_evidence.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ status: 'approved', source: 'обзор 2025' });
    expect(await prisma.audit_logs.count({ where: { entity_type: 'goal_evidence', entity_id: mine.id } })).toBe(3);
  });

  it('the answer: only chips and products go to the model; our level in words; «данных немного» without a row; the doctor line', async () => {
    const token = await customer();
    await add(token, p.mag.id);
    await add(token, p.d3.id);
    fake.reply = goodReply;
    const res = (await ask(token).expect(200)).body;
    const sent = fake.calls.at(-1)!;
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.data).toContain('цель: сон');
    expect(sent.data).toContain('что беспокоит: трудно заснуть');
    expect(sent.data).toContain('уровень B | когда помогает: при напряжении и дефиците магния');
    expect(sent.data).not.toMatch(/telegram|телефон|\+998/i);
    expect(res).toMatchObject({ goal: 'sleep', duration: '2to4w', kind: 'fall_asleep', doctor: 'Если проблема держится дольше 3–4 недель — обратитесь к врачу.' });
    const mag = res.products.find((x: { product_id: string }) => x.product_id === p.mag.id);
    const d3 = res.products.find((x: { product_id: string }) => x.product_id === p.d3.id);
    expect(mag).toMatchObject({ fit: 'helps', level: 'B', level_text: 'Есть данные исследований' });
    expect(d3).toMatchObject({ fit: 'no_data', level: null }); // the model said «helps», our base has nothing
    expect(res.steps).toHaveLength(2);
    const logged = await prisma.ai_requests.findFirstOrThrow({ where: { scenario: 'cart_goal' }, orderBy: { created_at: 'desc' } });
    expect(logged).toMatchObject({ status: 'ok', model: 'claude-haiku-5-5' });
  });

  it('wrong chips, no consent, an empty cart, a bad answer of the model, the daily limit, switched off', async () => {
    const token = await customer();
    await add(token, p.mag.id);
    fake.reply = goodReply;
    await ask(token, { goal: 'sleep', duration: '2to4w', kind: 'strength' }).expect(400);
    await ask(token, { goal: 'love', duration: '2to4w', kind: 'fall_asleep' }).expect(400);
    // free text is not part of the question: it is dropped and never reaches the model
    await ask(token, { goal: 'sleep', duration: '2to4w', kind: 'fall_asleep', text: 'свободный текст 777' }).expect(200);
    expect(fake.calls.at(-1)!.data).not.toContain('свободный текст 777');

    const no = await customer(false);
    await add(no, p.mag.id);
    expect((await ask(no).expect(403)).body.code).toBe('CONSENT_REQUIRED');
    expect((await ask(await customer()).expect(400)).body.code).toBe('NOT_ENOUGH_ITEMS');

    fake.reply = () => ({ summary: 'Похоже на синдром усталости, магний поможет вам точно.', products: [], steps: [] });
    expect((await ask(token).expect(503)).body.code).toBe('AI_UNAVAILABLE');

    await http().put('/api/staff/ai/settings').set(bearer(tokens.admin)).send({ settings: { chat_daily_limit: 1, goal_model: 'claude-sonnet-5-5' } }).expect(200);
    fake.reply = goodReply;
    const fresh = await customer();
    await add(fresh, p.mag.id);
    expect((await ask(fresh).expect(200)).body.left_today).toBe(0);
    expect(fake.calls.at(-1)!.model).toBe('claude-sonnet-5-5');
    expect((await ask(fresh).expect(429)).body.code).toBe('AI_DAILY_LIMIT');

    await http().put('/api/staff/ai/settings').set(bearer(tokens.admin)).send({ settings: { enabled: false, chat_daily_limit: 20 } }).expect(200);
    expect((await ask(token).expect(503)).body.code).toBe('AI_UNAVAILABLE');
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
  });
});
