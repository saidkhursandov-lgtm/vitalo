import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const MARKETER_TG = 222_222_224;
const WAREHOUSE_TG = 222_222_223;

/** 3.2: one message per order status (bot + Mini App centre), the centre, the active-order plaque, the intake memo, promos. */
describe('Stage 3.2 notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let manager: string;
  let tg = 832_100_000;
  const http = () => request(app.getHttpServer());

  async function customer() {
    const telegram = ++tg;
    const token = await loginCustomer(app, telegram);
    const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(telegram) } });
    return { telegram, token, user };
  }
  async function placeOrder(token: string, method: 'card_transfer' | 'cod' = 'card_transfer', memo?: { ru: string; uz?: string }) {
    const p = await createTestProduct(prisma, { price: 90_000, stock: 10 });
    if (memo) await prisma.products.update({ where: { id: p.id }, data: { intake_memo_ru: memo.ru, intake_memo_uz: memo.uz ?? null, short_name_ru: 'Магний B6', short_name_uz: 'Magniy B6' } });
    const body = {
      source: 'buy_now',
      buy_now: { product_id: p.id, qty: 1 },
      recipient_name: 'Тест Покупатель',
      recipient_phone: '90 123-45-67',
      ...(method === 'cod' ? addr.tashkent : addr.samarkand),
      address_text: 'ул. Тестовая, 1',
      payment_method: method,
    };
    const order = (await http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body;
    return { order, product: p };
  }
  const rowsOf = (orderId: string) => prisma.notifications.findMany({ where: { order_id: orderId }, orderBy: { created_at: 'asc' } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    manager = await loginStaff(app, DEV_MANAGER_TG);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('a card order gets one «принят, ожидает оплаты» with the pay button; a cash-on-delivery order — «ожидает подтверждения»', async () => {
    const c = await customer();
    const { order } = await placeOrder(c.token);
    const rows = await rowsOf(order.id);
    expect(rows.map((r) => r.template)).toEqual(['order.accepted_pay']);
    expect(rows[0]).toMatchObject({ category: 'order', user_id: c.user.id, dedup_key: `order:${order.id}:awaiting_payment` });
    expect(rows[0].payload).toMatchObject({ open_path: `/orders/${order.id}/pay`, open_button: 'pay', total_uzs: order.totals.total_uzs });
    // 6а-А: the centre card of an order opens the order itself (its screen has the right «Оплатить»)
    expect((await http().get('/api/notifications').set(bearer(c.token)).expect(200)).body.items[0]).toMatchObject({ path: `/orders/${order.id}` });

    const cod = await placeOrder(c.token, 'cod');
    expect((await rowsOf(cod.order.id)).map((r) => r.template)).toEqual(['order.accepted_cod']);
  });

  it('the same status twice gives one message (dedup)', async () => {
    const c = await customer();
    const { order } = await placeOrder(c.token);
    const n = app.get(NotificationsService);
    await n.orderStatusChanged(prisma, order.id, 'awaiting_payment');
    await n.orderStatusChanged(prisma, order.id, 'awaiting_payment');
    expect(await rowsOf(order.id)).toHaveLength(1);
  });

  it('intake memo: sent once after the payment, only products with a memo, with «Спросить специалиста»; the order card shows it', async () => {
    const c = await customer();
    const { order, product } = await placeOrder(c.token, 'card_transfer', { ru: 'По 1 таблетке вечером во время еды', uz: 'Kechqurun ovqat paytida 1 tabletkadan' });
    // before the payment: nothing in the card
    expect((await http().get(`/api/orders/${order.id}`).set(bearer(c.token)).expect(200)).body.intake_guide).toBeNull();

    await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    await app.get(NotificationsService).intakeGuide(prisma, order.id); // a second try changes nothing
    const rows = await rowsOf(order.id);
    expect(rows.map((r) => r.template)).toEqual(['order.accepted_pay', 'order.paid', 'order.intake_guide']);
    const guide = rows[2].payload as { guide: { name: string; text: string }[]; support_url: string | null };
    expect(guide.guide).toEqual([{ product_id: product.id, name: 'Магний B6', text: 'По 1 таблетке вечером во время еды' }]);
    expect(guide.support_url).toMatch(/^https:\/\/t\.me\//);
    expect(await prisma.analytics_events.count({ where: { user_id: c.user.id, event: 'intake_guide_sent' } })).toBe(1);

    const card = (await http().get(`/api/orders/${order.id}`).set(bearer(c.token)).expect(200)).body;
    expect(card.intake_guide.ru).toEqual([{ product_id: product.id, name: 'Магний B6', text: 'По 1 таблетке вечером во время еды' }]);
    expect(card.intake_guide.uz[0]).toMatchObject({ name: 'Magniy B6', text: 'Kechqurun ovqat paytida 1 tabletkadan' });
    expect(card.intake_guide.footer.ru).toContain('Сверяйте с этикеткой');

    // no product with a memo: no message at all
    const plain = await placeOrder(c.token);
    await http().post(`/api/staff/orders/${plain.order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    expect((await rowsOf(plain.order.id)).map((r) => r.template)).toEqual(['order.accepted_pay', 'order.paid']);
  });

  it('cash on delivery confirmed by the manager also gets the memo', async () => {
    const c = await customer();
    const { order } = await placeOrder(c.token, 'cod', { ru: 'Утром натощак' });
    await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    expect((await rowsOf(order.id)).map((r) => r.template)).toEqual(['order.accepted_cod', 'order.cod_confirmed', 'order.intake_guide']);
  });

  it('centre: one card per order with its steps, tabs, unread per tab, read one, read all; only own rows; RU/UZ', async () => {
    const c = await customer();
    const other = await customer();
    const zero = { personal: 0, orders: 0, promo: 0, service: 0 };
    const { order } = await placeOrder(c.token);
    await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);

    // two messages about the order (accepted, paid) = one card, the bell counts 1
    let list = (await http().get('/api/notifications?lang=uz').set(bearer(c.token)).expect(200)).body;
    expect(list).toMatchObject({ unread: 1, tabs: { personal: 0, orders: 1, promo: 0, service: 0 } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      tab: 'orders', category: 'order', template: 'order.paid', title: `№${order.order_number} buyurtma`, body: 'To‘lov tasdiqlandi',
      steps: ['Qabul qilindi', 'To‘landi'], has_guide: false, path: `/orders/${order.id}`, read: false,
    });

    const promo = { user_id: c.user.id, chat_id: BigInt(c.telegram), payload: { order_number: '', lang: 'ru', title_ru: 'Акция', text_ru: 'Текст' }, template: 'promo.message', kind: 'marketing', category: 'promo', status: 'sent' };
    await prisma.notifications.create({ data: promo });
    list = (await http().get('/api/notifications').set(bearer(c.token)).expect(200)).body;
    expect(list).toMatchObject({ unread: 2, tabs: { personal: 0, orders: 1, promo: 1, service: 0 } });
    expect(list.items.map((i: { tab: string }) => i.tab)).toEqual(['promo', 'orders']);
    const card = list.items[1];

    // opening the card marks every message of the order read
    await http().post(`/api/notifications/${card.id}/read`).set(bearer(other.token)).expect(404);
    expect((await http().post(`/api/notifications/${card.id}/read`).set(bearer(c.token)).expect(200)).body).toEqual({ unread: 1, tabs: { personal: 0, orders: 0, promo: 1, service: 0 } });
    expect(await prisma.notifications.count({ where: { order_id: order.id, read_at: null } })).toBe(0);

    // a new status: the same card goes up and is unread again
    await app.get(NotificationsService).orderStatusChanged(prisma, order.id, 'picking');
    list = (await http().get('/api/notifications').set(bearer(c.token)).expect(200)).body;
    expect(list.items[0]).toMatchObject({ tab: 'orders', template: 'order.picking', steps: ['Принят', 'Оплачен', 'Собирается'], read: false });
    expect(list.items).toHaveLength(2);

    expect((await http().get('/api/notifications/unread').set(bearer(c.token)).expect(200)).body).toEqual({ unread: 2, tabs: { personal: 0, orders: 1, promo: 1, service: 0 } });
    expect((await http().post('/api/notifications/read-all').set(bearer(c.token)).expect(200)).body).toEqual({ marked: 2, unread: 0, tabs: zero });
    expect((await http().get('/api/notifications').set(bearer(other.token)).expect(200)).body).toEqual({ unread: 0, tabs: zero, items: [] });
  });

  it('centre: the intake memo is a note on the order card, «снова в наличии» goes to «Сервисные»', async () => {
    const c = await customer();
    const { order } = await placeOrder(c.token, 'card_transfer', { ru: 'Утром' });
    await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    await prisma.notifications.create({
      data: { user_id: c.user.id, chat_id: BigInt(c.telegram), payload: { order_number: '', lang: 'ru', product: 'Омега-3' }, template: 'waitlist.back_in_stock', kind: 'transactional', category: 'waitlist', status: 'sent' },
    });
    const list = (await http().get('/api/notifications').set(bearer(c.token)).expect(200)).body;
    expect(list.tabs).toEqual({ personal: 0, orders: 1, promo: 0, service: 1 });
    const card = list.items.find((i: { tab: string }) => i.tab === 'orders');
    expect(card).toMatchObject({ template: 'order.paid', body: 'Оплата подтверждена', steps: ['Принят', 'Оплачен'], has_guide: true });
  });

  it('centre hides: staff messages, rows older than 90 days, skipped promos, promos put off until the morning', async () => {
    const c = await customer();
    const base = { user_id: c.user.id, chat_id: BigInt(c.telegram), payload: { order_number: '', lang: 'ru', title_ru: 'Акция', text_ru: 'Текст' }, template: 'promo.message', kind: 'marketing' };
    await prisma.notifications.create({ data: { ...base, category: 'promo', status: 'sent' } });
    await prisma.notifications.create({ data: { ...base, category: 'promo', status: 'skipped' } });
    await prisma.notifications.create({ data: { ...base, category: 'promo', next_attempt_at: new Date(Date.now() + 3600_000) } });
    await prisma.notifications.create({ data: { ...base, category: 'promo', status: 'sent', created_at: new Date(Date.now() - 91 * 24 * 3600_000) } });
    await prisma.notifications.create({ data: { ...base, category: 'bonus', status: 'sent' } }); // release 4: not shown yet
    await prisma.notifications.create({ data: { ...base, category: null, status: 'sent' } });
    const list = (await http().get('/api/notifications').set(bearer(c.token)).expect(200)).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ category: 'promo', title: 'Акция', body: 'Текст' });
  });

  it('active order plaque: the newest unfinished order, «+N», «Оплатить» only while waiting for the transfer', async () => {
    const c = await customer();
    expect((await http().get('/api/orders/active').set(bearer(c.token)).expect(200)).body).toEqual({ order: null, more: 0 });
    const first = await placeOrder(c.token);
    await http().post(`/api/staff/orders/${first.order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    const second = await placeOrder(c.token);
    const res = (await http().get('/api/orders/active').set(bearer(c.token)).expect(200)).body;
    expect(res.more).toBe(1);
    expect(res.order).toMatchObject({ id: second.order.id, status: 'awaiting_payment', can_pay: true, payment_reported: false });
    expect(res.order.delivery_eta).toHaveProperty('min_days');

    await http().post(`/api/orders/${second.order.id}/payment/bank-transfer/paid`).set(bearer(c.token)).send({}).expect(200);
    expect((await http().get('/api/orders/active').set(bearer(c.token)).expect(200)).body.order).toMatchObject({ can_pay: false, payment_reported: true });

    await http().post(`/api/staff/orders/${second.order.id}/cancel`).set(bearer(manager)).send({ reason: 'Тест' }).expect(200);
    expect((await http().get('/api/orders/active').set(bearer(c.token)).expect(200)).body).toMatchObject({ order: { id: first.order.id, status: 'paid' }, more: 0 });
  });

  it('promo: admin and marketer only; only customers with «Получать акции и новости»; audited; shown in the centre', async () => {
    const marketer = await loginStaff(app, MARKETER_TG);
    const warehouse = await loginStaff(app, WAREHOUSE_TG);
    const yes = await customer();
    const no = await customer();
    await prisma.users.update({ where: { id: no.user.id }, data: { marketing_opt_in: false } });
    const dto = { title_ru: 'Неделя витамина D', text_ru: '−15% на витамин D до пятницы', title_uz: 'D vitamini haftaligi', link: { type: 'category', value: 'vitamins' } };

    await http().post('/api/staff/promo').set(bearer(warehouse)).send(dto).expect(403);
    const audience = (await http().get('/api/staff/promo/audience').set(bearer(marketer)).expect(200)).body.recipients;
    const res = (await http().post('/api/staff/promo').set(bearer(marketer)).send(dto).expect(200)).body;
    expect(res.recipients).toBe(audience);

    const mine = await prisma.notifications.findMany({ where: { template: 'promo.message', dedup_key: { startsWith: `promo:${res.campaign}:` } } });
    expect(mine.some((r) => r.user_id === yes.user.id)).toBe(true);
    expect(mine.some((r) => r.user_id === no.user.id)).toBe(false);
    expect(mine.every((r) => r.kind === 'marketing' && r.category === 'promo')).toBe(true);
    expect(mine[0].payload).toMatchObject({ open_path: '/catalog/products?category=vitamins', open_button: 'link' });
    expect(await prisma.audit_logs.count({ where: { action: 'promo.sent', entity_id: res.campaign } })).toBe(1);

    if (!res.deferred) {
      const list = (await http().get('/api/notifications?lang=uz').set(bearer(yes.token)).expect(200)).body;
      expect(list.items[0]).toMatchObject({ category: 'promo', title: 'D vitamini haftaligi', body: '−15% на витамин D до пятницы', path: '/catalog/products?category=vitamins' });
    } else {
      // night in Tashkent: put off until 08:00 and not in the centre yet
      expect(new Date(res.scheduled_at).getTime()).toBeGreaterThan(Date.now());
      expect((await http().get('/api/notifications').set(bearer(yes.token)).expect(200)).body.items).toEqual([]);
    }
  });

  it('admin order card: the history of customer messages (what, when, delivered)', async () => {
    const c = await customer();
    const { order } = await placeOrder(c.token);
    await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    const card = (await http().get(`/api/staff/orders/${order.id}`).set(bearer(manager)).expect(200)).body;
    expect(card.customer_notifications.map((n: { template: string }) => n.template)).toEqual(['order.accepted_pay', 'order.paid']);
    expect(card.customer_notifications[1]).toMatchObject({ text: 'Оплата подтверждена', read_at: null });
    expect(['queued', 'sending', 'sent', 'failed']).toContain(card.customer_notifications[1].status);
  });
});
