import { INestApplication } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import request from 'supertest';
import { TELEGRAM_SENDER, type SendOptions, type TelegramSender } from '../src/notifications/telegram-sender';
import { PrismaService } from '../src/prisma/prisma.service';
import { checkWidgetAuth, deviceName, normalizeCode } from '../src/staff/staff-web-auth';
import { bearer, createTestApp, loginStaff } from './helpers';
import { TEST_ENV } from './test-env';

class FakeSender implements TelegramSender {
  sent: { chatId: bigint; text: string; opts?: SendOptions }[] = [];
  async sendMessage(chatId: bigint, text: string, opts?: SendOptions) {
    this.sent.push({ chatId, text, opts });
  }
}

/** Own staff rows: «Выйти везде» here must not sign out the seeded staff other test files use. */
const OWNER_TG = 976_300_001;
const MANAGER_TG = 976_300_002;
const STRANGER_TG = 976_300_009;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** What the Telegram Login Widget returns, signed like Telegram does (bot token of the test env). */
function widget(id: number, over: { auth_date?: number; token?: string } = {}) {
  const data: Record<string, string | number> = { id, first_name: 'Саид', username: 'said', auth_date: over.auth_date ?? Math.floor(Date.now() / 1000) };
  const check = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');
  const key = createHash('sha256').update(over.token ?? TEST_ENV.TELEGRAM_BOT_TOKEN).digest();
  return { ...data, hash: createHmac('sha256', key).update(check).digest('hex') };
}

const cookiesOf = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((c) => c.split(';')[0]);
const cookieValue = (res: request.Response, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

describe('Генплан, этап 3: admin panel in a browser — Telegram Login Widget, bot confirmation, backup codes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeSender();
  const http = () => request(app.getHttpServer());
  const H = { 'x-vitalo-admin': '1', 'user-agent': UA };
  let deviceCookie: string;
  let sessionCookie: string;

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(TELEGRAM_SENDER).useValue(fake));
    prisma = app.get(PrismaService);
    for (const [tg, role, name] of [
      [OWNER_TG, 'admin', 'E2E Владелец'],
      [MANAGER_TG, 'manager', 'E2E Менеджер'],
    ] as const) {
      await prisma.staff_users.upsert({ where: { telegram_user_id: BigInt(tg) }, update: { role, status: 'active', name }, create: { telegram_user_id: BigInt(tg), role, name, status: 'active' } });
    }
  });
  afterAll(async () => {
    await prisma.staff_users.updateMany({ where: { telegram_user_id: { in: [BigInt(OWNER_TG), BigInt(MANAGER_TG)] } }, data: { status: 'blocked' } });
    await app.close();
  });

  it('checks the widget signature and its age', () => {
    expect(checkWidgetAuth(widget(5), TEST_ENV.TELEGRAM_BOT_TOKEN)).toEqual({ id: 5n });
    expect(checkWidgetAuth(widget(5, { token: '1:OTHER' }), TEST_ENV.TELEGRAM_BOT_TOKEN)).toBeNull();
    expect(checkWidgetAuth({ ...widget(5), id: 6 }, TEST_ENV.TELEGRAM_BOT_TOKEN)).toBeNull();
    expect(checkWidgetAuth(widget(5, { auth_date: Math.floor(Date.now() / 1000) - 3600 }), TEST_ENV.TELEGRAM_BOT_TOKEN)).toBeNull();
    expect(deviceName(UA)).toBe('Chrome, Windows');
    expect(normalizeCode('abcd-efgh jk')).toBe('ABCDEFGHJK');
  });

  it('config tells the login page the bot of the widget', async () => {
    const { body } = await http().get('/api/staff/auth/web/config').expect(200);
    expect(body.session_days).toBe(30);
    expect(body).toHaveProperty('bot_username');
  });

  it('refuses without the admin header, with a bad signature and for a non-employee', async () => {
    await http().post('/api/staff/auth/web/login').set('user-agent', UA).send(widget(OWNER_TG)).expect(403);
    await http().post('/api/staff/auth/web/login').set(H).send(widget(OWNER_TG, { token: '1:OTHER' })).expect(401);
    const res = await http().post('/api/staff/auth/web/login').set(H).send(widget(STRANGER_TG)).expect(403);
    expect(res.body.code).toBe('NOT_STAFF');
  });

  it('new browser: the bot asks «Подтвердить / Это не я»; the page waits, then gets the session cookie once', async () => {
    fake.sent = [];
    const { body: pending } = await http().post('/api/staff/auth/web/login').set(H).send(widget(OWNER_TG)).expect(200);
    expect(pending).toMatchObject({ status: 'pending', request_id: expect.any(String), poll_token: expect.any(String) });
    const msg = fake.sent.find((m) => m.chatId === BigInt(OWNER_TG))!;
    expect(msg.text).toMatch(/Chrome, Windows/);
    expect(msg.opts?.buttons?.[0].map((b) => b.data)).toEqual([`sl:ok:${pending.request_id}`, `sl:no:${pending.request_id}`]);

    const poll = () => http().post('/api/staff/auth/web/poll').set(H).send({ request_id: pending.request_id, poll_token: pending.poll_token });
    expect((await poll().expect(200)).body).toEqual({ status: 'pending' });
    await http().post('/api/staff/auth/web/poll').set(H).send({ request_id: pending.request_id, poll_token: 'x'.repeat(43) }).expect(404);

    // another Telegram account cannot answer someone else's login
    const bot = (body: object) => http().post(`/api/internal/bot/staff-login/${pending.request_id}/decision`).set('x-bot-secret', TEST_ENV.BOT_API_SECRET).send(body);
    await bot({ telegram_id: String(MANAGER_TG), approve: true }).expect(404);
    expect((await bot({ telegram_id: String(OWNER_TG), approve: true }).expect(200)).body).toEqual({ result: 'approved' });
    expect((await bot({ telegram_id: String(OWNER_TG), approve: false }).expect(200)).body).toEqual({ result: 'approved' });

    const ok = await poll().expect(200);
    expect(ok.body).toMatchObject({ status: 'approved', staff: { role: 'admin' }, permissions: expect.arrayContaining(['staff.manage']) });
    expect(ok.body).not.toHaveProperty('token');
    const raw = (ok.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(raw).toMatch(/vitalo_staff=[^;]+; Max-Age=2592000; Path=\/api\/staff; Expires=[^;]+; HttpOnly; Secure; SameSite=Strict/);
    expect(raw).toMatch(/vitalo_staff_device=[^;]+;.*Path=\/api\/staff\/auth;.*HttpOnly; Secure; SameSite=Strict/);
    sessionCookie = cookieValue(ok, 'vitalo_staff')!;
    deviceCookie = cookieValue(ok, 'vitalo_staff_device')!;
    await poll().expect(410); // only once

    const me = await http().get('/api/staff/auth/me').set('Cookie', `vitalo_staff=${sessionCookie}`).expect(200);
    expect(me.body.staff.role).toBe('admin');
  });

  it('cookie session: reading works; a change without the admin header is refused (CSRF)', async () => {
    const c = { Cookie: `vitalo_staff=${sessionCookie}` };
    await http().get('/api/staff/auth/sessions').set(c).expect(200);
    const res = await http().post('/api/staff/auth/backup-codes').set(c).expect(403);
    expect(res.body.code).toBe('CSRF');
  });

  it('the confirmed browser logs in again without the bot', async () => {
    fake.sent = [];
    const res = await http().post('/api/staff/auth/web/login').set(H).set('Cookie', `vitalo_staff_device=${deviceCookie}`).send(widget(OWNER_TG)).expect(200);
    expect(res.body.status).toBe('approved');
    expect(cookieValue(res, 'vitalo_staff')).toBeTruthy();
    expect(fake.sent.filter((m) => m.chatId === BigInt(OWNER_TG))).toHaveLength(0);
    // the device cookie of one employee does not let another in
    const other = await http().post('/api/staff/auth/web/login').set(H).set('Cookie', `vitalo_staff_device=${deviceCookie}`).send(widget(MANAGER_TG)).expect(200);
    expect(other.body.status).toBe('pending');
  });

  it('«Это не я»: no session, admins are warned; an expired request is refused', async () => {
    fake.sent = [];
    const { body: p } = await http().post('/api/staff/auth/web/login').set(H).send(widget(MANAGER_TG)).expect(200);
    const bot = (id: string, approve: boolean) => http().post(`/api/internal/bot/staff-login/${id}/decision`).set('x-bot-secret', TEST_ENV.BOT_API_SECRET).send({ telegram_id: String(MANAGER_TG), approve });
    expect((await bot(p.request_id, false).expect(200)).body).toEqual({ result: 'denied' });
    expect((await http().post('/api/staff/auth/web/poll').set(H).send({ request_id: p.request_id, poll_token: p.poll_token }).expect(200)).body).toEqual({ status: 'denied' });
    expect(fake.sent.some((m) => m.chatId === BigInt(OWNER_TG) && /Это не я/.test(m.text))).toBe(true);
    expect(await prisma.audit_logs.count({ where: { action: 'staff.login_denied', entity_id: (await prisma.staff_users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(MANAGER_TG) } })).id } })).toBeGreaterThan(0);

    const { body: late } = await http().post('/api/staff/auth/web/login').set(H).send(widget(MANAGER_TG)).expect(200);
    await prisma.staff_login_requests.update({ where: { id: late.request_id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect((await bot(late.request_id, true).expect(200)).body).toEqual({ result: 'expired' });
    expect((await http().post('/api/staff/auth/web/poll').set(H).send({ request_id: late.request_id, poll_token: late.poll_token }).expect(200)).body).toEqual({ status: 'expired' });
  });

  it('backup codes: only the admin creates them; a code works once; every use is told to admins', async () => {
    const manager = await loginStaff(app, MANAGER_TG);
    await http().post('/api/staff/auth/backup-codes').set(bearer(manager)).expect(403);
    const owner = await loginStaff(app, OWNER_TG);
    const { body } = await http().post('/api/staff/auth/backup-codes').set(bearer(owner)).expect(200);
    expect(body.codes).toHaveLength(10);
    expect(body.codes[0]).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect((await http().get('/api/staff/auth/backup-codes').set(bearer(owner)).expect(200)).body).toMatchObject({ total: 10, left: 10 });
    expect(await prisma.staff_backup_codes.count({ where: { code_hash: { in: body.codes } } })).toBe(0); // only hashes are stored

    fake.sent = [];
    await http().post('/api/staff/auth/web/backup-code').set(H).send({ code: body.codes[0] }).expect(200);
    const again = await http().post('/api/staff/auth/web/backup-code').set(H).send({ code: body.codes[0].toLowerCase() }).expect(401);
    expect(again.body.code).toBe('BAD_CODE');
    expect(fake.sent.some((m) => m.chatId === BigInt(OWNER_TG) && /резервному коду.*Осталось кодов: 9/.test(m.text))).toBe(true);

    // new codes replace the old unused ones
    const { body: fresh } = await http().post('/api/staff/auth/backup-codes').set(bearer(owner)).expect(200);
    await http().post('/api/staff/auth/web/backup-code').set(H).send({ code: body.codes[1] }).expect(401);
    const ok = await http().post('/api/staff/auth/web/backup-code').set(H).send({ code: fresh.codes[0] }).expect(200);
    expect(cookieValue(ok, 'vitalo_staff')).toBeTruthy();
  });

  it('«Мои устройства»: the list marks this session; «Выйти» on a line and «Выйти везде» end sessions and confirmed browsers', async () => {
    const owner = await loginStaff(app, OWNER_TG);
    const { body: list } = await http().get('/api/staff/auth/sessions').set(bearer(owner)).expect(200);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const web = list.find((s: { kind: string; device_name: string }) => s.kind === 'web' && s.device_name === 'Chrome, Windows');
    expect(web).toBeTruthy();

    await http().delete(`/api/staff/auth/sessions/${web.id}`).set(bearer(owner)).expect(204);
    const row = await prisma.staff_sessions.findUniqueOrThrow({ where: { id: web.id } });
    expect(row.revoked_at).not.toBeNull();
    expect((await prisma.staff_devices.findUniqueOrThrow({ where: { id: row.device_id! } })).revoked_at).not.toBeNull();
    // that browser now has to be confirmed in the bot again
    const res = await http().post('/api/staff/auth/web/login').set(H).set('Cookie', `vitalo_staff_device=${deviceCookie}`).send(widget(OWNER_TG)).expect(200);
    expect(res.body.status).toBe('pending');

    const out = await http().post('/api/staff/auth/logout-everywhere').set(bearer(owner)).expect(200);
    expect(out.body.sessions).toBeGreaterThan(1);
    await http().get('/api/staff/auth/me').set(bearer(owner)).expect(401);
    await http().get('/api/staff/auth/me').set('Cookie', `vitalo_staff=${sessionCookie}`).expect(401);
  });
});
