import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;

/** Аудит админки 2.10: one search for orders of both channels, products, customers and jars — by permissions. */
describe('Admin search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const find = (q: string, r: Role = 'admin') => http().get(`/api/staff/search?q=${encodeURIComponent(q)}`).set(bearer(tokens[r]));
  const run = Date.now().toString(36).toUpperCase();
  const phoneTail = String(Date.now()).slice(-7);
  let product: { id: string; sku: string };
  let orderId: string;
  let orderNumber: string;
  let yandexId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    const addr = await seededAddresses(prisma);
    const token = await loginCustomer(app, 975_200_001);
    product = await createTestProduct(prisma, { price: 10_000, stock: 5, name: `Поиск ${run}` });
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'buy_now', buy_now: { product_id: product.id, qty: 1 }, recipient_name: `Искомый ${run}`, recipient_phone: `+99890${phoneTail}`, ...addr.tashkent, address_text: 'ул. 1', payment_method: 'card_transfer' })
        .expect(201)
    ).body;
    orderId = order.id;
    orderNumber = order.order_number;
    await prisma.orders.update({ where: { id: orderId }, data: { is_test: true } });
    yandexId = (await prisma.marketplace_orders.create({ data: { external_number: `SRCH-${run}`, order_date: new Date(), status: 'NEW', customer_name: 'Яндекс Поиск', is_test: true } })).id;
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('finds an order by its number and by the phone with spaces, a Yandex order and a product by SKU', async () => {
    expect((await find(orderNumber).expect(200)).body.orders.map((h: { to: string }) => h.to)).toContain(`/orders/${orderId}`);
    const byPhone = (await find(`90 ${phoneTail.slice(0, 3)} ${phoneTail.slice(3)}`).expect(200)).body;
    expect(byPhone.orders.map((h: { id: string }) => h.id)).toContain(orderId);
    expect((await find(`srch-${run}`).expect(200)).body.orders).toEqual([expect.objectContaining({ id: yandexId, to: `/yandex-orders/${yandexId}` })]);
    expect((await find(product.sku).expect(200)).body.products).toEqual([expect.objectContaining({ id: product.id, to: `/products/${product.id}` })]);
  });

  it('each group only for those who may open it', async () => {
    // marketer: products only — no orders, no customers
    const m = (await find(`Поиск ${run}`, 'marketer').expect(200)).body;
    expect(Object.keys(m)).toEqual(['products']);
    expect((await find(orderNumber, 'marketer').expect(200)).body).toEqual({});
    // warehouse sees orders but not customers
    const w = (await find(`90${phoneTail}`, 'warehouse').expect(200)).body;
    expect(w.orders.map((h: { id: string }) => h.id)).toContain(orderId);
    expect(w).not.toHaveProperty('customers');
  });

  it('a too short or missing query is refused', async () => {
    await find('a').expect(400);
    await http().get('/api/staff/search').set(bearer(tokens.admin)).expect(400);
    await http().get('/api/staff/search?q=abc').expect(401);
  });
});
