import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { renderNotification } from '../src/notifications/notification-templates';
import { NotificationWorker } from '../src/notifications/notification-worker';
import { sanitizeAlert, SystemErrorsService, TECH_ALERT_INTERVAL_MS } from '../src/notifications/system-errors';
import { TELEGRAM_SENDER, type SendOptions, type TelegramSender } from '../src/notifications/telegram-sender';
import { ReservationExpiryService } from '../src/orders/reservation-expiry.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { LocalFileStorage } from '../src/storage/file-storage';
import { applyPhotoOptimization, planPhotoOptimization } from '../src/storage/optimize-existing';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

class FakeSender implements TelegramSender {
  sent: { chatId: bigint; text: string; opts?: SendOptions }[] = [];
  async sendMessage(chatId: bigint, text: string, opts?: SendOptions) {
    this.sent.push({ chatId, text, opts });
  }
}

const ADMIN_TG = 222_222_221;
const UPLOADS = process.env.UPLOAD_DIR!;
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 22, g: 163, b: 154, alpha: 1 } } }).png().toBuffer();

describe('Launch block D (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const fake = new FakeSender();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(TELEGRAM_SENDER).useValue(fake));
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    addr = await seededAddresses(prisma);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ D2 photos
  describe('D2: optimized photos', () => {
    it('upload keeps a 1200 px WebP + 400 px thumbnail (and JPEG fallbacks), never the original; delete removes all files', async () => {
      const p = await createTestProduct(prisma, { price: 1000, stock: 1 });
      const res = await http().post(`/api/staff/products/${p.id}/photos`).set(bearer(admin)).attach('file', await png(2400, 1200), 'big.png').expect(201);
      const media = await prisma.product_media.findFirstOrThrow({ where: { product_id: p.id } });
      expect(media).toMatchObject({ width: 1200, height: 600, is_main: true });
      expect(media.url).toMatch(/\.webp$/);
      expect(media.url_jpeg).toMatch(/\.jpg$/);
      expect(media.thumb_url).toMatch(/-400\.webp$/);
      const dir = join(UPLOADS, 'products', p.id);
      expect(readdirSync(dir).sort()).toHaveLength(4);
      expect(readdirSync(dir).some((f) => f.endsWith('.png'))).toBe(false);
      // read into memory: a file opened by sharp stays locked on Windows
      const thumb = await sharp(readFileSync(join(UPLOADS, media.thumb_url!.replace(/^\/uploads\//, '')))).metadata();
      expect([thumb.width, thumb.height, thumb.format]).toEqual([400, 200, 'webp']);
      expect(res.body.media[0].url).toBe(media.url);

      // the shop: thumbnail in lists, main photo with size on the product page
      await prisma.products.update({ where: { id: p.id }, data: { status: 'active' } });
      const card = (await http().get(`/api/catalog/products/${p.id}`).expect(200)).body;
      expect(card.image).toEqual({ webp: media.thumb_url, jpeg: media.thumb_url_jpeg, width: 400, height: 200 });
      expect(card.media[0]).toMatchObject({ url: media.url, url_jpeg: media.url_jpeg, width: 1200, height: 600 });

      await http().delete(`/api/staff/products/${p.id}/photos/${media.id}`).set(bearer(admin)).expect(200);
      expect(readdirSync(dir)).toHaveLength(0);
      await http().post(`/api/staff/products/${p.id}/photos`).set(bearer(admin)).attach('file', Buffer.from('not an image at all'), 'x.png').expect(400);
    });

    it('optimize-existing: old uploads are converted (original removed), external links skipped, dry run changes nothing', async () => {
      const p = await createTestProduct(prisma, { price: 1000, stock: 1 });
      await mkdir(join(UPLOADS, 'products', p.id), { recursive: true });
      await writeFile(join(UPLOADS, 'products', p.id, 'old.png'), await png(1600, 1600));
      await prisma.product_media.createMany({
        data: [
          { product_id: p.id, media_type: 'image', url: `/uploads/products/${p.id}/old.png`, is_main: true },
          { product_id: p.id, media_type: 'image', url: 'https://placehold.co/600x600/png', sort_order: 1 },
        ],
      });
      const plan = (await planPhotoOptimization(prisma, UPLOADS)).filter((r) => r.product_id === p.id);
      expect(plan.map((r) => r.action)).toEqual(['optimize', 'skip']);
      expect(existsSync(join(UPLOADS, 'products', p.id, 'old.png'))).toBe(true); // dry run

      const res = await applyPhotoOptimization(prisma, new LocalFileStorage(app.get(ConfigService)), UPLOADS, plan);
      expect(res.failed).toEqual([]);
      expect(res.done[0].after).toBeLessThan(res.done[0].before);
      expect(existsSync(join(UPLOADS, 'products', p.id, 'old.png'))).toBe(false);
      expect(await prisma.product_media.findFirst({ where: { product_id: p.id, is_main: true } })).toMatchObject({ width: 1200, height: 1200 });
      expect((await planPhotoOptimization(prisma, UPLOADS)).filter((r) => r.product_id === p.id && r.action === 'optimize')).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ D3 payment reminder
  describe('D3: payment reminder', () => {
    let tg = 990_000_000;
    async function placeOrder(lang: 'ru' | 'uz' = 'ru') {
      const id = ++tg;
      const token = await loginCustomer(app, id);
      if (lang === 'uz') await prisma.users.update({ where: { telegram_user_id: BigInt(id) }, data: { language: 'uz' } });
      const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
      const order = (
        await http()
          .post('/api/orders')
          .set(bearer(token))
          .set('Idempotency-Key', randomUUID())
          .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 1 }, recipient_name: 'Т', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: 'card_transfer' })
          .expect(201)
      ).body;
      return { order, token, chatId: BigInt(id) };
    }
    const dueIn = (orderId: string, hours: number) => prisma.orders.update({ where: { id: orderId }, data: { reserved_until: new Date(Date.now() + hours * 3600_000) } });
    const reminders = (orderId: string) => prisma.notifications.findMany({ where: { template: 'order.payment_reminder', payload: { path: ['open_path'], string_contains: orderId } } });

    it('3 hours before cancellation: one reminder, only for unpaid orders without «Я оплатил(а)»', async () => {
      const job = app.get(ReservationExpiryService);
      const due = await placeOrder('uz');
      const early = await placeOrder();
      const reported = await placeOrder();
      await dueIn(due.order.id, 2);
      await dueIn(early.order.id, 5);
      await dueIn(reported.order.id, 2);
      await http().post(`/api/orders/${reported.order.id}/payment/bank-transfer/paid`).set(bearer(reported.token)).send({}).expect(200);

      await job.remindOnce();
      await job.remindOnce(); // second pass: nothing new
      expect(await reminders(due.order.id)).toHaveLength(1);
      expect(await reminders(early.order.id)).toHaveLength(0);
      expect(await reminders(reported.order.id)).toHaveLength(0);
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: due.order.id } })).payment_reminder_sent_at).not.toBeNull();

      const [n] = await reminders(due.order.id);
      const payload = n.payload as { until: string; lang: string; open_path: string };
      expect(payload).toMatchObject({ lang: 'uz', open_path: `/orders/${due.order.id}/pay` });
      expect(renderNotification(n.template, payload as never)).toBe(
        `⏰ №${due.order.order_number} buyurtma ${payload.until} gacha to‘lovni kutmoqda.\nAgar pulni allaqachon o‘tkazgan bo‘lsangiz, «To‘ladim» tugmasini bosing.`,
      );
      expect(renderNotification(n.template, { ...payload, lang: 'ru', order_number: 'VTL-1' } as never)).toBe(
        `⏰ Заказ №VTL-1 ждёт оплаты до ${payload.until}.\nЕсли вы уже перевели деньги, нажмите «Я оплатил(а)».`,
      );

      // delivered with a button that opens this order in the Mini App
      process.env.MINIAPP_URL = 'https://shop.example.com';
      try {
        fake.sent = [];
        // the queue may hold messages of other tests: drain it
        for (let i = 0; i < 50; i++) {
          const r = await app.get(NotificationWorker).processOnce();
          if (!r.sent && !r.failed && !r.retried && !r.skipped) break;
        }
        const msg = fake.sent.find((m) => m.chatId === due.chatId && m.text.startsWith('⏰'));
        expect(msg?.opts?.webApp).toEqual({ text: 'To‘lash / Chek yuborish', url: `https://shop.example.com/orders/${due.order.id}/pay` });
      } finally {
        process.env.MINIAPP_URL = '';
      }
    });

    it('the shop shows the deadline (reserved_until) on the order', async () => {
      const { order, token } = await placeOrder();
      const view = (await http().get(`/api/orders/${order.id}`).set(bearer(token)).expect(200)).body;
      expect(new Date(view.reserved_until).getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ------------------------------------------------------------------ D4 documents tile
  it('D4: the documents tile is off by default', async () => {
    const shop = (await http().get('/api/catalog/texts').expect(200)).body;
    expect(shop.home_content.trust.find((t: { key: string }) => t.key === 'documents').enabled).toBe(false);
  });

  // ------------------------------------------------------------------ D5 tech chat
  describe('D5: tech chat', () => {
    it('no secrets or personal data in alerts', () => {
      const text = sanitizeAlert('fail 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw for +998 90 123-45-67 ali@mail.uz chat 6436343149 secret-value-xyz', ['secret-value-xyz']);
      expect(text).not.toMatch(/AAHdq|998 90|ali@mail|6436343149|secret-value/);
      expect(text).toContain('[токен скрыт]');
    });

    it('sends to TECH_CHAT_ID at most once per 10 minutes for the same error; empty id -> silently nothing', async () => {
      const errors = app.get(SystemErrorsService);
      const entry = { level: 'error' as const, service: 'notifications', message: 'Notification failed: Telegram 403: Forbidden', context: { template: 'order.paid', attempts: 5, chat: 777 } };
      fake.sent = [];
      await errors.record(entry); // TECH_CHAT_ID is empty in tests
      expect(fake.sent).toHaveLength(0);
      expect(await prisma.system_errors.count({ where: { message: entry.message } })).toBe(1);

      process.env.TECH_CHAT_ID = '-1001234567890';
      try {
        const t0 = Date.now();
        await errors.record(entry, t0);
        await errors.record({ ...entry, message: entry.message.replace('403', '404') }, t0 + 60_000); // same shape -> skipped
        await errors.record(entry, t0 + TECH_ALERT_INTERVAL_MS + 1);
        expect(fake.sent).toHaveLength(2);
        expect(fake.sent[0].chatId).toBe(-1001234567890n);
        expect(fake.sent[0].text).toContain('VITALO · notifications');
        expect(fake.sent[0].text).toContain('template: order.paid');
        expect(fake.sent[0].text).not.toContain('chat');
        const stored = await prisma.system_errors.findFirst({ where: { message: entry.message }, orderBy: { created_at: 'desc' } });
        expect(stored?.notified_at).not.toBeNull();
      } finally {
        process.env.TECH_CHAT_ID = '';
      }
    });
  });
});
