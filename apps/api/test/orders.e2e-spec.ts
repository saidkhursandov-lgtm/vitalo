import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { tashkentDateString } from '../src/common/tashkent';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  archiveTestProducts,
  bearer,
  createTestApp,
  createTestProduct,
  DEV_MANAGER_TG,
  loginCustomer,
  loginStaff,
  seededAddresses,
  setStock,
  stockOf,
} from './helpers';

describe('Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let expiry: ReservationExpiryService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let tg = 800_000_000;
  const http = () => request(app.getHttpServer());
  const newCustomer = () => loginCustomer(app, ++tg);

  const checkout = (over: Record<string, unknown> = {}) => ({
    recipient_name: 'Тест Покупатель',
    recipient_phone: '90 123-45-67',
    ...addr.tashkent,
    address_text: 'ул. Тестовая, 1',
    payment_method: 'bank_transfer',
    ...over,
  });
  const buyNow = (product_id: string, qty: number, over: Record<string, unknown> = {}) =>
    checkout({ source: 'buy_now', buy_now: { product_id, qty }, ...over });
  const place = (token: string, body: object, key: string = randomUUID()) =>
    http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', key).send(body);
  const addToCart = (token: string, product_id: string, qty: number) =>
    http().post('/api/cart/items').set(bearer(token)).send({ product_id, qty }).expect(201);
  const reserveMovements = (orderId: string, type: 'reserve' | 'release' | 'deduct') =>
    prisma.inventory_movements.count({ where: { reference_type: 'order', reference_id: orderId, movement_type: type } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    expiry = app.get(ReservationExpiryService);
    addr = await seededAddresses(prisma);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('create from cart', () => {
    let token: string;
    let order: any;
    let p: { id: string };
    let gone: { id: string };

    beforeAll(async () => {
      token = await newCustomer();
      p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
      gone = await createTestProduct(prisma, { price: 50_000, stock: 5 });
      await addToCart(token, p.id, 2);
      await addToCart(token, gone.id, 1);
      await setStock(prisma, gone.id, 0); // ran out after it was put in the cart
      order = (await place(token, checkout({ source: 'cart' })).expect(201)).body;
    });

    it('gets a number VTL-YYYYMMDD-NNNN with the Tashkent date', () => {
      expect(order.order_number).toMatch(new RegExp(`^VTL-${tashkentDateString(new Date()).replace(/-/g, '')}-\\d{4}$`));
    });

    it('is awaiting payment, reserved for 12 hours, with history New -> Awaiting payment', () => {
      expect(order).toMatchObject({ status: 'awaiting_payment', payment_status: 'payment_pending', can_cancel: true });
      expect(order.payment).toMatchObject({ method: 'bank_transfer', status: 'payment_pending', amount_uzs: 220_000 });
      const hours = (new Date(order.reserved_until).getTime() - Date.now()) / 3600_000;
      expect(hours).toBeGreaterThan(11.9);
      expect(hours).toBeLessThanOrEqual(12);
      expect(order.history.map((h: any) => h.to_status)).toEqual(['new', 'awaiting_payment']);
    });

    it('fixes server-side prices and totals (delivery 20 000 below the 300 000 threshold)', () => {
      expect(order.items).toEqual([expect.objectContaining({ product_id: p.id, qty: 2, unit_price_uzs: 100_000, line_total_uzs: 200_000 })]);
      expect(order.totals).toEqual({
        goods_total_uzs: 200_000,
        discount_total_uzs: 0,
        bonus_used_uzs: 0,
        goods_paid_uzs: 200_000,
        delivery_cost_uzs: 20_000,
        total_uzs: 220_000,
      });
      expect(order.recipient.phone).toBe('+998901234567');
    });

    it('reserves stock (actual unchanged) and records a reserve movement', async () => {
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 10, reserved: 2 });
      expect(await reserveMovements(order.id, 'reserve')).toBe(1);
    });

    it('removes ordered lines from the cart; the unavailable line stays', async () => {
      const { body } = await http().get('/api/cart').set(bearer(token)).expect(200);
      expect(body.items.map((i: any) => [i.product_id, i.status])).toEqual([[gone.id, 'unavailable']]);
    });

    it('a later price change does not touch the existing order', async () => {
      await prisma.products.update({ where: { id: p.id }, data: { price_uzs: 150_000n } });
      const { body } = await http().get(`/api/orders/${order.id}`).set(bearer(token)).expect(200);
      expect(body.totals.total_uzs).toBe(220_000);
      await prisma.products.update({ where: { id: p.id }, data: { price_uzs: 100_000n } });
    });
  });

  describe('buy now', () => {
    it('orders only the chosen product and leaves the cart untouched', async () => {
      const token = await newCustomer();
      const inCart = await createTestProduct(prisma, { price: 10_000, stock: 5 });
      const now = await createTestProduct(prisma, { price: 40_000, stock: 5 });
      await addToCart(token, inCart.id, 3);

      const { body } = await place(token, buyNow(now.id, 2)).expect(201);
      expect(body.items.map((i: any) => [i.product_id, i.qty])).toEqual([[now.id, 2]]);

      const cart = (await http().get('/api/cart').set(bearer(token)).expect(200)).body;
      expect(cart.items.map((i: any) => [i.product_id, i.qty])).toEqual([[inCart.id, 3]]);
    });
  });

  describe('pricing is decided by the server', () => {
    it('ignores prices/totals sent by the client', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 70_000, stock: 5 });
      const { body } = await place(token, { ...buyNow(p.id, 1), total_uzs: 1, unit_price_uzs: 1, delivery_cost_uzs: 0 }).expect(201);
      expect(body.totals.total_uzs).toBe(90_000);
    });

    it('expected_total_uzs mismatch -> 409 PRICE_CHANGED, nothing reserved or created', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 70_000, stock: 5 });
      const res = await place(token, buyNow(p.id, 1, { expected_total_uzs: 80_000 })).expect(409);
      expect(res.body).toMatchObject({ code: 'PRICE_CHANGED', actual_total_uzs: 90_000 });
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });
      expect(await prisma.order_items.count({ where: { product_id: p.id } })).toBe(0);

      await place(token, buyNow(p.id, 1, { expected_total_uzs: 90_000 })).expect(201);
    });

    it('preview returns the same totals as the order, without reserving', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 110_000, stock: 5 });
      const preview = await http().post('/api/orders/preview').set(bearer(token)).send(buyNow(p.id, 3)).expect(200);
      expect(preview.body).toMatchObject({ can_place: true, totals: { total_uzs: 330_000, delivery_cost_uzs: 0 } });
      expect(preview.body.delivery.message_ru).toContain('доставка бесплатна');
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });

      const order = await place(token, buyNow(p.id, 3)).expect(201);
      expect(order.body.totals).toEqual(preview.body.totals);
    });

    it('uses the city tariff (Kattakurgan 45 000)', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
      const { body } = await place(token, buyNow(p.id, 1, addr.kattakurgan)).expect(201);
      expect(body.totals.delivery_cost_uzs).toBe(45_000);
    });
  });

  describe('validation and stock errors', () => {
    let token: string;
    beforeAll(async () => (token = await newCustomer()));

    it('requires Idempotency-Key', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const res = await http().post('/api/orders').set(bearer(token)).send(buyNow(p.id, 1)).expect(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('empty cart -> 422', async () => {
      expect((await place(token, checkout({ source: 'cart' })).expect(422)).body.code).toBe('EMPTY_ORDER');
    });

    it('not enough stock -> 409 with details, nothing reserved', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 3 });
      const res = await place(token, buyNow(p.id, 5)).expect(409);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', items: [{ product_id: p.id, requested: 5, available: 3 }] });
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 3, reserved: 0 });
    });

    it('one short line rolls back the reservation of all lines', async () => {
      const t = await newCustomer();
      const plenty = await createTestProduct(prisma, { price: 1_000, stock: 10 });
      const scarce = await createTestProduct(prisma, { price: 1_000, stock: 3 });
      await addToCart(t, plenty.id, 2);
      await addToCart(t, scarce.id, 3);
      await setStock(prisma, scarce.id, 2); // cart still says 3

      await place(t, checkout({ source: 'cart' })).expect(409);
      expect(await stockOf(prisma, plenty.id)).toEqual({ actual: 10, reserved: 0 });
      expect(await stockOf(prisma, scarce.id)).toEqual({ actual: 2, reserved: 0 });
    });

    it('rejects bad input', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      expect((await place(token, buyNow(p.id, 1, { payment_method: 'payme' })).expect(422)).body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      expect((await place(token, buyNow(p.id, 1, { city_id: addr.samarkand.city_id })).expect(400)).body.code).toBe('INVALID_ADDRESS');
      await place(token, buyNow(p.id, 1, { recipient_phone: '12345' })).expect(400);
      await place(token, buyNow(p.id, 0)).expect(400);
      await place(token, checkout({ source: 'buy_now' })).expect(400);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });
    });

    it('archived product cannot be bought', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      await prisma.products.update({ where: { id: p.id }, data: { status: 'archived' } });
      expect((await place(token, buyNow(p.id, 1)).expect(409)).body.code).toBe('PRODUCT_UNAVAILABLE');
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });
    });
  });

  describe('idempotency (double submit protection)', () => {
    it('repeating a request with the same key returns the same order and reserves once', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 5_000, stock: 10 });
      const key = randomUUID();

      const first = await place(token, buyNow(p.id, 2), key).expect(201);
      const again = await place(token, buyNow(p.id, 2), key).expect(201);

      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.order_number).toBe(first.body.order_number);
      expect(await prisma.order_items.count({ where: { product_id: p.id } })).toBe(1);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 10, reserved: 2 });
    });

    it('5 simultaneous submits with the same key create exactly one order', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 5_000, stock: 10 });
      const key = randomUUID();

      const results = await Promise.all(Array.from({ length: 5 }, () => place(token, buyNow(p.id, 3), key)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.order_items.count({ where: { product_id: p.id } })).toBe(1);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 10, reserved: 3 });
    });

    it('the same key with a different body -> 422', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 5_000, stock: 10 });
      const key = randomUUID();
      await place(token, buyNow(p.id, 1), key).expect(201);
      expect((await place(token, buyNow(p.id, 2), key).expect(422)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('keys are per customer', async () => {
      const p = await createTestProduct(prisma, { price: 5_000, stock: 10 });
      const key = randomUUID();
      const a = await place(await newCustomer(), buyNow(p.id, 1), key).expect(201);
      const b = await place(await newCustomer(), buyNow(p.id, 1), key).expect(201);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it('a failed attempt does not burn the key: retry after restock succeeds', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 5_000, stock: 1 });
      const key = randomUUID();
      await place(token, buyNow(p.id, 2), key).expect(409);
      await setStock(prisma, p.id, 5);
      await place(token, buyNow(p.id, 2), key).expect(201);
    });
  });

  describe('concurrent orders never oversell', () => {
    it('10 customers buy the last 5 units at the same moment: exactly 5 succeed', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const tokens = await Promise.all(Array.from({ length: 10 }, () => newCustomer()));

      const results = await Promise.all(tokens.map((t) => place(t, buyNow(p.id, 1))));
      const ok = results.filter((r) => r.status === 201);
      const conflict = results.filter((r) => r.status === 409);

      expect(ok).toHaveLength(5);
      expect(conflict).toHaveLength(5);
      conflict.forEach((r) => expect(r.body.code).toBe('INSUFFICIENT_STOCK'));
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 5 });
      expect(new Set(ok.map((r) => r.body.order_number)).size).toBe(5);
    });

    it('4 customers each want 2 of 5 units: exactly 2 succeed, 1 unit left', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const tokens = await Promise.all(Array.from({ length: 4 }, () => newCustomer()));
      const results = await Promise.all(tokens.map((t) => place(t, buyNow(p.id, 2))));

      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 4 });
    });

    it('parallel orders get consecutive unique numbers', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 50 });
      const tokens = await Promise.all(Array.from({ length: 6 }, () => newCustomer()));
      const results = await Promise.all(tokens.map((t) => place(t, buyNow(p.id, 1)).expect(201)));
      const seq = results.map((r) => Number(r.body.order_number.split('-')[2])).sort((a, b) => a - b);
      expect(seq).toEqual(seq.map((_, i) => seq[0] + i));
    });
  });

  describe('bank transfer', () => {
    let token: string;
    let staff: string;
    let order: any;
    let p: { id: string };

    beforeAll(async () => {
      token = await newCustomer();
      staff = await loginStaff(app, DEV_MANAGER_TG);
      p = await createTestProduct(prisma, { price: 60_000, stock: 10 });
      order = (await place(token, buyNow(p.id, 2)).expect(201)).body;
    });

    it('shows requisites from settings, the amount and the payment purpose', async () => {
      const { body } = await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(token)).expect(200);
      expect(body).toMatchObject({ amount_uzs: 140_000, purpose: `Оплата заказа ${order.order_number}`, customer_reported_paid_at: null });
      expect(body.requisites.recipient).toContain('ТЕСТ');
      expect(body.requisites).not.toHaveProperty('purpose_template');
      expect(body).toMatchObject({ method: 'bank_transfer', card: null });
      expect(body.hint.ru).toContain('Я оплатил(а)');
    });

    it('card transfer: the customer sees the card number and recipient instead of requisites', async () => {
      const buyer = await newCustomer();
      const cardProduct = await createTestProduct(prisma, { price: 30_000, stock: 3 });
      const cardOrder = (await place(buyer, buyNow(cardProduct.id, 1, { payment_method: 'card_transfer' })).expect(201)).body;
      expect(cardOrder.payment).toMatchObject({ method: 'card_transfer', status: 'payment_pending' });
      const { body } = await http().get(`/api/orders/${cardOrder.id}/payment/bank-transfer`).set(bearer(buyer)).expect(200);
      expect(body).toMatchObject({ method: 'card_transfer', requisites: null, card: { card_number: expect.stringMatching(/^[0-9]{16}$/) } });
      // Release 1 (D-04): the card holder's name is never shown to customers
      expect(body.card).not.toHaveProperty('recipient');

      await http().post(`/api/orders/${cardOrder.id}/payment/bank-transfer/paid`).set(bearer(buyer)).send({}).expect(200);
      const list = (await http().get('/api/orders').set(bearer(buyer)).expect(200)).body;
      const items = Array.isArray(list) ? list : list.items;
      expect(items.find((o: { id: string }) => o.id === cardOrder.id).payment_reported).toBe(true);
    });

    it('"Я оплатил" records the claim and creates one manager task, however many clicks', async () => {
      const first = await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200);
      await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200);

      expect(first.body.status).toBe('awaiting_payment');
      expect(first.body.payment.customer_reported_paid_at).toBeTruthy();
      const tasks = await prisma.manager_tasks.findMany({ where: { order_id: order.id } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: 'bank_transfer_check', status: 'open' });
    });

    it('staff endpoints: customer token 401, warehouse role 403', async () => {
      await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(token)).send({}).expect(401);
      await prisma.staff_users.create({ data: { telegram_user_id: 333_333_333n, name: 'Склад', role: 'warehouse' } });
      const wh = await loginStaff(app, 333_333_333);
      await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(wh)).send({}).expect(403);
      await http().post('/api/staff/auth/telegram').send({ initData: 'x' }).expect(401);
    });

    it('the manager sees it among orders awaiting confirmation', async () => {
      const { body } = await http().get('/api/staff/orders?awaiting_confirmation=true').set(bearer(staff)).expect(200);
      expect(body.items.map((o: any) => o.id)).toContain(order.id);
    });

    it('manager confirmation: Paid, reservation turns into a write-off, task closed, audit written', async () => {
      const { body } = await http()
        .post(`/api/staff/orders/${order.id}/confirm-payment`)
        .set(bearer(staff))
        .send({ comment: 'Деньги пришли' })
        .expect(200);

      expect(body).toMatchObject({ status: 'paid', payment_status: 'payment_success', can_cancel: false, reserved_until: null });
      expect(body.history.at(-1)).toMatchObject({ from_status: 'awaiting_payment', to_status: 'paid', changed_by_type: 'staff' });
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 8, reserved: 0 });
      expect(await reserveMovements(order.id, 'deduct')).toBe(1);
      expect((await prisma.manager_tasks.findFirstOrThrow({ where: { order_id: order.id } })).status).toBe('done');
      expect(await prisma.audit_logs.count({ where: { entity_id: order.id, action: 'order.bank_transfer_confirmed' } })).toBe(1);
    });

    it('confirming twice (or in parallel) never deducts twice', async () => {
      const results = await Promise.all(
        [1, 2, 3].map(() => http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(staff)).send({})),
      );
      results.forEach((r) => expect(r.status).toBe(200));
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 8, reserved: 0 });
      expect(await reserveMovements(order.id, 'deduct')).toBe(1);
    });

    it('a paid order cannot be cancelled by the customer', async () => {
      const res = await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(409);
      expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
    });

    it('the manager can confirm before the customer pressed "Я оплатил"', async () => {
      const o = (await place(await newCustomer(), buyNow(p.id, 1)).expect(201)).body;
      const { body } = await http().post(`/api/staff/orders/${o.id}/confirm-payment`).set(bearer(staff)).send({}).expect(200);
      expect(body.status).toBe('paid');
    });

    it('a blocked employee loses access immediately', async () => {
      await prisma.staff_users.create({ data: { telegram_user_id: 444_444_444n, name: 'Уволен', role: 'manager' } });
      const t = await loginStaff(app, 444_444_444);
      await prisma.staff_users.update({ where: { telegram_user_id: 444_444_444n }, data: { status: 'blocked' } });
      await http().get('/api/staff/orders').set(bearer(t)).expect(401);
    });
  });

  describe('customer cancellation', () => {
    it('cancels an unpaid order, releases stock, writes history; repeating is harmless', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const order = (await place(token, buyNow(p.id, 3)).expect(201)).body;
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 3 });

      const { body } = await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({ reason: 'Передумал' }).expect(200);
      expect(body).toMatchObject({ status: 'cancelled', payment_status: 'payment_cancelled', can_cancel: false });
      expect(body.payment.status).toBe('payment_cancelled');
      expect(body.history.at(-1)).toMatchObject({ from_status: 'awaiting_payment', to_status: 'cancelled', changed_by_type: 'customer', reason: 'Передумал' });
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });

      await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(200);
      expect(await reserveMovements(order.id, 'release')).toBe(1);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });
    });

    it('after cancellation: no payment confirmation, no "Я оплатил"', async () => {
      const token = await newCustomer();
      const staff = await loginStaff(app, DEV_MANAGER_TG);
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const order = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(200);

      const c = await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(staff)).send({}).expect(409);
      expect(c.body.code).toBe('ORDER_CANCELLED');
      await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(409);
    });

    it('after "Я оплатил(а)" the customer cannot cancel (payment is being checked); support can', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const order = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200);

      const view = (await http().get(`/api/orders/${order.id}`).set(bearer(token)).expect(200)).body;
      expect(view).toMatchObject({ status: 'awaiting_payment', can_cancel: false, delivery_eta: { min_days: 2, max_days: 5 } });
      const res = await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(409);
      expect(res.body.code).toBe('PAYMENT_BEING_CHECKED');
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 1 });
      const details = (await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(token)).expect(200)).body;
      expect(details.delivery_eta).toMatchObject({ min_days: 2, max_days: 5 });
    });

    it("other customers' orders are invisible", async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const order = (await place(await newCustomer(), buyNow(p.id, 1)).expect(201)).body;
      const stranger = await newCustomer();
      await http().get(`/api/orders/${order.id}`).set(bearer(stranger)).expect(404);
      await http().post(`/api/orders/${order.id}/cancel`).set(bearer(stranger)).send({}).expect(404);
      await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(stranger)).expect(404);
    });
  });

  describe('reservation expiry (background job)', () => {
    const expire = (orderId: string) =>
      prisma.orders.update({ where: { id: orderId }, data: { reserved_until: new Date(Date.now() - 60_000) } });

    it('cancels expired unpaid orders and releases stock; skips fresh and "Я оплатил" orders', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 10 });
      const tExpired = await newCustomer();
      const tReported = await newCustomer();
      const expired = (await place(tExpired, buyNow(p.id, 2)).expect(201)).body;
      const reported = (await place(tReported, buyNow(p.id, 3)).expect(201)).body;
      const fresh = (await place(await newCustomer(), buyNow(p.id, 1)).expect(201)).body;

      await http().post(`/api/orders/${reported.id}/payment/bank-transfer/paid`).set(bearer(tReported)).send({}).expect(200);
      await expire(expired.id);
      await expire(reported.id);

      // "Я оплатил" after the deadline is refused even before the job runs
      const late = await http().post(`/api/orders/${expired.id}/payment/bank-transfer/paid`).set(bearer(tExpired)).send({}).expect(409);
      expect(late.body.code).toBe('RESERVATION_EXPIRED');

      expect(await expiry.runOnce()).toBeGreaterThanOrEqual(1);

      const status = async (id: string) => (await prisma.orders.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(expired.id)).toBe('cancelled');
      expect(await status(reported.id)).toBe('awaiting_payment');
      expect(await status(fresh.id)).toBe('awaiting_payment');
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 10, reserved: 4 });

      const last = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: expired.id }, orderBy: { created_at: 'desc' } });
      expect(last).toMatchObject({ to_status: 'cancelled', changed_by_type: 'system', reason: 'Reservation expired: not paid in time' });

      expect(await expiry.runOnce()).toBe(0); // nothing left to do
    });

    it('job and customer cancelling at the same moment release stock exactly once', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const order = (await place(token, buyNow(p.id, 4)).expect(201)).body;
      await expire(order.id);

      await Promise.all([expiry.runOnce(), http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({})]);
      expect(await reserveMovements(order.id, 'release')).toBe(1);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 5, reserved: 0 });
    });
  });

  describe('my orders', () => {
    it('lists own orders newest first and prefills checkout from the last one', async () => {
      const token = await newCustomer();
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const first = (await place(token, buyNow(p.id, 1)).expect(201)).body;
      const second = (await place(token, buyNow(p.id, 1, { address_text: 'Новый адрес, 7' })).expect(201)).body;

      const { body } = await http().get('/api/orders').set(bearer(token)).expect(200);
      expect(body.total).toBe(2);
      expect(body.items.map((o: any) => o.id)).toEqual([second.id, first.id]);
      expect(body.items[0]).toMatchObject({ order_number: second.order_number, status: 'awaiting_payment', total_uzs: 21_000, items_count: 1 });

      const defaults = await http().get('/api/orders/checkout-defaults').set(bearer(token)).expect(200);
      expect(defaults.body).toMatchObject({ address_text: 'Новый адрес, 7', recipient_phone: '+998901234567', ...addr.tashkent });
    });
  });
});
