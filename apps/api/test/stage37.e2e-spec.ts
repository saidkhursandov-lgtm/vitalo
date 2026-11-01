import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CampaignsService } from '../src/promo/campaigns.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const MARKETER_TG = 837_000_001;

/** 3.7: sales («Акции») — dates, limits, margin floor, one product in one sale, shop prices, cart, orders, start message. */
describe('Stage 3.7 campaigns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let manager: string;
  let marketer: string;
  let tg = 837_100_000;
  let codeNo = 0;
  const http = () => request(app.getHttpServer());
  const hour = 3600_000;
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

  async function product(price: number, cost: number | null = null) {
    const p = await createTestProduct(prisma, { price, stock: 50 });
    return prisma.products.update({ where: { id: p.id }, data: { cost_uzs: cost == null ? null : BigInt(cost) } });
  }

  const body = (items: { product_id: string; discount_pct?: number; campaign_price_uzs?: number }[], over: Record<string, unknown> = {}) => ({
    title_ru: `Распродажа ${++codeNo}`,
    title_uz: `Chegirma ${codeNo}`,
    skin: 'eleven_eleven',
    start_at: iso(-hour),
    end_at: iso(24 * hour),
    open_ended: false,
    active: true,
    notify_start: false,
    items,
    ...over,
  });
  const create = (b: object, as = admin) => http().post('/api/staff/campaigns').set(bearer(as)).send(b);
  const card = async (id: string) => (await http().get(`/api/catalog/products/${id}`).expect(200)).body;
  const setDates = (id: string, start: number, end: number) => prisma.promotions.update({ where: { id }, data: { start_at: new Date(Date.now() + start), end_at: new Date(Date.now() + end) } });

  const checkout = (productId: string, qty: number, over: Record<string, unknown> = {}) => ({
    source: 'buy_now',
    buy_now: { product_id: productId, qty },
    recipient_name: 'Тест Акция',
    recipient_phone: '90 123-45-67',
    ...addr.samarkand,
    address_text: 'ул. Тестовая, 1',
    payment_method: 'card_transfer',
    ...over,
  });
  const place = (token: string, b: object) => http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(b);

  async function makeCode(value: number) {
    const code = `S37X${process.pid}X${Date.now() % 1_000_000}X${++codeNo}`;
    await http()
      .post('/api/staff/promo-codes')
      .set(bearer(admin))
      .send({ code, type: 'percent', value, scope: 'order', first_order_only: false, per_customer_limit: 5, start_at: iso(-hour), end_at: iso(24 * hour), active: true })
      .expect(201);
    return code;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    await prisma.staff_users.upsert({
      where: { telegram_user_id: BigInt(MARKETER_TG) },
      create: { telegram_user_id: BigInt(MARKETER_TG), name: 'Маркетолог 3.7', role: 'marketer' },
      update: { status: 'active', role: 'marketer' },
    });
    marketer = await loginStaff(app, MARKETER_TG);
    await prisma.settings.deleteMany({ where: { key: 'promo_guard' } }); // 10% markup, 20% without a cost
  });
  afterAll(async () => {
    // sales of this suite must not show up in other suites (home banners)
    await prisma.promotions.updateMany({ where: { kind: 'campaign' }, data: { status: 'disabled' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('admin «Акции»: rules shown while typing and enforced on save', () => {
    it('admin and marketer create; manager only views', async () => {
      const p = await product(100_000, 40_000);
      const c = (await create(body([{ product_id: p.id, discount_pct: 20 }]), marketer).expect(201)).body;
      expect(c).toMatchObject({ skin: 'eleven_eleven', active: true, state: 'running', items: [{ product_id: p.id, discount_pct: 20 }] });
      expect(c.slug).toMatch(/^rasprodazha-\d+/);
      await http().get('/api/staff/campaigns').set(bearer(manager)).expect(200);
      await create(body([{ product_id: p.id, discount_pct: 10 }]), manager).expect(403);
      await http().post(`/api/staff/campaigns/${c.id}/status`).set(bearer(manager)).send({ active: false }).expect(403);
      await http().post(`/api/staff/campaigns/${c.id}/status`).set(bearer(marketer)).send({ active: false }).expect(200);
    });

    it('D-28: up to 35% with an end date; 25% without one (D-09)', async () => {
      const p = await product(100_000, 30_000);
      const ok = (await http().post('/api/staff/campaigns/check').set(bearer(marketer)).send(body([{ product_id: p.id, discount_pct: 35 }])).expect(200)).body;
      expect(ok).toMatchObject({ ok: true, items: [{ price_uzs: 65_000, discount_pct: 35, max_pct: 35, problem: null }] });
      const big = (await http().post('/api/staff/campaigns/check').set(bearer(marketer)).send(body([{ product_id: p.id, discount_pct: 36 }])).expect(200)).body;
      expect(big).toMatchObject({ ok: false, items: [{ problem: 'too_big' }] });
      const open = (await http().post('/api/staff/campaigns/check').set(bearer(marketer)).send(body([{ product_id: p.id, discount_pct: 30 }], { open_ended: true, end_at: null })).expect(200)).body;
      expect(open).toMatchObject({ ok: false, items: [{ problem: 'too_big', max_pct: 25 }] });
      const refused = await create(body([{ product_id: p.id, discount_pct: 36 }])).expect(422);
      expect(refused.body).toMatchObject({ code: 'CAMPAIGN_INVALID', items: [{ problem: 'too_big' }] });
      // an end date is required unless «Без даты окончания»
      expect((await create(body([{ product_id: p.id, discount_pct: 10 }], { end_at: null })).expect(422)).body.code).toBe('BAD_DATES');
    });

    it('margin floor (3.3): cost × 1.10; without a cost — at most 20%; the save below it is refused', async () => {
      const withCost = await product(100_000, 70_000);
      const noCost = await product(100_000);
      const r = (await http().post('/api/staff/campaigns/check').set(bearer(marketer)).send(body([{ product_id: withCost.id, campaign_price_uzs: 76_000 }, { product_id: noCost.id, discount_pct: 21 }])).expect(200)).body;
      expect(r.items).toEqual([
        expect.objectContaining({ product_id: withCost.id, floor_uzs: 77_000, problem: 'below_margin', cost_known: true }),
        expect.objectContaining({ product_id: noCost.id, floor_uzs: 80_000, problem: 'below_margin', cost_known: false }),
      ]);
      await create(body([{ product_id: withCost.id, campaign_price_uzs: 76_000 }])).expect(422);
      await create(body([{ product_id: withCost.id, campaign_price_uzs: 77_000 }, { product_id: noCost.id, discount_pct: 20 }])).expect(201);
    });

    it('one product — one switched-on sale at a time; touching dates and a switched-off sale do not block', async () => {
      const p = await product(100_000, 30_000);
      const first = (await create(body([{ product_id: p.id, discount_pct: 10 }], { start_at: iso(hour), end_at: iso(10 * hour) })).expect(201)).body;
      const clash = await create(body([{ product_id: p.id, discount_pct: 15 }], { start_at: iso(5 * hour), end_at: iso(20 * hour) })).expect(422);
      expect(clash.body.items[0].conflict).toMatchObject({ id: first.id });
      await create(body([{ product_id: p.id, discount_pct: 15 }], { start_at: first.end_at, end_at: iso(20 * hour) })).expect(201);
      const off = (await create(body([{ product_id: p.id, discount_pct: 20 }], { start_at: iso(2 * hour), end_at: iso(3 * hour), active: false })).expect(201)).body;
      // switching it on checks again
      expect((await http().post(`/api/staff/campaigns/${off.id}/status`).set(bearer(admin)).send({ active: true }).expect(422)).body.code).toBe('CAMPAIGN_INVALID');
    });
  });

  describe('shop: dates switch prices by themselves', () => {
    it('scheduled → regular price; running → sale price, old price crossed out, badge; ended → regular again', async () => {
      const p = await product(120_000, 40_000);
      const c = (await create(body([{ product_id: p.id, discount_pct: 25 }], { skin: 'black_friday', start_at: iso(hour), end_at: iso(5 * hour) })).expect(201)).body;
      expect((await card(p.id)).price_uzs).toBe(120_000);
      expect((await card(p.id)).campaign).toBeNull();

      await setDates(c.id, -hour, 5 * hour);
      const on = await card(p.id);
      expect(on).toMatchObject({ price_uzs: 90_000, old_price_uzs: 120_000, campaign: { id: c.id, skin: 'black_friday', discount_pct: 25, list_price_uzs: 120_000 } });
      const list = (await http().get('/api/catalog/products').query({ q: undefined, page: 1, page_size: 100 }).expect(200)).body;
      expect(list.items.length).toBeGreaterThan(0);
      const slides = (await http().get('/api/catalog/banners?lang=ru').expect(200)).body;
      expect(slides[0]).toMatchObject({ kind: 'campaign', link: { type: 'campaign' }, campaign: { id: expect.any(String) } });
      expect(slides.some((s: { campaign?: { id: string } }) => s.campaign?.id === c.id)).toBe(true);
      const page = (await http().get(`/api/catalog/campaigns/${c.slug}`).expect(200)).body;
      expect(page.campaign).toMatchObject({ id: c.id, max_discount_pct: 25, products_count: 1 });
      expect(page.items.map((i: { id: string }) => i.id)).toEqual([p.id]);

      await setDates(c.id, -5 * hour, -1);
      expect(await card(p.id)).toMatchObject({ price_uzs: 120_000, campaign: null });
      expect((await http().get(`/api/catalog/campaigns/${c.slug}`).expect(404)).body.code).toBe('CAMPAIGN_NOT_RUNNING');
      // products.price_uzs was never touched
      expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: p.id } })).price_uzs)).toBe(120_000);
    });

    it('a cost that grew after the save: the margin floor wins at sale time', async () => {
      const p = await product(100_000, 40_000);
      await create(body([{ product_id: p.id, discount_pct: 30 }])).expect(201);
      expect((await card(p.id)).price_uzs).toBe(70_000);
      await prisma.products.update({ where: { id: p.id }, data: { cost_uzs: 70_000n } });
      expect((await card(p.id)).price_uzs).toBe(77_000);
    });
  });

  describe('cart and order (one discount module)', () => {
    it('the cart shows «Акция …: −X»; the sale ends while in the cart → regular price and «Акция завершилась»', async () => {
      const p = await product(100_000, 30_000);
      const c = (await create(body([{ product_id: p.id, discount_pct: 20 }], { title_ru: 'Акция корзины' })).expect(201)).body;
      const token = await loginCustomer(app, ++tg);
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 2 }).expect(201);
      const cart = (await http().get('/api/cart').set(bearer(token)).expect(200)).body;
      expect(cart).toMatchObject({ goods_total_uzs: 160_000, goods_list_total_uzs: 200_000, campaign_discount_uzs: 40_000, campaigns: [{ promotion_id: c.id, title_ru: 'Акция корзины', amount_uzs: 40_000 }] });
      expect(cart.items[0]).toMatchObject({ unit_price_uzs: 80_000, list_price_uzs: 100_000, campaign: { id: c.id } });

      await setDates(c.id, -5 * hour, -1);
      const after = (await http().get('/api/cart').set(bearer(token)).expect(200)).body;
      expect(after.warnings).toEqual([expect.objectContaining({ code: 'campaign_ended', product_id: p.id, old_price_uzs: 80_000, new_price_uzs: 100_000, campaign_title_ru: 'Акция корзины' })]);
      expect(after).toMatchObject({ goods_total_uzs: 200_000, campaign_discount_uzs: 0, campaigns: [] });
      // shown once
      expect((await http().get('/api/cart').set(bearer(token)).expect(200)).body.warnings).toEqual([]);
    });

    it('promo code: not on a product in a sale above 15%, but on top of a sale of 15% or less', async () => {
      const big = await product(100_000, 10_000);
      const mild = await product(100_000, 10_000);
      await create(body([{ product_id: big.id, discount_pct: 30 }, { product_id: mild.id, discount_pct: 10 }])).expect(201);
      const code = await makeCode(10);
      const token = await loginCustomer(app, ++tg);
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: big.id, qty: 1 }).expect(201);
      const refused = await http().post('/api/cart/promo').set(bearer(token)).send({ code }).expect(422);
      expect(refused.body).toMatchObject({ reason: 'not_applicable' });
      await http().post('/api/cart/items').set(bearer(token)).send({ product_id: mild.id, qty: 1 }).expect(201);
      const cart = (await http().post('/api/cart/promo').set(bearer(token)).send({ code }).expect(201)).body;
      // only the 10% sale line takes the code: 10% of 90 000
      expect(cart).toMatchObject({ goods_total_uzs: 160_000, campaign_discount_uzs: 40_000, discount_total_uzs: 9_000 });
    });

    it('the order freezes the sale price and the «Акция» line; ending the sale later changes nothing', async () => {
      const p = await product(150_000, 50_000);
      const c = (await create(body([{ product_id: p.id, campaign_price_uzs: 120_000 }], { title_ru: '11.11', title_uz: '11.11' })).expect(201)).body;
      const token = await loginCustomer(app, ++tg);
      const order = (await place(token, checkout(p.id, 2)).expect(201)).body;
      expect(order.items[0]).toMatchObject({ unit_price_uzs: 120_000, list_price_uzs: 150_000, line_total_uzs: 240_000 });
      expect(order.campaigns).toEqual([{ promotion_id: c.id, title_ru: '11.11', title_uz: '11.11', skin: 'eleven_eleven', amount_uzs: 60_000 }]);
      expect(order.totals).toMatchObject({ goods_list_total_uzs: 300_000, goods_total_uzs: 240_000 });
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.pricing_json).toMatchObject({ version: 2, goods_list_total_uzs: 300_000, lines: [{ product_id: p.id, list_price_uzs: 150_000, campaign_id: c.id, campaign_discount_uzs: 60_000 }] });

      // the staff message about the new order has the line too
      const staffMsg = await prisma.notifications.findFirst({ where: { template: 'staff.new_order', payload: { path: ['order_number'], equals: order.order_number } } });
      expect(staffMsg?.payload).toMatchObject({ campaigns: [{ title_ru: '11.11', amount_uzs: 60_000 }] });

      await http().post(`/api/staff/campaigns/${c.id}/status`).set(bearer(admin)).send({ active: false }).expect(200);
      const again = (await http().get(`/api/orders/${order.id}`).set(bearer(token)).expect(200)).body;
      expect(again.items[0].unit_price_uzs).toBe(120_000);
      expect(again.campaigns[0].amount_uzs).toBe(60_000);
      const admin_view = (await http().get(`/api/staff/orders/${order.id}`).set(bearer(admin)).expect(200)).body;
      expect(admin_view.campaigns[0]).toMatchObject({ title_ru: '11.11', amount_uzs: 60_000 });
      // the list counts the order
      const list = (await http().get('/api/staff/campaigns').set(bearer(manager)).expect(200)).body;
      expect(list.find((x: { id: string }) => x.id === c.id)).toMatchObject({ orders: 1, discount_total_uzs: 60_000, state: 'disabled' });
    });
  });

  describe('«Сообщить о старте акции»', () => {
    it('centre for everybody, bot only with «Получать акции»; once per sale; at night — at 08:00', async () => {
      const p = await product(100_000, 30_000);
      const optIn = await loginCustomer(app, ++tg);
      const optOutTg = ++tg;
      await loginCustomer(app, optOutTg);
      await prisma.users.update({ where: { telegram_user_id: BigInt(optOutTg) }, data: { marketing_opt_in: false } });
      void optIn;
      // starts at night in Tashkent (02:00 = 21:00 UTC the day before)
      const night = new Date('2030-03-10T21:00:00.000Z');
      const c = (await create(body([{ product_id: p.id, discount_pct: 20 }], { notify_start: true, start_at: '2030-03-10T20:00:00.000Z', end_at: '2030-03-20T19:00:00.000Z' })).expect(201)).body;
      const campaigns = app.get(CampaignsService);
      expect(await campaigns.notifyStarted(new Date('2030-03-10T19:00:00.000Z'))).toBe(0); // not started yet
      const sent = await campaigns.notifyStarted(night);
      expect(sent).toBeGreaterThan(1);
      const rows = await prisma.notifications.findMany({ where: { dedup_key: { startsWith: `campaign:${c.id}:` } }, include: { user: { select: { telegram_user_id: true, marketing_opt_in: true } } } });
      expect(rows.length).toBe(sent);
      const outRow = rows.find((r) => r.user?.telegram_user_id === BigInt(optOutTg))!;
      expect(outRow).toMatchObject({ status: 'centre', category: 'promo', kind: 'marketing' });
      expect(rows.filter((r) => r.user?.marketing_opt_in).every((r) => r.status === 'queued')).toBe(true);
      expect(rows[0].next_attempt_at.toISOString()).toBe('2030-03-11T03:00:00.000Z'); // 08:00 Tashkent
      expect(rows[0].payload).toMatchObject({ title_ru: expect.stringContaining('началась'), text_ru: expect.stringContaining('20%'), open_path: `/campaign/${c.slug}` });
      expect(await campaigns.notifyStarted(night)).toBe(0); // once
      await http().post(`/api/staff/campaigns/${c.id}/status`).set(bearer(admin)).send({ active: false }).expect(200);
    });
  });
});
