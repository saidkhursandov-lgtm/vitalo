import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TEST_ENV } from './test-env';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;

/** Release 1: «Оплата при получении» (only the city of Tashkent, limit), first order free delivery, new analytics events, D-18 reminder. */
describe('Release 1 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let expiry: ReservationExpiryService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let oblast: { region_id: string; city_id: string }; // «Ташкентская область» — NOT the city of Tashkent
  let admin: string;
  let manager: string;
  let tg = 810_000_000;
  const http = () => request(app.getHttpServer());
  const newCustomer = () => loginCustomer(app, ++tg);

  const checkout = (over: Record<string, unknown> = {}) => ({
    recipient_name: 'Тест Покупатель',
    recipient_phone: '90 123-45-67',
    ...addr.tashkent,
    address_text: 'ул. Тестовая, 1',
    payment_method: 'cod',
    ...over,
  });
  const buyNow = (product_id: string, qty: number, over: Record<string, unknown> = {}) => checkout({ source: 'buy_now', buy_now: { product_id, qty }, ...over });
  const place = (token: string, body: object) => http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body);
  const preview = (token: string, body: object) => http().post('/api/orders/preview').set(bearer(token)).send(body);
  const setOptions = (value: Record<string, unknown>) =>
    prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value: value as object }, update: { value: value as object } });
  const defaults = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    expiry = app.get(ReservationExpiryService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);

    const region = await prisma.regions.create({ data: { name_ru: 'Ташкентская область', name_uz: 'Toshkent viloyati' } });
    const city = await prisma.cities.create({ data: { region_id: region.id, name_ru: 'Чирчик', name_uz: 'Chirchiq' } });
    await prisma.delivery_tariffs.create({ data: { region_id: region.id, tariff_uzs: 30_000n, free_shipping_threshold_uzs: 300_000n } });
    oblast = { region_id: region.id, city_id: city.id };
    await setOptions(defaults);
  });
  afterAll(async () => {
    await setOptions(defaults);
    // the extra region must not stay in the shared test database (other suites count regions and cities)
    await prisma.delivery_tariffs.deleteMany({ where: { region_id: oblast.region_id } });
    await prisma.cities.deleteMany({ where: { region_id: oblast.region_id } });
    await prisma.regions.delete({ where: { id: oblast.region_id } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('cash on delivery: only the city of Tashkent', () => {
    it('is offered in Tashkent and creates an order waiting for the manager, without a payment deadline', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const view = (await preview(token, buyNow(p.id, 1)).expect(200)).body;
      expect(view.payment_options).toEqual({ cod: true, cod_unavailable: null, payme: false, payme_unavailable: 'off' });
      expect(view.can_place).toBe(true);

      const order = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      expect(order).toMatchObject({ status: 'new', payment_status: 'payment_pending' });
      expect(order.payment).toMatchObject({ method: 'cod', status: 'payment_pending' });
      expect(order.reserved_until).toBeNull();
    });

    it('is refused for another region (422 COD_UNAVAILABLE, reason region)', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const view = (await preview(token, buyNow(p.id, 1, addr.samarkand)).expect(200)).body;
      expect(view.payment_options).toEqual({ cod: false, cod_unavailable: 'region', payme: false, payme_unavailable: 'off' });
      expect(view.can_place).toBe(false); // the chosen method (cod) is blocked

      const res = await place(token, buyNow(p.id, 1, addr.samarkand)).expect(422);
      expect(res.body).toMatchObject({ code: 'COD_UNAVAILABLE', reason: 'region' });
    });

    it('is refused for the Tashkent REGION («Ташкентская область») — the city only', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const view = (await preview(token, buyNow(p.id, 1, oblast)).expect(200)).body;
      expect(view.payment_options).toEqual({ cod: false, cod_unavailable: 'region', payme: false, payme_unavailable: 'off' });
      const res = await place(token, buyNow(p.id, 1, oblast)).expect(422);
      expect(res.body).toMatchObject({ code: 'COD_UNAVAILABLE', reason: 'region' });
      // the order was not created: the whole transaction (with the stock reserve) is rolled back
      expect(await prisma.orders.count({ where: { user: { telegram_user_id: BigInt(tg) } } })).toBe(0);
    });

    it('a card transfer is still possible in the same region (checked on the preview: no order is left in the region)', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const view = (await preview(token, buyNow(p.id, 1, { ...oblast, payment_method: 'card_transfer' })).expect(200)).body;
      expect(view.can_place).toBe(true);
    });
  });

  describe('limit of the order total (cod_max_total_uzs)', () => {
    afterEach(() => setOptions(defaults));

    it('empty limit = no limit', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 9_000_000, stock: 5 });
      await place(token, buyNow(p.id, 1)).expect(201);
    });

    it('refuses a total above the limit and accepts a total equal to it (the total includes delivery)', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      // Tashkent delivery is 20 000, free from 300 000 -> 100 000 + 20 000 = 120 000
      await setOptions({ ...defaults, cod_max_total_uzs: 119_999 });
      const view = (await preview(token, buyNow(p.id, 1)).expect(200)).body;
      expect(view.totals.total_uzs).toBe(120_000);
      expect(view.payment_options).toEqual({ cod: false, cod_unavailable: 'limit', payme: false, payme_unavailable: 'off' });
      expect((await place(token, buyNow(p.id, 1)).expect(422)).body).toMatchObject({ code: 'COD_UNAVAILABLE', reason: 'limit' });

      await setOptions({ ...defaults, cod_max_total_uzs: 120_000 });
      await place(token, buyNow(p.id, 1)).expect(201);
    });

    it('admin settings: GET/PUT checkout-options, empty limit is saved as null, a manager cannot change it', async () => {
      const put = (body: object, token = admin) => http().put('/api/staff/settings/checkout-options').set(bearer(token)).send(body);
      await put({ cod_max_total_uzs: 500_000, show_online_soon: true, first_order_free_delivery: true }).expect(200);
      expect((await http().get('/api/staff/settings/checkout-options').set(bearer(admin)).expect(200)).body).toMatchObject({
        cod_max_total_uzs: 500_000,
        show_online_soon: true,
        first_order_free_delivery: true,
      });
      await put({ ...defaults }).expect(200); // empty limit
      // 2.1: the answer also has the per-system modes (old switch false = all hidden) and what is missing for «Работает»
      expect((await http().get('/api/staff/settings/checkout-options').set(bearer(admin)).expect(200)).body).toMatchObject({
        ...defaults,
        online: { payme: 'hidden', click: 'hidden', uzum: 'hidden' },
      });
      await put({ ...defaults, cod_max_total_uzs: 0 }).expect(400);
      await put({ ...defaults, cod_max_total_uzs: 'abc' }).expect(400);
      await put({ cod_max_total_uzs: 1 }).expect(400); // first_order_free_delivery is required too
      await put({ ...defaults, cod_max_total_uzs: 1 }, manager).expect(403);
    });
  });

  describe('first order: free delivery', () => {
    afterEach(() => setOptions(defaults));

    it('the first order of a customer is delivered free, the second one pays; off by default', async () => {
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const card = { payment_method: 'card_transfer' };

      const off = await newCustomer();
      expect((await preview(off, buyNow(p.id, 1, card)).expect(200)).body.totals.delivery_cost_uzs).toBe(20_000);

      await setOptions({ ...defaults, first_order_free_delivery: true });
      const token = await newCustomer();
      const first = (await preview(token, buyNow(p.id, 1, card)).expect(200)).body;
      expect(first.totals.delivery_cost_uzs).toBe(0);
      expect(first.delivery).toMatchObject({ first_order: true, is_free: true });

      await place(token, buyNow(p.id, 1, card)).expect(201);
      const second = (await preview(token, buyNow(p.id, 1, card)).expect(200)).body;
      expect(second.totals.delivery_cost_uzs).toBe(20_000);
    });
  });

  describe('home: free-delivery offer (GET /delivery/free-shipping)', () => {
    afterEach(() => setOptions(defaults));

    it('the threshold is the Tashkent tariff\'s (not a number from the code); the first-order offer is per customer', async () => {
      await http().get('/api/delivery/free-shipping').expect(401);
      const token = await newCustomer();
      const info = async () => (await http().get('/api/delivery/free-shipping').set(bearer(token)).expect(200)).body;

      // switch off: only the threshold
      expect(await info()).toEqual({ from_uzs: 300_000, first_order_free: false });
      await setOptions({ ...defaults, first_order_free_delivery: true });
      expect(await info()).toEqual({ from_uzs: 300_000, first_order_free: true });

      // the admin changes the tariff: the home page follows it
      const tariff = await prisma.delivery_tariffs.findFirstOrThrow({ where: { city_id: null, region: { name_ru: 'г. Ташкент' } } });
      await prisma.delivery_tariffs.update({ where: { id: tariff.id }, data: { free_shipping_threshold_uzs: 250_000n } });
      try {
        expect(await info()).toEqual({ from_uzs: 250_000, first_order_free: true });
        // after a real (not cancelled) order the first-order offer is gone, the threshold stays
        const p = await createTestProduct(prisma, { price: 100_000, stock: 5 });
        await place(token, buyNow(p.id, 1, { payment_method: 'card_transfer' })).expect(201);
        expect(await info()).toEqual({ from_uzs: 250_000, first_order_free: false });
      } finally {
        await prisma.delivery_tariffs.update({ where: { id: tariff.id }, data: { free_shipping_threshold_uzs: 300_000n } });
      }
    });
  });

  describe('analytics events', () => {
    it('accepts language_change and cod_selected; refuses an unknown event', async () => {
      const token = await newCustomer();
      const send = (event: string, props?: object) => http().post('/api/analytics/events').set(bearer(token)).send({ event, props });
      await send('language_change', { to: 'uz' }).expect(202);
      await send('cod_selected').expect(202);
      await send('made_up_event').expect(400);
      const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(tg) } });
      const names = (await prisma.analytics_events.findMany({ where: { user_id: user.id } })).map((e) => e.event);
      expect(names).toEqual(expect.arrayContaining(['language_change', 'cod_selected']));
    });
  });

  describe('managers: cod orders in the list and the D-18 reminder', () => {
    let codOrder: { id: string; order_number: string };
    let codCustomerTg = 0;

    beforeAll(async () => {
      const token = await newCustomer();
      codCustomerTg = tg;
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      codOrder = (await place(token, buyNow(p.id, 1)).expect(201)).body;
    });

    it('the filter «ожидают подтверждения» shows the cod order and the list tells the payment method', async () => {
      const list = (await http().get('/api/staff/orders?awaiting_confirmation=true&page_size=100').set(bearer(admin)).expect(200)).body;
      const row = list.items.find((o: { id: string }) => o.id === codOrder.id);
      expect(row).toMatchObject({ payment_method: 'cod', status: 'new' });
    });

    it('the bot gets the payment method of the last orders, so it can say «Ожидает подтверждения» instead of «Ожидает оплаты»', async () => {
      const { body } = await http().get(`/api/internal/bot/users/${codCustomerTg}`).set('x-bot-secret', TEST_ENV.BOT_API_SECRET).expect(200);
      expect(body.orders[0]).toMatchObject({ id: codOrder.id, status: 'new', payment_method: 'cod' });
    });

    it('moving a cod order out of Tashkent is refused (409 COD_REGION)', async () => {
      const res = await http().patch(`/api/staff/orders/${codOrder.id}`).set(bearer(admin)).send({ ...addr.samarkand, reason: 'клиент переехал' }).expect(409);
      expect(res.body).toMatchObject({ code: 'COD_REGION' });
    });

    it('moving a cod order to another place in Tashkent is checked against the limit with the new delivery', async () => {
      // goods 100 000: delivery in Tashkent is 20 000, so the total is 120 000 and does not change -> allowed even with a low limit
      await setOptions({ ...defaults, cod_max_total_uzs: 100 });
      await http().patch(`/api/staff/orders/${codOrder.id}`).set(bearer(admin)).send({ ...addr.tashkent, address_text: 'ул. Новая, 5', reason: 'новый адрес' }).expect(200);
      await setOptions(defaults);
    });

    it('reminds the managers once, 3 hours after the order and only 8:00–22:00 Tashkent; a night order — at 8:00', async () => {
      const staffReminders = (orderNumber: string) =>
        prisma.notifications.count({ where: { template: 'staff.cod_confirm_overdue', payload: { path: ['order_number'], equals: orderNumber } } });
      // The order was placed at 10:00 Tashkent (05:00 UTC)
      await prisma.orders.update({ where: { id: codOrder.id }, data: { created_at: new Date('2026-10-20T05:00:00Z') } });
      expect(await expiry.remindCodOnce(new Date('2026-10-20T07:59:00Z'))).toBe(0); // 2 h 59 min
      expect(await staffReminders(codOrder.order_number)).toBe(0);
      expect(await expiry.remindCodOnce(new Date('2026-10-20T08:00:00Z'))).toBe(1); // 3 h, 13:00 Tashkent
      expect(await staffReminders(codOrder.order_number)).toBeGreaterThan(0);
      expect(await expiry.remindCodOnce(new Date('2026-10-20T09:00:00Z'))).toBe(0); // only once

      // placed at 20:00 Tashkent (15:00 UTC): 3 hours end at 23:00 — night, nothing until 8:00
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const night = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      await prisma.orders.update({ where: { id: night.id }, data: { created_at: new Date('2026-10-21T15:00:00Z') } });
      expect(await expiry.remindCodOnce(new Date('2026-10-21T18:30:00Z'))).toBe(0); // 23:30, night
      expect(await expiry.remindCodOnce(new Date('2026-10-22T02:59:00Z'))).toBe(0); // 07:59
      expect(await expiry.remindCodOnce(new Date('2026-10-22T03:00:00Z'))).toBe(1); // 08:00
    });

    it('a confirmed cod order is not reminded and the timer never cancels it', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const o = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      await prisma.orders.update({ where: { id: o.id }, data: { created_at: new Date('2026-10-23T05:00:00Z') } });
      await http().post(`/api/staff/orders/${o.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      expect(await expiry.remindCodOnce(new Date('2026-10-23T09:00:00Z'))).toBe(0);
      // the timer that cancels unpaid orders (even a year later) leaves cash-on-delivery orders alone
      await expiry.runOnce(new Date('2027-10-29T00:00:00Z'));
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('cancelled');
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: codOrder.id } })).status).toBe('new');
    });

    it('D-53: a confirmed cod order is not paid until «Доставлен»; a second confirm changes nothing', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const o = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      const stock = async () => (await prisma.inventory.findFirstOrThrow({ where: { product_id: p.id } })).actual_qty;
      await http().post(`/api/staff/orders/${o.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      const afterConfirm = await stock();
      let row = await prisma.orders.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } });
      expect(row).toMatchObject({ status: 'paid', payment_status: 'payment_pending', paid_at: null });
      expect(row.payments[0].status).toBe('payment_pending');
      // the label can be printed for a confirmed cod order
      const card = (await http().get(`/api/staff/orders/${o.id}`).set(bearer(manager)).expect(200)).body;
      expect(card.actions.print_label).toBe(true);
      await http().post(`/api/staff/orders/${o.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      expect(await stock()).toBe(afterConfirm);
      for (const status of ['picking', 'handed_to_delivery', 'in_transit']) {
        await http().post(`/api/staff/orders/${o.id}/status`).set(bearer(manager)).send({ status }).expect(200);
      }
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).payment_status).toBe('payment_pending');
      await http().post(`/api/staff/orders/${o.id}/status`).set(bearer(manager)).send({ status: 'delivered' }).expect(200);
      row = await prisma.orders.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } });
      expect(row.payment_status).toBe('payment_success');
      expect(row.paid_at).not.toBeNull();
      expect(row.payments[0].status).toBe('payment_success');
    });

    it('D-53: cancelling a confirmed cod order cancels its payment (no money was taken)', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      const o = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      await http().post(`/api/staff/orders/${o.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      await http().post(`/api/staff/orders/${o.id}/cancel`).set(bearer(manager)).send({ reason: 'Клиент передумал' }).expect(200);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } });
      expect(row).toMatchObject({ status: 'cancelled', payment_status: 'payment_cancelled' });
      expect(row.payments[0].status).toBe('payment_cancelled');
    });
  });
});
