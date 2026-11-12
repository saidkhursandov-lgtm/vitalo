import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AI_MODEL, type AiCompletion, type AiModel } from '../src/compat/ai-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

class FakeModel implements AiModel {
  key = true;
  fail = false;
  calls: { model: string; system: string; data: string }[] = [];
  reply: (data: string) => unknown = () => ({});
  ready() {
    return this.key;
  }
  async complete(input: { model: string; system: string; data: string }): Promise<AiCompletion> {
    this.calls.push(input);
    if (this.fail) throw new (await import('../src/compat/ai-client')).AiCallError('timeout');
    return { json: this.reply(input.data), inputTokens: 1200, outputTokens: 300, outcome: 'ok' };
  }
}

/** D-70: «Спросить VITALO AI о корзине» — the conversation, its storage and «VITALO AI → Переписки»; a fake model only. */
describe('D-70: переписка с VITALO AI (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeModel();
  const tokens: Record<string, string> = {};
  let tg = 839_300_000;
  // digits only: a random «b6» or «b12» in a name would change the topics of the cart
  const run = String(Date.now());
  const http = () => request(app.getHttpServer());
  const p: Record<string, { id: string; sku: string }> = {};
  const s: Record<string, string> = {};

  async function customer(consent = true) {
    const telegram = ++tg;
    const token = await loginCustomer(app, telegram);
    await prisma.users.update({ where: { telegram_user_id: BigInt(telegram) }, data: { language: 'ru', ...(consent && { ai_chat_consent_at: new Date(), ai_consent_at: new Date() }) } });
    return token;
  }
  const add = (token: string, productId: string) => http().post('/api/cart/items').set(bearer(token)).send({ product_id: productId, qty: 1 }).expect(201);
  const say = (token: string, text: string, chatId?: string) => http().post('/api/compat/ai/chat/message').set(bearer(token)).send({ text, ...(chatId && { chat_id: chatId }) });
  const skusOf = (data: string) => [...data.matchAll(/- id (\S+) \|/g)].map((m) => m[1]);
  const answer = (data: string) => ({
    kind: 'answer',
    goal: 'sleep',
    text: 'Для сна из вашей корзины может помочь магний, если мешает напряжение.',
    clarify_options: [],
    products: skusOf(data).map((id) => ({ productId: id, fit: 'helps', text: 'Может помочь, если сон мешает напряжение после дня.' })),
    steps: ['Ложитесь в одно и то же время.'],
    followups: ['Как принимать их вместе?', 'Что ещё может помочь со сном?'],
  });

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(AI_MODEL).useValue(fake));
    prisma = app.get(PrismaService);
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);
    for (const code of ['mg', 'd3']) {
      s[code] = (await prisma.substances.create({ data: { code: `chat_${code}_${run}`, name_ru: code === 'mg' ? `Магний ${run}` : `Витамин D3 ${run}`, name_uz: `Modda ${code}`, synonyms: [] } })).id;
    }
    const product = async (key: string, subs: string[]) => {
      const row = await createTestProduct(prisma, { price: 50_000, stock: 5, name: `Chat ${key} ${run}` });
      await prisma.product_substances.createMany({ data: subs.map((id) => ({ product_id: row.id, substance_id: id })) });
      p[key] = row;
    };
    await product('mag', [s.mg]);
    await product('d3', [s.d3]);
    await prisma.goal_evidence.create({
      data: { substance_id: s.mg, goal: 'sleep', level: 'B', helps_ru: 'при напряжении', helps_uz: 'zoʻriqishda', not_helps_ru: 'если мешает кофеин', not_helps_uz: 'kofein xalaqit bersa', status: 'approved' },
    });
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    await prisma.goal_evidence.updateMany({ where: { substance_id: { in: Object.values(s) } }, data: { status: 'off' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('the state: the consent of D-70 is asked once more; the topics of the cart come first', async () => {
    const telegram = ++tg;
    const token = await loginCustomer(app, telegram);
    // agreed to VITALO AI before D-70: the new consent is still needed
    await prisma.users.update({ where: { telegram_user_id: BigInt(telegram) }, data: { ai_consent_at: new Date() } });
    await add(token, p.mag.id);
    const st = (await http().get('/api/compat/ai/chat').set(bearer(token)).expect(200)).body;
    expect(st).toMatchObject({ available: true, consent: false, max_chars: 300, max_turns: 6, chat: null });
    expect(st.topics[0]).toBe('sleep');
    expect((await say(token, 'Мне трудно заснуть').expect(403)).body.code).toBe('CONSENT_REQUIRED');
    const after = (await http().post('/api/compat/ai/chat/consent').set(bearer(token)).expect(200)).body;
    expect(after.consent).toBe(true);
  });

  it('a conversation: the number, the history goes to the model, our label, follow-ups; phones never reach the model or the base', async () => {
    const token = await customer();
    await add(token, p.mag.id);
    await add(token, p.d3.id);
    fake.reply = () => ({ kind: 'clarify', goal: 'sleep', text: 'Подскажите, вам трудно заснуть или вы просыпаетесь ночью?', clarify_options: ['Трудно заснуть', 'Просыпаюсь ночью'], products: [], steps: [], followups: [] });
    const first = (await say(token, 'Плохо сплю, мой номер +998 90 123 45 67').expect(200)).body;
    expect(first.chat.number).toMatch(/^AI-\d{8}-\d{4}$/);
    expect(first.chat.messages.map((m: { role: string; kind: string }) => `${m.role}:${m.kind}`)).toEqual(['user:question', 'ai:clarify']);
    expect(first.chat.messages[0].text).not.toContain('123 45 67');
    expect(first.chat.messages[1].options).toEqual(['Трудно заснуть', 'Просыпаюсь ночью']);
    expect(fake.calls.at(-1)!.data).not.toContain('123 45 67');
    expect(fake.calls.at(-1)!.data).toContain('осталось уточнений: 2');

    fake.reply = answer;
    const second = (await say(token, 'Трудно заснуть', first.chat.id).expect(200)).body;
    const sent = fake.calls.at(-1)!.data;
    expect(sent).toContain('Покупатель: Плохо сплю');
    expect(sent).toContain('VITALO AI: Подскажите');
    expect(sent).toContain('осталось уточнений: 1');
    expect(sent).toContain('<вопрос>Трудно заснуть</вопрос>');
    const ai = second.chat.messages.at(-1);
    expect(ai).toMatchObject({ kind: 'answer', topic: 'sleep', doctor: 'Если проблема держится дольше 3–4 недель — обратитесь к врачу.', specialist: true });
    expect(ai.followups).toEqual(['Как принимать их вместе?', 'Что ещё может помочь со сном?']);
    const mag = ai.products.find((x: { product_id: string }) => x.product_id === p.mag.id);
    const d3 = ai.products.find((x: { product_id: string }) => x.product_id === p.d3.id);
    expect(mag).toMatchObject({ fit: 'helps', level: 'B', level_text: 'Есть данные исследований', in_cart: true });
    expect(d3).toMatchObject({ fit: 'no_data', level: null }); // the model said «helps», our base has nothing
    expect(second.chat.questions).toBe(2);
    const chat = await prisma.ai_chats.findUniqueOrThrow({ where: { id: first.chat.id } });
    expect(chat).toMatchObject({ topic: 'sleep', outcome: 'answered', questions: 2, empty_cart: false });
    expect(Number(chat.cost_usd)).toBeGreaterThan(0);
    // the same conversation is returned to the customer
    expect((await http().get('/api/compat/ai/chat').set(bearer(token)).expect(200)).body.chat.id).toBe(first.chat.id);
  });

  it('red flags never reach the model; a bad answer and a failure are a message with the specialist; limits', async () => {
    const token = await customer();
    await add(token, p.mag.id);
    const calls = fake.calls.length;
    const red = (await say(token, 'Я беременна, можно магний?').expect(200)).body;
    expect(red.chat.messages.at(-1)).toMatchObject({ kind: 'red_flag', specialist: true });
    expect(red.chat.messages.at(-1).text).toContain('обсудить с врачом');
    expect(fake.calls.length).toBe(calls);

    fake.reply = () => ({ kind: 'answer', goal: 'sleep', text: 'Похоже на синдром усталости, принимайте 400 мг магния.', clarify_options: [], products: [], steps: [], followups: [] });
    const bad = (await say(token, 'Что поможет уснуть?', red.chat.id).expect(200)).body;
    expect(bad.chat.messages.at(-1)).toMatchObject({ kind: 'failed', specialist: true });
    fake.fail = true;
    const failed = (await say(token, 'А как принимать?', red.chat.id).expect(200)).body;
    fake.fail = false;
    expect(failed.chat.messages.at(-1).kind).toBe('failed');
    expect((await say(token, 'x'.repeat(301), red.chat.id).expect(400)).body.code).toBe('TOO_LONG');
    expect((await say(token, '   ', red.chat.id).expect(400)).body.code).toBe('EMPTY');

    // 6 questions in a conversation
    fake.reply = answer;
    for (let i = 0; i < 3; i++) await say(token, `Вопрос номер ${i}`, red.chat.id).expect(200);
    expect((await say(token, 'Седьмой', red.chat.id).expect(409)).body.code).toBe('CHAT_FULL');
    // another customer's conversation is not found
    expect((await say(await customer(), 'Привет', red.chat.id).expect(404)).body.code).toBe('NOT_FOUND');

    // the daily limit counts answered questions
    await prisma.settings.upsert({ where: { key: 'vitalo_ai' }, create: { key: 'vitalo_ai', value: { chat_daily_limit: 1 } }, update: { value: { chat_daily_limit: 1 } } });
    const limited = await customer();
    await say(limited, 'Что поможет уснуть?').expect(200);
    expect((await say(limited, 'А ещё?').expect(429)).body.code).toBe('AI_DAILY_LIMIT');
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
  });

  it('an empty cart: products of the catalogue approved for the goal, «В корзину»', async () => {
    const token = await customer();
    fake.reply = (data: string) => ({
      kind: 'answer',
      goal: 'sleep',
      text: 'Для сна можно присмотреться к магнию из нашего каталога.',
      clarify_options: [],
      products: skusOf(data).slice(0, 1).map((id) => ({ productId: id, fit: 'maybe', text: 'Может помочь при напряжении после дня.' })),
      steps: [],
      followups: ['Как принимать магний?'],
    });
    const res = (await say(token, 'Что выпить при бессоннице?').expect(200)).body;
    expect(fake.calls.at(-1)!.data).toContain('корзина пуста');
    expect(fake.calls.at(-1)!.data).toContain('<товары каталога для целей>');
    const ai = res.chat.messages.at(-1);
    expect(ai.products.length).toBe(1);
    expect(ai.products[0]).toMatchObject({ in_cart: false, fit: 'maybe' });
    expect((await prisma.ai_chats.findUniqueOrThrow({ where: { id: res.chat.id } })).empty_cart).toBe(true);
  });

  it('«Переписки»: the admin and a specialist see them by month, opening is audited, the mark; a manager cannot; the customer deletes', async () => {
    const token = await customer();
    await add(token, p.mag.id);
    fake.reply = answer;
    const res = (await say(token, 'Мне трудно заснуть').expect(200)).body;
    const id = res.chat.id;
    await http().get('/api/staff/ai/chats').set(bearer(tokens.manager)).expect(403);
    const list = (await http().get('/api/staff/ai/chats').query({ topic: 'sleep' }).set(bearer(tokens.admin)).expect(200)).body;
    expect(list.month).toMatch(/^\d{4}-\d{2}$/);
    expect(list.items.some((c: { id: string }) => c.id === id)).toBe(true);
    const byNumber = (await http().get('/api/staff/ai/chats').query({ q: res.chat.number }).set(bearer(tokens.admin)).expect(200)).body;
    expect(byNumber.items.map((c: { id: string }) => c.id)).toEqual([id]);
    const one = (await http().get(`/api/staff/ai/chats/${id}`).set(bearer(tokens.admin)).expect(200)).body;
    expect(one.messages.map((m: { text: string }) => m.text)[0]).toBe('Мне трудно заснуть');
    expect(one.cart[0]).toMatchObject({ product_id: p.mag.id });
    expect(await prisma.audit_logs.count({ where: { entity_type: 'ai_chat', entity_id: id, action: 'ai_chat.viewed' } })).toBe(1);
    await http().patch(`/api/staff/ai/chats/${id}`).set(bearer(tokens.admin)).send({ review: 'wrong', note: 'Не учёл кофеин' }).expect(200);
    expect(await prisma.ai_chats.findUniqueOrThrow({ where: { id } })).toMatchObject({ review: 'wrong', review_note: 'Не учёл кофеин' });

    await http().delete(`/api/compat/ai/chat/${id}`).set(bearer(token)).expect(200);
    const gone = await prisma.ai_chat_messages.findMany({ where: { chat_id: id } });
    expect(gone.every((m) => m.text === null && m.payload === null)).toBe(true);
    expect((await http().get('/api/compat/ai/chat').set(bearer(token)).expect(200)).body.chat).toBeNull();
  });
});
