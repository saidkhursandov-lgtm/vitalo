import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, loginCustomer, makeInitData } from './helpers';
import { TEST_ENV } from './test-env';

describe('Internal API for the bot, start_param, CORS (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const asBot = (path: string) => http().get(`/api/internal/bot${path}`).set('x-bot-secret', TEST_ENV.BOT_API_SECRET);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('/internal/bot is only for the bot', () => {
    it('no secret or a wrong secret -> 401', async () => {
      await http().get('/api/internal/bot/info').expect(401);
      await http().get('/api/internal/bot/info').set('x-bot-secret', 'wrong').expect(401);
      await http().get('/api/internal/bot/users/1').set('x-bot-secret', `${TEST_ENV.BOT_API_SECRET}x`).expect(401);
    });

    it('a customer token is not accepted either', async () => {
      const token = await loginCustomer(app, 960_000_001);
      await http().get('/api/internal/bot/users/960000001').set('Authorization', `Bearer ${token}`).expect(401);
    });
  });

  it('user summary: language, counts and last orders; unknown users are not registered', async () => {
    await http().post('/api/auth/telegram').send({ initData: makeInitData({ id: 960_000_002, first_name: 'Botir', language_code: 'uz' }) }).expect(200);
    const { body } = await asBot('/users/960000002').expect(200);
    expect(body).toMatchObject({ registered: true, first_name: 'Botir', language: 'uz', orders_total: 0, orders: [], bonus_balance_uzs: 0 });

    expect((await asBot('/users/123').expect(200)).body).toEqual({ registered: false, blocked: false });
    await asBot('/users/abc').expect(400);
  });

  it('blocked customers are reported as not registered', async () => {
    await loginCustomer(app, 960_000_003);
    await prisma.users.update({ where: { telegram_user_id: 960_000_003n }, data: { status: 'blocked' } });
    expect((await asBot('/users/960000003').expect(200)).body).toEqual({ registered: false, blocked: true });
  });

  it('staff check for /admin: only active employees', async () => {
    expect((await asBot('/staff/222222221').expect(200)).body).toEqual({ is_staff: true, role: 'admin', name: 'Админ (тест)' });
    expect((await asBot('/staff/960000002').expect(200)).body).toEqual({ is_staff: false });
    await prisma.staff_users.create({ data: { telegram_user_id: 960_000_009n, name: 'Ушёл', role: 'manager', status: 'blocked' } });
    expect((await asBot('/staff/960000009').expect(200)).body).toEqual({ is_staff: false });
  });

  it('«Новые адреса» recipients: only active admins and managers, never customers or other roles', async () => {
    await http().get('/api/internal/bot/staff-notify').expect(401);
    await prisma.staff_users.upsert({
      where: { telegram_user_id: 960_000_010n },
      create: { telegram_user_id: 960_000_010n, name: 'Ушедший админ', role: 'admin', status: 'blocked' },
      update: { status: 'blocked' },
    });
    const { recipients } = (await asBot('/staff-notify').expect(200)).body as { recipients: { telegram_id: string; role: string }[] };
    const ids = recipients.map((r) => r.telegram_id);
    expect(ids).toEqual(expect.arrayContaining(['222222221', '222222222'])); // seeded admin and manager
    expect(ids).not.toContain('222222223'); // warehouse
    expect(ids).not.toContain('222222224'); // marketer
    expect(ids).not.toContain('960000010'); // blocked admin
    expect(ids).not.toContain('960000002'); // a customer
    expect(new Set(recipients.map((r) => r.role))).toEqual(new Set(['admin', 'manager']));
    const customers = await prisma.users.findMany({ select: { telegram_user_id: true } });
    const staffIds = new Set((await prisma.staff_users.findMany({ select: { telegram_user_id: true } })).map((s) => s.telegram_user_id.toString()));
    for (const c of customers) if (!staffIds.has(c.telegram_user_id.toString())) expect(ids).not.toContain(c.telegram_user_id.toString());
  });

  it('info: defaults, overridable through settings', async () => {
    const before = (await asBot('/info').expect(200)).body;
    expect(before).toMatchObject({ support_contact: '@VITALO_support', support_url: 'https://t.me/VITALO_support' });
    expect(before.about_ru).toContain('VITALO');
    const saved = await prisma.settings.findUnique({ where: { key: 'support_contact' } });
    await prisma.settings.upsert({ where: { key: 'support_contact' }, create: { key: 'support_contact', value: '@vitalo_help' }, update: { value: '@vitalo_help' } });
    expect((await asBot('/info').expect(200)).body).toMatchObject({ support_contact: '@vitalo_help', support_url: 'https://t.me/vitalo_help' });
    // Nothing saved -> the default contact, never "скоро появится"
    await prisma.settings.delete({ where: { key: 'support_contact' } });
    expect((await asBot('/info').expect(200)).body.support_contact).toBe('@VITALO_support');
    if (saved) await prisma.settings.create({ data: { key: saved.key, value: saved.value as string } });
  });

  describe('referral code (start_param) at login', () => {
    it('the code passed by the Mini App is returned', async () => {
      const res = await http().post('/api/auth/telegram').send({ initData: makeInitData({ id: 960_000_010, first_name: 'Ref' }), start_param: 'FRIEND_42' }).expect(200);
      expect(res.body.start_param).toBe('FRIEND_42');
    });

    it('a code signed inside initData wins over the passed one', async () => {
      const { signInitData } = await import('../src/auth/sign-init-data');
      const initData = signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 960_000_011, first_name: 'Ref' }), start_param: 'SIGNED' },
        TEST_ENV.TELEGRAM_BOT_TOKEN,
      );
      const res = await http().post('/api/auth/telegram').send({ initData, start_param: 'OTHER' }).expect(200);
      expect(res.body.start_param).toBe('SIGNED');
    });

    it('invalid codes are rejected', async () => {
      await http().post('/api/auth/telegram').send({ initData: makeInitData({ id: 960_000_012, first_name: 'X' }), start_param: 'bad code!' }).expect(400);
    });
  });

  describe('CORS uses the configured list', () => {
    it('allowed origin gets the CORS header', async () => {
      const res = await http().get('/api/catalog/brands').set('Origin', 'https://shop.example.com').expect(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    });

    it('any other origin does not', async () => {
      const res = await http().get('/api/catalog/brands').set('Origin', 'https://evil.example.com').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const pre = await http().options('/api/auth/me').set('Origin', 'https://evil.example.com').set('Access-Control-Request-Method', 'GET');
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
