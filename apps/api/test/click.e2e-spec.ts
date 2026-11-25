import { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ClickService } from '../src/payments/click/click.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
/** Fake values for this suite only (never real keys). */
const SECRET = 'e2e-click-secret-0123456789';
const SERVICE_ID = '77777';
const CLICK_ENV = {
  CLICK_SERVICE_ID: SERVICE_ID,
  CLICK_MERCHANT_ID: '55555',
  CLICK_SECRET_KEY: SECRET,
  CLICK_MERCHANT_USER_ID: '33333',
  CLICK_API_BASE: 'https://click-api.invalid/v2/merchant',
  PAYME_DELIVERY_IKPU: '10112006002000000',
  PAYME_DELIVERY_PACKAGE_CODE: '1209885',
  PAYME_VAT_PERCENT: '0',
};
const IKPU = '03004001001000000';
const PACKAGE = '1501226';

/** A fresh answer of Click's Merchant API for every call (a Response body can be read once). */
const clickAnswer = (code: number, note: string) => new Response(JSON.stringify({ error_code: code, error_note: note }), { status: 200 });
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Click SHOP API (Prepare / Complete): signature, amount, repeated calls, cancellation, the fiscal receipt. */
describe('Click SHOP API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let tg = 872_000_000;
  let clickTrans = 9_000_000_000 + Math.floor(Math.random() * 1_000_000) * 100;
  const saved: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  const setModes = (click: 'hidden' | 'soon' | 'test' | 'live') =>
    http()
      .put('/api/staff/settings/checkout-options')
      .set(bearer(admin))
      .send({ cod_max_total_uzs: null, first_order_free_delivery: false, online: { payme: 'soon', click, uzum: 'soon' } });

  async function clickOrder(opts: { ikpu?: boolean; price?: number; qty?: number } = {}) {
    const p = await createTestProduct(prisma, { price: opts.price ?? 120_000, stock: 10 });
    if (opts.ikpu !== false) await prisma.products.update({ where: { id: p.id }, data: { ikpu_code: IKPU, package_code: PACKAGE } });
    const token = await loginCustomer(app, ++tg);
    await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: opts.qty ?? 2 }).expect(201);
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'cart', ...addr.tashkent, payment_method: 'click', recipient_name: 'Тест', recipient_phone: '90 123-45-67', address_text: 'ул. Тестовая, 1' })
        .expect(201)
    ).body;
    return { order, token, product: p, amount: `${Number(order.totals.total_uzs)}.00`, account: order.order_number.replace(/\D/g, '') as string };
  }

  type Fields = Record<string, string>;
  /** A signed Prepare (action 0) as Click sends it: form-urlencoded. */
  function prepareBody(o: { account: string; amount: string; transId?: string; error?: string; secret?: string; serviceId?: string }): Fields {
    const f: Fields = {
      click_trans_id: o.transId ?? String(++clickTrans),
      service_id: o.serviceId ?? SERVICE_ID,
      click_paydoc_id: String(clickTrans + 7),
      merchant_trans_id: o.account,
      amount: o.amount,
      action: '0',
      error: o.error ?? '0',
      error_note: o.error && o.error !== '0' ? 'Ошибка' : 'Success',
      sign_time: '2026-11-23 12:00:00',
    };
    f.sign_string = md5(f.click_trans_id + f.service_id + (o.secret ?? SECRET) + f.merchant_trans_id + f.amount + f.action + f.sign_time);
    return f;
  }
  function completeBody(prep: Fields, prepareId: number | string, o: { error?: string; amount?: string; secret?: string } = {}): Fields {
    const f: Fields = { ...prep, action: '1', merchant_prepare_id: String(prepareId), amount: o.amount ?? prep.amount, error: o.error ?? '0', error_note: o.error && o.error !== '0' ? 'Card declined' : 'Success' };
    delete f.sign_string;
    f.sign_string = md5(f.click_trans_id + f.service_id + (o.secret ?? SECRET) + f.merchant_trans_id + f.merchant_prepare_id + f.amount + f.action + f.sign_time);
    return f;
  }
  const prepare = async (f: Fields) => (await http().post('/api/payments/click/prepare').type('form').send(f).expect(200)).body;
  const complete = async (f: Fields) => (await http().post('/api/payments/click/complete').type('form').send(f).expect(200)).body;
  const orderRow = (id: string) => prisma.orders.findUniqueOrThrow({ where: { id } });

  let fetchSpy: jest.SpyInstance;
  beforeAll(async () => {
    for (const k of Object.keys(CLICK_ENV)) saved[k] = process.env[k];
    Object.assign(process.env, CLICK_ENV);
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    await setModes('live').expect(200);
  });
  beforeEach(() => {
    // the fiscal receipt never leaves the test: Click's Merchant API answers «Success»
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => clickAnswer(0, 'Success'));
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

  describe('checkout and the payment link', () => {
    it('preview offers Click; the link goes to my.click.uz with service, merchant, amount N.NN and the order digits', async () => {
      const { order, token, account } = await clickOrder();
      expect(order.payment.method).toBe('click');
      const start = (await http().post(`/api/payments/online/click/orders/${order.id}/start`).set(bearer(token)).send({ lang: 'uz' }).expect(200)).body;
      const url = new URL(start.checkout_url);
      expect(url.origin + url.pathname).toBe('https://my.click.uz/services/pay/');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ service_id: SERVICE_ID, merchant_id: '55555', amount: `${order.totals.total_uzs}.00`, transaction_param: account });
      expect(start.checkout_url).not.toContain(SECRET);

      const row = await prisma.notifications.findFirstOrThrow({ where: { order_id: order.id, template: 'order.accepted_pay' } });
      expect(row.payload).toMatchObject({ open_path: '/orders/' + order.id + '/click' });
    });

    it('«Скоро» or a product without ИКПУ: Click cannot be chosen', async () => {
      const noIkpu = await createTestProduct(prisma, { price: 50_000, stock: 5 });
      await prisma.products.update({ where: { id: noIkpu.id }, data: { ikpu_code: null, package_code: null } });
      const token = await loginCustomer(app, ++tg);
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: noIkpu.id, qty: 1 }).expect(201);
      const body = { source: 'cart', ...addr.tashkent, payment_method: 'click' };
      const preview = (await http().post('/api/orders/preview').set(bearer(token)).send({ ...body, payment_method: 'card_transfer' }).expect(200)).body;
      expect(preview.payment_options).toMatchObject({ click: false, click_unavailable: 'ikpu' });

      await setModes('soon').expect(200);
      try {
        const r = await http().post('/api/orders/preview').set(bearer(token)).send(body).expect(422);
        expect(r.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      } finally {
        await setModes('live').expect(200);
      }
    });

    it('the admin panel sees the Click module and keys (no values)', async () => {
      const opts = (await http().get('/api/staff/settings/checkout-options').set(bearer(admin)).expect(200)).body;
      expect(opts.online_status.click).toEqual({ keys_present: true, module_ready: true, can_go_live: true });
      expect(JSON.stringify(opts)).not.toContain(SECRET);
    });
  });

  describe('signature and request checks', () => {
    it('a wrong signature: -1, nothing is stored', async () => {
      const { account, amount, order } = await clickOrder();
      const bad = prepareBody({ account, amount, secret: 'wrong-secret' });
      expect(await prepare(bad)).toMatchObject({ error: -1, error_note: 'SIGN CHECK FAILED!' });
      expect(await prepare({ ...prepareBody({ account, amount }), amount: '1.00' })).toMatchObject({ error: -1 }); // amount changed after signing
      expect(await prisma.click_transactions.count({ where: { order_id: order.id } })).toBe(0);
    });

    it('missing fields -8; wrong action -3; another service -8', async () => {
      const { account, amount } = await clickOrder();
      expect((await prepare({ click_trans_id: '1' })).error).toBe(-8);
      const f = prepareBody({ account, amount });
      const wrongAction: Fields = { ...f, action: '1' };
      wrongAction.sign_string = md5(f.click_trans_id + f.service_id + SECRET + f.merchant_trans_id + f.amount + '1' + f.sign_time);
      expect((await prepare(wrongAction)).error).toBe(-3);
      expect((await prepare(prepareBody({ account, amount, serviceId: '1' }))).error).toBe(-8);
    });

    it('unknown order -5; wrong amount -2', async () => {
      const { account, amount } = await clickOrder();
      expect((await prepare(prepareBody({ account: '209901010001', amount }))).error).toBe(-5);
      expect((await prepare(prepareBody({ account, amount: '1000.00' }))).error).toBe(-2);
    });
  });

  describe('Prepare → Complete', () => {
    it('pays the order once; repeated Prepare and Complete get the same answer / -4; the receipt goes to Click', async () => {
      const { order, account, amount } = await clickOrder();
      const prep = prepareBody({ account, amount });
      const p1 = await prepare(prep);
      expect(p1).toMatchObject({ error: 0, click_trans_id: prep.click_trans_id, merchant_trans_id: account, merchant_prepare_id: expect.any(Number) });
      expect(await prepare(prep)).toMatchObject({ error: 0, merchant_prepare_id: p1.merchant_prepare_id }); // the same answer

      const done = await complete(completeBody(prep, p1.merchant_prepare_id));
      expect(done).toMatchObject({ error: 0, merchant_confirm_id: p1.merchant_prepare_id, click_trans_id: prep.click_trans_id });
      expect(await orderRow(order.id)).toMatchObject({ status: 'paid', payment_status: 'payment_success' });
      const payment = await prisma.payments.findFirstOrThrow({ where: { order_id: order.id } });
      expect(payment).toMatchObject({ status: 'payment_success', provider_payment_id: prep.click_trans_id });

      // repeated: Complete -4 (already paid), Prepare -4; still one payment and the order paid once
      expect((await complete(completeBody(prep, p1.merchant_prepare_id))).error).toBe(-4);
      expect((await prepare(prep)).error).toBe(-4);
      expect((await prepare(prepareBody({ account, amount }))).error).toBe(-4); // a new Click transaction for a paid order
      expect(await prisma.order_status_history.count({ where: { order_id: order.id, to_status: 'paid' } })).toBe(1);

      // the fiscal receipt: Merchant API with the Auth header, items with ИКПУ, the whole sum by card (tiyin)
      await new Promise((r) => setTimeout(r, 50));
      const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/payment/ofd_data/submit_items'));
      expect(call).toBeDefined();
      const sent = JSON.parse(String(call![1].body));
      expect(call![1].headers.Auth).toMatch(/^33333:[0-9a-f]{40}:\d{10}$/);
      expect(sent).toMatchObject({ service_id: Number(SERVICE_ID), payment_id: Number(prep.click_trans_id), received_card: Number(order.totals.total_uzs) * 100, received_cash: 0 });
      expect(sent.items[0]).toMatchObject({ SPIC: IKPU, PackageCode: PACKAGE, Amount: 2, VATPercent: 0, VAT: 0 });
      const tx = await prisma.click_transactions.findUniqueOrThrow({ where: { id: p1.merchant_prepare_id } });
      expect(tx).toMatchObject({ state: 1, fiscal_status: 'sent' });
    });

    it('Complete with a wrong signature -1, a wrong amount -2, an unknown prepare id -6', async () => {
      const { order, account, amount } = await clickOrder();
      const prep = prepareBody({ account, amount });
      const { merchant_prepare_id: id } = await prepare(prep);
      expect((await complete(completeBody(prep, id, { secret: 'nope' }))).error).toBe(-1);
      expect((await complete(completeBody(prep, id, { amount: '1.00' }))).error).toBe(-2);
      expect((await complete(completeBody(prep, 999_999_999))).error).toBe(-6);
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
    });

    it('Click reports a failure (error < 0): -9, the order keeps waiting and a new Click payment works', async () => {
      const { order, account, amount } = await clickOrder();
      const prep = prepareBody({ account, amount });
      const { merchant_prepare_id: id } = await prepare(prep);
      expect((await complete(completeBody(prep, id, { error: '-5017' })))).toMatchObject({ error: -9 });
      expect(await prisma.click_transactions.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: -1, click_error: -5017 });
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      // repeated Complete for the cancelled one: -9 again
      expect((await complete(completeBody(prep, id))).error).toBe(-9);
      expect((await prepare(prep)).error).toBe(-9);

      const again = prepareBody({ account, amount });
      const p2 = await prepare(again);
      expect((await complete(completeBody(again, p2.merchant_prepare_id))).error).toBe(0);
      expect((await orderRow(order.id)).status).toBe('paid');
    });

    it('the customer cancelled the order between Prepare and Complete: -9, nothing is paid', async () => {
      const { order, token, account, amount } = await clickOrder();
      const prep = prepareBody({ account, amount });
      const { merchant_prepare_id: id } = await prepare(prep);
      await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(200);
      expect((await complete(completeBody(prep, id))).error).toBe(-9);
      expect(await orderRow(order.id)).toMatchObject({ status: 'cancelled' });
      expect((await prisma.click_transactions.findUniqueOrThrow({ where: { id } })).state).toBe(-1);
      // a cancelled order cannot be prepared again
      expect((await prepare(prepareBody({ account, amount }))).error).toBe(-9);
    });

    it('reservation expiry waits for Complete after Prepare; without Prepare the order is cancelled', async () => {
      const job = app.get(ReservationExpiryService);
      const held = await clickOrder();
      const prep = prepareBody({ account: held.account, amount: held.amount });
      const { merchant_prepare_id: id } = await prepare(prep);
      const idle = await clickOrder();
      await prisma.orders.updateMany({ where: { id: { in: [held.order.id, idle.order.id] } }, data: { reserved_until: new Date(Date.now() - 60_000) } });

      await job.runOnce();
      expect((await orderRow(held.order.id)).status).toBe('awaiting_payment');
      expect((await orderRow(idle.order.id)).status).toBe('cancelled');
      expect((await complete(completeBody(prep, id))).error).toBe(0);
      expect((await orderRow(held.order.id)).status).toBe('paid');
    });

    it('the common address /payments/online/click/callback answers by action', async () => {
      const { account, amount } = await clickOrder();
      const prep = prepareBody({ account, amount });
      const r = (await http().post('/api/payments/online/click/callback').type('form').send(prep).expect(200)).body;
      expect(r).toMatchObject({ error: 0, merchant_prepare_id: expect.any(Number) });
    });

    it('a receipt Click did not accept is stored as failed and sent again', async () => {
      fetchSpy.mockImplementation(async () => clickAnswer(-5, 'Bad item'));
      const { account, amount } = await clickOrder();
      const prep = prepareBody({ account, amount });
      const { merchant_prepare_id: id } = await prepare(prep);
      await complete(completeBody(prep, id));
      await new Promise((r) => setTimeout(r, 50));
      expect(await prisma.click_transactions.findUniqueOrThrow({ where: { id } })).toMatchObject({ fiscal_status: 'failed', fiscal_error: expect.stringContaining('Bad item') });

      fetchSpy.mockImplementation(async () => clickAnswer(0, 'Success'));
      await app.get(ClickService).retryFiscal();
      expect(await prisma.click_transactions.findUniqueOrThrow({ where: { id } })).toMatchObject({ fiscal_status: 'sent', fiscal_attempts: 2 });
    });
  });
});
