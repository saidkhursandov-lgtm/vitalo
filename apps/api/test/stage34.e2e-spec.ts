import { INestApplication } from '@nestjs/common';
import { DEFAULT_TEMPLATES } from '../src/compat/compat';
import request from 'supertest';
import { CompatService } from '../src/compat/compat.service';
import { NotificationWorker } from '../src/notifications/notification-worker';
import { TELEGRAM_SENDER, type SendOptions, type TelegramSender } from '../src/notifications/telegram-sender';
import { PrismaService } from '../src/prisma/prisma.service';
import { TEST_ENV } from './test-env';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const SPECIALIST_TG = 834_000_001; // a marketer marked «специалист»
const MARKETER_TG = 834_000_002; // a plain marketer
const WAREHOUSE_TG = 834_000_003;

class FakeSender implements TelegramSender {
  sent: { chatId: bigint; text: string; opts?: SendOptions; id: number }[] = [];
  edited: { chatId: bigint; messageId: number; text: string }[] = [];
  private next = 1000;
  async sendMessage(chatId: bigint, text: string, opts?: SendOptions) {
    const id = ++this.next;
    this.sent.push({ chatId, text, opts, id });
    return id;
  }
  async editMessage(chatId: bigint, messageId: number, text: string) {
    this.edited.push({ chatId, messageId, text });
  }
}

/** 3.4: «Проверить совместимость у специалиста» (D-40). */
describe('Stage 3.4 compatibility check (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let compat: CompatService;
  let worker: NotificationWorker;
  const fake = new FakeSender();
  const tokens: Record<string, string> = {};
  let tg = 834_100_000;
  const http = () => request(app.getHttpServer());
  const secret = { 'x-bot-secret': TEST_ENV.BOT_API_SECRET };

  async function customer(lang: 'ru' | 'uz' = 'ru') {
    const telegram = ++tg;
    const token = await loginCustomer(app, telegram);
    await prisma.users.update({ where: { telegram_user_id: BigInt(telegram) }, data: { language: lang } });
    const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(telegram) } });
    return { telegram, token, user };
  }
  const add = (token: string, productId: string, qty = 1) => http().post('/api/cart/items').set(bearer(token)).send({ product_id: productId, qty }).expect(201);
  const removeLine = (token: string, productId: string) => http().delete(`/api/cart/items/${productId}`).set(bearer(token));
  const state = async (token: string) => (await http().get('/api/compat').set(bearer(token)).expect(200)).body;
  const ask = (token: string, comment?: string) => http().post('/api/compat').set(bearer(token)).send(comment === undefined ? {} : { comment });
  const botAnswer = (staffTg: number, id: string, verdict: string, text?: string) => http().post(`/api/internal/bot/compat/${id}/answer`).set(secret).send({ telegram_id: String(staffTg), verdict, text });

  /** Sends only the messages of this suite (other suites run in parallel on the same database). */
  async function drain() {
    const mine = await prisma.notifications.findMany({
      where: { status: 'queued', OR: [{ template: 'staff.compat_request' }, { template: 'compat.answered' }] },
      select: { id: true },
    });
    if (mine.length) await worker.processOnce(new Date(), mine.map((n) => n.id));
  }

  async function staffRow(telegram: number, name: string, role: 'marketer' | 'warehouse', isSpecialist: boolean) {
    await prisma.staff_users.upsert({
      where: { telegram_user_id: BigInt(telegram) },
      create: { telegram_user_id: BigInt(telegram), name, role, is_specialist: isSpecialist },
      update: { status: 'active', role, is_specialist: isSpecialist, name },
    });
  }

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(TELEGRAM_SENDER).useValue(fake));
    prisma = app.get(PrismaService);
    compat = app.get(CompatService);
    worker = app.get(NotificationWorker);
    await staffRow(SPECIALIST_TG, 'Специалист E2E', 'marketer', true);
    await staffRow(MARKETER_TG, 'Маркетолог E2E', 'marketer', false);
    await staffRow(WAREHOUSE_TG, 'Склад E2E', 'warehouse', false);
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);
    tokens.specialist = await loginStaff(app, SPECIALIST_TG);
    tokens.marketer = await loginStaff(app, MARKETER_TG);
    tokens.warehouse = await loginStaff(app, WAREHOUSE_TG);
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'compat_templates' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('the button needs 2+ different products; a request goes to admins and specialists with quick answers', async () => {
    const c = await customer();
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id, 3);
    expect(await state(c.token)).toMatchObject({ eligible: false, request: null, left_today: 5 });
    expect((await ask(c.token).expect(400)).body.code).toBe('NOT_ENOUGH_ITEMS');

    await add(c.token, b.id);
    expect((await state(c.token)).eligible).toBe(true);
    const sent = (await ask(c.token, 'Принимаю L-тироксин').expect(200)).body;
    expect(sent).toMatchObject({ result: 'sent', left_today: 4, request: { status: 'pending', source: 'specialist', changed: false } });
    expect(sent.request.products).toHaveLength(2);

    // one waiting request per cart composition
    expect((await ask(c.token).expect(409)).body.code).toBe('ALREADY_PENDING');

    const rows = await prisma.notifications.findMany({ where: { template: 'staff.compat_request', payload: { path: ['compat_id'], equals: sent.request.id } }, include: { staff: true } });
    const who = rows.map((r) => Number(r.staff!.telegram_user_id));
    expect(who).toEqual(expect.arrayContaining([ADMIN_TG, SPECIALIST_TG]));
    expect(who).not.toContain(DEV_MANAGER_TG);
    expect(who).not.toContain(MARKETER_TG);
    expect(who).not.toContain(WAREHOUSE_TG);

    await drain();
    const msg = fake.sent.find((s) => s.chatId === BigInt(SPECIALIST_TG) && s.text.includes('Проверка совместимости'))!;
    expect(msg.text).toContain('Принимаю L-тироксин');
    expect(msg.text).toContain('русский (RU)');
    const data = msg.opts!.buttons!.flat().map((x) => x.data);
    expect(data).toEqual([`cp:c:${sent.request.id}`, `cp:s:${sent.request.id}`, `cp:k:${sent.request.id}`, `cp:t:${sent.request.id}`]);
    const stored = await prisma.notifications.findFirstOrThrow({ where: { id: rows.find((r) => Number(r.staff!.telegram_user_id) === SPECIALIST_TG)!.id } });
    expect((stored.payload as { tg_message_id?: number }).tg_message_id).toBe(msg.id);

    expect(await prisma.analytics_events.count({ where: { user_id: c.user.id, event: 'compat_request' } })).toBe(1);
    const ev = await prisma.analytics_events.findFirstOrThrow({ where: { user_id: c.user.id, event: 'compat_request' } });
    expect(JSON.stringify(ev.props)).not.toContain('тироксин'); // the comment never goes to analytics
  });

  it('the bot answer reaches the customer (bot + centre + cart); the first answer wins; other roles cannot answer', async () => {
    const c = await customer('uz');
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id);
    await add(c.token, b.id);
    const id = (await ask(c.token).expect(200)).body.request.id;
    await drain();

    expect((await botAnswer(DEV_MANAGER_TG, id, 'c').expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    expect((await botAnswer(MARKETER_TG, id, 'c').expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    await http().post(`/api/internal/bot/compat/${id}/answer`).send({ telegram_id: String(SPECIALIST_TG), verdict: 'c' }).expect(401); // no bot secret

    const res = (await botAnswer(SPECIALIST_TG, id, 's').expect(200)).body;
    expect(res).toEqual({ result: 'answered', verdict: 'spread', by: 'Специалист E2E' });
    expect((await botAnswer(ADMIN_TG, id, 'c').expect(200)).body).toEqual({ result: 'already', verdict: 'spread', by: 'Специалист E2E' });

    // the template in the customer's language
    const s = await state(c.token);
    expect(s.request).toMatchObject({ status: 'answered', verdict: 'spread', changed: false });
    expect(s.request.text).toContain('soat');

    // the buttons are removed from every staff message of the request
    const edited = fake.edited.filter((e) => e.text.includes('Ответ дан — Специалист E2E: Разнести по времени'));
    expect(edited.map((e) => Number(e.chatId))).toEqual(expect.arrayContaining([ADMIN_TG, SPECIALIST_TG]));

    await drain();
    const toCustomer = fake.sent.find((m) => m.chatId === BigInt(c.telegram))!;
    expect(toCustomer.text).toContain('Vaqt boʻyicha ajrating');
    expect(toCustomer.text).toContain('Tibbiy maslahat hisoblanmaydi');
    expect(toCustomer.opts?.webApp?.url).toMatch(/\/cart$/);

    const centre = (await http().get('/api/notifications?lang=uz').set(bearer(c.token)).expect(200)).body;
    const card = centre.items.find((i: { template: string }) => i.template === 'compat.answered');
    expect(card).toMatchObject({ tab: 'orders', category: 'compat', path: '/cart', read: false, title: 'Moslikni tekshirish' });
    expect(centre.tabs.orders).toBeGreaterThanOrEqual(1);

    expect(await prisma.analytics_events.count({ where: { user_id: c.user.id, event: 'compat_answered', props: { path: ['via'], equals: 'bot' } } })).toBe(1);

    // the cart changed after the answer: «Состав корзины изменился — проверьте снова»
    const extra = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    await add(c.token, extra.id);
    expect((await state(c.token)).request).toMatchObject({ status: 'answered', changed: true });
    await removeLine(c.token, extra.id);
    expect((await state(c.token)).request.changed).toBe(false); // quantities and order never matter, the set does
  });

  it('own text from the bot is sent as written', async () => {
    const c = await customer();
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id);
    await add(c.token, b.id);
    const id = (await ask(c.token).expect(200)).body.request.id;
    await botAnswer(ADMIN_TG, id, 'k', 'Магний лучше вечером, а железо утром.').expect(200);
    expect((await state(c.token)).request).toMatchObject({ verdict: 'consult', text: 'Магний лучше вечером, а железо утром.' });
  });

  it('the customer switched RU → UZ after asking: a template answer comes in UZ; switching back shows RU; own text stays', async () => {
    const c = await customer('ru');
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id);
    await add(c.token, b.id);
    const id = (await ask(c.token).expect(200)).body.request.id;
    await prisma.users.update({ where: { id: c.user.id }, data: { language: 'uz' } });
    await botAnswer(SPECIALIST_TG, id, 'c').expect(200);
    expect((await state(c.token)).request.text).toBe(DEFAULT_TEMPLATES.compatible.uz);
    expect((await prisma.compat_requests.findUniqueOrThrow({ where: { id } })).lang).toBe('uz');

    await drain();
    const toCustomer = fake.sent.filter((m) => m.chatId === BigInt(c.telegram)).pop()!;
    expect(toCustomer.text).toContain(DEFAULT_TEMPLATES.compatible.uz);

    await prisma.users.update({ where: { id: c.user.id }, data: { language: 'ru' } });
    expect((await state(c.token)).request.text).toBe(DEFAULT_TEMPLATES.compatible.ru);
    const centre = (await http().get('/api/notifications?lang=ru').set(bearer(c.token)).expect(200)).body;
    expect(centre.items.find((i: { template: string }) => i.template === 'compat.answered').body).toContain(DEFAULT_TEMPLATES.compatible.ru);

    // own text: written for the language of the request, never swapped
    const d = await customer('ru');
    await add(d.token, a.id);
    await add(d.token, b.id);
    const id2 = (await ask(d.token).expect(200)).body.request.id;
    await prisma.users.update({ where: { id: d.user.id }, data: { language: 'uz' } });
    await botAnswer(ADMIN_TG, id2, 'k', 'Магний вечером.').expect(200);
    expect((await state(d.token)).request.text).toBe('Магний вечером.');
  });

  it('a reusable answer is given at once for the same set in any order and quantity, same language, without a comment', async () => {
    const [a, b, x] = [await createTestProduct(prisma, { price: 50_000, stock: 20 }), await createTestProduct(prisma, { price: 60_000, stock: 20 }), await createTestProduct(prisma, { price: 70_000, stock: 20 })];
    const first = await customer();
    await add(first.token, a.id);
    await add(first.token, b.id);
    const id = (await ask(first.token).expect(200)).body.request.id;
    await http().post(`/api/staff/compat/requests/${id}/answer`).set(bearer(tokens.admin)).send({ verdict: 'compatible', text: 'Можно вместе, утром.', reuse: true }).expect(200);
    const saved = (await http().get('/api/staff/compat/answers').set(bearer(tokens.admin)).expect(200)).body;
    expect(saved.find((s: { text: string }) => s.text === 'Можно вместе, утром.')).toMatchObject({ lang: 'ru', verdict: 'compatible', enabled: true });

    // another customer, the products added in the other order and with other quantities
    const second = await customer();
    await add(second.token, b.id, 2);
    await add(second.token, a.id, 4);
    const before = await prisma.notifications.count({ where: { template: 'staff.compat_request' } });
    const instant = (await ask(second.token).expect(200)).body;
    expect(instant).toMatchObject({ result: 'instant', left_today: 5, request: { status: 'answered', source: 'instant', verdict: 'compatible', text: 'Можно вместе, утром.' } });
    expect(await prisma.notifications.count({ where: { template: 'staff.compat_request' } })).toBe(before); // nobody is bothered
    expect(await prisma.analytics_events.count({ where: { user_id: second.user.id, event: 'compat_instant_answer' } })).toBe(1);

    // with a comment — a person reads it
    const third = await customer();
    await add(third.token, a.id);
    await add(third.token, b.id);
    expect((await ask(third.token, 'Беременность').expect(200)).body.result).toBe('sent');

    // another language — no saved answer
    const uz = await customer('uz');
    await add(uz.token, a.id);
    await add(uz.token, b.id);
    expect((await ask(uz.token).expect(200)).body.result).toBe('sent');

    // a bigger set is another set
    const bigger = await customer();
    await add(bigger.token, a.id);
    await add(bigger.token, b.id);
    await add(bigger.token, x.id);
    expect((await ask(bigger.token).expect(200)).body.result).toBe('sent');

    // switched off — no longer given
    const savedId = saved.find((s: { text: string }) => s.text === 'Можно вместе, утром.').id;
    await http().patch(`/api/staff/compat/answers/${savedId}`).set(bearer(tokens.manager)).send({ enabled: false }).expect(403);
    await http().patch(`/api/staff/compat/answers/${savedId}`).set(bearer(tokens.specialist)).send({ enabled: false }).expect(200);
    const fourth = await customer();
    await add(fourth.token, a.id);
    await add(fourth.token, b.id);
    expect((await ask(fourth.token).expect(200)).body.result).toBe('sent');
  });

  it('no more than 5 requests a day; instant answers do not count; a changed cart closes the waiting request', async () => {
    const c = await customer();
    const products = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => createTestProduct(prisma, { price: 20_000, stock: 50 })));
    await add(c.token, products[0].id);
    for (let i = 1; i <= 5; i++) {
      await add(c.token, products[i].id);
      expect((await ask(c.token).expect(200)).body.result).toBe('sent');
    }
    // every new request closed the previous one (its cart changed)
    expect(await prisma.compat_requests.count({ where: { user_id: c.user.id, status: 'closed' } })).toBe(4);
    expect(await prisma.compat_requests.count({ where: { user_id: c.user.id, status: 'pending' } })).toBe(1);
    expect((await state(c.token)).left_today).toBe(0);
    await add(c.token, products[6].id);
    expect((await ask(c.token).expect(429)).body.code).toBe('DAILY_LIMIT');

    // a closed request cannot be answered any more
    const closed = await prisma.compat_requests.findFirstOrThrow({ where: { user_id: c.user.id, status: 'closed' } });
    expect((await botAnswer(ADMIN_TG, closed.id, 'c').expect(200)).body).toEqual({ result: 'closed' });
  });

  it('roles: the manager sees requests without the comment, a specialist sees it, others have no access', async () => {
    const c = await customer();
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id);
    await add(c.token, b.id);
    const id = (await ask(c.token, 'Пью варфарин').expect(200)).body.request.id;

    const byManager = (await http().get('/api/staff/compat/requests?status=pending').set(bearer(tokens.manager)).expect(200)).body.find((r: { id: string }) => r.id === id);
    expect(byManager).toMatchObject({ has_comment: true, comment: null, comment_hidden: true });
    const bySpecialist = (await http().get('/api/staff/compat/requests').set(bearer(tokens.specialist)).expect(200)).body.find((r: { id: string }) => r.id === id);
    expect(bySpecialist).toMatchObject({ comment: 'Пью варфарин', comment_hidden: false });
    await http().get('/api/staff/compat/requests').set(bearer(tokens.marketer)).expect(403);
    await http().get('/api/staff/compat/requests').set(bearer(tokens.warehouse)).expect(403);

    await http().post(`/api/staff/compat/requests/${id}/answer`).set(bearer(tokens.manager)).send({ verdict: 'compatible' }).expect(403);
    await http().put('/api/staff/compat/templates').set(bearer(tokens.manager)).send({ templates: {} }).expect(403);

    const me = (await http().get('/api/staff/auth/me').set(bearer(tokens.specialist)).expect(200)).body;
    expect(me.permissions).toEqual(expect.arrayContaining(['compat.view', 'compat.answer', 'promo.manage']));
    const mgr = (await http().get('/api/staff/auth/me').set(bearer(tokens.manager)).expect(200)).body;
    expect(mgr.permissions).toContain('compat.view');
    expect(mgr.permissions).not.toContain('compat.answer');

    // the admin can mark an employee «специалист» in «Сотрудники»
    const marketer = await prisma.staff_users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(MARKETER_TG) } });
    const list = (await http().patch(`/api/staff/users/${marketer.id}`).set(bearer(tokens.admin)).send({ is_specialist: true }).expect(200)).body;
    expect(list.find((s: { id: string }) => s.id === marketer.id).is_specialist).toBe(true);
    await prisma.staff_users.update({ where: { id: marketer.id }, data: { is_specialist: false } });

    // the comment is not in the audit log
    await http().post(`/api/staff/compat/requests/${id}/answer`).set(bearer(tokens.specialist)).send({ verdict: 'consult' }).expect(200);
    const audit = await prisma.audit_logs.findFirstOrThrow({ where: { action: 'compat.answered', entity_id: id } });
    expect(JSON.stringify(audit)).not.toContain('варфарин');
  });

  it('templates are edited by an admin and used for quick answers', async () => {
    const templates = (await http().get('/api/staff/compat/templates').set(bearer(tokens.manager)).expect(200)).body;
    templates.compatible.ru = 'Шаблон E2E: можно вместе.';
    await http().put('/api/staff/compat/templates').set(bearer(tokens.admin)).send({ templates: { ...templates, spread: { ru: '', uz: 'x' } } }).expect(400);
    await http().put('/api/staff/compat/templates').set(bearer(tokens.admin)).send({ templates }).expect(200);

    const c = await customer();
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id);
    await add(c.token, b.id);
    const id = (await ask(c.token).expect(200)).body.request.id;
    await botAnswer(SPECIALIST_TG, id, 'c').expect(200);
    expect((await state(c.token)).request.text).toBe('Шаблон E2E: можно вместе.');
  });

  it('after 90 days the comment text is cleared; the request and the answer stay', async () => {
    const c = await customer();
    const [a, b] = [await createTestProduct(prisma, { price: 50_000, stock: 10 }), await createTestProduct(prisma, { price: 60_000, stock: 10 })];
    await add(c.token, a.id);
    await add(c.token, b.id);
    const id = (await ask(c.token, 'Диабет 2 типа').expect(200)).body.request.id;
    await botAnswer(ADMIN_TG, id, 'c').expect(200);

    // 89 days: still there
    const old = new Date(Date.now() - 89 * 24 * 3600_000);
    await prisma.compat_requests.update({ where: { id }, data: { created_at: old } });
    await prisma.notifications.updateMany({ where: { template: 'staff.compat_request', payload: { path: ['compat_id'], equals: id } }, data: { created_at: old } });
    await compat.purgeComments();
    expect((await prisma.compat_requests.findUniqueOrThrow({ where: { id } })).comment).toBe('Диабет 2 типа');

    const older = new Date(Date.now() - 91 * 24 * 3600_000);
    await prisma.compat_requests.update({ where: { id }, data: { created_at: older } });
    await prisma.notifications.updateMany({ where: { template: 'staff.compat_request', payload: { path: ['compat_id'], equals: id } }, data: { created_at: older } });
    expect(await compat.purgeComments()).toBeGreaterThanOrEqual(1);

    const row = await prisma.compat_requests.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ comment: null, status: 'answered', verdict: 'compatible' });
    expect(row.comment_purged_at).not.toBeNull();
    expect(row.answer_text).toBeTruthy();
    const staffRows = await prisma.notifications.findMany({ where: { template: 'staff.compat_request', payload: { path: ['compat_id'], equals: id } } });
    expect(staffRows.length).toBeGreaterThan(0);
    for (const n of staffRows) expect(JSON.stringify(n.payload)).not.toContain('Диабет');

    const listed = (await http().get('/api/staff/compat/requests?status=answered').set(bearer(tokens.admin)).expect(200)).body.find((r: { id: string }) => r.id === id);
    expect(listed).toMatchObject({ comment: null, comment_purged: true });
  });

  it('compat_view is accepted from the app', async () => {
    const c = await customer();
    await http().post('/api/analytics/events').set(bearer(c.token)).send({ event: 'compat_view', props: { verdict: 'compatible', source: 'instant', changed: false } }).expect(202);
    expect(await prisma.analytics_events.count({ where: { user_id: c.user.id, event: 'compat_view' } })).toBe(1);
  });
});
