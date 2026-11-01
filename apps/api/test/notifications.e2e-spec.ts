import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { NotificationWorker } from '../src/notifications/notification-worker';
import { TELEGRAM_SENDER, TelegramSendError, type TelegramSender } from '../src/notifications/telegram-sender';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  archiveTestProducts,
  bearer,
  createTestApp,
  createTestProduct,
  loginStaff,
  makeInitData,
  seededAddresses,
} from './helpers';

/** Records messages instead of calling Telegram; can be told to fail. */
class FakeSender implements TelegramSender {
  sent: { chatId: bigint; text: string }[] = [];
  failWith: TelegramSendError | null = null;
  async sendMessage(chatId: bigint, text: string) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ chatId, text });
  }
}

const ADMIN_TG = 222_222_221n;
const MANAGER_TG = 222_222_222n;

describe('Telegram notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: NotificationWorker;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const fake = new FakeSender();
  let tg = 970_000_000;
  const http = () => request(app.getHttpServer());

  /** Logs a customer in with the given Telegram language and places a buy-now order. */
  async function order(lang: 'ru' | 'uz' = 'ru', extra: object = {}) {
    const id = ++tg;
    const login = await http().post('/api/auth/telegram').send({ initData: makeInitData({ id, first_name: 'Notify', language_code: lang }) }).expect(200);
    const p = await createTestProduct(prisma, { price: 10_000, stock: 10 });
    const res = await http()
      .post('/api/orders')
      .set(bearer(login.body.token))
      .set('Idempotency-Key', randomUUID())
      .send({
        source: 'buy_now',
        buy_now: { product_id: p.id, qty: 1 },
        recipient_name: 'Получатель Тест',
        recipient_phone: '+998901112233',
        ...addr.tashkent,
        address_text: 'ул. 1',
        payment_method: 'bank_transfer',
        ...extra,
      })
      .expect(201);
    return { order: res.body, token: login.body.token as string, chatId: BigInt(id) };
  }
  const queued = (where: object = {}) => prisma.notifications.findMany({ where, orderBy: { created_at: 'asc' } });
  /** Runs the worker until the queue has nothing due (it handles 20 messages per pass). */
  async function drain(now?: Date) {
    const total = { sent: 0, failed: 0, retried: 0, skipped: 0 };
    for (;;) {
      const r = await worker.processOnce(now);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
      if (r.sent + r.failed + r.retried + r.skipped === 0) return total;
    }
  }
  const resetQueue = () => prisma.notifications.updateMany({ where: { status: { in: ['queued', 'sending'] } }, data: { status: 'skipped' } });

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(TELEGRAM_SENDER).useValue(fake));
    prisma = app.get(PrismaService);
    worker = app.get(NotificationWorker);
    addr = await seededAddresses(prisma);
  });
  beforeEach(async () => {
    await resetQueue();
    fake.sent = [];
    fake.failWith = null;
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('what gets queued', () => {
    it('a new order notifies every active admin and manager (not warehouse/marketer, not blocked)', async () => {
      await prisma.staff_users.create({ data: { telegram_user_id: 970_999_001n, name: 'Блок', role: 'manager', status: 'blocked' } });
      const { order: o } = await order();
      const rows = await queued({ template: 'staff.new_order', payload: { path: ['order_number'], equals: o.order_number } });
      const chats = rows.map((r) => r.chat_id);
      expect(chats).toEqual(expect.arrayContaining([ADMIN_TG, MANAGER_TG]));
      expect(chats).not.toContain(222_222_223n); // warehouse
      expect(chats).not.toContain(222_222_224n); // marketer
      expect(chats).not.toContain(970_999_001n); // blocked
      expect(rows.every((r) => r.kind === 'service' && r.staff_user_id)).toBe(true);
    });

    it('3.5: «Комментарий к заказу» reaches the admin order card and the staff message, line breaks and full length kept', async () => {
      const comment = `Позвоните за час до доставки.
Домофон 25, 3 этаж.
Qo‘ng‘iroq qiling. ${'Длинный текст '.repeat(30)}`.slice(0, 500).trim();
      const { order: o } = await order('uz', { customer_comment: `  ${comment}  ` });
      const admin = await loginStaff(app, Number(ADMIN_TG));
      const card = (await http().get(`/api/staff/orders/${o.id}`).set(bearer(admin)).expect(200)).body;
      expect(card.customer_comment).toBe(comment);

      await drain();
      const toManager = fake.sent.find((m) => m.chatId === MANAGER_TG && m.text.includes(o.order_number))!;
      expect(toManager.text).toContain(`
💬 Комментарий клиента:
${comment}`);
      // the queued new-order rows (one per employee) keep the same text
      const rows = await queued({ template: 'staff.new_order', payload: { path: ['order_number'], equals: o.order_number } });
      expect(rows.every((r) => (r.payload as { comment?: string }).comment === comment)).toBe(true);
    });

    it('3.5: a comment longer than 500 characters is refused, no order is created', async () => {
      const id = ++tg;
      const login = await http().post('/api/auth/telegram').send({ initData: makeInitData({ id, first_name: 'Notify', language_code: 'ru' }) }).expect(200);
      const p = await createTestProduct(prisma, { price: 10_000, stock: 10 });
      await http()
        .post('/api/orders')
        .set(bearer(login.body.token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 1 }, recipient_name: 'Т', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: 'bank_transfer', customer_comment: 'я'.repeat(501) })
        .expect(400);
    });

    it('"Я оплатил" notifies admins and managers', async () => {
      const { order: o, token } = await order();
      await http().post(`/api/orders/${o.id}/payment/bank-transfer/paid`).set(bearer(token)).send({}).expect(200);
      const rows = await queued({ template: 'staff.customer_paid' });
      expect(rows.map((r) => r.chat_id)).toEqual(expect.arrayContaining([ADMIN_TG, MANAGER_TG]));
    });

    it('3.2: one customer message per status: accepted, paid, picking, handed over, in transit, delivered', async () => {
      const { order: o, chatId } = await order('uz');
      const manager = await loginStaff(app, Number(MANAGER_TG));
      await http().post(`/api/staff/orders/${o.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      for (const status of ['picking', 'handed_to_delivery', 'in_transit', 'delivered']) {
        await http().post(`/api/staff/orders/${o.id}/status`).set(bearer(manager)).send({ status }).expect(200);
      }
      const rows = await queued({ chat_id: chatId });
      expect(rows.map((r) => r.template)).toEqual(['order.accepted_pay', 'order.paid', 'order.picking', 'order.handed_to_delivery', 'order.in_transit', 'order.delivered']);
      expect(rows.every((r) => r.order_id === o.id && r.category === 'order')).toBe(true);
      expect(rows.every((r) => (r.payload as { lang: string }).lang === 'uz')).toBe(true);

      await drain();
      const texts = fake.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
      expect(texts[0]).toContain('qabul qilindi. To‘lov kutilmoqda'); // Uzbek
      expect(texts[1]).toContain('to‘lov tasdiqlandi');
      expect(texts[2]).toContain('yig‘ilmoqda');
      expect(texts[3]).toContain('🚚 Kuryerga topshirildi');
      expect(texts[5]).toContain('✅ Yetkazildi');
    });

    it('cancellation: staff reason is shown; automatic expiry gets a localized reason', async () => {
      const a = await order('ru');
      const manager = await loginStaff(app, Number(MANAGER_TG));
      await http().post(`/api/staff/orders/${a.order.id}/cancel`).set(bearer(manager)).send({ reason: 'Нет в наличии у поставщика' }).expect(200);

      const b = await order('ru');
      await prisma.orders.update({ where: { id: b.order.id }, data: { reserved_until: new Date(Date.now() - 60_000) } });
      await app.get(ReservationExpiryService).runOnce();

      await drain();
      const text = (chat: bigint) => fake.sent.find((m) => m.chatId === chat && m.text.includes('Отменён'))?.text;
      expect(text(a.chatId)).toBe(`Заказ №${a.order.order_number}: ⚪ Отменён\nПричина: Нет в наличии у поставщика`);
      expect(text(b.chatId)).toBe(`Заказ №${b.order.order_number}: ⚪ Отменён\nПричина: заказ не был оплачен вовремя`);
    });

    it('nothing is queued when the order change is rolled back', async () => {
      const before = await prisma.notifications.count();
      const p = await createTestProduct(prisma, { price: 1_000, stock: 1 });
      const login = await http().post('/api/auth/telegram').send({ initData: makeInitData({ id: ++tg, first_name: 'X' }) }).expect(200);
      await http()
        .post('/api/orders')
        .set(bearer(login.body.token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 5 }, recipient_name: 'X', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'x', payment_method: 'bank_transfer' })
        .expect(409); // not enough stock -> whole transaction rolled back
      expect(await prisma.notifications.count()).toBe(before);
    });
  });

  describe('delivery with retries', () => {
    it('sends queued messages and marks them sent', async () => {
      const { chatId } = await order();
      const r = await drain();
      expect(r.sent).toBeGreaterThan(0);
      expect(fake.sent.some((m) => m.text.startsWith('🆕 Новый заказ'))).toBe(true);
      expect(await prisma.notifications.count({ where: { status: { in: ['queued', 'sending'] } } })).toBe(0);
      expect(chatId).toBeGreaterThan(0n);
    });

    it('temporary failure: retried later with backoff, logged as warn in system_errors', async () => {
      await order();
      fake.failWith = new TelegramSendError('Telegram 502: Bad Gateway', false);
      const now = new Date();
      const r = await drain(now);
      expect(r.retried).toBeGreaterThan(0);

      const row = (await queued({ template: 'staff.new_order', status: 'queued' })).at(-1)!;
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at.getTime()).toBe(now.getTime() + 30_000);
      const err = await prisma.system_errors.findFirst({ where: { service: 'notifications' }, orderBy: { created_at: 'desc' } });
      expect(err).toMatchObject({ level: 'warn', message: 'Notification will be retried: Telegram 502: Bad Gateway' });

      fake.failWith = null;
      expect((await drain(now)).sent).toBe(0); // not due yet
      expect((await drain(new Date(now.getTime() + 31_000))).sent).toBeGreaterThan(0);
    });

    it('gives up after 5 attempts and logs an error', async () => {
      await order();
      fake.failWith = new TelegramSendError('Telegram 500: oops', false);
      let t = Date.now();
      for (let i = 0; i < 5; i++) {
        await drain(new Date(t));
        t += 3 * 3600_000;
      }
      const rows = await queued({ template: 'staff.new_order', status: 'failed' });
      expect(rows.at(-1)).toMatchObject({ attempts: 5, error: 'Telegram 500: oops' });
      expect(await prisma.system_errors.count({ where: { service: 'notifications', level: 'error', message: { contains: 'oops' } } })).toBeGreaterThan(0);
    });

    it('permanent failure (bot blocked) is not retried', async () => {
      await order();
      fake.failWith = new TelegramSendError('Telegram 403: Forbidden: bot was blocked by the user', true);
      const r = await drain();
      expect(r.failed).toBeGreaterThan(0);
      expect(r.retried).toBe(0);
    });

    it('rate limit (429) waits exactly as long as Telegram asks', async () => {
      await order();
      fake.failWith = new TelegramSendError('Telegram 429: Too Many Requests', false, 7);
      const now = new Date();
      await drain(now);
      const row = (await queued({ template: 'staff.new_order', status: 'queued' })).at(-1)!;
      expect(row.next_attempt_at.getTime()).toBe(now.getTime() + 7_000);
    });

    it('marketing respects the opt-out, service messages do not', async () => {
      const { chatId } = await order();
      const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: chatId } });
      await prisma.users.update({ where: { id: user.id }, data: { marketing_opt_in: false } });
      const base = { user_id: user.id, chat_id: chatId, payload: { order_number: 'VTL-X', lang: 'ru' } };
      await prisma.notifications.create({ data: { ...base, kind: 'marketing', template: 'order.paid' } });
      await prisma.notifications.create({ data: { ...base, kind: 'service', template: 'order.delivered' } });

      // daytime in Tashkent (the quiet hours 22:00–08:00 would put marketing off): tomorrow 12:00
      const d = new Date();
      const r = await drain(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 7)));
      expect(r.skipped).toBe(1);
      const toUser = fake.sent.filter((m) => m.chatId === chatId && m.text.startsWith('Заказ №VTL-X')).map((m) => m.text);
      expect(toUser).toEqual(['Заказ №VTL-X: ✅ Доставлен\nСпасибо, что выбрали VITALO!']);
    });

    it('two workers at once never send the same message twice', async () => {
      await order();
      const [a, b] = await Promise.all([worker.processOnce(), worker.processOnce()]);
      const texts = fake.sent.map((m) => `${m.chatId}:${m.text}`);
      expect(new Set(texts).size).toBe(texts.length);
      expect(a.sent + b.sent).toBe(texts.length);
    });
  });
});
