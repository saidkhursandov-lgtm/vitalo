import { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
/** Fake values for this suite only (never real keys). */
const PAYME_KEY = 'e2e-pay-method-payme-key';
const CLICK_SECRET = 'e2e-pay-method-click-secret';
const SERVICE_ID = '77778';
const ENV = {
  PAYME_MERCHANT_ID: '0123456789abcdef01234568',
  PAYME_KEY,
  PAYME_TEST_MODE: 'true',
  CLICK_SERVICE_ID: SERVICE_ID,
  CLICK_MERCHANT_ID: '55556',
  CLICK_SECRET_KEY: CLICK_SECRET,
  CLICK_MERCHANT_USER_ID: '33334',
  CLICK_API_BASE: 'https://click-api.invalid/v2/merchant',
  PAYME_DELIVERY_IKPU: '10112006002000000',
  PAYME_DELIVERY_PACKAGE_CODE: '1209885',
  PAYME_VAT_PERCENT: '0',
};
const IKPU = '03004001001000000';
const PACKAGE = '1501226';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/**
 * «Сменить способ оплаты»: an unpaid order can move between Payme, Click and the card transfer; the amount and the
 * reservation stay; a transaction started in the old system is cancelled, so the order is never paid twice.
 */
describe('Payment method change (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let tg = 873_000_000;
  let clickTrans = 8_000_000_000 + Math.floor(Math.random() * 1_000_000) * 100;
  let rpcId = 0;
  const saved: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  const setModes = (online: { payme: string; click: string }) =>
    http()
      .put('/api/staff/settings/checkout-options')
      .set(bearer(admin))
      .send({ cod_max_total_uzs: null, first_order_free_delivery: false, online: { ...online, uzum: 'soon' } });

  async function newOrder(method: string, opts: { ikpu?: boolean } = {}) {
    const p = await createTestProduct(prisma, { price: 120_000, stock: 10 });
    if (opts.ikpu !== false) await prisma.products.update({ where: { id: p.id }, data: { ikpu_code: IKPU, package_code: PACKAGE } });
    const token = await loginCustomer(app, ++tg);
    await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 2 }).expect(201);
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'cart', ...addr.tashkent, payment_method: method, recipient_name: 'Тест', recipient_phone: '90 123-45-67', address_text: 'ул. Тестовая, 1' })
        .expect(201)
    ).body;
    return { order, token, account: order.order_number.replace(/\D/g, '') as string, total: Number(order.totals.total_uzs) };
  }

  const methods = (id: string, token: string) => http().get(`/api/payments/online/orders/${id}/methods`).set(bearer(token));
  const change = (id: string, token: string, method: string) => http().post(`/api/payments/online/orders/${id}/method`).set(bearer(token)).send({ method });

  const paymeAuth = { Authorization: `Basic ${Buffer.from(`Paycom:${PAYME_KEY}`).toString('base64')}` };
  const rpc = async (method: string, params: object) =>
    (await http().post('/api/payments/payme').set(paymeAuth).send({ jsonrpc: '2.0', id: ++rpcId, method, params }).expect(200)).body as {
      result?: Record<string, any>;
      error?: { code: number };
    };

  type Fields = Record<string, string>;
  function clickPrepare(account: string, amount: string): Fields {
    const f: Fields = {
      click_trans_id: String(++clickTrans),
      service_id: SERVICE_ID,
      click_paydoc_id: String(clickTrans + 7),
      merchant_trans_id: account,
      amount,
      action: '0',
      error: '0',
      error_note: 'Success',
      sign_time: '2026-11-25 12:00:00',
    };
    f.sign_string = md5(f.click_trans_id + f.service_id + CLICK_SECRET + f.merchant_trans_id + f.amount + f.action + f.sign_time);
    return f;
  }
  function clickComplete(prep: Fields, prepareId: number): Fields {
    const f: Fields = { ...prep, action: '1', merchant_prepare_id: String(prepareId) };
    delete f.sign_string;
    f.sign_string = md5(f.click_trans_id + f.service_id + CLICK_SECRET + f.merchant_trans_id + f.merchant_prepare_id + f.amount + f.action + f.sign_time);
    return f;
  }
  const clickPost = async (path: 'prepare' | 'complete', f: Fields) => (await http().post(`/api/payments/click/${path}`).type('form').send(f).expect(200)).body;

  let fetchSpy: jest.SpyInstance;
  beforeAll(async () => {
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    await setModes({ payme: 'live', click: 'live' }).expect(200);
  });
  beforeEach(() => {
    // Click's fiscal receipt never leaves the test
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error_code: 0, error_note: 'Success' }), { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'checkout_options' } });
    await archiveTestProducts(prisma);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });

  it('the list: Payme, Click and the card transfer, the current one marked; no cash on delivery', async () => {
    const { order, token, total } = await newOrder('click');
    const r = (await methods(order.id, token).expect(200)).body;
    expect(r).toMatchObject({ current: 'click', total_uzs: total, blocked: null });
    expect(r.methods.map((m: { code: string }) => m.code)).toEqual(['payme', 'click', 'card_transfer']);
    expect(r.methods.every((m: { unavailable: unknown }) => m.unavailable === null)).toBe(true);

    // somebody else's order: not found
    const other = await loginCustomer(app, ++tg);
    await methods(order.id, other).expect(404);
    await change(order.id, other, 'payme').expect(404);
  });

  it('Click → Payme: the same amount and reservation, one payment row with a new attempt, the Payme link works', async () => {
    const { order, token, account, total } = await newOrder('click');
    const before = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    const r = (await change(order.id, token, 'payme').expect(200)).body;
    expect(r.current).toBe('payme');

    const after = await prisma.orders.findUniqueOrThrow({ where: { id: order.id }, include: { payments: { include: { method: true, attempts: { orderBy: { attempt_no: 'asc' } } } } } });
    expect(after.total_uzs).toBe(before.total_uzs);
    expect(after.reserved_until?.getTime()).toBe(before.reserved_until?.getTime());
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0].method.code).toBe('payme');
    expect(after.payments[0].attempts.map((a) => a.status)).toEqual(['cancelled', 'pending']);

    const view = (await http().get(`/api/orders/${order.id}`).set(bearer(token)).expect(200)).body;
    expect(view.payment.method).toBe('payme');

    // the Click link is refused now (the order waits for Payme); the Payme one works and Payme can pay it
    const wrong = await http().post(`/api/payments/online/click/orders/${order.id}/start`).set(bearer(token)).send({ lang: 'ru' }).expect(409);
    expect(wrong.body).toMatchObject({ code: 'PAYMENT_METHOD_MISMATCH', current: 'payme' });
    await http().post(`/api/payments/online/payme/orders/${order.id}/start`).set(bearer(token)).send({ lang: 'ru' }).expect(200);
    // Click itself can no longer start a payment for it
    expect((await clickPost('prepare', clickPrepare(account, `${total}.00`))).error).toBe(-5);

    const id = randomUUID().replace(/-/g, '').slice(0, 24);
    const created = await rpc('CreateTransaction', { id, time: Date.now(), amount: total * 100, account: { order_id: account } });
    expect(created.result?.state).toBe(1);
    expect((await rpc('PerformTransaction', { id })).result?.state).toBe(2);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).payment_status).toBe('payment_success');
  });

  it('a Click payment started before the change can no longer pay: Complete gets −9, the new way pays once', async () => {
    const { order, token, account, total } = await newOrder('click');
    const prep = clickPrepare(account, `${total}.00`);
    const prepared = await clickPost('prepare', prep);
    expect(prepared.error).toBe(0);

    await change(order.id, token, 'payme').expect(200);
    const row = await prisma.click_transactions.findUniqueOrThrow({ where: { click_trans_id: BigInt(prep.click_trans_id) } });
    expect(row.state).toBe(-1);

    const late = await clickPost('complete', clickComplete(prep, prepared.merchant_prepare_id));
    expect(late.error).toBe(-9);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).payment_status).toBe('payment_pending');
  });

  it('a Payme transaction created before the change is cancelled: PerformTransaction is refused', async () => {
    const { order, token, account, total } = await newOrder('payme');
    const id = randomUUID().replace(/-/g, '').slice(0, 24);
    expect((await rpc('CreateTransaction', { id, time: Date.now(), amount: total * 100, account: { order_id: account } })).result?.state).toBe(1);

    await change(order.id, token, 'click').expect(200);
    const tx = await prisma.payme_transactions.findUniqueOrThrow({ where: { payme_id: id } });
    expect(tx).toMatchObject({ state: -1, reason: 3 });
    expect((await rpc('PerformTransaction', { id })).error?.code).toBe(-31008);
    expect((await rpc('CheckTransaction', { id })).result).toMatchObject({ state: -1, reason: 3 });

    // Click pays it now, exactly once
    const prep = clickPrepare(account, `${total}.00`);
    const prepared = await clickPost('prepare', prep);
    expect(prepared.error).toBe(0);
    expect((await clickPost('complete', clickComplete(prep, prepared.merchant_prepare_id))).error).toBe(0);
    const paid = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.payment_status).toBe('payment_success');
  });

  it('to the card transfer and back; after «Я оплатил(а)» the way is locked', async () => {
    const { order, token } = await newOrder('payme');
    await change(order.id, token, 'card_transfer').expect(200);
    await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(token)).expect(200);
    await change(order.id, token, 'payme').expect(200);
    await change(order.id, token, 'card_transfer').expect(200);
    await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200);

    expect((await methods(order.id, token).expect(200)).body.blocked).toBe('reported');
    expect((await change(order.id, token, 'payme').expect(409)).body.code).toBe('PAYMENT_ALREADY_REPORTED');
  });

  it('refused: the same method is a no-op; cash on delivery, an unknown or switched-off method; no ИКПУ; a paid order', async () => {
    const { order, token } = await newOrder('click');
    expect((await change(order.id, token, 'click').expect(200)).body.current).toBe('click');
    expect((await change(order.id, token, 'cod').expect(422)).body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect((await change(order.id, token, 'bitcoin').expect(422)).body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    await change(order.id, token, 'Bad Code!').expect(400);

    await setModes({ payme: 'soon', click: 'live' }).expect(200);
    try {
      const r = (await methods(order.id, token).expect(200)).body;
      expect(r.methods.map((m: { code: string }) => m.code)).toEqual(['click', 'card_transfer']);
      expect((await change(order.id, token, 'payme').expect(422)).body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    } finally {
      await setModes({ payme: 'live', click: 'live' }).expect(200);
    }

    // a card-transfer order whose product has no ИКПУ: Payme and Click are listed but cannot be chosen
    const noIkpu = await newOrder('card_transfer', { ikpu: false });
    const list = (await methods(noIkpu.order.id, noIkpu.token).expect(200)).body;
    expect(list.methods).toEqual([
      { code: 'payme', unavailable: 'ikpu' },
      { code: 'click', unavailable: 'ikpu' },
      { code: 'card_transfer', unavailable: null },
    ]);
    expect((await change(noIkpu.order.id, noIkpu.token, 'payme').expect(422)).body.code).toBe('PAYME_RECEIPT_INCOMPLETE');

    // paid or cancelled: nothing to change
    await prisma.orders.update({ where: { id: order.id }, data: { reserved_until: new Date(Date.now() - 1000) } });
    expect((await change(order.id, token, 'payme').expect(409)).body.code).toBe('RESERVATION_EXPIRED');
    await http().post(`/api/orders/${noIkpu.order.id}/cancel`).set(bearer(noIkpu.token)).send({}).expect(200);
    expect((await methods(noIkpu.order.id, noIkpu.token).expect(200)).body.blocked).toBe('not_awaiting');
    expect((await change(noIkpu.order.id, noIkpu.token, 'payme').expect(409)).body.code).toBe('ORDER_NOT_AWAITING_PAYMENT');
  });
});
