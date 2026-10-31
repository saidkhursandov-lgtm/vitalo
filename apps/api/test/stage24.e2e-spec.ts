import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { renderNotification } from '../src/notifications/notification-templates';
import { PrismaService } from '../src/prisma/prisma.service';
import { MANIFEST_DEFAULT } from '../src/settings/home-content';
import { WaitlistService } from '../src/waitlist/waitlist.module';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, setStock } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;

/** Stage 2.4: manifest texts from the settings and the waiting list «Сообщить о поступлении». */
describe('Stage 2.4 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, MANAGER_TG);
    await prisma.settings.deleteMany({ where: { key: 'home_manifest' } });
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'home_manifest' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  describe('manifest', () => {
    it('the shop gets the texts from the content file until an admin saves new ones; point 1 has no «4–5%»', async () => {
      const texts = (await http().get('/api/catalog/texts').expect(200)).body;
      expect(texts.manifest).toEqual(MANIFEST_DEFAULT);
      expect(texts.manifest.points).toHaveLength(3);
      expect(texts.manifest.points[0].text.ru).toContain('усваиваются значительно хуже органических форм');
      expect(texts.manifest.points[0].text.uz).toContain('organik shakllarga qaraganda ancha yomon');
      expect(JSON.stringify(texts.manifest)).not.toMatch(/4–5%/);
    });

    it('admin edits every text and switches the block off; the manager may not', async () => {
      const body = { ...MANIFEST_DEFAULT, enabled: false, title: { ru: ' Как мы отбираем ', uz: 'Qanday tanlaymiz' } };
      await http().put('/api/staff/settings/manifest').set(bearer(manager)).send(body).expect(403);
      const saved = (await http().put('/api/staff/settings/manifest').set(bearer(admin)).send(body).expect(200)).body;
      expect(saved).toMatchObject({ enabled: false, title: { ru: 'Как мы отбираем', uz: 'Qanday tanlaymiz' } });
      const texts = (await http().get('/api/catalog/texts').expect(200)).body;
      expect(texts.manifest.enabled).toBe(false);
      expect(texts.manifest.title.ru).toBe('Как мы отбираем');
    });

    it('refuses empty texts and anything but exactly 3 points', async () => {
      const put = (b: object) => http().put('/api/staff/settings/manifest').set(bearer(admin)).send(b);
      await put({ ...MANIFEST_DEFAULT, intro: { ru: '', uz: 'x' } }).expect(400);
      await put({ ...MANIFEST_DEFAULT, points: MANIFEST_DEFAULT.points.slice(0, 2) }).expect(400);
      await put({ ...MANIFEST_DEFAULT, points: [...MANIFEST_DEFAULT.points, MANIFEST_DEFAULT.points[0]] }).expect(400);
    });
  });

  describe('waiting list', () => {
    it('subscribe once per product: staff get a message with the count; a repeat changes nothing; in stock = 409', async () => {
      const p = await createTestProduct(prisma, { price: 98_000, stock: 0, name: 'Магний ожидание' });
      const inStock = await createTestProduct(prisma, { price: 10_000, stock: 3 });
      const c1 = await loginCustomer(app, 770_000_001);
      const c2 = await loginCustomer(app, 770_000_002);
      await prisma.users.update({ where: { telegram_user_id: 770_000_001n }, data: { phone: '+998901112233' } });
      const before = await prisma.notifications.count({ where: { template: 'staff.waitlist_new' } });

      expect((await http().put(`/api/waitlist/${p.id}`).set(bearer(c1)).expect(200)).body).toEqual({ status: 'subscribed' });
      expect((await http().put(`/api/waitlist/${p.id}`).set(bearer(c1)).expect(200)).body).toEqual({ status: 'already' });
      await http().put(`/api/waitlist/${p.id}`).set(bearer(c2)).expect(200);
      await http().put(`/api/waitlist/${inStock.id}`).set(bearer(c1)).expect(409);
      await http().put(`/api/waitlist/${p.id}`).expect(401);

      expect((await http().get('/api/waitlist/ids').set(bearer(c1)).expect(200)).body).toEqual([p.id]);
      const rows = await prisma.product_waitlist.findMany({ where: { product_id: p.id }, include: { user: true }, orderBy: { created_at: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows[0].phone).toBe('+998901112233');
      expect(rows[1].phone).toBeNull();

      const staffMsgs = await prisma.notifications.findMany({ where: { template: 'staff.waitlist_new' }, orderBy: { created_at: 'desc' } });
      expect(staffMsgs.length - before).toBeGreaterThanOrEqual(2 * 2); // two subscriptions × (admin + manager)
      const last = staffMsgs[0].payload as { product: string; count: number; admin_path: string };
      expect(last.count).toBe(2);
      expect(last.product).toContain(p.sku);
      expect(last.admin_path).toBe(`/waitlist/${p.id}`);
      expect(renderNotification('staff.waitlist_new', { order_number: '', product: last.product, count: 2 })).toContain('Ждут поступления: 2');
      const events = await prisma.analytics_events.count({ where: { event: 'waitlist_subscribe', user_id: rows[0].user_id } });
      expect(events).toBe(1);

      // admin panel: the product with 2 waiting, then its customers (managers see it too: customers.view)
      const list = (await http().get('/api/staff/waitlist').set(bearer(manager)).expect(200)).body;
      expect(list.find((x: { product_id: string }) => x.product_id === p.id)).toMatchObject({ waiting: 2, notified: 0, available_qty: 0 });
      const detail = (await http().get(`/api/staff/waitlist/${p.id}`).set(bearer(admin)).expect(200)).body;
      expect(detail.customers).toHaveLength(2);
      expect(detail.customers.map((x: { phone: string | null }) => x.phone)).toContain('+998901112233');
    });

    it('back in stock: each waiting customer gets one message with «Открыть товар», in their language, never twice', async () => {
      const p = await createTestProduct(prisma, { price: 50_000, stock: 0, name: 'Витамин ожидание' });
      await prisma.products.update({ where: { id: p.id }, data: { short_name_ru: 'Витамин D3, 60 капс.', short_name_uz: 'Vitamin D3, 60 kaps.' } });
      const c1 = await loginCustomer(app, 770_000_011);
      const c2 = await loginCustomer(app, 770_000_012);
      await prisma.users.update({ where: { telegram_user_id: 770_000_012n }, data: { language: 'uz' } });
      await http().put(`/api/waitlist/${p.id}`).set(bearer(c1)).expect(200);
      await http().put(`/api/waitlist/${p.id}`).set(bearer(c2)).expect(200);
      const waitlist = app.get(WaitlistService);

      await waitlist.notifyOnce(); // still out of stock: nothing
      expect(await prisma.notifications.count({ where: { template: 'waitlist.back_in_stock', payload: { path: ['open_path'], equals: `/product/${p.id}` } } })).toBe(0);

      await setStock(prisma, p.id, 4);
      await waitlist.notifyOnce();
      await waitlist.notifyOnce(); // a second run sends nothing more
      const msgs = await prisma.notifications.findMany({ where: { template: 'waitlist.back_in_stock', payload: { path: ['open_path'], equals: `/product/${p.id}` } } });
      expect(msgs).toHaveLength(2);
      const texts = msgs.map((m) => renderNotification(m.template, m.payload as never)).sort();
      expect(texts).toEqual(['Vitamin D3, 60 kaps. yana sotuvda', 'Витамин D3, 60 капс. снова в наличии']);
      expect(msgs.every((m) => (m.payload as { open_button: string }).open_button === 'product' && m.kind === 'service')).toBe(true);
      const rows = await prisma.product_waitlist.findMany({ where: { product_id: p.id } });
      expect(rows.every((r) => r.notified_at)).toBe(true);
      expect(await prisma.analytics_events.count({ where: { event: 'waitlist_notified', props: { path: ['product_id'], equals: p.id } } })).toBe(2);
      expect((await http().get('/api/waitlist/ids').set(bearer(c1)).expect(200)).body).not.toContain(p.id);

      // sold out again: the customer may ask once more — the same row reopens, one more message later
      await setStock(prisma, p.id, 0);
      expect((await http().put(`/api/waitlist/${p.id}`).set(bearer(c1)).expect(200)).body).toEqual({ status: 'subscribed' });
      expect(await prisma.product_waitlist.count({ where: { product_id: p.id } })).toBe(2);
      await setStock(prisma, p.id, 1);
      await waitlist.notifyOnce();
      expect(await prisma.notifications.count({ where: { template: 'waitlist.back_in_stock', payload: { path: ['open_path'], equals: `/product/${p.id}` } } })).toBe(3);
    });
  });
});
