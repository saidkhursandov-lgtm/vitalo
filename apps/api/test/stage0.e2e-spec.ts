import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import request from 'supertest';
import { renderNotification } from '../src/notifications/notification-templates';
import { NotificationWorker } from '../src/notifications/notification-worker';
import { TELEGRAM_SENDER, type SendOptions, type TelegramSender } from '../src/notifications/telegram-sender';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses, stockOf } from './helpers';

class FakeSender implements TelegramSender {
  sent: { chatId: bigint; text: string; opts?: SendOptions }[] = [];
  async sendMessage(chatId: bigint, text: string, opts?: SendOptions) {
    this.sent.push({ chatId, text, opts });
  }
}

/** Seeded dev staff (prisma/seed.ts), one per role. */
const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const HOUR = 3600_000;

describe('Stage 0: permissions, payment check reminder, reservation time (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const tokens = {} as Record<Role, string>;
  const fake = new FakeSender();
  const http = () => request(app.getHttpServer());
  let tg = 975_000_000;

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(TELEGRAM_SENDER).useValue(fake));
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    // Other suites expect the seeded 12 hours.
    await prisma.payment_methods.updateMany({ where: { code: { in: ['card_transfer', 'bank_transfer'] } }, data: { timeout_minutes: 720 } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  async function placeOrder(method: 'card_transfer' | 'bank_transfer' = 'card_transfer') {
    const id = ++tg;
    const token = await loginCustomer(app, id);
    const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 1 }, recipient_name: 'Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: method })
        .expect(201)
    ).body;
    return { order, token, productId: p.id };
  }

  // ------------------------------------------------------------------ 0.1 cost price and revenue
  describe('0.1: cost price and revenue are not for everyone', () => {
    it('GET /staff/products/:id: only admin gets cost_uzs; manager, warehouse and marketer do not', async () => {
      const p = await createTestProduct(prisma, { price: 50_000, stock: 1 });
      await prisma.products.update({ where: { id: p.id }, data: { cost_uzs: 12_345n } });
      const get = (r: Role) => http().get(`/api/staff/products/${p.id}`).set(bearer(tokens[r])).expect(200);

      expect((await get('admin')).body.cost_uzs).toBe(12_345);
      for (const r of ['manager', 'warehouse', 'marketer'] as Role[]) {
        const body = (await get(r)).body;
        expect(body).not.toHaveProperty('cost_uzs');
        expect(body.price_uzs).toBe(50_000); // the rest of the card is still there
      }
    });

    it('warehouse cannot enter the purchase price on a receipt; without it the batch is stored without a price', async () => {
      const p = await createTestProduct(prisma, { price: 10_000, stock: 2 });
      const wh = await prisma.warehouses.findFirstOrThrow();
      const receipt = (r: Role, body: object) => http().post('/api/staff/inventory/receipt').set(bearer(tokens[r])).send({ product_id: p.id, warehouse_id: wh.id, qty: 3, ...body });

      const refused = await receipt('warehouse', { cost_uzs: 7_000 }).expect(403);
      expect(refused.body.code).toBe('COST_FORBIDDEN');
      expect((await stockOf(prisma, p.id)).actual).toBe(2); // nothing received
      expect(await prisma.inventory_batches.count({ where: { product_id: p.id } })).toBe(0);

      await receipt('warehouse', { batch_no: 'W-1' }).expect(201);
      await receipt('admin', { cost_uzs: 7_000, batch_no: 'A-1' }).expect(201);
      const batches = await prisma.inventory_batches.findMany({ where: { product_id: p.id }, orderBy: { batch_no: 'asc' } });
      expect(batches.map((b) => [b.batch_no, b.cost_uzs])).toEqual([
        ['A-1', 7_000n],
        ['W-1', null],
      ]);
      expect((await stockOf(prisma, p.id)).actual).toBe(8);
    });

    it('the dashboard shows revenue and average check to admin and manager, not to marketer (the funnel stays)', async () => {
      const dash = async (r: Role) => (await http().get('/api/staff/dashboard?days=30').set(bearer(tokens[r])).expect(200)).body;
      for (const r of ['admin', 'manager'] as Role[]) {
        const d = await dash(r);
        expect(typeof d.sales.revenue_uzs).toBe('number');
        expect(typeof d.sales.average_check_uzs).toBe('number');
      }
      const m = await dash('marketer');
      expect(m.sales).not.toHaveProperty('revenue_uzs');
      expect(m.sales).not.toHaveProperty('average_check_uzs');
      expect(m.sales.channels.vitalo).not.toHaveProperty('revenue_uzs');
      for (const d of m.sales.by_day) expect(d).not.toHaveProperty('vitalo_revenue_uzs');
      for (const t of m.top_products) expect(t).not.toHaveProperty('revenue_uzs');
      expect(m.sales).toHaveProperty('orders');
      // генплан, этап 2: margin and the AI spend — admin only
      expect(await dash('admin')).toMatchObject({ margin: expect.any(Object), ai_spend: { month_usd: expect.any(Number), budget_usd: expect.any(Number) } });
      for (const r of ['manager', 'marketer'] as Role[]) {
        const d = await dash(r);
        expect(d).not.toHaveProperty('margin');
        expect(d).not.toHaveProperty('ai_spend');
      }
      await http().get('/api/staff/dashboard/funnel?period=7').set(bearer(tokens.marketer)).expect(200);
    });
  });

  // ------------------------------------------------------------------ 0.2 payment check reminder for staff
  describe('0.2: «Я оплатил(а)» unchecked for N hours -> one reminder to admins and managers', () => {
    const reportPaid = (o: { order: { id: string }; token: string }) =>
      http().post(`/api/orders/${o.order.id}/payment/bank-transfer/paid`).set(bearer(o.token)).send({}).expect(200);
    const reportedHoursAgo = (orderId: string, hours: number) =>
      prisma.manual_payment_confirmations.updateMany({
        where: { payment: { order_id: orderId }, customer_confirmed_at: { not: null } },
        data: { customer_confirmed_at: new Date(Date.now() - hours * HOUR) },
      });
    const overdue = (orderNumber: string) =>
      prisma.notifications.findMany({ where: { template: 'staff.payment_check_overdue', payload: { path: ['order_number'], equals: orderNumber } } });

    it('is queued once per order for every active admin/manager, without customer data; the order and stock stay as they are', async () => {
      const job = app.get(ReservationExpiryService);
      const o = await placeOrder();
      await reportPaid(o);
      await reportedHoursAgo(o.order.id, 4);
      const stockBefore = await stockOf(prisma, o.productId);

      await Promise.all([job.remindStaffOnce(), job.remindStaffOnce()]); // two instances at the same moment
      await job.remindStaffOnce(); // and a later run
      const staffCount = await prisma.staff_users.count({ where: { status: 'active', role: { in: ['admin', 'manager'] } } });
      const sent = await overdue(o.order.order_number);
      expect(sent).toHaveLength(staffCount);
      expect(new Set(sent.map((n) => n.staff_user_id)).size).toBe(staffCount);

      const payload = sent[0].payload as Record<string, unknown>;
      expect(payload).toMatchObject({ order_number: o.order.order_number, total_uzs: o.order.totals.total_uzs, hours: 4, admin_path: `/orders/${o.order.id}` });
      expect(payload).not.toHaveProperty('customer');
      expect(payload).not.toHaveProperty('phone');
      expect(renderNotification('staff.payment_check_overdue', payload as never)).toContain('ждёт проверки уже 4 ч');

      const order = await prisma.orders.findUniqueOrThrow({ where: { id: o.order.id } });
      expect(order).toMatchObject({ status: 'awaiting_payment', payment_status: 'payment_pending' });
      expect(order.payment_check_reminder_sent_at).not.toBeNull();
      expect(await stockOf(prisma, o.productId)).toEqual(stockBefore);

      // Delivered with a button to the order in the admin panel.
      process.env.ADMIN_URL = 'https://admin.example.com';
      try {
        fake.sent = [];
        for (let i = 0; i < 50; i++) {
          const r = await app.get(NotificationWorker).processOnce();
          if (!r.sent && !r.failed && !r.retried && !r.skipped) break;
        }
        const msg = fake.sent.find((m) => m.chatId === BigInt(STAFF_TG.admin) && m.text.startsWith('⏳') && m.text.includes(o.order.order_number));
        expect(msg?.opts?.webApp).toEqual({ text: 'Открыть в админке', url: `https://admin.example.com/orders/${o.order.id}` });
      } finally {
        process.env.ADMIN_URL = '';
      }
    });

    it('is not sent too early, after the payment was confirmed, or after the order was cancelled', async () => {
      const job = app.get(ReservationExpiryService);
      const fresh = await placeOrder();
      await reportPaid(fresh);
      await reportedHoursAgo(fresh.order.id, 1);

      const confirmed = await placeOrder();
      await reportPaid(confirmed);
      await reportedHoursAgo(confirmed.order.id, 5);
      await http().post(`/api/staff/orders/${confirmed.order.id}/confirm-payment`).set(bearer(tokens.manager)).send({}).expect(200);

      const cancelled = await placeOrder('bank_transfer');
      await reportPaid(cancelled);
      await reportedHoursAgo(cancelled.order.id, 5);
      await http().post(`/api/staff/orders/${cancelled.order.id}/cancel`).set(bearer(tokens.manager)).send({ reason: 'Клиент передумал' }).expect(200);

      await job.remindStaffOnce();
      for (const o of [fresh, confirmed, cancelled]) expect(await overdue(o.order.order_number)).toHaveLength(0);
    });

    it('the hours come from the settings (Тексты и контакты), 1–48', async () => {
      const put = (v: unknown) => {
        return http()
          .put('/api/staff/settings/contacts')
          .set(bearer(tokens.admin))
          .send({ support_contact: '@VITALO_support', payment_check_from: '08:00', payment_check_to: '22:00', delivery_days_label: { ru: 'рабочих дней', uz: 'ish kuni' }, payment_check_reminder_hours: v });
      };
      expect((await put(6).expect(200)).body.payment_check_reminder_hours).toBe(6);
      for (const bad of [0, 49, 2.5, 'x']) await put(bad).expect(400);

      const job = app.get(ReservationExpiryService);
      const o = await placeOrder();
      await reportPaid(o);
      await reportedHoursAgo(o.order.id, 5);
      await job.remindStaffOnce();
      expect(await overdue(o.order.order_number)).toHaveLength(0); // 5 h < 6 h
      await reportedHoursAgo(o.order.id, 7);
      await job.remindStaffOnce();
      expect((await overdue(o.order.order_number)).length).toBeGreaterThan(0);
      await put(3).expect(200);
    });
  });

  // ------------------------------------------------------------------ 0.3 reservation time in the admin panel
  describe('0.3: reservation time of card / bank transfer', () => {
    const minutesHeld = async (orderId: string) => {
      const o = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      return Math.round((o.reserved_until!.getTime() - o.created_at.getTime()) / 60_000);
    };
    const put = (code: string, body: object, role: Role = 'admin') =>
      http().put(`/api/staff/settings/payment-methods/${code}`).set(bearer(tokens[role])).send(body);

    it('a new order gets the new time, an existing one keeps its own; the change is audited', async () => {
      const list = (await http().get('/api/staff/settings/payment-methods').set(bearer(tokens.admin)).expect(200)).body;
      expect(list.map((m: { code: string; timeout_minutes: number }) => [m.code, m.timeout_minutes])).toEqual([
        ['bank_transfer', 720],
        ['card_transfer', 720],
        ['payme', 30],
      ]);
      const before = await placeOrder('card_transfer');
      const reservedUntil = (await prisma.orders.findUniqueOrThrow({ where: { id: before.order.id } })).reserved_until;
      expect(await minutesHeld(before.order.id)).toBe(720);

      const res = await put('card_transfer', { timeout_minutes: 240 }).expect(200);
      expect(res.body.find((m: { code: string }) => m.code === 'card_transfer').timeout_minutes).toBe(240);
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { action: 'settings.payment_timeout_updated' }, orderBy: { created_at: 'desc' } });
      expect(audit.before_json).toMatchObject({ code: 'card_transfer', timeout_minutes: 720 });
      expect(audit.after_json).toMatchObject({ code: 'card_transfer', timeout_minutes: 240 });

      const after = await placeOrder('card_transfer');
      expect(await minutesHeld(after.order.id)).toBe(240);
      expect(await minutesHeld((await placeOrder('bank_transfer')).order.id)).toBe(720); // the other method is untouched
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: before.order.id } })).reserved_until).toEqual(reservedUntil);

      await put('card_transfer', { timeout_minutes: 720 }).expect(200);
    });

    it('rejects values outside 30–1440, shorter than the customer reminder, unknown methods and other roles', async () => {
      for (const bad of [20, 1441, 90.5, '600', null]) await put('card_transfer', { timeout_minutes: bad }).expect(400);
      const short = await put('card_transfer', { timeout_minutes: 120 }).expect(400); // reminder: 3 h before cancellation
      expect(short.body.code).toBe('TIMEOUT_SHORTER_THAN_REMINDER');
      await put('click', { timeout_minutes: 600 }).expect(404);
      await put('card_transfer', { timeout_minutes: 600 }, 'manager').expect(403);
      expect((await prisma.payment_methods.findUniqueOrThrow({ where: { code: 'card_transfer' } })).timeout_minutes).toBe(720);
    });

    it('Payme: 30 minutes to 3 days (its checks of test orders), no reminder rule; other methods stay up to a day', async () => {
      const list = (await http().get('/api/staff/settings/payment-methods').set(bearer(tokens.admin)).expect(200)).body;
      expect(list.find((m: { code: string }) => m.code === 'payme')).toMatchObject({ timeout_minutes: 30, max_minutes: 4320 });
      await put('payme', { timeout_minutes: 4321 }).expect(400);
      expect((await put('card_transfer', { timeout_minutes: 4320 }).expect(400)).body.code).toBe('TIMEOUT_TOO_LONG');
      await put('payme', { timeout_minutes: 4320 }).expect(200);
      expect((await prisma.payment_methods.findUniqueOrThrow({ where: { code: 'payme' } })).timeout_minutes).toBe(4320);
      await put('payme', { timeout_minutes: 30 }).expect(200); // shorter than the reminder: allowed for Payme
      await put('payme', { timeout_minutes: 600 }, 'manager').expect(403);
    });
  });

  // ------------------------------------------------------------------ 0.5 database guard of seed / dev scripts
  it('0.5: the demo seed refuses a database whose name does not end with _dev or _test', () => {
    // Port 1 on this computer: nothing listens there, so even a broken guard could not touch any database.
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ts-node', 'prisma/seed.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/vitalo' },
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('оканчивается на _dev или _test');
  }, 60_000);
});
