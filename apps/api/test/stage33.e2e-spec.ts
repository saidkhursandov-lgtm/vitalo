import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const MARKETER_TG = 833_000_001;

/** 3.3: one discount calculation and promo codes — rules, limits, margin protection, cancellation, admin section. */
describe('Stage 3.3 promo codes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let manager: string;
  let marketer: string;
  let tg = 833_100_000;
  let codeNo = 0;
  const http = () => request(app.getHttpServer());
  const hour = 3600_000;

  /** A unique code text for each test (the test database keeps codes between runs). */
  const newCode = (prefix = 'T') => `${prefix}${process.pid}X${Date.now() % 1_000_000}X${++codeNo}`.toUpperCase();

  async function makeCode(over: Record<string, unknown> = {}, as = admin) {
    const body = {
      code: newCode(),
      type: 'percent',
      value: 10,
      scope: 'order',
      first_order_only: false,
      per_customer_limit: 1,
      start_at: new Date(Date.now() - hour).toISOString(),
      end_at: new Date(Date.now() + 24 * hour).toISOString(),
      active: true,
      description_ru: 'Скидка для теста',
      description_uz: 'Test chegirmasi',
      ...over,
    };
    return (await http().post('/api/staff/promo-codes').set(bearer(as)).send(body).expect(201)).body;
  }

  async function customer() {
    return loginCustomer(app, ++tg);
  }

  /** A product with a purchase cost (or none) and, optionally, an «old price». */
  async function product(price: number, extra: { cost?: number; old?: number; brand_id?: string } = {}) {
    const p = await createTestProduct(prisma, { price, stock: 50 });
    return prisma.products.update({
      where: { id: p.id },
      data: { cost_uzs: extra.cost == null ? null : BigInt(extra.cost), old_price_uzs: extra.old == null ? null : BigInt(extra.old), brand_id: extra.brand_id ?? null },
    });
  }

  const checkout = (productId: string, qty: number, over: Record<string, unknown> = {}) => ({
    source: 'buy_now',
    buy_now: { product_id: productId, qty },
    recipient_name: 'Тест Промокод',
    recipient_phone: '90 123-45-67',
    ...addr.samarkand,
    address_text: 'ул. Тестовая, 1',
    payment_method: 'card_transfer',
    ...over,
  });
  const preview = (token: string, body: object) => http().post('/api/orders/preview').set(bearer(token)).send(body);
  const place = (token: string, body: object) => http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body);

  async function setCheckoutOptions(first_order_free_delivery: boolean) {
    const value = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery };
    await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    await prisma.staff_users.upsert({
      where: { telegram_user_id: BigInt(MARKETER_TG) },
      create: { telegram_user_id: BigInt(MARKETER_TG), name: 'Маркетолог E2E', role: 'marketer' },
      update: { status: 'active', role: 'marketer' },
    });
    marketer = await loginStaff(app, MARKETER_TG);
    await setCheckoutOptions(false);
    await prisma.settings.deleteMany({ where: { key: 'promo_guard' } }); // defaults: 10% markup, 20% without a cost
  });
  afterAll(async () => {
    await setCheckoutOptions(false);
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('admin section «Промокоды» (D-39 Б)', () => {
    it('admin and marketer create; manager only views', async () => {
      const c = await makeCode({}, marketer);
      expect(c).toMatchObject({ type: 'percent', value: 10, scope: 'order', active: true, per_customer_limit: 1 });
      await http().get('/api/staff/promo-codes').set(bearer(manager)).expect(200);
      await http().post('/api/staff/promo-codes').set(bearer(manager)).send({}).expect(403);
      await http().post(`/api/staff/promo-codes/${c.id}/status`).set(bearer(manager)).send({ active: false }).expect(403);
    });

    it('the code is stored without case and spaces; a taken code is refused; not Latin is refused', async () => {
      const text = newCode('lower').toLowerCase();
      const c = await makeCode({ code: `  ${text} ` });
      expect(c.code).toBe(text.toUpperCase());
      await http().post('/api/staff/promo-codes').set(bearer(admin)).send({ ...c, code: text }).expect(409);
      const bad = await http().post('/api/staff/promo-codes').set(bearer(admin)).send({ ...c, code: 'ПРОМО10' }).expect(400);
      expect(bad.body.code).toBe('BAD_CODE');
    });

    it('«Сгенерировать код» gives a free code', async () => {
      const { code } = (await http().get('/api/staff/promo-codes/generate').set(bearer(marketer)).expect(200)).body;
      expect(code).toMatch(/^VIT[A-Z2-9]{5}$/);
    });

    it('margin warning before saving: cut by cost, by «no cost» and products with a visible discount', async () => {
      const brand = await prisma.brands.create({ data: { name_ru: `E2E brand ${Date.now()}` } });
      const a = await product(100_000, { cost: 80_000, brand_id: brand.id });
      const b = await product(100_000, { brand_id: brand.id });
      const c = await product(100_000, { old: 125_000, brand_id: brand.id }); // 20% shown
      await product(100_000, { cost: 10_000, brand_id: brand.id }); // plenty of room: no warning
      const body = { code: newCode(), type: 'percent', value: 30, scope: 'brand', brand_ids: [brand.id], first_order_only: false, per_customer_limit: 1, start_at: new Date().toISOString(), end_at: new Date(Date.now() + hour).toISOString(), active: true };
      const r = (await http().post('/api/staff/promo-codes/margin-check').set(bearer(marketer)).send(body).expect(200)).body;
      expect(r.products_checked).toBe(4);
      const by = (id: string) => r.items.find((i: { product_id: string }) => i.product_id === id);
      expect(by(a.id)).toMatchObject({ wanted_uzs: 30_000, allowed_uzs: 12_000, reason: 'margin' });
      expect(by(b.id)).toMatchObject({ wanted_uzs: 30_000, allowed_uzs: 20_000, reason: 'no_cost' });
      expect(by(c.id)).toMatchObject({ allowed_uzs: 0, reason: 'product_discount' });
      expect(r.items).toHaveLength(3);
    });

    it('margin settings: admin only', async () => {
      expect((await http().get('/api/staff/promo-codes/settings').set(bearer(manager)).expect(200)).body).toEqual({ min_markup_pct: 10, max_discount_pct: 20 });
      await http().put('/api/staff/promo-codes/settings').set(bearer(marketer)).send({ min_markup_pct: 0, max_discount_pct: 90 }).expect(403);
    });
  });

  describe('calculation and rounding', () => {
    it('10% on goods: discount line, delivery after the discount, total', async () => {
      const c = await makeCode({ value: 10 });
      const p = await product(123_456, { cost: 10_000 });
      const token = await customer();
      const r = (await preview(token, checkout(p.id, 2, { promo_code: ` ${c.code.toLowerCase()} ` })).expect(200)).body;
      // 10% of 246 912 = 24 691.2 → 24 600 (down to 100 sum)
      expect(r.totals).toEqual({ goods_list_total_uzs: 246_912, campaign_discount_uzs: 0, goods_total_uzs: 246_912, discount_total_uzs: 24_600, bonus_used_uzs: 0, goods_paid_uzs: 222_312, delivery_cost_uzs: 35_000, total_uzs: 257_312 });
      expect(r.promo).toMatchObject({ code: c.code, discount_uzs: 24_600, free_delivery: false, capped: false, message_ru: `Промокод ${c.code} применён (−24 600 сум)` });
      expect(r.items[0].discount_uzs).toBe(24_600);
    });

    it('the free-delivery threshold counts goods after the promo code', async () => {
      const c = await makeCode({ type: 'fixed', value: 30_000 });
      const p = await product(510_000, { cost: 10_000 });
      const token = await customer();
      const without = (await preview(token, checkout(p.id, 1)).expect(200)).body;
      expect(without.totals.delivery_cost_uzs).toBe(0); // 510 000 ≥ 500 000
      const withCode = (await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body;
      expect(withCode.totals).toMatchObject({ discount_total_uzs: 30_000, delivery_cost_uzs: 35_000, total_uzs: 480_000 + 35_000 });
    });

    it('the order keeps the frozen calculation; lines, payment and refund basis use the discounted price', async () => {
      const c = await makeCode({ type: 'fixed', value: 30_000 });
      const a = await product(100_000, { cost: 89_000 }); // room 2 100
      const token = await customer();
      const cartLine = async (id: string, qty: number) => http().post('/api/cart/items').set(bearer(token)).send({ product_id: id, qty }).expect(201);
      const b = await product(100_000, { cost: 10_000 });
      await cartLine(a.id, 1);
      await cartLine(b.id, 1);
      await http().post('/api/cart/promo').set(bearer(token)).send({ code: c.code }).expect(201);
      const order = (await place(token, { ...checkout(a.id, 1), source: 'cart', buy_now: undefined }).expect(201)).body;
      expect(order.totals).toMatchObject({ goods_total_uzs: 200_000, discount_total_uzs: 30_000, total_uzs: 170_000 + 35_000 });
      expect(order.promo).toEqual({ code: c.code, discount_uzs: 30_000, free_delivery: false });
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payments: true } });
      const line = (id: string) => row.items.find((i) => i.product_id === id)!;
      expect(Number(line(a.id).discount_uzs)).toBe(2_100);
      expect(Number(line(b.id).discount_uzs)).toBe(27_900);
      expect(Number(line(b.id).paid_line_total_uzs)).toBe(72_100);
      expect(Number(row.payments[0].amount_uzs)).toBe(205_000);
      expect(row.promo_code).toBe(c.code);
      const snap = row.pricing_json as { discounts: { code: string; amount_uzs: number }[]; total_uzs: number; lines: unknown[] };
      expect(snap.discounts[0]).toMatchObject({ code: c.code, amount_uzs: 30_000, type: 'fixed', target: 'goods' });
      expect(snap.total_uzs).toBe(205_000);
      expect(snap.lines).toHaveLength(2);
      // the code left the cart together with the ordered lines
      expect((await prisma.carts.findFirstOrThrow({ where: { user: { telegram_user_id: BigInt(tg) }, status: 'active' } })).promo_code).toBeNull();
      // the bot message to the customer has the promo line
      const msg = await prisma.notifications.findFirstOrThrow({ where: { order_id: order.id, template: 'order.accepted_pay' } });
      expect((msg.payload as { promo: unknown }).promo).toEqual({ code: c.code, discount_uzs: 30_000, free_delivery: false });
    });

    it('a changed promo after preview: 409 PRICE_CHANGED through expected_total, never a silent new price', async () => {
      const c = await makeCode({ value: 10 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      const r = (await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body;
      await http().post(`/api/staff/promo-codes/${c.id}/status`).set(bearer(admin)).send({ active: false }).expect(200);
      const res = await place(token, checkout(p.id, 1, { promo_code: c.code, expected_total_uzs: r.totals.total_uzs })).expect(409);
      expect(res.body).toMatchObject({ code: 'PROMO_REJECTED', reason: 'disabled', message_ru: 'Промокод больше не действует' });
    });
  });

  describe('rules (D-39)', () => {
    it('errors in RU and UZ: unknown, not started, expired, min order', async () => {
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      const why = async (code: string) => (await preview(token, checkout(p.id, 1, { promo_code: code })).expect(200)).body.promo_rejection;
      expect(await why('NOSUCHCODE')).toMatchObject({ reason: 'not_found', message_ru: 'Такого промокода нет', message_uz: 'Bunday promokod yo‘q' });
      const later = await makeCode({ start_at: new Date(Date.now() + hour).toISOString(), end_at: new Date(Date.now() + 2 * hour).toISOString() });
      expect((await why(later.code)).reason).toBe('not_started');
      const old = await makeCode({ start_at: new Date(Date.now() - 2 * hour).toISOString(), end_at: new Date(Date.now() - hour).toISOString() });
      expect(await why(old.code)).toMatchObject({ reason: 'expired', message_ru: 'Срок действия промокода истёк' });
      const min = await makeCode({ min_order_uzs: 300_000 });
      expect(await why(min.code)).toMatchObject({ reason: 'min_order', message_ru: 'Промокод действует при заказе от 300 000 сум', message_uz: 'Promokod 300 000 so‘mlik buyurtmadan boshlab amal qiladi' });
      // the totals are computed without the code
      expect((await preview(token, checkout(p.id, 1, { promo_code: min.code })).expect(200)).body.totals.discount_total_uzs).toBe(0);
    });

    it('a promo code skips products with a visible discount above 15%; hidden Market «old prices» do not count', async () => {
      const c = await makeCode({ value: 10 });
      const shown = await product(100_000, { old: 125_000, cost: 10_000 }); // 20% crossed out
      const market = await product(100_000, { old: 400_000, cost: 10_000 }); // 75%: not shown (D-09)
      const token = await customer();
      expect((await preview(token, checkout(shown.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection).toMatchObject({ reason: 'not_applicable', message_ru: 'Промокод не подходит к товарам в корзине' });
      expect((await preview(token, checkout(market.id, 1, { promo_code: c.code })).expect(200)).body.totals.discount_total_uzs).toBe(10_000);
    });

    it('brand and product codes touch only their lines', async () => {
      const brand = await prisma.brands.create({ data: { name_ru: `E2E brand ${Date.now()}` } });
      const mine = await product(100_000, { cost: 10_000, brand_id: brand.id });
      const other = await product(100_000, { cost: 10_000 });
      const byBrand = await makeCode({ scope: 'brand', brand_ids: [brand.id], value: 20 });
      const byProduct = await makeCode({ scope: 'product', product_ids: [other.id], value: 20 });
      const token = await customer();
      expect((await preview(token, checkout(mine.id, 1, { promo_code: byBrand.code })).expect(200)).body.totals.discount_total_uzs).toBe(20_000);
      expect((await preview(token, checkout(other.id, 1, { promo_code: byBrand.code })).expect(200)).body.promo_rejection.reason).toBe('not_applicable');
      expect((await preview(token, checkout(other.id, 1, { promo_code: byProduct.code })).expect(200)).body.totals.discount_total_uzs).toBe(20_000);
    });

    it('margin protection: cost + 10%, or at most 20% without a cost', async () => {
      const c = await makeCode({ value: 50 });
      const withCost = await product(100_000, { cost: 80_000 });
      const noCost = await product(100_000);
      const token = await customer();
      const a = (await preview(token, checkout(withCost.id, 1, { promo_code: c.code })).expect(200)).body;
      expect(a.totals.discount_total_uzs).toBe(12_000);
      expect(a.promo.capped).toBe(true);
      expect((await preview(token, checkout(noCost.id, 1, { promo_code: c.code })).expect(200)).body.totals.discount_total_uzs).toBe(20_000);
    });

    it('the admin margin setting is used', async () => {
      await http().put('/api/staff/promo-codes/settings').set(bearer(admin)).send({ min_markup_pct: 50, max_discount_pct: 5 }).expect(200);
      try {
        const c = await makeCode({ value: 50 });
        const withCost = await product(100_000, { cost: 60_000 });
        const noCost = await product(100_000);
        const token = await customer();
        expect((await preview(token, checkout(withCost.id, 1, { promo_code: c.code })).expect(200)).body.totals.discount_total_uzs).toBe(10_000);
        expect((await preview(token, checkout(noCost.id, 1, { promo_code: c.code })).expect(200)).body.totals.discount_total_uzs).toBe(5_000);
      } finally {
        await http().put('/api/staff/promo-codes/settings').set(bearer(admin)).send({ min_markup_pct: 10, max_discount_pct: 20 }).expect(200);
      }
    });

    it('free delivery: delivery 0; not needed (and not counted) when the delivery is already free', async () => {
      const c = await makeCode({ type: 'free_delivery', value: 0, per_customer_limit: 5 });
      const cheap = await product(100_000, { cost: 10_000 });
      const dear = await product(600_000, { cost: 10_000 });
      const token = await customer();
      const r = (await preview(token, checkout(cheap.id, 1, { promo_code: c.code })).expect(200)).body;
      expect(r.totals).toMatchObject({ delivery_cost_uzs: 0, discount_total_uzs: 0, total_uzs: 100_000 });
      expect(r.promo).toMatchObject({ free_delivery: true, discount_uzs: 35_000, message_ru: `Промокод ${c.code} применён (−35 000 сум)` });
      expect(r.delivery).toMatchObject({ is_free: true, promo: true });
      // the threshold is reached: the code is not needed
      expect((await preview(token, checkout(dear.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection).toMatchObject({ reason: 'delivery_free', message_ru: 'Доставка уже бесплатная — промокод не нужен' });
      // the first order is delivered free: the same
      await setCheckoutOptions(true);
      try {
        const fresh = await customer();
        expect((await preview(fresh, checkout(cheap.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection.reason).toBe('delivery_free');
        // an order with the rejected code is refused, without the code it is placed — and no activation is taken
        await place(fresh, checkout(cheap.id, 1, { promo_code: c.code })).expect(409);
        expect(await prisma.promotion_usages.count({ where: { promotion_id: c.id } })).toBe(0);
      } finally {
        await setCheckoutOptions(false);
      }
    });

    it('free delivery stays free when the admin changes the city', async () => {
      const c = await makeCode({ type: 'free_delivery', value: 0 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      const order = (await place(token, checkout(p.id, 1, { promo_code: c.code })).expect(201)).body;
      expect(order.totals.delivery_cost_uzs).toBe(0);
      await http().patch(`/api/staff/orders/${order.id}`).set(bearer(manager)).send({ ...addr.kattakurgan, reason: 'клиент переехал' }).expect(200);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(row.delivery_cost_uzs)).toBe(0);
      expect(Number(row.total_uzs)).toBe(100_000);
    });

    it('«first order» = no order except cancelled ones — one rule for the code and for free delivery (D-39 В)', async () => {
      const c = await makeCode({ first_order_only: true, per_customer_limit: 5 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      expect((await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo).not.toBeNull();
      // an unpaid order without the code already counts
      const first = (await place(token, checkout(p.id, 1)).expect(201)).body;
      expect((await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection).toMatchObject({ reason: 'first_order', message_ru: 'Промокод только для первого заказа' });
      await setCheckoutOptions(true);
      try {
        expect((await preview(token, checkout(p.id, 1)).expect(200)).body.delivery.first_order).toBeFalsy();
        // cancelled orders do not count — for both
        await http().post(`/api/orders/${first.id}/cancel`).set(bearer(token)).send({}).expect(200);
        const again = (await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body;
        expect(again.promo).not.toBeNull();
        expect(again.delivery.first_order).toBe(true);
      } finally {
        await setCheckoutOptions(false);
      }
    });
  });

  describe('activations: reserve, cancel, limits', () => {
    it('one per customer: «Уже использован»; cancelling the order gives the activation back', async () => {
      const c = await makeCode({ value: 10 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      const order = (await place(token, checkout(p.id, 1, { promo_code: c.code })).expect(201)).body;
      expect(await prisma.promotion_usages.findFirstOrThrow({ where: { order_id: order.id } })).toMatchObject({ status: 'reserved' });
      expect((await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection).toMatchObject({ reason: 'already_used', message_ru: 'Промокод уже использован' });
      await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(200);
      expect(await prisma.promotion_usages.findFirstOrThrow({ where: { order_id: order.id } })).toMatchObject({ status: 'rolled_back' });
      expect((await preview(token, checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo).not.toBeNull();
    });

    it('a paid order consumes the activation; staff cancelling a paid order gives it back', async () => {
      const c = await makeCode({ value: 10, global_limit: 1 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      const order = (await place(token, checkout(p.id, 1, { promo_code: c.code })).expect(201)).body;
      await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      expect((await prisma.promotion_usages.findFirstOrThrow({ where: { order_id: order.id } })).status).toBe('consumed');
      expect((await preview(await customer(), checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection.reason).toBe('limit_reached');
      await http().post(`/api/staff/orders/${order.id}/cancel`).set(bearer(manager)).send({ reason: 'тест' }).expect(200);
      expect((await prisma.promotion_usages.findFirstOrThrow({ where: { order_id: order.id } })).status).toBe('rolled_back');
      expect((await preview(await customer(), checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo).not.toBeNull();
    });

    it('an expired reservation (order cancelled by the system) gives the activation back', async () => {
      const c = await makeCode({ value: 10 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      const order = (await place(token, checkout(p.id, 1, { promo_code: c.code })).expect(201)).body;
      await prisma.orders.update({ where: { id: order.id }, data: { reserved_until: new Date(Date.now() - 1000) } });
      const { ReservationExpiryService } = await import('../src/orders/reservation-expiry.service');
      await app.get(ReservationExpiryService).runOnce();
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('cancelled');
      expect((await prisma.promotion_usages.findFirstOrThrow({ where: { order_id: order.id } })).status).toBe('rolled_back');
    });

    it('the «всего» limit holds when orders come at the same moment', async () => {
      const c = await makeCode({ value: 10, global_limit: 2 });
      const p = await product(100_000, { cost: 10_000 });
      const tokens = await Promise.all(Array.from({ length: 6 }, () => customer()));
      const results = await Promise.all(tokens.map((t) => place(t, checkout(p.id, 1, { promo_code: c.code }))));
      const ok = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(2);
      expect(refused).toHaveLength(4);
      refused.forEach((r) => expect(r.body).toMatchObject({ code: 'PROMO_REJECTED', reason: 'limit_reached' }));
      expect(await prisma.promotion_usages.count({ where: { promotion_id: c.id, status: { in: ['reserved', 'consumed'] } } })).toBe(2);
    });

    it('cash on delivery with a discount: the limit and the amount use the discounted total', async () => {
      const c = await makeCode({ type: 'fixed', value: 50_000 });
      const p = await product(200_000, { cost: 10_000 });
      const value = { cod_max_total_uzs: 180_000, show_online_soon: false, first_order_free_delivery: false };
      await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
      try {
        const token = await customer();
        const body = checkout(p.id, 1, { ...addr.tashkent, payment_method: 'cod' });
        expect((await preview(token, body).expect(200)).body.payment_options.cod).toBe(false); // 220 000 > 180 000
        const r = (await preview(token, { ...body, promo_code: c.code }).expect(200)).body;
        expect(r.totals.total_uzs).toBe(170_000); // 150 000 + 20 000
        expect(r.payment_options.cod).toBe(true);
        const order = (await place(token, { ...body, promo_code: c.code }).expect(201)).body;
        expect(order.payment).toMatchObject({ method: 'cod', amount_uzs: 170_000 });
        await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
        expect((await prisma.promotion_usages.findFirstOrThrow({ where: { order_id: order.id } })).status).toBe('consumed');
        const msg = await prisma.notifications.findFirstOrThrow({ where: { order_id: order.id, template: 'order.cod_confirmed' } });
        expect((msg.payload as { promo: { discount_uzs: number } }).promo.discount_uzs).toBe(50_000);
      } finally {
        await setCheckoutOptions(false);
      }
    });
  });

  describe('cart', () => {
    it('apply, keep for checkout, remove; a code that stops fitting is removed with a hint', async () => {
      const c = await makeCode({ value: 10, min_order_uzs: 150_000 });
      const p = await product(100_000, { cost: 10_000 });
      const token = await customer();
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 1 }).expect(201);
      const refused = await http().post('/api/cart/promo').set(bearer(token)).send({ code: c.code }).expect(422);
      expect(refused.body).toMatchObject({ code: 'PROMO_REJECTED', reason: 'min_order', message_ru: 'Промокод действует при заказе от 150 000 сум' });
      await http().patch(`/api/cart/items/${p.id}`).set(bearer(token)).send({ qty: 2 }).expect(200);
      const cart = (await http().post('/api/cart/promo').set(bearer(token)).send({ code: c.code.toLowerCase(), ...addr.samarkand }).expect(201)).body;
      expect(cart).toMatchObject({ goods_total_uzs: 200_000, discount_total_uzs: 20_000, promo: { code: c.code, discount_uzs: 20_000 } });
      expect(cart.delivery.remaining_for_free_uzs).toBe(500_000 - 180_000);
      // the checkout takes the cart's code when the app sends none
      const pv = (await preview(token, { ...checkout(p.id, 1), source: 'cart', buy_now: undefined }).expect(200)).body;
      expect(pv.promo.code).toBe(c.code);
      // fewer jars: below the minimum → removed, with the reason
      const after = (await http().patch(`/api/cart/items/${p.id}`).set(bearer(token)).send({ qty: 1 }).expect(200)).body;
      expect(after.promo).toBeNull();
      expect(after.discount_total_uzs).toBe(0);
      expect(after.warnings).toContainEqual(expect.objectContaining({ code: 'promo_removed', promo_code: c.code, reason: 'min_order' }));
      expect((await http().get('/api/cart').set(bearer(token)).expect(200)).body.warnings.some((w: { code: string }) => w.code === 'promo_removed')).toBe(false);
      // [✕]
      await http().patch(`/api/cart/items/${p.id}`).set(bearer(token)).send({ qty: 2 }).expect(200);
      await http().post('/api/cart/promo').set(bearer(token)).send({ code: c.code }).expect(201);
      expect((await http().delete('/api/cart/promo').set(bearer(token)).expect(200)).body.promo).toBeNull();
    });
  });

  describe('admin stats and switching off', () => {
    it('used / limit, sum of discounts, revenue of paid orders; a used code keeps its text; disabled = refused', async () => {
      const c = await makeCode({ value: 10, global_limit: 10 });
      const p = await product(100_000, { cost: 10_000 });
      const paid = (await place(await customer(), checkout(p.id, 1, { promo_code: c.code })).expect(201)).body;
      await place(await customer(), checkout(p.id, 1, { promo_code: c.code })).expect(201);
      await http().post(`/api/staff/orders/${paid.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      const row = (await http().get('/api/staff/promo-codes').set(bearer(manager)).expect(200)).body.find((x: { id: string }) => x.id === c.id);
      expect(row).toMatchObject({ used: 2, used_paid: 1, global_limit: 10, discount_total_uzs: 20_000, revenue_uzs: 90_000 + 35_000, state: 'active' });
      const renamed = await http().put(`/api/staff/promo-codes/${c.id}`).set(bearer(admin)).send({ ...c, code: newCode() }).expect(409);
      expect(renamed.body.code).toBe('CODE_USED');
      await http().post(`/api/staff/promo-codes/${c.id}/status`).set(bearer(marketer)).send({ active: false }).expect(200);
      expect((await preview(await customer(), checkout(p.id, 1, { promo_code: c.code })).expect(200)).body.promo_rejection.reason).toBe('disabled');
      // nothing is deleted
      expect(await prisma.promo_codes.count({ where: { code: c.code } })).toBe(1);
      // the admin order card shows the code
      const card = (await http().get(`/api/staff/orders/${paid.id}`).set(bearer(manager)).expect(200)).body;
      expect(card.promo).toEqual({ code: c.code, discount_uzs: 10_000, free_delivery: false });
    });
  });
});
