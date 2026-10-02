import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  archiveTestProducts,
  bearer,
  createTestApp,
  createTestProduct,
  loginCustomer,
  loginStaff,
  makeInitData,
  seededAddresses,
  stockOf,
} from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('Admin panel operations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const t = {} as Record<keyof typeof STAFF_TG, string>;
  let tg = 980_000_000;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(token)),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(token)).send(body),
    patch: (p: string, body: object = {}) => http().patch(`/api${p}`).set(bearer(token)).send(body),
    put: (p: string, body: object = {}) => http().put(`/api${p}`).set(bearer(token)).send(body),
  });
  const audits = (entityId: string, action?: string) =>
    prisma.audit_logs.findMany({ where: { entity_id: entityId, ...(action && { action }) }, orderBy: { created_at: 'asc' } });

  /** A customer buys `qty` of a fresh product; returns the order and the product. */
  async function placeOrder(qty = 2, stock = 10, price = 50_000) {
    const p = await createTestProduct(prisma, { price, stock });
    const customer = await loginCustomer(app, ++tg);
    const res = await http()
      .post('/api/orders')
      .set(bearer(customer))
      .set('Idempotency-Key', randomUUID())
      .send({
        source: 'buy_now',
        buy_now: { product_id: p.id, qty },
        recipient_name: 'Клиент Тест',
        recipient_phone: '+998901112233',
        ...addr.tashkent,
        address_text: 'ул. Тестовая, 1',
        payment_method: 'bank_transfer',
      })
      .expect(201);
    return { order: res.body, product: p, customer };
  }
  const paidOrder = async (qty = 2, stock = 10) => {
    const r = await placeOrder(qty, stock);
    await as(t.manager).post(`/staff/orders/${r.order.id}/confirm-payment`).expect(200);
    return r;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    for (const [role, id] of Object.entries(STAFF_TG)) t[role as keyof typeof STAFF_TG] = await loginStaff(app, id);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ orders
  describe('order state machine', () => {
    it('Paid -> Picking -> Handed (warehouse) -> In transit -> Delivered (manager), with history and audit', async () => {
      const { order } = await paidOrder();
      const step = (token: string, status: string) => as(token).post(`/staff/orders/${order.id}/status`, { status });

      await step(t.warehouse, 'picking').expect(200);
      await step(t.warehouse, 'handed_to_delivery').expect(200);
      const forbidden = await step(t.warehouse, 'in_transit').expect(403); // delivery steps belong to the manager
      expect(forbidden.body.code).toBe('FORBIDDEN_FOR_ROLE');
      await step(t.manager, 'in_transit').expect(200);
      const { body } = await step(t.manager, 'delivered').expect(200);

      expect(body.status).toBe('delivered');
      expect(body.history.map((h: { to_status: string }) => h.to_status)).toEqual(['new', 'awaiting_payment', 'paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered']);
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).delivered_at).not.toBeNull();
      expect(await audits(order.id, 'order.status_changed')).toHaveLength(4);
    });

    it('refuses to jump over a step, go back, or move an unpaid order', async () => {
      const { order } = await paidOrder();
      expect((await as(t.manager).post(`/staff/orders/${order.id}/status`, { status: 'in_transit' }).expect(409)).body.code).toBe('INVALID_STATUS_TRANSITION');
      await as(t.manager).post(`/staff/orders/${order.id}/status`, { status: 'picking' }).expect(200);
      await as(t.manager).post(`/staff/orders/${order.id}/status`, { status: 'picking' }).expect(409);

      const unpaid = (await placeOrder()).order;
      await as(t.manager).post(`/staff/orders/${unpaid.id}/status`, { status: 'picking' }).expect(409);
    });

    it('GET tells the employee which actions are available to them', async () => {
      const { order } = await paidOrder();
      const m = (await as(t.manager).get(`/staff/orders/${order.id}`).expect(200)).body;
      const w = (await as(t.warehouse).get(`/staff/orders/${order.id}`).expect(200)).body;
      expect(m.actions).toMatchObject({ confirm_payment: false, next_status: 'picking', cancel: true, edit: true, locked: false });
      expect(w.actions).toMatchObject({ next_status: 'picking', cancel: false, edit: false });
      expect(m.customer.name).toMatch(/^User/);
    });
  });

  describe('editing is allowed only before handover', () => {
    it('edits recipient data of a paid order, writing order_edit_log and audit', async () => {
      const { order } = await paidOrder();
      const { body } = await as(t.manager)
        .patch(`/staff/orders/${order.id}`, { reason: 'Клиент попросил', recipient_name: 'Новое Имя', recipient_phone: '90 765 43 21' })
        .expect(200);

      expect(body.recipient).toEqual({ name: 'Новое Имя', phone: '+998907654321' });
      expect(body.edits[0]).toMatchObject({
        reason: 'Клиент попросил',
        staff_name: 'Менеджер (тест)',
        before: { recipient_name: 'Клиент Тест', recipient_phone: '+998901112233' },
        after: { recipient_name: 'Новое Имя', recipient_phone: '+998907654321' },
      });
      const [a] = await audits(order.id, 'order.edited');
      expect(a.before_json).toMatchObject({ recipient_name: 'Клиент Тест' });
      expect(a.after_json).toMatchObject({ recipient_name: 'Новое Имя', reason: 'Клиент попросил' });
    });

    it('a reason is mandatory', async () => {
      const { order } = await paidOrder();
      await as(t.manager).patch(`/staff/orders/${order.id}`, { recipient_name: 'X' }).expect(400);
    });

    it('after handover: edit and cancel are refused (ORDER_LOCKED) and nothing changes', async () => {
      const { order } = await paidOrder();
      for (const s of ['picking', 'handed_to_delivery']) await as(t.manager).post(`/staff/orders/${order.id}/status`, { status: s }).expect(200);

      const edit = await as(t.admin).patch(`/staff/orders/${order.id}`, { reason: 'попытка', recipient_name: 'Взлом' }).expect(409);
      expect(edit.body.code).toBe('ORDER_LOCKED');
      expect((await as(t.manager).post(`/staff/orders/${order.id}/cancel`, { reason: 'поздно' }).expect(409)).body.code).toBe('ORDER_LOCKED');

      const view = (await as(t.manager).get(`/staff/orders/${order.id}`).expect(200)).body;
      expect(view.recipient.name).toBe('Клиент Тест');
      expect(view.actions).toMatchObject({ edit: false, cancel: false, locked: true });
      expect(await prisma.order_edit_log.count({ where: { order_id: order.id } })).toBe(0);
    });

    it('changing the city recalculates delivery while unpaid, and is refused once paid', async () => {
      const { order } = await placeOrder(1, 10, 50_000); // 50 000 + Tashkent 20 000
      const { body } = await as(t.manager).patch(`/staff/orders/${order.id}`, { reason: 'Другой город', ...addr.kattakurgan }).expect(200);
      expect(body.totals).toMatchObject({ delivery_cost_uzs: 45_000, total_uzs: 95_000 });
      expect(body.payment.amount_uzs).toBe(95_000);

      const paid = (await paidOrder()).order;
      expect((await as(t.manager).patch(`/staff/orders/${paid.id}`, { reason: 'x', ...addr.kattakurgan }).expect(409)).body.code).toBe('PAID_ORDER_CITY_LOCKED');
    });
  });

  describe('cancellation by staff returns stock', () => {
    it('unpaid: the reservation is released', async () => {
      const { order, product } = await placeOrder(3, 10);
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 10, reserved: 3 });
      const { body } = await as(t.manager).post(`/staff/orders/${order.id}/cancel`, { reason: 'Клиент не отвечает' }).expect(200);
      expect(body.status).toBe('cancelled');
      expect(body.history.at(-1)).toMatchObject({ to_status: 'cancelled', changed_by_type: 'staff', reason: 'Клиент не отвечает' });
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 10, reserved: 0 });
    });

    it('paid (picking): written-off units come back, a refund task appears; repeating changes nothing', async () => {
      const { order, product } = await paidOrder(4, 10);
      await as(t.warehouse).post(`/staff/orders/${order.id}/status`, { status: 'picking' }).expect(200);
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 6, reserved: 0 });

      const { body } = await as(t.manager).post(`/staff/orders/${order.id}/cancel`, { reason: 'Нет курьера' }).expect(200);
      await as(t.manager).post(`/staff/orders/${order.id}/cancel`, { reason: 'Повтор' }).expect(200);

      expect(body).toMatchObject({ status: 'cancelled', payment_status: 'payment_success' });
      expect(body.tasks).toEqual([expect.objectContaining({ type: 'refund', status: 'open' })]);
      expect(await stockOf(prisma, product.id)).toEqual({ actual: 10, reserved: 0 });
      expect(await prisma.inventory_movements.count({ where: { reference_id: order.id, movement_type: 'return_to_stock' } })).toBe(1);
      expect(await audits(order.id, 'order.cancelled')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ products
  describe('products', () => {
    const sku = `ADM-${Date.now()}`;
    let id: string;

    it('admin creates a product with RU/UZ texts and categories (audited)', async () => {
      const vitamins = await prisma.categories.findUniqueOrThrow({ where: { slug: 'vitamin-d' } });
      const { body } = await as(t.admin)
        .post('/staff/products', {
          sku,
          name_ru: 'Витамин D3 5000 МЕ',
          name_uz: 'Vitamin D3 5000 IU',
          brand: 'E2E',
          manufacturer: 'Test Labs',
          price_uzs: 99_000,
          old_price_uzs: 120_000,
          min_stock: 5,
          composition_ru: 'Холекальциферол',
          warnings_uz: 'Shifokor bilan maslahatlashing',
          category_ids: [vitamins.id],
        })
        .expect(201);
      id = body.id;
      expect(body).toMatchObject({ sku, price_uzs: 99_000, old_price_uzs: 120_000, status: 'active', category_ids: [vitamins.id], name_uz: 'Vitamin D3 5000 IU' });
      expect(await audits(id, 'product.created')).toHaveLength(1);
    });

    it('SKU must be unique; unknown categories are rejected', async () => {
      expect((await as(t.admin).post('/staff/products', { sku, name_ru: 'X', brand: 'E2E', manufacturer: 'X', price_uzs: 1 }).expect(409)).body.code).toBe('SKU_TAKEN');
      await as(t.admin).patch(`/staff/products/${id}`, { category_ids: ['00000000-0000-4000-8000-000000000000'] }).expect(400);
    });

    it('update writes before/after into the audit log', async () => {
      await as(t.admin).patch(`/staff/products/${id}`, { price_uzs: 95_000, name_uz: '' }).expect(200);
      const [a] = await audits(id, 'product.updated');
      expect(a.before_json).toMatchObject({ price_uzs: 99_000, name_uz: 'Vitamin D3 5000 IU' });
      expect(a.after_json).toMatchObject({ price_uzs: 95_000, name_uz: null });
    });

    it('photos: upload (real image check), main photo, removal; files are served', async () => {
      const up = await http().post(`/api/staff/products/${id}/photos`).set(bearer(t.admin)).attach('file', PNG, 'a.png').expect(201);
      expect(up.body.media).toHaveLength(1);
      const first = up.body.media[0];
      expect(first).toMatchObject({ is_main: true });
      expect(first.url).toMatch(/^\/uploads\/products\/.+\.png$/);
      await http().get(first.url).expect(200).expect('content-type', /image\/png/);

      const second = (await http().post(`/api/staff/products/${id}/photos`).set(bearer(t.admin)).attach('file', PNG, 'b.png').expect(201)).body.media;
      const other = second.find((m: { id: string }) => m.id !== first.id);
      expect(other.is_main).toBe(false);

      const main = (await as(t.admin).post(`/staff/products/${id}/photos/${other.id}/main`).expect(200)).body.media;
      expect(main.find((m: { is_main: boolean }) => m.is_main).id).toBe(other.id);

      await http().delete(`/api/staff/products/${id}/photos/${first.id}`).set(bearer(t.admin)).expect(200);
      await http().get(first.url).expect(404);
    });

    it('rejects non-images (even renamed to .png) and files over 5 MB', async () => {
      const fake = await http().post(`/api/staff/products/${id}/photos`).set(bearer(t.admin)).attach('file', Buffer.from('not an image'), 'evil.png').expect(400);
      expect(fake.body.code).toBe('UNSUPPORTED_IMAGE');
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
      await http().post(`/api/staff/products/${id}/photos`).set(bearer(t.admin)).attach('file', big, 'big.png').expect(413);
    });

    it('archiving hides the product from the shop; there is no way to delete it', async () => {
      await as(t.admin).post(`/staff/products/${id}/archive`).expect(200);
      await http().get(`/api/catalog/products/${id}`).expect(404);
      expect(await audits(id, 'product.archived')).toHaveLength(1);
      await http().delete(`/api/staff/products/${id}`).set(bearer(t.admin)).expect(404); // no such endpoint
      await expect(prisma.products.delete({ where: { id } })).rejects.toThrow(/cannot be deleted/); // DB trigger
    });
  });

  // ------------------------------------------------------------------ inventory
  describe('inventory', () => {
    let wh: string;
    beforeAll(async () => (wh = (await prisma.warehouses.findFirstOrThrow()).id));

    it('receipt adds stock, creates a batch, a movement and an audit entry', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      const { body } = await as(t.warehouse).post('/staff/inventory/receipt', { product_id: p.id, warehouse_id: wh, qty: 20, cost_uzs: 500, batch_no: 'B-1', expiry_date: '2028-01-31' }).expect(201);
      expect(body.actual_qty).toBe(25);
      expect(await prisma.inventory_batches.count({ where: { product_id: p.id, batch_no: 'B-1' } })).toBe(1);
      const moves = (await as(t.warehouse).get(`/staff/inventory/movements?product_id=${p.id}`).expect(200)).body.items;
      expect(moves[0]).toMatchObject({ type: 'receipt', qty: 20, staff_name: 'Склад (тест)' });
      expect(await audits(p.id, 'inventory.receipt')).toHaveLength(1);
    });

    it('write-off cannot touch reserved units; a reason is required', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 10, reserved: 7 });
      await as(t.warehouse).post('/staff/inventory/writeoff', { product_id: p.id, warehouse_id: wh, qty: 2 }).expect(400);
      const res = await as(t.warehouse).post('/staff/inventory/writeoff', { product_id: p.id, warehouse_id: wh, qty: 4, reason: 'Бой' }).expect(409);
      expect(res.body).toMatchObject({ code: 'STOCK_RESERVED', available_qty: 3 });
      await as(t.warehouse).post('/staff/inventory/writeoff', { product_id: p.id, warehouse_id: wh, qty: 3, reason: 'Бой' }).expect(201);
      expect(await stockOf(prisma, p.id)).toEqual({ actual: 7, reserved: 7 });
    });

    it('adjustment sets the counted quantity, stores the signed difference, never below reserved', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 10, reserved: 4 });
      await as(t.warehouse).post('/staff/inventory/adjustment', { product_id: p.id, warehouse_id: wh, actual_qty: 3, reason: 'Пересчёт' }).expect(409);
      await as(t.warehouse).post('/staff/inventory/adjustment', { product_id: p.id, warehouse_id: wh, actual_qty: 10, reason: 'Пересчёт' }).expect(400);
      const { body } = await as(t.warehouse).post('/staff/inventory/adjustment', { product_id: p.id, warehouse_id: wh, actual_qty: 8, reason: 'Пересчёт' }).expect(201);
      expect(body).toMatchObject({ actual_qty: 8, delta: -2 });
      expect((await prisma.inventory_movements.findFirstOrThrow({ where: { product_id: p.id, movement_type: 'adjustment' } })).qty).toBe(-2);
    });

    it('return: resellable goes back on sale, damaged is received and written off', async () => {
      const p = await createTestProduct(prisma, { price: 1_000, stock: 5 });
      await as(t.warehouse).post('/staff/inventory/return', { product_id: p.id, warehouse_id: wh, qty: 2, condition: 'resellable', reason: 'Возврат клиента' }).expect(201);
      expect((await stockOf(prisma, p.id)).actual).toBe(7);
      await as(t.warehouse).post('/staff/inventory/return', { product_id: p.id, warehouse_id: wh, qty: 1, condition: 'damaged', reason: 'Разбит' }).expect(201);
      expect((await stockOf(prisma, p.id)).actual).toBe(7);
      const types = (await prisma.inventory_movements.findMany({ where: { product_id: p.id }, orderBy: { created_at: 'asc' } })).map((m) => m.movement_type);
      expect(types).toEqual(['return_to_stock', 'return_to_stock', 'writeoff']);
    });

    it('stock list marks low stock', async () => {
      const { body } = await as(t.manager).get('/staff/inventory?low_only=true&q=VTL-ZINC').expect(200);
      expect(body.items).toEqual([expect.objectContaining({ sku: 'VTL-ZINC-25', available_qty: 0, low: true })]);
    });
  });

  // ------------------------------------------------------------------ customers
  describe('customers', () => {
    it('search, profile, block (sessions die, login refused, audited), unblock', async () => {
      const id = ++tg;
      const token = await loginCustomer(app, id);
      const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(id) } });

      const list = (await as(t.manager).get(`/staff/customers?q=${id}`).expect(200)).body;
      expect(list.items.map((u: { id: string }) => u.id)).toEqual([user.id]);
      expect((await as(t.manager).get(`/staff/customers/${user.id}`).expect(200)).body).toMatchObject({ status: 'active', orders: [], bonus_balance_uzs: 0 });

      await as(t.manager).post(`/staff/customers/${user.id}/block`, {}).expect(400); // reason required
      await as(t.manager).post(`/staff/customers/${user.id}/block`, { reason: 'Мошенничество' }).expect(200);
      await http().get('/api/auth/me').set(bearer(token)).expect(401);
      await http().post('/api/auth/telegram').send({ initData: makeInitData({ id, first_name: 'X' }) }).expect(403);
      expect((await audits(user.id, 'customer.blocked'))[0].after_json).toMatchObject({ status: 'blocked', reason: 'Мошенничество' });

      await as(t.manager).post(`/staff/customers/${user.id}/unblock`, { reason: 'Разобрались' }).expect(200);
      await loginCustomer(app, id);
    });
  });

  // ------------------------------------------------------------------ settings
  describe('settings', () => {
    it('bank transfer details: validated, used by the shop, audited', async () => {
      const before = (await as(t.admin).get('/staff/settings/bank-transfer').expect(200)).body;
      try {
        await as(t.admin).put('/staff/settings/bank-transfer', { ...before, account: '123' }).expect(400);
        await as(t.admin).put('/staff/settings/bank-transfer', { ...before, purpose_template: 'без номера' }).expect(400);
        await as(t.admin).put('/staff/settings/bank-transfer', { ...before, recipient: 'ООО «VITALO» (ТЕСТ 2)' }).expect(200);

        const { order, customer } = await placeOrder(1);
        const shown = (await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(customer)).expect(200)).body;
        expect(shown.requisites.recipient).toBe('ООО «VITALO» (ТЕСТ 2)');
        expect(await prisma.audit_logs.count({ where: { action: 'settings.bank_transfer_updated' } })).toBeGreaterThan(0);
      } finally {
        await as(t.admin).put('/staff/settings/bank-transfer', before).expect(200);
      }
    });

    it('tariffs: one active per region/city; a city tariff changes the shop quote', async () => {
      const chilanzar = await prisma.cities.findFirstOrThrow({ where: { name_ru: 'Чиланзарский район' } });
      const quote = async () =>
        (await http().get(`/api/delivery/quote?region_id=${chilanzar.region_id}&city_id=${chilanzar.id}&goods_total_uzs=1000`).expect(200)).body.cost_uzs;

      expect((await as(t.admin).post('/staff/settings/tariffs', { region_id: chilanzar.region_id, tariff_uzs: 1, free_shipping_threshold_uzs: 1 }).expect(409)).body.code).toBe('TARIFF_EXISTS');
      const list = (await as(t.admin).post('/staff/settings/tariffs', { region_id: chilanzar.region_id, city_id: chilanzar.id, tariff_uzs: 15_000, free_shipping_threshold_uzs: 300_000 }).expect(201)).body;
      expect(await quote()).toBe(15_000);

      const created = list.find((x: { city: { id: string } | null }) => x.city?.id === chilanzar.id);
      await as(t.admin).patch(`/staff/settings/tariffs/${created.id}`, { status: 'disabled' }).expect(200);
      expect(await quote()).toBe(20_000);
    });
  });

  // ------------------------------------------------------------------ employees
  describe('employees and sessions', () => {
    it('add an employee, who can then log in; duplicates refused', async () => {
      await as(t.admin).post('/staff/users', { telegram_user_id: '555000001', name: 'Новый менеджер', role: 'manager' }).expect(201);
      expect((await as(t.admin).post('/staff/users', { telegram_user_id: '555000001', name: 'X', role: 'admin' }).expect(409)).body.code).toBe('STAFF_EXISTS');
      await loginStaff(app, 555_000_001);
    });

    it('changing the role signs the employee out, so the new rights apply at once', async () => {
      await as(t.admin).post('/staff/users', { telegram_user_id: '555000002', name: 'Был менеджер', role: 'manager' }).expect(201);
      const old = await loginStaff(app, 555_000_002);
      const target = await prisma.staff_users.findUniqueOrThrow({ where: { telegram_user_id: 555_000_002n } });

      await as(t.admin).patch(`/staff/users/${target.id}`, { role: 'warehouse' }).expect(200);
      await as(old).get('/staff/orders').expect(401);
      const fresh = await loginStaff(app, 555_000_002);
      await as(fresh).post(`/staff/orders/${target.id}/confirm-payment`).expect(403); // warehouse now
      expect((await audits(target.id, 'staff.updated'))[0].after_json).toMatchObject({ role: 'warehouse' });
    });

    it('revoke sessions and logout', async () => {
      await as(t.admin).post('/staff/users', { telegram_user_id: '555000003', name: 'Сессии', role: 'marketer' }).expect(201);
      const a = await loginStaff(app, 555_000_003);
      const b = await loginStaff(app, 555_000_003);
      const target = await prisma.staff_users.findUniqueOrThrow({ where: { telegram_user_id: 555_000_003n } });
      expect((await as(t.admin).post(`/staff/users/${target.id}/revoke-sessions`).expect(200)).body).toEqual({ revoked: 2 });
      await as(a).get('/staff/auth/me').expect(401);
      await as(b).get('/staff/auth/me').expect(401);

      const c = await loginStaff(app, 555_000_003);
      await http().post('/api/staff/auth/logout').set(bearer(c)).expect(204);
      await as(c).get('/staff/auth/me').expect(401);
    });

    it('an admin cannot block or demote themselves', async () => {
      const me = (await as(t.admin).get('/staff/auth/me').expect(200)).body.staff;
      expect((await as(t.admin).patch(`/staff/users/${me.id}`, { status: 'blocked' }).expect(409)).body.code).toBe('CANNOT_CHANGE_SELF');
      await as(t.admin).patch(`/staff/users/${me.id}`, { role: 'manager' }).expect(409);
    });
  });

  // ------------------------------------------------------------------ audit + dashboard
  describe('audit log and dashboard', () => {
    it('the audit log shows who did what, with before/after, filterable', async () => {
      const { order } = await paidOrder();
      await as(t.manager).patch(`/staff/orders/${order.id}`, { reason: 'Проверка журнала', recipient_name: 'Журнал' }).expect(200);

      const { body } = await as(t.admin).get(`/staff/audit?entity_id=${order.id}`).expect(200);
      expect(body.items.map((i: { action: string }) => i.action)).toEqual(['order.edited', 'order.bank_transfer_confirmed']);
      expect(body.items[0]).toMatchObject({
        staff: { name: 'Менеджер (тест)', role: 'manager' },
        entity_type: 'order',
        before: { recipient_name: 'Клиент Тест' },
        after: { recipient_name: 'Журнал', reason: 'Проверка журнала' },
      });
      const inv = (await as(t.admin).get('/staff/audit?action=inventory.').expect(200)).body.items;
      expect(inv.length).toBeGreaterThan(0);
      expect(inv.every((i: { action: string }) => i.action.startsWith('inventory.'))).toBe(true);
    });

    it('dashboard: revenue, orders, average check, statuses, top products, low stock', async () => {
      const { body } = await as(t.manager).get('/staff/dashboard?days=30').expect(200);
      const paid = await prisma.orders.aggregate({
        where: { status: { in: ['paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'] }, paid_at: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        _sum: { total_uzs: true },
        _count: { _all: true },
      });
      expect(body.revenue_uzs).toBe(Number(paid._sum.total_uzs));
      expect(body.paid_orders).toBe(paid._count._all);
      expect(body.average_check_uzs).toBe(Math.round(Number(paid._sum.total_uzs) / paid._count._all));
      expect(body.orders_created).toBeGreaterThanOrEqual(body.paid_orders);
      expect(body.statuses.delivered).toBeGreaterThanOrEqual(1);
      expect(body.top_products.length).toBeGreaterThan(0);
      expect(body.low_stock.map((p: { sku: string }) => p.sku)).toContain('VTL-ZINC-25');
      await as(t.manager).get('/staff/dashboard?days=5').expect(400);
    });
  });
});
