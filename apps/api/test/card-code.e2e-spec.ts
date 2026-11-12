import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TELEGRAM_SENDER, type TelegramSender } from '../src/notifications/telegram-sender';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createTestApp, loginStaff } from './helpers';

class FakeSender implements TelegramSender {
  sent: { chatId: bigint; text: string }[] = [];
  async sendMessage(chatId: bigint, text: string) {
    this.sent.push({ chatId, text });
  }
}

const ADMIN_TG = 222_222_221;

/** D-65 / аудит админки 4.8: a new card number only with the code from the bot; all admins told; idle sessions end. */
describe('Card number code and idle sign-out (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const fake = new FakeSender();
  const http = () => request(app.getHttpServer());
  const codeFromBot = () => fake.sent.filter((m) => m.text.includes('Код для смены номера карты')).at(-1)!.text.match(/(\d{6})/)![1];

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(TELEGRAM_SENDER).useValue(fake));
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
  });
  afterAll(async () => {
    await app.close();
  });

  it('a new number: refused without a code and with a wrong one; saved with the right one; admins get a masked notice', async () => {
    const before = (await http().get('/api/staff/settings/card-transfer').set(bearer(admin)).expect(200)).body;
    const next = before.card_number === '8600111122223333' ? '8600444455556666' : '8600111122223333';
    const put = (body: object) => http().put('/api/staff/settings/card-transfer').set(bearer(admin)).send({ card_number: next, ...body });

    expect((await put({}).expect(403)).body.code).toBe('CARD_CODE_REQUIRED');
    await http().post('/api/staff/settings/card-transfer/code').set(bearer(admin)).expect(200);
    const code = codeFromBot();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await put({ code: wrong }).expect(403)).body.code).toBe('CARD_CODE_WRONG');

    const sentBefore = fake.sent.length;
    expect((await put({ code }).expect(200)).body.card_number).toBe(next);
    const notices = fake.sent.slice(sentBefore).filter((m) => m.text.includes('Номер карты для переводов'));
    const admins = await prisma.staff_users.count({ where: { role: 'admin', status: 'active' } });
    expect(notices).toHaveLength(admins);
    expect(notices[0].text).toContain(`**** ${next.slice(-4)}`);
    expect(notices[0].text).not.toContain(next); // never the full number
    await put({ code }).expect(200); // the same number again: no code needed (it is not a change)

    // the code works once
    await http().put('/api/staff/settings/card-transfer').set(bearer(admin)).send({ card_number: before.card_number, code }).expect(403);
    await http().post('/api/staff/settings/card-transfer/code').set(bearer(admin)).expect(200);
    await http().put('/api/staff/settings/card-transfer').set(bearer(admin)).send({ card_number: before.card_number, recipient: before.recipient, code: codeFromBot() }).expect(200);
  });

  it('a session not used for 30 days signs out by itself', async () => {
    const token = await loginStaff(app, ADMIN_TG);
    await http().get('/api/staff/auth/me').set(bearer(token)).expect(200);
    const s = await prisma.staff_sessions.findFirstOrThrow({ where: { staff_user: { telegram_user_id: BigInt(ADMIN_TG) }, revoked_at: null }, orderBy: { created_at: 'desc' } });
    await prisma.staff_sessions.update({ where: { id: s.id }, data: { last_seen_at: new Date(Date.now() - 31 * 86_400_000), expires_at: new Date(Date.now() + 86_400_000) } });
    await http().get('/api/staff/auth/me').set(bearer(token)).expect(401);
    expect((await prisma.staff_sessions.findUniqueOrThrow({ where: { id: s.id } })).revoked_at).not.toBeNull();
  });
});
