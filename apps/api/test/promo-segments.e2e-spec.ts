import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const MARKETER_TG = 222_222_224;
const MANAGER_TG = 222_222_222;

/** Аудит админки 4.2: promo groups (bought / waiting / no orders N days), «Отправить себе», the history of sends. */
describe('Promo segments and history (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let marketer: string;
  let manager: string;
  const http = () => request(app.getHttpServer());
  const base = 975_400_000 + Math.floor(Math.random() * 90_000);
  let product: { id: string; sku: string };
  let waiter: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    marketer = await loginStaff(app, MARKETER_TG);
    manager = await loginStaff(app, MANAGER_TG);
    product = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    await loginCustomer(app, base);
    waiter = (await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(base) } })).id;
    await prisma.product_waitlist.create({ data: { product_id: product.id, user_id: waiter } });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('«Ждут товар» counts only the active subscribers of that product; an opted-out one is not counted', async () => {
    const count = async () => (await http().get(`/api/staff/promo/audience?segment=waiting&product_id=${product.id}`).set(bearer(marketer)).expect(200)).body.recipients;
    expect(await count()).toBe(1);
    await prisma.users.update({ where: { id: waiter }, data: { marketing_opt_in: false } });
    expect(await count()).toBe(0);
    await prisma.users.update({ where: { id: waiter }, data: { marketing_opt_in: true } });
    expect((await http().get(`/api/staff/promo/audience?segment=bought&product_id=${product.id}`).set(bearer(marketer)).expect(200)).body.recipients).toBe(0);
    await http().get('/api/staff/promo/audience?segment=waiting').set(bearer(marketer)).expect(400); // no product
    await http().get('/api/staff/promo/audience?segment=inactive&days=3').set(bearer(marketer)).expect(400);
    await http().get('/api/staff/promo/audience').set(bearer(manager)).expect(403);
  });

  it('«Отправить себе» goes only to the employee; the real send reaches the group and appears in the history', async () => {
    const body = { segment: 'waiting', product_id: product.id, title_ru: 'Снова в продаже', text_ru: 'Товар, который вы ждали, скоро будет.' };
    const before = await prisma.notifications.count({ where: { template: 'promo.message', user_id: waiter } });
    const test = (await http().post('/api/staff/promo').set(bearer(admin)).send({ ...body, to_me: true }).expect(200)).body;
    expect(test).toMatchObject({ to_me: true, recipients: 1, would_reach: 1 });
    const staff = await prisma.staff_users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(ADMIN_TG) } });
    expect(await prisma.notifications.count({ where: { template: 'promo.message', staff_user_id: staff.id } })).toBeGreaterThan(0);
    expect(await prisma.notifications.count({ where: { template: 'promo.message', user_id: waiter } })).toBe(before);

    const sent = (await http().post('/api/staff/promo').set(bearer(admin)).send(body).expect(200)).body;
    expect(sent.recipients).toBe(1);
    expect(await prisma.notifications.count({ where: { template: 'promo.message', user_id: waiter } })).toBe(before + 1);
    // the customer opened it in the centre
    await prisma.notifications.updateMany({ where: { dedup_key: `promo:${sent.campaign}:${waiter}` }, data: { read_at: new Date(), status: 'sent' } });
    const row = (await http().get('/api/staff/promo/history').set(bearer(admin)).expect(200)).body.find((h: { id: string }) => h.id === sent.campaign);
    expect(row).toMatchObject({ title_ru: 'Снова в продаже', segment: `Ждут ${product.sku}`, recipients: 1, sent: 1, read: 1 });
  });
});
