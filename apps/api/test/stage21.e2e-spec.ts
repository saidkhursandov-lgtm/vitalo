import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;

/** Stage 2.1: short product name, Payme / Click / Uzum «Скоро» per system, online payment skeleton, payment_soon_click. */
describe('Stage 2.1 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let tg = 821_000_000;
  const http = () => request(app.getHttpServer());
  const newCustomer = () => loginCustomer(app, ++tg);
  const resetOptions = () => prisma.settings.deleteMany({ where: { key: 'checkout_options' } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    await resetOptions();
  });
  afterAll(async () => {
    await resetOptions();
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('short product name', () => {
    it('admin saves it; cart, checkout preview and the order show it with the photo and the form; empty = cleared', async () => {
      const p = await createTestProduct(prisma, { price: 50_000, stock: 5 });
      await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ short_name_ru: '  Витамин D3, 60 капс.  ', short_name_uz: 'Vitamin D3' }).expect(200);
      await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ short_name_ru: 'x'.repeat(61) }).expect(400);

      const token = await newCustomer();
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 1 }).expect(201);
      const cart = (await http().get('/api/cart').set(bearer(token)).expect(200)).body;
      expect(cart.items[0]).toMatchObject({ short_name_ru: 'Витамин D3, 60 капс.', short_name_uz: 'Vitamin D3' });

      const body = { source: 'cart', ...addr.tashkent, payment_method: 'card_transfer' };
      const preview = (await http().post('/api/orders/preview').set(bearer(token)).send(body).expect(200)).body;
      expect(preview.items[0]).toMatchObject({ short_name_ru: 'Витамин D3, 60 капс.', short_name_uz: 'Vitamin D3' });
      expect(preview.items[0]).toHaveProperty('image_url');
      expect(preview.items[0]).toHaveProperty('form');

      const order = (
        await http()
          .post('/api/orders')
          .set(bearer(token))
          .set('Idempotency-Key', randomUUID())
          .send({ ...body, recipient_name: 'Тест', recipient_phone: '90 123-45-67', address_text: 'ул. Тестовая, 1' })
          .expect(201)
      ).body;
      expect(order.items[0]).toMatchObject({ short_name_ru: 'Витамин D3, 60 капс.', short_name_uz: 'Vitamin D3' });

      await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ short_name_ru: '' }).expect(200);
      expect((await prisma.products.findUniqueOrThrow({ where: { id: p.id } })).short_name_ru).toBeNull();
    });
  });

  describe('Payme / Click / Uzum per system', () => {
    afterEach(resetOptions);
    const get = () => http().get('/api/staff/settings/checkout-options').set(bearer(admin)).expect(200);
    const put = (body: object) => http().put('/api/staff/settings/checkout-options').set(bearer(admin)).send(body);
    const base = { cod_max_total_uzs: null, first_order_free_delivery: false };

    it('nothing saved: all three «Скоро» (D-20) in the admin panel and in the Mini App', async () => {
      const opts = (await get()).body;
      expect(opts.online).toEqual({ payme: 'soon', click: 'soon', uzum: 'soon' });
      expect(opts.show_online_soon).toBe(true);
      // Payme's module is connected, but the tests have no keys (test-env.ts); Click has neither
      expect(opts.online_status.payme).toEqual({ keys_present: false, module_ready: true, can_go_live: false });
      expect(opts.online_status.click).toEqual({ keys_present: false, module_ready: false, can_go_live: false });
      const token = await newCustomer();
      const shop = (await http().get('/api/catalog/texts').set(bearer(token)).expect(200)).body;
      expect(shop.checkout.online).toEqual({ payme: 'soon', click: 'soon', uzum: 'soon' });
    });

    it('modes are saved per system; «Работает» is refused without keys and a module; the old switch still works', async () => {
      await put({ ...base, online: { payme: 'soon', click: 'hidden', uzum: 'soon' } }).expect(200);
      expect((await get()).body.online).toEqual({ payme: 'soon', click: 'hidden', uzum: 'soon' });

      const live = await put({ ...base, online: { payme: 'live', click: 'hidden', uzum: 'soon' } }).expect(400);
      expect(live.body).toMatchObject({ code: 'ONLINE_PROVIDER_NOT_CONNECTED', provider: 'payme' });
      expect(live.body.message).toContain('Payme нельзя включить');
      await put({ ...base, online: { payme: 'maybe', click: 'hidden', uzum: 'soon' } }).expect(400);

      // release 1 admin panel: only show_online_soon
      await put({ ...base, show_online_soon: false }).expect(200);
      expect((await get()).body).toMatchObject({ online: { payme: 'hidden', click: 'hidden', uzum: 'hidden' }, show_online_soon: false });
    });

    it('confirmation address answers «не подключено»; starting a payment is refused', async () => {
      const cb = await http().post('/api/payments/online/payme/callback').send({ method: 'CheckPerformTransaction' }).expect(501);
      expect(cb.body).toMatchObject({ error: 'not_connected' });
      await http().post('/api/payments/online/paypal/callback').send({}).expect(404);

      const token = await newCustomer();
      await http().post(`/api/payments/online/payme/orders/${randomUUID()}/start`).send({}).expect(401);
      const start = await http().post(`/api/payments/online/click/orders/${randomUUID()}/start`).set(bearer(token)).send({}).expect(409);
      expect(start.body).toMatchObject({ code: 'ONLINE_PAYMENT_NOT_CONNECTED' });
    });

    it('migration added the three methods switched off', async () => {
      const rows = await prisma.payment_methods.findMany({ where: { code: { in: ['payme', 'click', 'uzum'] } } });
      expect(rows.map((r) => [r.code, r.status]).sort()).toEqual([
        ['click', 'disabled'],
        ['payme', 'disabled'],
        ['uzum', 'disabled'],
      ]);
    });
  });

  it('analytics: payment_soon_click is counted per system in «Аналитика → Воронка»', async () => {
    const token = await newCustomer();
    const track = (system: string) => http().post('/api/analytics/events').set(bearer(token)).send({ event: 'payment_soon_click', props: { system } }).expect(202);
    await track('payme');
    await track('payme');
    await track('uzum');
    const funnel = (await http().get('/api/staff/dashboard/funnel?period=today').set(bearer(admin)).expect(200)).body;
    const soon = funnel.extra.find((e: { event: string }) => e.event === 'payment_soon_click');
    expect(soon.events).toBeGreaterThanOrEqual(3);
    expect(soon.by_system.find((s: { system: string }) => s.system === 'payme').events).toBeGreaterThanOrEqual(2);
    expect(soon.by_system.find((s: { system: string }) => s.system === 'uzum').events).toBeGreaterThanOrEqual(1);
  });
});
