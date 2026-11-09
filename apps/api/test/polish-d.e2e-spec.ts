import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff } from './helpers';

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
});
