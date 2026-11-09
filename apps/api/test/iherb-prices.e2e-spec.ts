import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IherbPricesService } from '../src/iherb/iherb-prices';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;

/** Генплан, этап 5, ветка iherb-2-prices (D-57): wishlist upload, price history, auto price with guards. */
describe('iHerb prices (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  const http = () => request(app.getHttpServer());
  const base = 400_000 + (Date.now() % 100_000) * 3;
  const ids = { auto: base + 1, shelf: base + 2, floor: base + 3, off: base + 4, unknown: base + 5, dynamic: base + 6 };
  const link = (id: number) => `https://uz.iherb.com/pr/test-product/${id}`;
  const made: Record<string, string> = {};

  const table = (rows: [number, number, string?][]) => rows.map(([id, price, note]) => `${link(id)};${price} сум${note ? ';' + note : ''}`).join('\n');
  const send = (text: string, dryRun = false) =>
    http()
      .post('/api/staff/iherb/uploads' + (dryRun ? '?dry_run=1' : ''))
      .set(bearer(admin))
      .field('text', text);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, MANAGER_TG);
    const mk = async (key: keyof typeof ids, opts: { price: number; stock: number; auto?: boolean; mode?: string; cost?: number }) => {
      const p = await createTestProduct(prisma, { price: opts.price, stock: opts.stock });
      await prisma.products.update({
        where: { id: p.id },
        data: {
          iherb_url: link(ids[key]),
          iherb_product_id: String(ids[key]),
          auto_pricing_enabled: opts.auto ?? true,
          markup_percent: 80,
          price_round_to: 1000,
          stock_price_mode: opts.mode ?? 'freeze',
          cost_uzs: opts.cost == null ? null : BigInt(opts.cost),
          old_price_uzs: key === 'auto' ? BigInt(175_000) : null,
          yandex_price_uzs: key === 'auto' ? BigInt(200_000) : null,
        },
      });
      made[key] = p.id;
    };
    await mk('auto', { price: 170_000, stock: 0 });
    await mk('shelf', { price: 170_000, stock: 2 });
    await mk('floor', { price: 170_000, stock: 0, cost: 200_000 });
    await mk('off', { price: 170_000, stock: 0, auto: false });
    await mk('dynamic', { price: 100_000, stock: 5, mode: 'dynamic' });
  });

  afterAll(async () => {
    await prisma.products.updateMany({ where: { id: { in: Object.values(made) } }, data: { iherb_url: null, iherb_product_id: null } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  const upload = () =>
    table([
      [ids.auto, 100_300],
      [ids.shelf, 100_000],
      [ids.floor, 100_000],
      [ids.off, 100_000],
      [ids.unknown, 55_000],
      [ids.dynamic, 100_000],
    ]);

  it('the preview shows what would happen and writes nothing', async () => {
    const { body } = await send(upload(), true).expect(201);
    expect(body.summary).toEqual({ total: 6, matched: 5, unknown: 1, will_change: 3, big_jumps: 2 }); // floor 170→220 and dynamic 100→180
    const row = (id: number) => body.items.find((i: { iherb_product_id: string }) => i.iherb_product_id === String(id));
    expect(row(ids.auto).auto).toMatchObject({ target_uzs: 181_000, apply: true, big_jump: false });
    expect(row(ids.shelf).auto).toMatchObject({ apply: false, skip_reason: 'in_stock_freeze', skip_label: 'товар есть на складе, режим «Цену не менять»' });
    expect(row(ids.floor).auto).toMatchObject({ target_uzs: 220_000, apply: true, floor_applied: true, big_jump: true });
    expect(row(ids.off).auto).toBeNull();
    expect(row(ids.unknown).product).toBeNull();
    expect(row(ids.dynamic).auto).toMatchObject({ target_uzs: 180_000, apply: true });
    expect(await prisma.iherb_price_snapshots.count({ where: { iherb_product_id: String(ids.auto) } })).toBe(0);
    expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: made.auto } })).price_uzs)).toBe(170_000);
  });

  it('saving writes the snapshot, applies the prices at once and logs every change', async () => {
    const { body } = await send(upload()).expect(201);
    expect(body.upload_id).toEqual(expect.any(String));
    const p = await prisma.products.findUniqueOrThrow({ where: { id: made.auto } });
    expect(Number(p.price_uzs)).toBe(181_000);
    expect(p.old_price_uzs).toBeNull(); // 175 000 < 181 000: the crossed-out price would read as a rise
    expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: made.shelf } })).price_uzs)).toBe(170_000);
    expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: made.floor } })).price_uzs)).toBe(220_000);
    expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: made.off } })).price_uzs)).toBe(170_000);
    expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: made.dynamic } })).price_uzs)).toBe(180_000);

    const change = await prisma.price_changes.findFirstOrThrow({ where: { product_id: made.auto } });
    expect(change).toMatchObject({ status: 'applied', reason: 'iherb_auto', yandex_check: true, big_jump: false, markup_percent: 80 });
    expect([Number(change.old_price_uzs), Number(change.new_price_uzs), Number(change.iherb_price_uzs)]).toEqual([170_000, 181_000, 100_300]);
    expect((await prisma.price_changes.findFirstOrThrow({ where: { product_id: made.floor } })).floor_applied).toBe(true);
    expect(await prisma.audit_logs.count({ where: { action: 'product.price_auto_iherb', entity_id: made.auto } })).toBe(1);
    // the not linked product is kept too: its history is there when the link is added later
    expect(await prisma.iherb_price_snapshots.count({ where: { iherb_product_id: String(ids.unknown), product_id: null } })).toBe(1);
  });

  it('the list and the chart data show the last snapshot and the change', async () => {
    const list = (await http().get('/api/staff/iherb/products').set(bearer(admin)).expect(200)).body;
    const auto = list.find((p: { id: string }) => p.id === made.auto);
    expect(auto).toMatchObject({ price_uzs: 181_000, last_snapshot: { price_uzs: 100_300, in_stock: true }, last_change: { old_price_uzs: 170_000, new_price_uzs: 181_000 } });
    const hist = (await http().get(`/api/staff/iherb/products/${made.auto}/history`).set(bearer(admin)).expect(200)).body;
    expect(hist.snapshots.map((s: { price_uzs: number }) => s.price_uzs)).toEqual([100_300]);
    expect(hist.changes).toHaveLength(1);
    // the second upload: iHerb out of stock — the price stays, the chart gets a point
    await send(table([[ids.auto, 90_000, 'нет']])).expect(201);
    expect(Number((await prisma.products.findUniqueOrThrow({ where: { id: made.auto } })).price_uzs)).toBe(181_000);
    const again = (await http().get(`/api/staff/iherb/products/${made.auto}/history`).set(bearer(admin)).expect(200)).body;
    expect(again.snapshots.map((s: { in_stock: boolean }) => s.in_stock)).toEqual([true, false]);
    expect((await http().get('/api/staff/iherb/uploads').set(bearer(admin)).expect(200)).body[0]).toMatchObject({ items_total: 1, prices_changed: 0, staff_name: expect.any(String) });
  });

  it('wrong input: nothing found, dollars, empty', async () => {
    expect((await send('просто текст без товаров').expect(400)).body.code).toBe('WISHLIST_NOTHING');
    const usd = `<html><body><a href="/pr/x/${ids.unknown}">X</a><span>$12.50</span><a href="/pr/y/${ids.off}">Y</a><span>$3.00</span></body></html>`;
    expect((await send(usd).expect(400)).body.code).toBe('WISHLIST_CURRENCY');
    expect((await http().post('/api/staff/iherb/uploads').set(bearer(admin)).field('text', ' ').expect(400)).body.code).toBe('WISHLIST_EMPTY');
  });

  it('the saved page as a file works the same way', async () => {
    const html = `<html><body><div><a href="https://uz.iherb.com/pr/test-product/${ids.off}">Тест</a><span class="price">123 000 сум</span></div></body></html>`;
    const { body } = await http().post('/api/staff/iherb/uploads?dry_run=1').set(bearer(admin)).attach('file', Buffer.from(html), 'wishlist.html').expect(201);
    expect(body).toMatchObject({ format: 'html', summary: { total: 1, matched: 1 } });
  });

  it('only the admin: a manager gets 403 everywhere', async () => {
    await http().get('/api/staff/iherb/products').set(bearer(manager)).expect(403);
    await http().post('/api/staff/iherb/uploads?dry_run=1').set(bearer(manager)).field('text', table([[ids.auto, 100_000]])).expect(403);
    await http().put('/api/staff/iherb/settings').set(bearer(manager)).send({ reminders: true }).expect(403);
  });

  it('reminders: off by default; on — once per slot, not after a fresh upload', async () => {
    const svc = app.get(IherbPricesService);
    expect((await http().get('/api/staff/iherb/settings').set(bearer(admin)).expect(200)).body).toEqual({ reminders: false, shipping_rate_per_kg_uzs: 0, signal_a_pct: 10, signal_a_strong_pct: 15, signal_b_pct: 7 });
    // 15:10 Tashkent of a day far in the future (no upload near it)
    const at = new Date('2031-03-03T10:10:00Z');
    expect(await svc.remindOnce(at)).toBe(false);
    await http().put('/api/staff/iherb/settings').set(bearer(admin)).send({ reminders: true }).expect(200);
    try {
      const before = await prisma.notifications.count({ where: { template: 'staff.iherb_upload_due' } });
      expect(await svc.remindOnce(at)).toBe(true);
      expect(await svc.remindOnce(new Date('2031-03-03T10:40:00Z'))).toBe(false); // the same slot
      expect(await prisma.notifications.count({ where: { template: 'staff.iherb_upload_due' } })).toBeGreaterThan(before);
      // today: the uploads above are fresh — no reminder for the current slot
      const now = new Date();
      const slotNow = (await import('../src/iherb/iherb-prices')).reminderSlot(now);
      if (slotNow) expect(await svc.remindOnce(now)).toBe(false);
    } finally {
      await http().put('/api/staff/iherb/settings').set(bearer(admin)).send({ reminders: false }).expect(200);
    }
  });
});
