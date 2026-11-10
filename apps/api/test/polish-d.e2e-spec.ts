import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const CUSTOMER_TG = 777_000_611;

/**
 * 6а-Д (D-62): «Спросить специалиста» inside the Mini App — a question with a topic (and the product), the reply from
 * Админка → Обращения comes to «Личные» and to the bot; the customer answers back; medical questions only for admins
 * and specialists (D-40).
 */
describe('6а-Д: questions to the specialist (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  let customer: string;
  let product: { id: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    customer = await loginCustomer(app, CUSTOMER_TG);
    product = await createTestProduct(prisma, { price: 90_000, stock: 3 });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('a question from the product card: the product is attached, staff are told, the reply goes to «Личные» and the bot', async () => {
    const created = (await http().post('/api/support/threads').set(bearer(customer)).send({ topic: 'promo', text: 'Есть ли скидка на этот товар?', product_id: product.id }).expect(201)).body;
    expect(created.topic).toBe('promo');
    expect(created.product.id).toBe(product.id);
    expect(created.messages).toEqual([expect.objectContaining({ author: 'customer', text: 'Есть ли скидка на этот товар?' })]);
    const told = await prisma.notifications.findMany({ where: { template: 'staff.support_new', payload: { path: ['admin_path'], equals: `/support/${created.id}` } } });
    expect(told.length).toBeGreaterThan(0);

    const list = (await http().get('/api/staff/support/threads?status=open').set(bearer(manager)).expect(200)).body;
    expect(list.items.map((t: { id: string }) => t.id)).toContain(created.id);
    await http().post(`/api/staff/support/threads/${created.id}/reply`).set(bearer(manager)).send({ text: 'Да, промокод VITA10 даёт 10%.' }).expect(200);

    const note = await prisma.notifications.findFirstOrThrow({ where: { template: 'support.reply', payload: { path: ['thread_id'], equals: created.id } } });
    expect(note.category).toBe('personal');
    expect(note.chat_id).toBe(BigInt(CUSTOMER_TG)); // the bot message
    const centre = (await http().get('/api/notifications').set(bearer(customer)).expect(200)).body;
    const card = centre.items.find((c: { id: string }) => c.id === note.id);
    expect(card).toMatchObject({ tab: 'personal', path: `/support/${created.id}`, read: false });
    expect(card.body).toContain('VITA10');
    expect(centre.tabs.personal).toBeGreaterThan(0);

    // the customer opens the conversation: the reply is read; then answers back — the question is open again
    const opened = (await http().get(`/api/support/threads/${created.id}`).set(bearer(customer)).expect(200)).body;
    expect(opened.messages.map((m: { author: string }) => m.author)).toEqual(['customer', 'staff']);
    expect((await prisma.notifications.findUniqueOrThrow({ where: { id: note.id } })).read_at).not.toBeNull();
    await http().post(`/api/support/threads/${created.id}/messages`).set(bearer(customer)).send({ text: 'Спасибо!' }).expect(201);
    expect((await prisma.support_threads.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('open');
  });

  it('a medical question: hidden from a manager, seen and answered by an admin; another customer cannot open it', async () => {
    const created = (await http().post('/api/support/threads').set(bearer(customer)).send({ topic: 'medical', text: 'Можно ли магний при давлении?' }).expect(201)).body;
    const forManager = (await http().get('/api/staff/support/threads?status=open').set(bearer(manager)).expect(200)).body;
    expect(forManager.items.map((t: { id: string }) => t.id)).not.toContain(created.id);
    await http().get(`/api/staff/support/threads/${created.id}`).set(bearer(manager)).expect(403);
    const forAdmin = (await http().get(`/api/staff/support/threads/${created.id}`).set(bearer(admin)).expect(200)).body;
    expect(forAdmin.messages[0].text).toContain('магний');
    await http().post(`/api/staff/support/threads/${created.id}/close`).set(bearer(admin)).expect(200);

    const stranger = await loginCustomer(app, CUSTOMER_TG + 1);
    await http().get(`/api/support/threads/${created.id}`).set(bearer(stranger)).expect(404);
    await http().post('/api/support/threads').set(bearer(customer)).send({ topic: 'other', text: 'x x' }).expect(400);
  });

  it('6б-Б: numbers, the order, «Написать покупателю», closing with the last message, the rating, no messages after closing', async () => {
    const addr = await seededAddresses(prisma);
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(customer))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'buy_now', buy_now: { product_id: product.id, qty: 1 }, recipient_name: 'Обращение Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: 'card_transfer' })
        .expect(201)
    ).body;

    // the customer asks about the order: the number and the order come back; someone else's order is refused
    const asked = (await http().post('/api/support/threads').set(bearer(customer)).send({ topic: 'order', text: 'Когда доставка?', order_id: order.id }).expect(201)).body;
    expect(asked.number).toMatch(/^[0-9]{4,}$/);
    expect(asked.order).toEqual({ id: order.id, number: order.order_number });
    const stranger = await loginCustomer(app, CUSTOMER_TG + 2);
    await http().post('/api/support/threads').set(bearer(stranger)).send({ topic: 'order', text: 'чужой', order_id: order.id }).expect(404);

    // the shop writes first from the order card: a request about the order, in «Личные» and in the bot
    const started = (await http().post('/api/staff/support/threads').set(bearer(manager)).send({ order_id: order.id, text: 'Уточните, пожалуйста, подъезд.' }).expect(201)).body;
    expect(started).toMatchObject({ started_by: 'staff', status: 'answered', order: { id: order.id } });
    const note = await prisma.notifications.findFirstOrThrow({ where: { template: 'support.reply', payload: { path: ['thread_id'], equals: started.id } } });
    expect(note.category).toBe('personal');
    expect(note.chat_id).toBe(BigInt(CUSTOMER_TG));
    expect((note.payload as { thread_no: string }).thread_no).toBe(started.number);
    const forOrder = (await http().get(`/api/staff/support/orders/${order.id}`).set(bearer(manager)).expect(200)).body;
    expect(forOrder.map((t: { id: string }) => t.id).sort()).toEqual([asked.id, started.id].sort());

    // a rating before closing is refused; closing with the last message asks the customer to rate
    await http().post(`/api/support/threads/${asked.id}/rating`).set(bearer(customer)).send({ rating: 5 }).expect(409);
    const closed = (await http().post(`/api/staff/support/threads/${asked.id}/close`).set(bearer(manager)).send({ text: 'Доставим завтра.' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'closed', closed_by: expect.any(String) });
    expect(closed.messages.at(-1)).toMatchObject({ author: 'staff', text: 'Доставим завтра.' });
    const closing = await prisma.notifications.findFirstOrThrow({ where: { template: 'support.closed', payload: { path: ['thread_id'], equals: asked.id } } });
    expect(closing.category).toBe('personal');

    await http().post(`/api/support/threads/${asked.id}/messages`).set(bearer(customer)).send({ text: 'Ещё вопрос' }).expect(409);
    await http().post(`/api/support/threads/${asked.id}/rating`).set(bearer(customer)).send({ rating: 6 }).expect(400);
    const rated = (await http().post(`/api/support/threads/${asked.id}/rating`).set(bearer(customer)).send({ rating: 4 }).expect(200)).body;
    expect(rated.rating).toBe(4);
    const list = (await http().get('/api/staff/support/threads?status=closed').set(bearer(manager)).expect(200)).body;
    expect(list.items.find((t: { id: string }) => t.id === asked.id)).toMatchObject({ rating: 4, order_number: order.order_number });
  });
});
