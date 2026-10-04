import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { cleanProps } from '../src/analytics/analytics.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { periodStart } from '../src/staff/dashboard';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';
import { TEST_ENV } from './test-env';

const ADMIN_TG = 222_222_221;

describe('Launch block B (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    addr = await seededAddresses(prisma);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ B3 funnel analytics
  describe('B3: funnel analytics', () => {
    it('props keep only short plain values', () => {
      expect(cleanProps({ product_id: 'x'.repeat(100), qty: 2, ok: true, nested: { a: 1 }, 'Bad-Key': 1 })).toEqual({ product_id: 'x'.repeat(64), qty: 2, ok: true });
      expect(cleanProps('nope')).toBeUndefined();
    });

    it('"today" starts at midnight in Tashkent', () => {
      expect(periodStart('today', new Date('2026-10-04T03:00:00Z')).toISOString()).toBe('2026-10-03T19:00:00.000Z');
      expect(periodStart('today', new Date('2026-10-04T20:00:00Z')).toISOString()).toBe('2026-10-04T19:00:00.000Z');
    });

    it('the app may send only its own steps, signed in; spam over the limit is dropped', async () => {
      const token = await loginCustomer(app, 980_000_001);
      await http().post('/api/analytics/events').send({ event: 'app_open' }).expect(401);
      await http().post('/api/analytics/events').set(bearer(token)).send({ event: 'order_created' }).expect(400);
      await http().post('/api/analytics/events').set(bearer(token)).send({ event: 'hack' }).expect(400);
      const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: 980_000_001n } });

      const answers = [];
      for (let i = 0; i < 32; i++) answers.push((await http().post('/api/analytics/events').set(bearer(token)).send({ event: 'product_view', props: { product_id: 'p' } }).expect(202)).body.accepted);
      expect(answers.filter(Boolean)).toHaveLength(30);
      expect(await prisma.analytics_events.count({ where: { user_id: user.id, event: 'product_view' } })).toBe(30);
    });

    it('order created, "Я оплатил(а)" and payment confirmed are recorded by the server; the dashboard shows the funnel', async () => {
      const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
      const token = await loginCustomer(app, 980_000_002);
      for (const event of ['app_open', 'product_view', 'add_to_cart', 'checkout_start']) {
        await http().post('/api/analytics/events').set(bearer(token)).send({ event }).expect(202);
      }
      const order = (
        await http()
          .post('/api/orders')
          .set(bearer(token))
          .set('Idempotency-Key', randomUUID())
          .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 1 }, recipient_name: 'Т', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: 'card_transfer' })
          .expect(201)
      ).body;
      await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200);
      await http().post(`/api/orders/${order.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200); // twice: one event
      await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(admin)).send({}).expect(200);
      await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(admin)).send({}).expect(200); // again: no new event

      const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: 980_000_002n } });
      const events = await prisma.analytics_events.findMany({ where: { user_id: user.id }, orderBy: { created_at: 'asc' } });
      expect(events.map((e) => e.event)).toEqual(['app_open', 'product_view', 'add_to_cart', 'checkout_start', 'order_created', 'payment_marked', 'payment_confirmed']);

      const funnel = (await http().get('/api/staff/dashboard/funnel?period=today').set(bearer(admin)).expect(200)).body;
      const step = (e: string) => funnel.steps.find((s: { event: string }) => s.event === e);
      expect(funnel.steps.map((s: { event: string }) => s.event)).toEqual(['app_open', 'product_view', 'add_to_cart', 'checkout_start', 'order_created', 'payment_marked', 'payment_confirmed']);
      expect(step('product_view').users).toBeGreaterThanOrEqual(2); // two customers in this file
      // other test files also create and pay orders today, so only the shape and bounds are exact here
      expect(step('payment_confirmed').users).toBeGreaterThanOrEqual(1);
      expect(step('app_open').conversion_pct).toBeNull();
      expect(step('payment_confirmed').conversion_pct).toBeGreaterThan(0);
      await http().get('/api/staff/dashboard/funnel?period=year').set(bearer(admin)).expect(400);
    });
  });

  // ------------------------------------------------------------------ B1 home, B4 bonus teaser
  describe('B1/B4: home page and bonus card from the settings', () => {
    it('defaults reach the shop; the admin edits them (validated)', async () => {
      const shop = (await http().get('/api/catalog/texts').expect(200)).body;
      expect(shop.home_content.trust.map((t: { key: string }) => t.key)).toEqual(['original', 'delivery', 'documents', 'payments']);
      expect(shop.home_content.trust[1].text.ru).toBe('{delivery}');
      expect(shop.bonus_teaser).toMatchObject({ enabled: true });
      expect(JSON.stringify(shop.bonus_teaser)).not.toMatch(/\d/); // no balance, no numbers

      const asAdmin = (method: 'get' | 'put', path: string, body?: object) => http()[method](`/api${path}`).set(bearer(admin)).send(body);
      const home = (await asAdmin('get', '/staff/settings/home').expect(200)).body;
      await asAdmin('put', '/staff/settings/home', { ...home, trust: home.trust.slice(0, 3) }).expect(400);
      await asAdmin('put', '/staff/settings/home', { ...home, banner: { ...home.banner, title: { ru: '', uz: 'x' } } }).expect(400);
      try {
        const next = { ...home, banner: { ...home.banner, enabled: false }, trust: home.trust.map((t: object, i: number) => (i === 3 ? { ...t, enabled: false } : t)) };
        await asAdmin('put', '/staff/settings/home', next).expect(200);
        const saved = (await http().get('/api/catalog/texts').expect(200)).body.home_content;
        expect(saved.banner.enabled).toBe(false);
        expect(saved.trust[3].enabled).toBe(false);
      } finally {
        await asAdmin('put', '/staff/settings/home', home).expect(200);
      }

      const bonus = (await asAdmin('get', '/staff/settings/bonus-teaser').expect(200)).body;
      try {
        await asAdmin('put', '/staff/settings/bonus-teaser', { enabled: false, text: bonus.text }).expect(200);
        expect((await http().get('/api/catalog/texts').expect(200)).body.bonus_teaser.enabled).toBe(false);
        const bot = await http().get('/api/internal/bot/info').set('x-bot-secret', TEST_ENV.BOT_API_SECRET).expect(200);
        expect(bot.body.bonus_teaser).toBe(false);
      } finally {
        await asAdmin('put', '/staff/settings/bonus-teaser', bonus).expect(200);
      }
      const manager = await loginStaff(app, DEV_MANAGER_TG);
      await http().get('/api/staff/settings/home').set(bearer(manager)).expect(403);
    });
  });

  // ------------------------------------------------------------------ B2 phone from Telegram
  describe('B2: phone shared through the bot', () => {
    it('saves only the sender’s own number, normalised; the shop profile has it', async () => {
      const token = await loginCustomer(app, 980_000_003);
      const asBot = (body: object) => http().post('/api/internal/bot/users/980000003/contact').set('x-bot-secret', TEST_ENV.BOT_API_SECRET).send(body);
      await http().post('/api/internal/bot/users/980000003/contact').send({ phone: '998901234567', contact_user_id: 980_000_003 }).expect(401);
      await asBot({ phone: '998907777777', contact_user_id: 1 }).expect(400);
      await asBot({ phone: '12', contact_user_id: 980_000_003 }).expect(400);
      expect((await asBot({ phone: '998 90 123-45-67', contact_user_id: 980_000_003 }).expect(200)).body).toEqual({ saved: true, phone: '+998901234567' });
      expect((await http().get('/api/auth/me').set(bearer(token)).expect(200)).body.phone).toBe('+998901234567');
    });
  });
});
