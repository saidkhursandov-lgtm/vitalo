import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TELEGRAM_SENDER } from '../src/notifications/telegram-sender';
import { PrismaService } from '../src/prisma/prisma.service';
import { normalizeLoginPhone } from '../src/auth/web-login';
import { bearer, createTestApp, TEST_BRAND } from './helpers';
import { TEST_ENV } from './test-env';

/** Release 6 «Сайт»: product and brand slugs, sitemap, and the customer login outside Telegram. */
describe('Site: slugs and web login (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sent: { chatId: bigint; text: string }[] = [];
  const http = () => request(app.getHttpServer());
  const bot = { 'x-bot-secret': TEST_ENV.BOT_API_SECRET };

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(TELEGRAM_SENDER).useValue({ sendMessage: async (chatId: bigint, text: string) => void sent.push({ chatId, text }) }),
    );
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('slugs', () => {
    it('the database gives every product a slug from its Russian name, unique, and keeps it on rename', async () => {
      const base = { brand: TEST_BRAND, manufacturer: TEST_BRAND, price_uzs: 10_000n };
      const a = await prisma.products.create({ data: { ...base, sku: 'E2E-SLUG-1', name_ru: 'Магний B6 Щит, 60 таблеток' } });
      const b = await prisma.products.create({ data: { ...base, sku: 'E2E-SLUG-2', name_ru: 'Магний B6 Щит, 60 таблеток' } });
      expect(a.slug).toBe('magniy-b6-shchit-60-tabletok');
      expect(b.slug).toBe('magniy-b6-shchit-60-tabletok-2');
      const renamed = await prisma.products.update({ where: { id: a.id }, data: { name_ru: 'Другое имя' } });
      expect(renamed.slug).toBe(a.slug);
    });

    it('every seeded product and brand has a slug', async () => {
      expect(await prisma.products.count({ where: { slug: null } })).toBe(0);
      expect(await prisma.brands.count({ where: { slug: null } })).toBe(0);
    });

    it('the card opens by slug and by id; a bad value is refused', async () => {
      const p = await prisma.products.findFirstOrThrow({ where: { status: 'active', is_test: false } });
      const bySlug = await http().get(`/api/catalog/products/${p.slug}`).expect(200);
      expect(bySlug.body).toMatchObject({ id: p.id, slug: p.slug });
      await http().get(`/api/catalog/products/${p.id}`).expect(200);
      await http().get('/api/catalog/products/Bad%20Slug!').expect(400);
      await http().get('/api/catalog/products/no-such-product-slug').expect(404);
    });

    it('sitemap.xml lists products by slug', async () => {
      const p = await prisma.products.findFirstOrThrow({ where: { status: 'active', is_test: false } });
      const res = await http().get('/api/sitemap.xml').expect(200);
      expect(res.headers['content-type']).toContain('application/xml');
      expect(res.text).toContain(`/product/${p.slug}</loc>`);
    });
  });

  describe('«Войти через Telegram»: confirmed in the bot', () => {
    it('start → bot confirms → poll gives a session once', async () => {
      const start = await http().post('/api/auth/web/telegram/start').expect(200);
      expect(start.body.bot_url).toMatch(/^https:\/\/t\.me\/vitalo_e2e_bot\?start=login_[0-9a-f]{32}$/);
      const { request_id, poll_token } = start.body;
      expect((await http().post('/api/auth/web/poll').send({ request_id, poll_token }).expect(200)).body.status).toBe('pending');

      const hex = start.body.bot_url.split('login_')[1];
      await http().post(`/api/internal/bot/customer-login/${hex}`).send({ from: { id: 900_100_001 } }).expect(401);
      const confirm = await http()
        .post(`/api/internal/bot/customer-login/${hex}`)
        .set(bot)
        .send({ from: { id: 900_100_001, first_name: 'Site', language_code: 'uz' } })
        .expect(200);
      expect(confirm.body).toEqual({ result: 'approved', lang: 'uz' });

      // another browser that only knows the request id gets nothing
      expect((await http().post('/api/auth/web/poll').send({ request_id, poll_token: 'wrong' }).expect(200)).body.status).toBe('expired');

      const ok = await http().post('/api/auth/web/poll').send({ request_id, poll_token }).expect(200);
      expect(ok.body.status).toBe('approved');
      expect(ok.body.user).toMatchObject({ telegram_user_id: 900_100_001, first_name: 'Site' });
      await http().get('/api/auth/me').set(bearer(ok.body.token)).expect(200);
      expect((await http().post('/api/auth/web/poll').send({ request_id, poll_token }).expect(200)).body.status).toBe('expired');

      const again = await http().post(`/api/internal/bot/customer-login/${hex}`).set(bot).send({ from: { id: 900_100_001, first_name: 'Site' } }).expect(200);
      expect(again.body.result).toBe('already');
    });

    it('an expired request is not confirmed', async () => {
      const start = await http().post('/api/auth/web/telegram/start').expect(200);
      await prisma.customer_login_requests.update({ where: { id: start.body.request_id }, data: { expires_at: new Date(Date.now() - 1000) } });
      const hex = start.body.bot_url.split('login_')[1];
      const res = await http().post(`/api/internal/bot/customer-login/${hex}`).set(bot).send({ from: { id: 900_100_002, first_name: 'Late' } }).expect(200);
      expect(res.body.result).toBe('expired');
    });
  });

  describe('«По номеру телефона»: a code from the bot', () => {
    const phone = '+998901112233';
    beforeAll(async () => {
      await prisma.users.create({ data: { telegram_user_id: 900_100_010n, first_name: 'Phone', phone, language: 'ru', bonus_account: { create: {} } } });
    });

    it('normalizes what people type', () => {
      expect(normalizeLoginPhone('90 111 22 33')).toBe(phone);
      expect(normalizeLoginPhone('+998 (90) 111-22-33')).toBe(phone);
      expect(normalizeLoginPhone('12345')).toBeNull();
    });

    it('sends the code to the customer with this phone and signs in with it', async () => {
      sent.length = 0;
      const start = await http().post('/api/auth/web/phone/start').send({ phone: '90 111 22 33' }).expect(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe(900_100_010n);
      const code = /(\d{6})/.exec(sent[0].text)![1];
      const { request_id, poll_token } = start.body;

      const wrong = code === '000000' ? '111111' : '000000';
      const bad = await http().post('/api/auth/web/phone/verify').send({ request_id, poll_token, code: wrong }).expect(400);
      expect(bad.body).toMatchObject({ code: 'BAD_CODE', attempts_left: 4 });

      const ok = await http().post('/api/auth/web/phone/verify').send({ request_id, poll_token, code }).expect(200);
      expect(ok.body.user).toMatchObject({ first_name: 'Phone', phone });
      await http().post('/api/auth/web/phone/verify').send({ request_id, poll_token, code }).expect(400); // used once
    });

    it('an unknown number gets the same answer but no message, and no code works', async () => {
      sent.length = 0;
      const start = await http().post('/api/auth/web/phone/start').send({ phone: '+998 93 000 00 00' }).expect(200);
      expect(start.body).toHaveProperty('request_id');
      expect(sent).toHaveLength(0);
      await http().post('/api/auth/web/phone/verify').send({ ...start.body, code: '123456' }).expect(400);
    });

    it('five wrong codes end the request; a fourth request in 10 minutes is refused', async () => {
      const start = await http().post('/api/auth/web/phone/start').send({ phone }).expect(200);
      const body = { request_id: start.body.request_id, poll_token: start.body.poll_token };
      for (let i = 0; i < 5; i++) await http().post('/api/auth/web/phone/verify').send({ ...body, code: '999999' }).expect(400);
      const code = /(\d{6})/.exec(sent[sent.length - 1].text)![1];
      const res = await http().post('/api/auth/web/phone/verify').send({ ...body, code }).expect(400);
      expect(res.body.code).toBe('CODE_EXPIRED');
      await http().post('/api/auth/web/phone/start').send({ phone }).expect(200);
      await http().post('/api/auth/web/phone/start').send({ phone }).expect(429);
    });
  });
});
