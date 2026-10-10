import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createTestApp, loginCustomer, loginStaff } from './helpers';

/** Seeded dev staff (prisma/seed.ts), one per role. */
export const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const ROLES = Object.keys(STAFF_TG) as Role[];
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Staff roles: the server enforces permissions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  let orderId = MISSING;
  let productId = MISSING;
  let customerId = MISSING;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of ROLES) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    productId = (await prisma.products.findUniqueOrThrow({ where: { sku: 'VTL-OMEGA3' } })).id;
    const user = await prisma.users.upsert({
      where: { telegram_user_id: 990_000_001n },
      create: { telegram_user_id: 990_000_001n, first_name: 'RoleTest' },
      update: {},
    });
    customerId = user.id;
    const order = await prisma.orders.findFirst();
    if (order) orderId = order.id;
  });
  afterAll(() => app.close());

  /**
   * Every staff endpoint x every role. Mutations are sent with an INVALID body (or a missing id):
   * an allowed role then gets 400/404 — the request passed the permission check but changed nothing —
   * while a forbidden role must get 403 before any validation happens.
   */
  const MATRIX: { label: string; method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: () => string; body?: object; allowed: Role[] }[] = [
    { label: 'see the dashboard', method: 'get', path: () => '/api/staff/dashboard', allowed: ['admin', 'manager', 'marketer'] },
    { label: 'list orders', method: 'get', path: () => '/api/staff/orders', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'open an order', method: 'get', path: () => `/api/staff/orders/${MISSING}`, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'confirm a bank transfer', method: 'post', path: () => `/api/staff/orders/${orderId}/confirm-payment`, body: { comment: 42 }, allowed: ['admin', 'manager'] },
    { label: 'change order status', method: 'post', path: () => `/api/staff/orders/${orderId}/status`, body: {}, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'cancel an order', method: 'post', path: () => `/api/staff/orders/${orderId}/cancel`, body: {}, allowed: ['admin', 'manager'] },
    { label: 'edit an order', method: 'patch', path: () => `/api/staff/orders/${orderId}`, body: {}, allowed: ['admin', 'manager'] },
    { label: 'list products', method: 'get', path: () => '/api/staff/products', allowed: ['admin', 'manager', 'warehouse', 'marketer'] },
    { label: 'create a product', method: 'post', path: () => '/api/staff/products', body: {}, allowed: ['admin'] },
    { label: 'edit a product', method: 'patch', path: () => `/api/staff/products/${productId}`, body: { price_uzs: -1 }, allowed: ['admin'] },
    { label: 'see dictionary values', method: 'get', path: () => '/api/staff/dictionaries/brands', allowed: ['admin', 'manager', 'warehouse', 'marketer'] },
    { label: 'add a dictionary value', method: 'post', path: () => '/api/staff/dictionaries/brands', body: {}, allowed: ['admin'] },
    { label: 'rename a dictionary value', method: 'patch', path: () => `/api/staff/dictionaries/brands/${MISSING}`, body: {}, allowed: ['admin'] },
    { label: 'mark the Yandex price synchronized', method: 'post', path: () => `/api/staff/products/${MISSING}/yandex-price-synced`, allowed: ['admin', 'manager'] },
    { label: 'list purchases', method: 'get', path: () => '/api/staff/purchases', allowed: ['admin', 'manager'] },
    { label: 'open a purchase', method: 'get', path: () => `/api/staff/purchases/${MISSING}`, allowed: ['admin', 'manager'] },
    { label: 'create a purchase', method: 'post', path: () => '/api/staff/purchases', body: {}, allowed: ['admin'] },
    { label: 'edit a purchase', method: 'patch', path: () => `/api/staff/purchases/${MISSING}`, body: {}, allowed: ['admin'] },
    { label: 'cancel Ozon quantities', method: 'post', path: () => '/api/staff/purchases/cancel', body: {}, allowed: ['admin'] },
    { label: 'preview purchase costs', method: 'post', path: () => '/api/staff/purchases/cost-preview', body: {}, allowed: ['admin'] },
    { label: 'see suppliers', method: 'get', path: () => '/api/staff/dictionaries/suppliers', allowed: ['admin', 'manager'] },
    { label: 'archive a product', method: 'post', path: () => `/api/staff/products/${MISSING}/archive`, allowed: ['admin'] },
    { label: 'upload a product photo', method: 'post', path: () => `/api/staff/products/${productId}/photos`, allowed: ['admin'] },
    { label: 'see stock', method: 'get', path: () => '/api/staff/inventory', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'see stock movements', method: 'get', path: () => '/api/staff/inventory/movements', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'receive stock', method: 'post', path: () => '/api/staff/inventory/receipt', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'write off stock', method: 'post', path: () => '/api/staff/inventory/writeoff', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'adjust stock', method: 'post', path: () => '/api/staff/inventory/adjustment', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'return to stock', method: 'post', path: () => '/api/staff/inventory/return', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'see receiving sources', method: 'get', path: () => '/api/staff/receiving/sources', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'start a receiving', method: 'post', path: () => '/api/staff/receiving/sessions', body: {}, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'open a receiving', method: 'get', path: () => `/api/staff/receiving/sessions/${MISSING}`, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'accept units', method: 'post', path: () => `/api/staff/receiving/sessions/${MISSING}/accept`, body: {}, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'list units', method: 'get', path: () => '/api/staff/units', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'open a unit', method: 'get', path: () => `/api/staff/units/${MISSING}`, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'reconcile units', method: 'get', path: () => '/api/staff/units/reconcile', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'print labels', method: 'post', path: () => '/api/staff/units/labels', body: {}, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'pick a unit for a Mini App order', method: 'post', path: () => '/api/staff/orders/' + MISSING + '/units/pick', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'reserve units for a Mini App order', method: 'post', path: () => '/api/staff/orders/' + MISSING + '/units/reserve', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'return a Mini App order after the handover', method: 'post', path: () => '/api/staff/orders/' + MISSING + '/return', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'list Yandex orders', method: 'get', path: () => '/api/staff/yandex-orders', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'create a Yandex order', method: 'post', path: () => '/api/staff/yandex-orders', body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'open a Yandex order', method: 'get', path: () => `/api/staff/yandex-orders/${MISSING}`, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'see Yandex prices for a new order', method: 'get', path: () => `/api/staff/yandex-orders/price-hints?product_ids=${MISSING}`, allowed: ['admin', 'warehouse'] },
    { label: 'pick a unit for a Yandex order', method: 'post', path: () => `/api/staff/yandex-orders/${MISSING}/pick`, body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'cancel a Yandex order', method: 'post', path: () => `/api/staff/yandex-orders/${MISSING}/cancel`, body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'reserve units for a Yandex order', method: 'post', path: () => `/api/staff/yandex-orders/${MISSING}/reserve`, body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'see alternative SKUs', method: 'get', path: () => `/api/staff/products/${MISSING}/aliases`, allowed: ['admin', 'manager', 'warehouse', 'marketer'] },
    { label: 'add an alternative SKU', method: 'post', path: () => `/api/staff/products/${MISSING}/aliases`, body: {}, allowed: ['admin'] },
    { label: 'remove an alternative SKU', method: 'delete', path: () => `/api/staff/products/${MISSING}/aliases/${MISSING}`, allowed: ['admin'] },
    { label: 'see the Yandex sync', method: 'get', path: () => '/api/staff/yandex-sync', allowed: ['admin'] },
    { label: 'run the Yandex sync now', method: 'post', path: () => '/api/staff/yandex-sync/run', body: {}, allowed: ['admin'] },
    { label: 'close Yandex attention entries in a batch', method: 'post', path: () => '/api/staff/yandex-sync/attention/close-batch', body: {}, allowed: ['admin'] },
    { label: 'close a Yandex attention entry', method: 'post', path: () => `/api/staff/yandex-sync/attention/${MISSING}/close`, body: {}, allowed: ['admin'] },
    { label: 'see a raw Yandex order', method: 'get', path: () => `/api/staff/yandex-sync/external/${MISSING}`, allowed: ['admin'] },
    { label: 'see returned units', method: 'get', path: () => '/api/staff/units/returns/pending', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'mark a unit missing', method: 'post', path: () => `/api/staff/units/${MISSING}/missing`, body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'decide on a returned unit', method: 'post', path: () => `/api/staff/units/${MISSING}/return-decision`, body: {}, allowed: ['admin', 'warehouse'] },
    { label: 'write off a unit', method: 'post', path: () => `/api/staff/units/${MISSING}/write-off`, body: {}, allowed: ['admin'] },
    { label: 'correct a unit', method: 'post', path: () => `/api/staff/units/${MISSING}/correct`, body: {}, allowed: ['admin'] },
    { label: 'get a print ticket', method: 'post', path: () => '/api/staff/units/labels/ticket', body: {}, allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'see the label size', method: 'get', path: () => '/api/staff/units/labels/size', allowed: ['admin', 'manager', 'warehouse'] },
    { label: 'see the label size setting', method: 'get', path: () => '/api/staff/settings/label-size', allowed: ['admin'] },
    { label: 'change the label size', method: 'put', path: () => '/api/staff/settings/label-size', body: {}, allowed: ['admin'] },
    { label: 'edit the label composition', method: 'patch', path: () => `/api/staff/products/${MISSING}/label`, body: { label_composition_ru: 5 }, allowed: ['admin', 'manager'] },
    { label: 'list customers', method: 'get', path: () => '/api/staff/customers', allowed: ['admin', 'manager'] },
    { label: 'block a customer', method: 'post', path: () => `/api/staff/customers/${customerId}/block`, body: {}, allowed: ['admin', 'manager'] },
    { label: 'see bank transfer settings', method: 'get', path: () => '/api/staff/settings/bank-transfer', allowed: ['admin'] },
    { label: 'change bank transfer settings', method: 'put', path: () => '/api/staff/settings/bank-transfer', body: {}, allowed: ['admin'] },
    { label: 'see card transfer settings', method: 'get', path: () => '/api/staff/settings/card-transfer', allowed: ['admin'] },
    { label: 'change card transfer settings', method: 'put', path: () => '/api/staff/settings/card-transfer', body: {}, allowed: ['admin'] },
    { label: 'see reservation times', method: 'get', path: () => '/api/staff/settings/payment-methods', allowed: ['admin'] },
    { label: 'change a reservation time', method: 'put', path: () => '/api/staff/settings/payment-methods/card_transfer', body: {}, allowed: ['admin'] },
    { label: 'see shop texts', method: 'get', path: () => '/api/staff/settings/texts', allowed: ['admin'] },
    { label: 'change shop texts', method: 'put', path: () => '/api/staff/settings/texts', body: {}, allowed: ['admin'] },
    { label: 'see delivery tariffs', method: 'get', path: () => '/api/staff/settings/tariffs', allowed: ['admin'] },
    { label: 'create a delivery tariff', method: 'post', path: () => '/api/staff/settings/tariffs', body: {}, allowed: ['admin'] },
    { label: 'list employees', method: 'get', path: () => '/api/staff/users', allowed: ['admin'] },
    { label: 'add an employee', method: 'post', path: () => '/api/staff/users', body: {}, allowed: ['admin'] },
    { label: "revoke an employee's sessions", method: 'post', path: () => `/api/staff/users/${MISSING}/revoke-sessions`, allowed: ['admin'] },
    { label: 'read the audit log', method: 'get', path: () => '/api/staff/audit', allowed: ['admin'] },
  ];

  const cases = MATRIX.flatMap((e) => ROLES.map((role) => ({ ...e, role, ok: e.allowed.includes(role) })));

  it.each(cases)('$role $ok: $label', async ({ method, path, body, role, ok }) => {
    let req = request(app.getHttpServer())[method](path()).set(bearer(tokens[role]));
    if (body) req = req.send(body);
    const res = await req;
    if (ok) {
      expect([401, 403]).not.toContain(res.status);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_FOR_ROLE');
    }
  });

  describe('the cases from the task, spelled out', () => {
    const call = (role: Role, method: 'get' | 'post' | 'patch', path: string, body: object = {}) =>
      request(app.getHttpServer())[method](path).set(bearer(tokens[role])).send(body);

    it('warehouse cannot see settings or touch payments', async () => {
      await call('warehouse', 'get', '/api/staff/settings/bank-transfer').expect(403);
      await call('warehouse', 'get', '/api/staff/settings/tariffs').expect(403);
      await call('warehouse', 'post', `/api/staff/orders/${orderId}/confirm-payment`).expect(403);
    });

    it('marketer cannot change orders in any way', async () => {
      for (const [m, p] of [['post', 'status'], ['post', 'cancel'], ['post', 'confirm-payment'], ['patch', '']] as const) {
        await call('marketer', m, `/api/staff/orders/${orderId}${p ? `/${p}` : ''}`, { status: 'picking', reason: 'x' }).expect(403);
      }
      await call('marketer', 'get', '/api/staff/orders').expect(403);
    });

    it('manager cannot change stock or employees', async () => {
      const wh = await prisma.warehouses.findFirstOrThrow();
      await call('manager', 'post', '/api/staff/inventory/receipt', { product_id: productId, warehouse_id: wh.id, qty: 5 }).expect(403);
      await call('manager', 'post', '/api/staff/users', { telegram_user_id: '777000001', name: 'X', role: 'admin' }).expect(403);
      await call('manager', 'patch', `/api/staff/products/${productId}`, { price_uzs: 1 }).expect(403);
      expect((await prisma.products.findUniqueOrThrow({ where: { id: productId } })).price_uzs).not.toBe(1n);
    });
  });

  it('tests never reach the real Yandex: no token from .env, no live mode, the run makes no request and stores nothing', async () => {
    // whatever apps/api/.env says, the test environment wins (test-env.ts)
    expect(process.env.YANDEX_API_KEY).toBe('');
    expect(process.env.YANDEX_SYNC_DRY_RUN).toBe('true');
    const before = [await prisma.marketplace_external_orders.count(), await prisma.marketplace_orders.count({ where: { source: 'yandex_api' } })];
    const run = (await request(app.getHttpServer()).post('/api/staff/yandex-sync/run').set(bearer(tokens.admin)).expect(200)).body;
    expect(run).toMatchObject({ mode: 'DRY_RUN', found: 0, created: 0 });
    expect(run.error).toContain('YANDEX_API_KEY');
    expect([await prisma.marketplace_external_orders.count(), await prisma.marketplace_orders.count({ where: { source: 'yandex_api' } })]).toEqual(before);
  });

  it('GET /staff/auth/me lists exactly the permissions of the role', async () => {
    const me = async (r: Role) => (await request(app.getHttpServer()).get('/api/staff/auth/me').set(bearer(tokens[r])).expect(200)).body;
    expect((await me('marketer')).permissions).toEqual(['dashboard.view', 'products.view', 'yandex.price.view']);
    expect((await me('warehouse')).permissions).toEqual(['orders.view', 'orders.fulfil', 'products.view', 'inventory.view', 'inventory.edit', 'receiving.perform', 'units.view', 'orders.units', 'yandex.orders.view', 'yandex.orders', 'units.missing', 'units.return_decision']);
    expect((await me('admin')).permissions).toEqual(expect.arrayContaining(['audit.view', 'costs.view', 'dashboard.revenue']));
    expect((await me('manager')).permissions).toContain('dashboard.revenue');
    expect((await me('manager')).permissions).not.toContain('costs.view');
    expect((await me('manager')).permissions).toContain('yandex.orders.view');
    expect((await me('manager')).permissions).not.toContain('yandex.orders');
    expect((await me('manager')).staff).toMatchObject({ role: 'manager', name: 'Менеджер (тест)' });
  });

  it('customers and anonymous requests get 401 on staff endpoints', async () => {
    const customer = await loginCustomer(app, 990_000_002);
    await request(app.getHttpServer()).get('/api/staff/orders').set(bearer(customer)).expect(401);
    await request(app.getHttpServer()).get('/api/staff/dashboard').expect(401);
  });

  it('a customer who is not staff cannot log into the admin panel', async () => {
    await loginCustomer(app, 990_000_003);
    const { makeInitData } = await import('./helpers');
    await request(app.getHttpServer())
      .post('/api/staff/auth/telegram')
      .send({ initData: makeInitData({ id: 990_000_003, first_name: 'Nope' }) })
      .expect(403);
  });
});
