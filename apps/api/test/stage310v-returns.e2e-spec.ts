import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const DAY = 86_400_000;

/** 3.10-В: returns on the customer's request — 14 days, damaged / wrong item with photos, staff decision, bonuses. */
describe('Stage 3.10-В returns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let manager: string;
  let png: Buffer;
  let tg = 833_000_000 + (Date.now() % 100_000) * 10;
  const http = () => request(app.getHttpServer());

  async function customer() {
    const token = await loginCustomer(app, ++tg);
    const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(tg) } });
    return { token, user };
  }

  async function order(token: string, productId: string, qty: number, delivered = true) {
    const res = await http()
      .post('/api/orders')
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ source: 'buy_now', buy_now: { product_id: productId, qty }, recipient_name: 'Тест Возврат', recipient_phone: '90 123-45-67', ...addr.samarkand, address_text: 'ул. Тестовая, 1', payment_method: 'card_transfer' })
      .expect(201);
    const id: string = res.body.id ?? res.body.order?.id;
    if (delivered) {
      await http().post(`/api/staff/orders/${id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      for (const s of ['picking', 'handed_to_delivery', 'in_transit', 'delivered']) await http().post(`/api/staff/orders/${id}/status`).set(bearer(manager)).send({ status: s }).expect(200);
    }
    return id;
  }

  const send = (token: string, f: { order_id: string; items: { order_item_id: string; qty: number }[]; reason?: string; photos?: number }) => {
    const r = http()
      .post('/api/returns')
      .set(bearer(token))
      .field('order_id', f.order_id)
      .field('reason', f.reason ?? 'damaged')
      .field('comment', 'Банка треснула при доставке')
      .field('items', JSON.stringify(f.items));
    for (let i = 0; i < (f.photos ?? 1); i++) r.attach('photos', png, { filename: `p${i}.png`, contentType: 'image/png' });
    return r;
  };
  const view = async (token: string, orderId: string) => (await http().get(`/api/returns/order/${orderId}`).set(bearer(token)).expect(200)).body;
  const ledger = (orderId: string) => prisma.bonus_ledger.findMany({ where: { order_id: orderId }, orderBy: { created_at: 'asc' } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    await prisma.settings.deleteMany({ where: { key: 'bonus' } }); // cashback 3% on
    const value = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false };
    await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
    png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#f0e0e0' } }).png().toBuffer();
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('only a delivered order, 14 days, a damaged or a wrong item, at least one photo, not more jars than bought', async () => {
    const p = await createTestProduct(prisma, { stock: 20, price: 100_000 });
    const { token } = await customer();
    const waiting = await order(token, p.id, 1, false);
    const w = await view(token, waiting);
    expect(w).toMatchObject({ can_request: false, blocked: 'RETURN_NOT_DELIVERED', days: 14 });
    const done = await order(token, p.id, 2);
    const v = await view(token, done);
    expect(v.can_request).toBe(true);
    const line = v.lines[0];
    expect(line).toMatchObject({ qty: 2, max_qty: 2 });
    await send(token, { order_id: done, items: [{ order_item_id: line.order_item_id, qty: 1 }], photos: 0 }).expect(400);
    await send(token, { order_id: done, items: [{ order_item_id: line.order_item_id, qty: 1 }], reason: 'changed_mind' }).expect(400);
    expect((await send(token, { order_id: done, items: [{ order_item_id: line.order_item_id, qty: 3 }] }).expect(400)).body.code).toBe('RETURN_QTY');

    const { token: stranger } = await customer();
    await http().get(`/api/returns/order/${done}`).set(bearer(stranger)).expect(404);

    await prisma.orders.update({ where: { id: done }, data: { delivered_at: new Date(Date.now() - 15 * DAY) } });
    expect((await send(token, { order_id: done, items: [{ order_item_id: line.order_item_id, qty: 1 }] }).expect(422)).body.code).toBe('RETURN_TOO_LATE');
  });

  it('a part of the order: one request at a time; rejected → again; approved → the order stays delivered, bonuses by share; «Деньги возвращены»', async () => {
    const p = await createTestProduct(prisma, { stock: 20, price: 100_000 });
    const { token, user } = await customer();
    const id = await order(token, p.id, 2);
    const cashback = (await ledger(id)).find((l) => l.operation_type === 'purchase');
    expect(Number(cashback?.amount_uzs)).toBeGreaterThan(0);
    const line = (await view(token, id)).lines[0];

    const r1 = (await send(token, { order_id: id, items: [{ order_item_id: line.order_item_id, qty: 1 }] }).expect(201)).body;
    expect((await send(token, { order_id: id, items: [{ order_item_id: line.order_item_id, qty: 1 }] }).expect(409)).body.code).toBe('RETURN_ACTIVE');
    // the staff got a message, the customer — «получена»
    expect(await prisma.notifications.count({ where: { template: 'staff.return_new' } })).toBeGreaterThan(0);
    expect(await prisma.notifications.count({ where: { user_id: user.id, template: 'return.received' } })).toBe(1);

    const list = (await http().get('/api/staff/returns?status=requested').set(bearer(manager)).expect(200)).body;
    const row = list.items.find((x: { id: string }) => x.id === r1.id);
    expect(row).toMatchObject({ full_order: false, suggested_uzs: 100_000, items: [{ qty: 1, line_qty: 2 }] });
    expect(row.media).toHaveLength(1);
    const photo = await http().get(`/api/staff/returns/${r1.id}/media/${row.media[0]}`).set(bearer(manager)).expect(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');

    await http().post(`/api/staff/returns/${r1.id}/reject`).set(bearer(manager)).send({ reason: 'На фото банка целая' }).expect(201);
    expect(await prisma.notifications.count({ where: { user_id: user.id, template: 'return.rejected' } })).toBe(1);

    const r2 = (await send(token, { order_id: id, items: [{ order_item_id: line.order_item_id, qty: 1 }], reason: 'wrong_item', photos: 2 }).expect(201)).body;
    await http().post(`/api/staff/returns/${r2.id}/refunded`).set(bearer(manager)).send({ method: 'card' }).expect(409); // not approved yet
    const ok = (await http().post(`/api/staff/returns/${r2.id}/approve`).set(bearer(manager)).send({ amount_uzs: 100_000 }).expect(201)).body;
    expect(ok).toMatchObject({ full_order: false, refund_amount_uzs: 100_000 });
    expect(ok.bonus_reversed_uzs).toBe(Math.round(Number(cashback!.amount_uzs) / 2));
    expect((await prisma.orders.findUniqueOrThrow({ where: { id } })).status).toBe('delivered');
    expect(await prisma.manager_tasks.count({ where: { order_id: id, type: 'refund', status: 'open' } })).toBe(1);
    // the approved jar cannot be asked for again; the other one can (after this request is closed)
    expect((await view(token, id)).lines[0].max_qty).toBe(1);

    await http().post(`/api/staff/returns/${r2.id}/refunded`).set(bearer(manager)).send({ method: 'card', comment: 'Uzcard' }).expect(201);
    expect(await prisma.manager_tasks.count({ where: { order_id: id, type: 'refund', status: 'open' } })).toBe(0);
    expect(await prisma.notifications.count({ where: { user_id: user.id, template: { in: ['return.approved', 'return.refunded'] } } })).toBe(2);
    await http().post(`/api/staff/returns/${r2.id}/approve`).set(bearer(manager)).send({ amount_uzs: 1 }).expect(409);
  });

  it('the whole order: approved → the order «Возврат», all the cashback taken back', async () => {
    const p = await createTestProduct(prisma, { stock: 20, price: 80_000 });
    const { token } = await customer();
    const id = await order(token, p.id, 1);
    const line = (await view(token, id)).lines[0];
    const r = (await send(token, { order_id: id, items: [{ order_item_id: line.order_item_id, qty: 1 }] }).expect(201)).body;
    const ok = (await http().post(`/api/staff/returns/${r.id}/approve`).set(bearer(manager)).send({ amount_uzs: 80_000 }).expect(201)).body;
    expect(ok.full_order).toBe(true);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id } })).status).toBe('return');
    const rows = await ledger(id);
    const accrued = Number(rows.find((l) => l.operation_type === 'purchase')!.amount_uzs);
    expect(rows.filter((l) => l.operation_type === 'reversal').reduce((s, l) => s + Number(l.amount_uzs), 0)).toBe(-accrued);
    await http().post(`/api/staff/returns/${r.id}/approve`).set(bearer(manager)).send({ amount_uzs: 80_000 }).expect(409);
  });
});
