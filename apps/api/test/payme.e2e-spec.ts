import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses, stockOf } from './helpers';

const ADMIN_TG = 222_222_221;
/** Fake values for this suite only (never real keys). */
const KEY = 'e2e-payme-test-key-0123456789';
const PAYME_ENV = {
  PAYME_MERCHANT_ID: '0123456789abcdef01234567',
  PAYME_KEY: KEY,
  PAYME_TEST_MODE: 'true',
  PAYME_DELIVERY_IKPU: '10112006002000000',
  PAYME_DELIVERY_PACKAGE_CODE: '1209885',
  PAYME_VAT_PERCENT: '0',
};
const IKPU = '03004001001000000';
const PACKAGE = '1501226';

/** Payme Merchant API (JSON-RPC): every method, repeated calls, wrong amount / key, cancel before and after paying. */
describe('Payme Merchant API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let tg = 871_000_000;
  let rpcId = 0;
  const saved: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  const auth = (key = KEY) => ({ Authorization: `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}` });
  const rpc = async (method: string, params: object, headers: Record<string, string> = auth()) => {
    const res = await http().post('/api/payments/payme').set(headers).send({ jsonrpc: '2.0', id: ++rpcId, method, params }).expect(200);
    return res.body as { id: number; result?: Record<string, any>; error?: { code: number; message: { ru: string; uz: string; en: string }; data?: string } };
  };
  const paymeId = () => randomUUID().replace(/-/g, '').slice(0, 24);

  const setModes = (payme: 'hidden' | 'soon' | 'live') =>
    http()
      .put('/api/staff/settings/checkout-options')
      .set(bearer(admin))
      .send({ cod_max_total_uzs: null, first_order_free_delivery: false, online: { payme, click: 'soon', uzum: 'soon' } });

  /** A customer's order paid by Payme: a product with ИКПУ (or without), Tashkent courier. */
  async function paymeOrder(opts: { ikpu?: boolean; price?: number; qty?: number } = {}) {
    const p = await createTestProduct(prisma, { price: opts.price ?? 120_000, stock: 10 });
    if (opts.ikpu !== false) await prisma.products.update({ where: { id: p.id }, data: { ikpu_code: IKPU, package_code: PACKAGE } });
    const token = await loginCustomer(app, ++tg);
    await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: opts.qty ?? 2 }).expect(201);
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'cart', ...addr.tashkent, payment_method: 'payme', recipient_name: 'Тест', recipient_phone: '90 123-45-67', address_text: 'ул. Тестовая, 1' })
        .expect(201)
    ).body;
    return { order, token, product: p, amount: Number(order.totals.total_uzs) * 100, account: { order_id: order.order_number } };
  }

  beforeAll(async () => {
    for (const k of Object.keys(PAYME_ENV)) saved[k] = process.env[k];
    Object.assign(process.env, PAYME_ENV);
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    await setModes('live').expect(200);
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'checkout_options' } });
    await archiveTestProducts(prisma);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });

  describe('access and settings', () => {
    it('wrong or missing key: -32504, nothing is touched', async () => {
      const { account, amount } = await paymeOrder();
      for (const headers of [auth('wrong-key'), {}, { Authorization: 'Bearer x' }]) {
        const r = await rpc('CheckPerformTransaction', { amount, account }, headers);
        expect(r.error?.code).toBe(-32504);
        expect(r.result).toBeUndefined();
      }
      const r = await rpc('CreateTransaction', { id: paymeId(), time: Date.now(), amount, account }, auth('wrong'));
      expect(r.error?.code).toBe(-32504);
      expect(await prisma.payme_transactions.count({ where: { order: { order_number: account.order_id } } })).toBe(0);
    });

    it('unknown method -32601; the answer keeps the request id', async () => {
      const r = await rpc('ChangePassword', { password: 'x' });
      expect(r.error?.code).toBe(-32601);
      expect(r.id).toBe(rpcId);
    });

    it('«Работает» is allowed with the keys; the admin panel sees the module and the keys (no values)', async () => {
      const opts = (await http().get('/api/staff/settings/checkout-options').set(bearer(admin)).expect(200)).body;
      expect(opts.online.payme).toBe('live');
      expect(opts.online_status.payme).toEqual({ keys_present: true, module_ready: true, can_go_live: true });
      expect(JSON.stringify(opts)).not.toContain(KEY);
    });
  });

  describe('order and payment link', () => {
    it('preview offers Payme; a product without ИКПУ: Payme unavailable, the order with Payme is refused', async () => {
      const p = await createTestProduct(prisma, { price: 50_000, stock: 5 });
      const token = await loginCustomer(app, ++tg);
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 1 }).expect(201);
      const body = { source: 'cart', ...addr.tashkent, payment_method: 'payme' };
      const preview = (await http().post('/api/orders/preview').set(bearer(token)).send(body).expect(200)).body;
      expect(preview.payment_options).toMatchObject({ payme: false, payme_unavailable: 'ikpu' });
      expect(preview.can_place).toBe(false);
      const refused = await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ ...body, recipient_name: 'Тест', recipient_phone: '90 123-45-67', address_text: 'ул. Тестовая, 1' })
        .expect(422);
      expect(refused.body).toMatchObject({ code: 'PAYME_RECEIPT_INCOMPLETE', skus: [p.sku] });

      await prisma.products.update({ where: { id: p.id }, data: { ikpu_code: IKPU, package_code: PACKAGE } });
      const ok = (await http().post('/api/orders/preview').set(bearer(token)).send(body).expect(200)).body;
      expect(ok.payment_options).toMatchObject({ payme: true, payme_unavailable: null });
      expect(ok.can_place).toBe(true);
    });

    it('Payme switched to «Скоро»: the method is refused', async () => {
      await setModes('soon').expect(200);
      try {
        const p = await createTestProduct(prisma, { price: 50_000, stock: 5 });
        const token = await loginCustomer(app, ++tg);
        await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 1 }).expect(201);
        const r = await http().post('/api/orders/preview').set(bearer(token)).send({ source: 'cart', ...addr.tashkent, payment_method: 'payme' }).expect(422);
        expect(r.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      } finally {
        await setModes('live').expect(200);
      }
    });

    it('the link: checkout.test.paycom.uz + base64(m;ac.order_id;a in tiyin;l;c); the same payment when pressed again', async () => {
      const { order, token, amount } = await paymeOrder();
      expect(order.status).toBe('awaiting_payment');
      const start = (await http().post(`/api/payments/online/payme/orders/${order.id}/start`).set(bearer(token)).send({ lang: 'uz' }).expect(200)).body;
      expect(start.checkout_url.startsWith('https://checkout.test.paycom.uz/')).toBe(true);
      const decoded = Buffer.from(start.checkout_url.split('/').pop(), 'base64').toString('utf8');
      expect(decoded).toBe(`m=${PAYME_ENV.PAYME_MERCHANT_ID};ac.order_id=${order.order_number};a=${amount};l=uz;c=https://t.me/vitalo_e2e_bot`);
      const again = (await http().post(`/api/payments/online/payme/orders/${order.id}/start`).set(bearer(token)).send({}).expect(200)).body;
      expect(again.payment_id).toBe(start.payment_id);
      expect(await prisma.payments.count({ where: { order_id: order.id } })).toBe(1);
      // somebody else's order is not found
      const other = await loginCustomer(app, ++tg);
      await http().post(`/api/payments/online/payme/orders/${order.id}/start`).set(bearer(other)).send({}).expect(404);
    });
  });

  describe('CheckPerformTransaction', () => {
    it('allow + the fiscal receipt: product lines with ИКПУ and the delivery line; the sum is the order total', async () => {
      const { order, amount, account, product } = await paymeOrder({ price: 120_000, qty: 2 });
      const r = await rpc('CheckPerformTransaction', { amount, account });
      expect(r.error).toBeUndefined();
      expect(r.result!.allow).toBe(true);
      const detail = r.result!.detail;
      expect(detail.receipt_type).toBe(0);
      expect(detail.items[0]).toMatchObject({ title: product.name_ru, price: 120_000 * 100, count: 2, code: IKPU, package_code: PACKAGE, vat_percent: 0 });
      const delivery = Number(order.totals.delivery_cost_uzs);
      if (delivery > 0) expect(detail.items[1]).toMatchObject({ title: 'Доставка', price: delivery * 100, count: 1, code: PAYME_ENV.PAYME_DELIVERY_IKPU });
      const sum = detail.items.reduce((s: number, i: { price: number; count: number; discount?: number }) => s + i.price * i.count - (i.discount ?? 0), 0);
      expect(sum).toBe(amount);
    });

    it('wrong amount -31001; unknown order -31050 (data order_id); no account -31050', async () => {
      const { amount, account } = await paymeOrder();
      expect((await rpc('CheckPerformTransaction', { amount: amount + 100, account })).error?.code).toBe(-31001);
      expect((await rpc('CheckPerformTransaction', { amount: amount - 100, account })).error?.code).toBe(-31001);
      const missing = await rpc('CheckPerformTransaction', { amount, account: { order_id: 'VTL-19990101-9999' } });
      expect(missing.error).toMatchObject({ code: -31050, data: 'order_id' });
      expect(missing.error!.message.ru).toBeTruthy();
      expect((await rpc('CheckPerformTransaction', { amount, account: {} })).error?.code).toBe(-31050);
    });

    it('a product lost its ИКПУ after the order: -31053', async () => {
      const { amount, account, product } = await paymeOrder();
      await prisma.products.update({ where: { id: product.id }, data: { ikpu_code: null } });
      expect((await rpc('CheckPerformTransaction', { amount, account })).error?.code).toBe(-31053);
    });
  });

  describe('create → perform', () => {
    it('the order becomes «Оплачен» exactly once (system in the history); repeated calls give the same answers', async () => {
      const { order, amount, account, product } = await paymeOrder({ qty: 2 });
      const id = paymeId();
      const time = Date.now();

      const created = await rpc('CreateTransaction', { id, time, amount, account });
      expect(created.result).toMatchObject({ state: 1, transaction: expect.any(String), create_time: expect.any(Number) });
      const createdAgain = await rpc('CreateTransaction', { id, time, amount, account });
      expect(createdAgain.result).toEqual(created.result);

      const checked = await rpc('CheckTransaction', { id });
      expect(checked.result).toEqual({ create_time: created.result!.create_time, perform_time: 0, cancel_time: 0, transaction: created.result!.transaction, state: 1, reason: null });

      // the order is still waiting while the money is held
      const before = (await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).status;
      expect(before).toBe('awaiting_payment');

      const performed = await rpc('PerformTransaction', { id });
      expect(performed.result).toMatchObject({ state: 2, transaction: created.result!.transaction, perform_time: expect.any(Number) });
      const performedAgain = await rpc('PerformTransaction', { id });
      expect(performedAgain.result).toEqual(performed.result);

      const paid = await prisma.orders.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true, history: true } });
      expect(paid).toMatchObject({ status: 'paid', payment_status: 'payment_success' });
      expect(paid.payments[0]).toMatchObject({ status: 'payment_success', provider_payment_id: id });
      const toPaid = paid.history.filter((h) => h.to_status === 'paid');
      expect(toPaid).toHaveLength(1);
      expect(toPaid[0].changed_by_type).toBe('system');
      // by quantity: the reservation became a write-off once (10 − 2)
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 8, reserved: 0 });

      const checkedPaid = await rpc('CheckTransaction', { id });
      expect(checkedPaid.result).toMatchObject({ state: 2, perform_time: performed.result!.perform_time, cancel_time: 0 });

      // a paid order: no new payment for it
      expect((await rpc('CheckPerformTransaction', { amount, account })).error?.code).toBe(-31051);
      expect((await rpc('CreateTransaction', { id: paymeId(), time: Date.now(), amount, account })).error?.code).toBe(-31051);
    });

    it('a second transaction for the same order while the first one waits: -31052', async () => {
      const { amount, account } = await paymeOrder();
      expect((await rpc('CreateTransaction', { id: paymeId(), time: Date.now(), amount, account })).result?.state).toBe(1);
      const second = await rpc('CreateTransaction', { id: paymeId(), time: Date.now(), amount, account });
      expect(second.error).toMatchObject({ code: -31052, data: 'order_id' });
    });

    it('wrong amount on create -31001; unknown transaction -31003 for perform / cancel / check', async () => {
      const { amount, account } = await paymeOrder();
      expect((await rpc('CreateTransaction', { id: paymeId(), time: Date.now(), amount: amount * 2, account })).error?.code).toBe(-31001);
      const unknown = paymeId();
      expect((await rpc('PerformTransaction', { id: unknown })).error?.code).toBe(-31003);
      expect((await rpc('CancelTransaction', { id: unknown, reason: 1 })).error?.code).toBe(-31003);
      expect((await rpc('CheckTransaction', { id: unknown })).error?.code).toBe(-31003);
    });

    it('older than 12 hours: cancelled with reason 4, perform -31008', async () => {
      const { order, amount, account } = await paymeOrder();
      const id = paymeId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount, account });
      await prisma.payme_transactions.update({ where: { payme_id: id }, data: { create_time: BigInt(Date.now() - 13 * 3600_000) } });
      expect((await rpc('PerformTransaction', { id })).error?.code).toBe(-31008);
      expect((await rpc('CheckTransaction', { id })).result).toMatchObject({ state: -1, reason: 4 });
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('awaiting_payment');
    });

    it('the order was cancelled meanwhile (customer): perform -31008, then Payme cancels', async () => {
      const { order, token, amount, account } = await paymeOrder();
      const id = paymeId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount, account });
      await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(200);
      expect((await rpc('PerformTransaction', { id })).error?.code).toBe(-31008);
      expect((await rpc('CancelTransaction', { id, reason: 3 })).result).toMatchObject({ state: -1 });
    });

    it('reservation expiry waits while Payme holds the money; without a transaction the order is cancelled', async () => {
      const job = app.get(ReservationExpiryService);
      const held = await paymeOrder();
      const id = paymeId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount: held.amount, account: held.account });
      const idle = await paymeOrder();
      const past = new Date(Date.now() - 60_000);
      await prisma.orders.updateMany({ where: { id: { in: [held.order.id, idle.order.id] } }, data: { reserved_until: past } });

      await job.runOnce();
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: held.order.id } })).status).toBe('awaiting_payment');
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: idle.order.id } })).status).toBe('cancelled');
      // the held one can still be paid
      expect((await rpc('PerformTransaction', { id })).result?.state).toBe(2);
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: held.order.id } })).status).toBe('paid');
    });
  });

  describe('CancelTransaction', () => {
    it('before the payment: state -1, the order keeps waiting and can be paid by a new transaction; repeated cancel = same', async () => {
      const { order, amount, account } = await paymeOrder();
      const id = paymeId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount, account });
      const cancelled = await rpc('CancelTransaction', { id, reason: 3 });
      expect(cancelled.result).toMatchObject({ state: -1, cancel_time: expect.any(Number) });
      expect((await rpc('CancelTransaction', { id, reason: 3 })).result).toEqual(cancelled.result);
      expect((await rpc('PerformTransaction', { id })).error?.code).toBe(-31008);
      expect((await rpc('CreateTransaction', { id, time: Date.now(), amount, account })).error?.code).toBe(-31008);
      expect((await rpc('CheckTransaction', { id })).result).toMatchObject({ state: -1, reason: 3 });
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('awaiting_payment');

      const next = paymeId();
      expect((await rpc('CreateTransaction', { id: next, time: Date.now(), amount, account })).result?.state).toBe(1);
      expect((await rpc('PerformTransaction', { id: next })).result?.state).toBe(2);
    });

    it('after the payment: state -2, the order is cancelled, stock returns, a refund task; repeated cancel = same', async () => {
      const { order, amount, account, product } = await paymeOrder({ qty: 3 });
      const id = paymeId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount, account });
      await rpc('PerformTransaction', { id });
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 7, reserved: 0 });

      const cancelled = await rpc('CancelTransaction', { id, reason: 5 });
      expect(cancelled.result).toMatchObject({ state: -2, cancel_time: expect.any(Number) });
      expect((await rpc('CancelTransaction', { id, reason: 5 })).result).toEqual(cancelled.result);
      expect((await rpc('CheckTransaction', { id })).result).toMatchObject({ state: -2, reason: 5 });

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id }, include: { tasks: true, history: true } });
      expect(row).toMatchObject({ status: 'cancelled', payment_status: 'payment_cancelled' });
      expect(row.tasks.filter((t) => t.type === 'refund')).toHaveLength(1);
      expect(row.tasks.find((t) => t.type === 'refund')!.note).toContain('Payme');
      expect(row.history.find((h) => h.to_status === 'cancelled')!.changed_by_type).toBe('system');
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 10, reserved: 0 });
    });

    it('after the handover to delivery: -31007, nothing changes', async () => {
      const { order, amount, account } = await paymeOrder();
      const id = paymeId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount, account });
      await rpc('PerformTransaction', { id });
      await prisma.orders.update({ where: { id: order.id }, data: { status: 'handed_to_delivery' } });
      expect((await rpc('CancelTransaction', { id, reason: 5 })).error?.code).toBe(-31007);
      expect((await rpc('CheckTransaction', { id })).result?.state).toBe(2);
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('handed_to_delivery');
    });
  });

  it('GetStatement: transactions of the period by Payme time, with the account', async () => {
    const { amount, account } = await paymeOrder();
    const id = paymeId();
    const time = Date.now() + 5 * 60_000; // a moment no other test used
    await rpc('CreateTransaction', { id, time, amount, account });
    const r = await rpc('GetStatement', { from: time - 1, to: time + 1 });
    const t = r.result!.transactions.find((x: { id: string }) => x.id === id);
    expect(t).toMatchObject({ id, time, amount, account, state: 1, perform_time: 0, cancel_time: 0, reason: null, transaction: expect.any(String) });
    const none = await rpc('GetStatement', { from: 1, to: 2 });
    expect(none.result!.transactions).toEqual([]);
  });
});
