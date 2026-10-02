import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hashSessionToken } from '../src/auth/session-token';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, makeInitData } from './helpers';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const login = (initData: string) => http().post('/api/auth/telegram').send({ initData });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('first and repeated login', () => {
    const tgId = 900_000_001;
    let firstToken: string;

    it('creates the user with a bonus account and returns a session token', async () => {
      const res = await login(makeInitData({ id: tgId, first_name: 'Ali', username: 'ali', language_code: 'uz' })).expect(200);

      expect(res.body.is_new_user).toBe(true);
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(res.body.user).toMatchObject({ telegram_user_id: tgId, first_name: 'Ali', username: 'ali', language: 'uz' });

      const user = await prisma.users.findUniqueOrThrow({
        where: { telegram_user_id: BigInt(tgId) },
        include: { bonus_account: true, sessions: true },
      });
      expect(user.bonus_account?.balance_uzs).toBe(0n);
      firstToken = res.body.token;
    });

    it('stores only the token hash, never the token itself', async () => {
      const sessions = await prisma.user_sessions.findMany({ where: { user: { telegram_user_id: BigInt(tgId) } } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].token_hash).toBe(hashSessionToken(firstToken));
      expect(JSON.stringify(sessions)).not.toContain(firstToken);
    });

    it('second login reuses the user, refreshes the profile, issues a new session', async () => {
      const res = await login(makeInitData({ id: tgId, first_name: 'Alisher', language_code: 'ru' })).expect(200);

      expect(res.body.is_new_user).toBe(false);
      expect(res.body.token).not.toBe(firstToken);
      expect(res.body.user).toMatchObject({ first_name: 'Alisher', username: null, language: 'uz' }); // language kept
      expect(await prisma.users.count({ where: { telegram_user_id: BigInt(tgId) } })).toBe(1);
      expect(await prisma.user_sessions.count({ where: { user: { telegram_user_id: BigInt(tgId) } } })).toBe(2);
    });

    it('defaults language to ru for non-uz Telegram clients', async () => {
      const res = await login(makeInitData({ id: 900_000_002, first_name: 'Olga', language_code: 'en' })).expect(200);
      expect(res.body.user.language).toBe('ru');
    });
  });

  describe('rejects bad initData', () => {
    it('signed with another bot token -> 401', async () => {
      await login(makeInitData({ id: 1, first_name: 'Eve' }, { botToken: '999:OTHER' })).expect(401);
    });

    it('tampered after signing -> 401', async () => {
      const forged = makeInitData({ id: 2, first_name: 'Eve' }).replace('Eve', 'Bob');
      await login(forged).expect(401);
    });

    it('older than INIT_DATA_MAX_AGE_SECONDS -> 401', async () => {
      const old = Math.floor(Date.now() / 1000) - 7200;
      await login(makeInitData({ id: 3, first_name: 'Old' }, { authDate: old })).expect(401);
    });

    it('missing initData -> 400', async () => {
      await http().post('/api/auth/telegram').send({}).expect(400);
    });

    it('no user is created for rejected requests', async () => {
      expect(await prisma.users.count({ where: { telegram_user_id: { in: [1n, 2n, 3n] } } })).toBe(0);
    });
  });

  it('blocked user cannot log in -> 403', async () => {
    await prisma.users.create({ data: { telegram_user_id: 900_000_099n, first_name: 'Blocked', status: 'blocked' } });
    await login(makeInitData({ id: 900_000_099, first_name: 'Blocked' })).expect(403);
  });

  describe('session usage', () => {
    let token: string;
    beforeAll(async () => {
      token = (await login(makeInitData({ id: 900_000_010, first_name: 'Sess' })).expect(200)).body.token;
    });
    const me = (t?: string) => {
      const req = http().get('/api/auth/me');
      return t ? req.set('Authorization', `Bearer ${t}`) : req;
    };

    it('GET /auth/me works with the token', async () => {
      const res = await me(token).expect(200);
      expect(res.body).toMatchObject({ telegram_user_id: 900_000_010, first_name: 'Sess' });
    });

    it('401 without token or with a wrong token', async () => {
      await me().expect(401);
      await me('not-a-real-token').expect(401);
    });

    it('expired session -> 401', async () => {
      const t = (await login(makeInitData({ id: 900_000_011, first_name: 'Exp' })).expect(200)).body.token;
      await prisma.user_sessions.update({ where: { token_hash: hashSessionToken(t) }, data: { expires_at: new Date(Date.now() - 1000) } });
      await me(t).expect(401);
    });

    it('session of a user blocked later -> 401', async () => {
      const t = (await login(makeInitData({ id: 900_000_012, first_name: 'Later' })).expect(200)).body.token;
      await prisma.users.update({ where: { telegram_user_id: 900_000_012n }, data: { status: 'blocked' } });
      await me(t).expect(401);
    });

    it('logout revokes the session', async () => {
      await http().post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);
      await me(token).expect(401);
    });
  });
});
