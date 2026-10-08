import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { StockService } from '../src/inventory/stock.service';
import type { FetchLike } from '../src/marketplace/yandex/yandex-client';
import { YANDEX_CLIENT_OPTIONS, YandexSyncService } from '../src/marketplace/yandex/yandex-sync';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUnits, moveUnits } from '../src/receiving/units';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

/**
 * Stage 2D with a fake Yandex: every answer comes from fixtures below. No request ever leaves the test.
 */
const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
const CAMPAIGN = 149165806;
/** Looks like a real API key; must never show up in runs, errors, notifications or answers. */
const KEY = `ACMA:e2eSecretKey${RUN}abcdef:87654321`;
const WEBHOOK_SECRET = `whsec-${RUN}-0123456789abcdef`;
const ENV_KEYS = ['YANDEX_API_KEY', 'YANDEX_SYNC_DRY_RUN', 'YANDEX_WEBHOOK_ENABLED', 'YANDEX_WEBHOOK_SECRET', 'YANDEX_CAMPAIGN_IDS', 'YANDEX_BUSINESS_ID'];

// ---------------------------------------------------------------- fake Yandex

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
const yandex = {
  orders: new Map<number, Record<string, unknown>>(),
  /** answers given before the normal one (errors, limits) */
  queue: [] as Reply[],
  calls: [] as { url: string; headers: Record<string, string>; body: { orderIds?: number[]; campaignIds?: number[] } }[],
};
const fakeFetch: FetchLike = async (url, init) => {
  const body = JSON.parse(init.body ?? '{}');
  yandex.calls.push({ url, headers: init.headers, body });
  const reply: Reply = yandex.queue.shift() ?? {
    status: 200,
    body: { orders: [...yandex.orders.values()].filter((o) => !body.orderIds || body.orderIds.includes(o.orderId as number)), paging: {} },
  };
  const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { status: reply.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(reply.body ?? null) };
};

let nextId = 70_000_000 + (Date.now() % 1_000_000);
/** A getBusinessOrders order; prices are totals for all units (payment + cashback + subsidy). */
function yOrder(items: { sku: string; count: number; unit?: number; currency?: string }[], patch: Record<string, unknown> = {}) {
  const orderId = ++nextId;
  const o = {
    orderId,
    campaignId: CAMPAIGN,
    programType: 'FBS',
    status: 'PROCESSING',
    substatus: 'STARTED',
    creationDate: '2026-10-10T09:15:00+05:00',
    updateDate: new Date().toISOString(),
    fake: false,
    paymentType: 'PREPAID',
    paymentMethod: 'YANDEX',
    delivery: {},
    items: items.map((i, k) => {
      const total = (i.unit ?? 150_000) * i.count;
      const cur = i.currency ?? 'UZS';
      return { id: k + 1, offerId: i.sku, offerName: 'Товар', count: i.count, prices: { payment: { value: total - 20_000, currencyId: cur }, subsidy: { value: 20_000, currencyId: cur } } };
    }),
    ...patch,
  };
  yandex.orders.set(orderId, o);
  return o;
}
const setStatus = (o: { orderId: number }, status: string, substatus: string | null = null) =>
  yandex.orders.set(o.orderId, { ...yandex.orders.get(o.orderId)!, status, substatus, updateDate: new Date().toISOString() });

describe('Stage 2D: Yandex orders arrive by themselves (e2e, fake Yandex)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let sync: YandexSyncService;
  let warehouseId: string;
  let supplierId: string;
  const saved: Record<string, string | undefined> = {};
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
  });
  const runSync = async () => (await as('admin').post('/staff/yandex-sync/run').expect(200)).body;
  const ourOrder = (o: { orderId: number }) => prisma.marketplace_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(o.orderId) } }, include: { units: { where: { released_at: null } } } });
  const external = (o: { orderId: number }) => prisma.marketplace_external_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(o.orderId) } } });
  const notes = (o: { orderId: number }, template: string) => prisma.notifications.count({ where: { template, payload: { path: ['order_number'], equals: String(o.orderId) } } });
  const shelf = async (productId: string) => {
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { product_id_warehouse_id: { product_id: productId, warehouse_id: warehouseId } } });
    return { actual: inv.actual_qty, reserved: inv.reserved_qty };
  };
  let activeAdmins = 0;
  let activeAdminsAndWarehouse = 0;

  async function stocked(expiries: string[], opts: { tracked?: boolean; commission?: number } = {}) {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Яндекс 2D ${RUN}` });
    await prisma.products.update({ where: { id: p.id }, data: { unit_tracking: opts.tracked ?? true, yandex_commission_percent: opts.commission ?? null } });
    await addUnits(p.id, expiries);
    return p;
  }
  async function addUnits(productId: string, expiries: string[]) {
    if (!expiries.length) return;
    const session = await prisma.receiving_sessions.findFirstOrThrow({ where: { supplier_id: supplierId, status: 'OPEN' } });
    await prisma.$transaction(async (tx) => {
      const created = await createUnits(tx, session.id, expiries.map((expiry) => ({ product_id: productId, purchase_id: null, purchase_line_id: null, cost: 40_000n, expiry })), null);
      await moveUnits(tx, { id: { in: created.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
      await stock.receiveUnits(tx, { warehouseId, productId, qty: created.length, referenceType: 'receiving_session', referenceId: session.id, reason: 'e2e', staffId: null });
    });
  }

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { YANDEX_API_KEY: KEY, YANDEX_SYNC_DRY_RUN: 'false', YANDEX_CAMPAIGN_IDS: String(CAMPAIGN), YANDEX_BUSINESS_ID: '216755072', YANDEX_WEBHOOK_ENABLED: 'false', YANDEX_WEBHOOK_SECRET: WEBHOOK_SECRET });
    app = await createTestApp((b) => b.overrideProvider(YANDEX_CLIENT_OPTIONS).useValue({ fetch: fakeFetch, retryDelaysMs: [0, 0, 0] }));
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    sync = app.get(YandexSyncService);
    warehouseId = await stock.mainWarehouseId();
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    supplierId = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик 2D ${RUN}` }).expect(201)).body.id;
    await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200);
    activeAdmins = await prisma.staff_users.count({ where: { status: 'active', role: 'admin' } });
    activeAdminsAndWarehouse = await prisma.staff_users.count({ where: { status: 'active', role: { in: ['admin', 'warehouse'] } } });
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    await archiveTestProducts(prisma);
    await app.close();
  });
  beforeEach(() => {
    yandex.orders.clear();
    yandex.queue = [];
    yandex.calls = [];
    process.env.YANDEX_SYNC_DRY_RUN = 'false';
  });

  it('rights: the sync screen and «Проверить сейчас» only for the admin', async () => {
    for (const r of ['manager', 'warehouse', 'marketer'] as Role[]) {
      expect((await as(r).get('/staff/yandex-sync').expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
      await as(r).post('/staff/yandex-sync/run').expect(403);
    }
    const s = (await as('admin').get('/staff/yandex-sync').expect(200)).body;
    expect(s.config).toMatchObject({ tokenSet: true, businessId: 216755072, campaignIds: [CAMPAIGN], dryRun: false });
    expect(JSON.stringify(s)).not.toContain('e2eSecretKey');
  });

  it('DRY_RUN: only the run log «что было бы сделано»; no order, no snapshot, no message', async () => {
    process.env.YANDEX_SYNC_DRY_RUN = 'true';
    const p = await stocked(['2028-01-01']);
    const o = yOrder([{ sku: p.sku, count: 1 }]);
    const run = await runSync();
    expect(run).toMatchObject({ mode: 'DRY_RUN', found: 1, created: 1, errors: 0, error: null });
    const full = (await as('admin').get(`/staff/yandex-sync/runs/${run.id}`).expect(200)).body;
    expect(full.details.items[0]).toMatchObject({ number: String(o.orderId), action: 'would_create' });
    expect(full.details.raw[0].orderId).toBe(o.orderId); // the raw answer of Yandex is kept in the log
    expect(await ourOrder(o)).toBeNull();
    expect(await external(o)).toBeNull();
    expect(await notes(o, 'staff.yandex_new_order')).toBe(0);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });
  });

  it('new order: created «Новый», units by FEFO, price per unit from the totals, commission from the card; message to warehouse and admin; a repeat changes nothing', async () => {
    const p = await stocked(['2029-01-01', '2027-06-01', '2028-01-01'], { commission: 15 });
    const o = yOrder([{ sku: p.sku, count: 2, unit: 175_000 }]);
    const run = await runSync();
    expect(run).toMatchObject({ mode: 'LIVE', found: 1, created: 1, errors: 0 });
    const ours = await ourOrder(o);
    expect(ours).toMatchObject({ status: 'NEW', source: 'yandex_api', stock_shortage: false, yandex_status: 'PROCESSING', yandex_substatus: 'STARTED', created_by: null });
    expect(Number(ours!.commission_percent)).toBe(15);
    expect(ours!.units).toHaveLength(2);
    const line = await prisma.marketplace_order_lines.findFirstOrThrow({ where: { order_id: ours!.id } });
    expect(Number(line.unit_price_uzs)).toBe(175_000); // (payment + subsidy) / count
    const card = (await as('warehouse').get(`/staff/yandex-orders/${ours!.id}`).expect(200)).body;
    expect(card.lines[0].units.map((u: { expiry_date: string }) => u.expiry_date)).toEqual(['2027-06-01', '2028-01-01']);
    expect(card.yandex).toMatchObject({ status: 'PROCESSING', substatus: 'STARTED', campaign_id: CAMPAIGN });
    expect(await shelf(p.id)).toEqual({ actual: 3, reserved: 2 });
    expect(await notes(o, 'staff.yandex_new_order')).toBe(activeAdminsAndWarehouse);
    const msg = await prisma.notifications.findFirstOrThrow({ where: { template: 'staff.yandex_new_order', payload: { path: ['order_number'], equals: String(o.orderId) } }, include: { staff: true } });
    expect(['admin', 'warehouse']).toContain(msg.staff!.role);
    expect(msg.payload).toMatchObject({ items: `${p.sku} × 2`, admin_path: `/yandex-orders/${ours!.id}` });

    // the same order again (poll and a notification): no second order, no second message
    expect(await runSync()).toMatchObject({ created: 0, errors: 0 });
    await sync.run({ trigger: 'webhook', orderIds: [o.orderId] });
    expect(await prisma.marketplace_orders.count({ where: { external_number: String(o.orderId) } })).toBe(1);
    expect(await notes(o, 'staff.yandex_new_order')).toBe(activeAdminsAndWarehouse);
    expect(await shelf(p.id)).toEqual({ actual: 3, reserved: 2 });
  });

  it('commission 18.5 % when the card has none; not confirmed yet → wait; other campaign → ignored', async () => {
    const p = await stocked(['2028-01-01', '2028-02-01']);
    const wait = yOrder([{ sku: p.sku, count: 1 }], { status: 'UNPAID', substatus: null });
    const foreign = yOrder([{ sku: p.sku, count: 1 }], { campaignId: 999 });
    const run = await runSync();
    expect(run.created).toBe(0);
    expect(await ourOrder(wait)).toBeNull();
    expect(await external(foreign)).toBeNull();
    setStatus(wait, 'PROCESSING', 'STARTED');
    await runSync();
    expect(Number((await ourOrder(wait))!.commission_percent)).toBe(18.5);
  });

  it('unknown SKU / product without units / not UZS: no order, «Требует внимания» with the raw answer, one message to the admin; «Закрыть как неактуальный» for good', async () => {
    const untracked = await stocked([], { tracked: false });
    const tracked = await stocked(['2028-01-01']);
    const unknown = yOrder([{ sku: `NO-SUCH-${RUN}`, count: 1 }]);
    const noUnits = yOrder([{ sku: untracked.sku, count: 1 }]);
    const rub = yOrder([{ sku: tracked.sku, count: 1, currency: 'RUR' }]);
    expect(await runSync()).toMatchObject({ created: 0, attention: 3, errors: 0 });
    expect(await ourOrder(unknown)).toBeNull();
    expect(await external(unknown)).toMatchObject({ attention_kind: 'UNKNOWN_SKU', order_id: null });
    expect(await external(noUnits)).toMatchObject({ attention_kind: 'NOT_UNIT_TRACKED' });
    expect(await external(rub)).toMatchObject({ attention_kind: 'CURRENCY' });
    expect(await shelf(tracked.id)).toEqual({ actual: 1, reserved: 0 });
    expect(await notes(unknown, 'staff.yandex_attention')).toBe(activeAdmins);

    const screen = (await as('admin').get('/staff/yandex-sync').expect(200)).body;
    const row = screen.attention.find((a: { external_number: string }) => a.external_number === String(unknown.orderId));
    expect(row).toMatchObject({ attention_kind: 'UNKNOWN_SKU', kind_ru: 'Неизвестный SKU' });
    expect((await as('admin').get(`/staff/yandex-sync/external/${row.id}`).expect(200)).body.raw.orderId).toBe(unknown.orderId);

    // repeated polls: no new message
    await runSync();
    expect(await notes(unknown, 'staff.yandex_attention')).toBe(activeAdmins);

    // close: admin only, reason required, audit; never raised again
    await as('warehouse').post(`/staff/yandex-sync/attention/${row.id}/close`, { reason: 'Тестовый заказ' }).expect(403);
    await as('admin').post(`/staff/yandex-sync/attention/${row.id}/close`, { reason: 'x' }).expect(400);
    await as('admin').post(`/staff/yandex-sync/attention/${row.id}/close`, { reason: 'Старый заказ, уже обработан вручную' }).expect(200);
    expect(await prisma.audit_logs.count({ where: { action: 'yandex_sync.closed', entity_id: row.id } })).toBe(1);
    setStatus(unknown, 'DELIVERY', 'SHIPPED');
    await runSync();
    const after = (await as('admin').get('/staff/yandex-sync').expect(200)).body;
    expect(after.attention.some((a: { id: string }) => a.id === row.id)).toBe(false);
    expect(await notes(unknown, 'staff.yandex_attention')).toBe(activeAdmins);
    expect(await external(unknown)).toMatchObject({ closed_at: expect.any(Date), close_reason: 'Старый заказ, уже обработан вручную', status: 'DELIVERY' });
  });

  it('not enough stock: the order is created without units («Не хватает остатка»), attention for the admin; «Зарезервировать банки» later', async () => {
    const p = await stocked(['2028-01-01']);
    const o = yOrder([{ sku: p.sku, count: 2 }]);
    expect(await runSync()).toMatchObject({ created: 1, attention: 1, errors: 0 });
    const ours = (await ourOrder(o))!;
    expect(ours).toMatchObject({ status: 'NEW', stock_shortage: true });
    expect(ours.units).toHaveLength(0);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 }); // nothing reserved automatically
    expect(await external(o)).toMatchObject({ attention_kind: 'NOT_ENOUGH_STOCK', order_id: ours.id });
    expect(await notes(o, 'staff.yandex_attention')).toBe(activeAdmins);
    const msg = await prisma.notifications.findFirstOrThrow({ where: { template: 'staff.yandex_new_order', payload: { path: ['order_number'], equals: String(o.orderId) } } });
    expect(msg.payload).toMatchObject({ shortage: true });

    expect((await as('warehouse').post(`/staff/yandex-orders/${ours.id}/pick`, { physical_id: '1' }).expect(409)).body.code).toBe('RESERVE_FIRST');
    expect((await as('warehouse').post(`/staff/yandex-orders/${ours.id}/reserve`).expect(409)).body.code).toBe('INSUFFICIENT_STOCK');
    await addUnits(p.id, ['2027-01-01']);
    const r = (await as('warehouse').post(`/staff/yandex-orders/${ours.id}/reserve`).expect(200)).body;
    expect(r.stock_shortage).toBe(false);
    expect(r.lines[0].units).toHaveLength(2);
    expect(await shelf(p.id)).toEqual({ actual: 2, reserved: 2 });
    expect(await external(o)).toMatchObject({ attention_kind: null });
    await as('manager').post(`/staff/yandex-orders/${ours.id}/reserve`).expect(403);
  });

  it('Yandex cancelled before the handover → our cancellation, units back; after the handover → return for a check', async () => {
    const p = await stocked(['2028-01-01', '2028-02-01']);
    const before = yOrder([{ sku: p.sku, count: 1 }]);
    const after = yOrder([{ sku: p.sku, count: 1 }]);
    await runSync();
    const a = (await ourOrder(after))!;
    const unit = await prisma.physical_units.findUniqueOrThrow({ where: { id: a.units[0].physical_unit_id } });
    await as('warehouse').post(`/staff/yandex-orders/${a.id}/pick`, { physical_id: unit.physical_id }).expect(200);
    await as('warehouse').post(`/staff/yandex-orders/${a.id}/assemble`).expect(200);
    await as('warehouse').post(`/staff/yandex-orders/${a.id}/hand-over`).expect(200);

    setStatus(before, 'CANCELLED', 'USER_CHANGED_MIND');
    setStatus(after, 'CANCELLED', 'USER_REFUSED_DELIVERY');
    expect(await runSync()).toMatchObject({ updated: 2, errors: 0 });
    const b = (await prisma.marketplace_orders.findUniqueOrThrow({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(before.orderId) } } }));
    expect(b).toMatchObject({ status: 'CANCELLED', yandex_status: 'CANCELLED', cancel_reason: 'Отменён в Яндексе (USER_CHANGED_MIND)' });
    expect((await prisma.marketplace_orders.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RETURNED');
    expect((await prisma.physical_units.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe('RETURNED');
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });
    const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: b.id, action: 'yandex_order.status' }, orderBy: { created_at: 'desc' } });
    expect(audit.staff_user_id).toBeNull(); // the system did it
    // repeat: nothing more
    expect(await runSync()).toMatchObject({ updated: 0, errors: 0 });
  });

  it('other Yandex statuses are only shown; a Yandex return → attention, our status unchanged', async () => {
    const p = await stocked(['2028-01-01']);
    const o = yOrder([{ sku: p.sku, count: 1 }]);
    await runSync();
    setStatus(o, 'PROCESSING', 'READY_TO_SHIP');
    await runSync();
    const ours = (await ourOrder(o))!;
    expect(ours).toMatchObject({ status: 'NEW', yandex_substatus: 'READY_TO_SHIP' });
    setStatus(o, 'RETURNED', null);
    expect(await runSync()).toMatchObject({ attention: 1 });
    expect((await ourOrder(o))!.status).toBe('NEW');
    expect(await external(o)).toMatchObject({ attention_kind: 'RETURN' });
  });

  it('first seen already shipped / cancelled: no order, attention, ONE summary message per run', async () => {
    const p = await stocked(['2028-01-01']);
    const late = [yOrder([{ sku: p.sku, count: 1 }], { status: 'DELIVERED', substatus: null }), yOrder([{ sku: p.sku, count: 1 }], { status: 'CANCELLED', substatus: 'USER_CHANGED_MIND' })];
    const before = await prisma.notifications.count({ where: { template: 'staff.yandex_late_summary' } });
    expect(await runSync()).toMatchObject({ created: 0, attention: 2 });
    for (const o of late) expect(await external(o)).toMatchObject({ attention_kind: 'FIRST_SEEN_LATE', order_id: null });
    expect(await prisma.notifications.count({ where: { template: 'staff.yandex_late_summary' } })).toBe(before + activeAdmins);
    await runSync(); // seen again: no new summary
    expect(await prisma.notifications.count({ where: { template: 'staff.yandex_late_summary' } })).toBe(before + activeAdmins);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });
  });

  it('one bad order never breaks the batch: broken data → attention, an order without number → counted as error, the good one is created', async () => {
    const p = await stocked(['2028-01-01']);
    const good = yOrder([{ sku: p.sku, count: 1 }]);
    const broken = yOrder([{ sku: p.sku, count: 1 }], { items: [] });
    yandex.orders.set(-1, { campaignId: CAMPAIGN, status: 'PROCESSING', items: [] }); // no orderId at all
    const run = await runSync();
    expect(run).toMatchObject({ found: 3, created: 1, errors: 1 });
    expect(await ourOrder(good)).not.toBeNull();
    expect(await external(broken)).toMatchObject({ attention_kind: 'BAD_DATA', order_id: null });
  });

  it('limits and failures: retried; a spent limit or a broken answer ends the run with a clear error, nothing created', async () => {
    const p = await stocked(['2028-01-01']);
    const o = yOrder([{ sku: p.sku, count: 1 }]);
    yandex.queue = [{ status: 420, headers: { 'X-RateLimit-Resource-Remaining': '3' } }, { status: 503 }];
    expect(await runSync()).toMatchObject({ error: null, created: 1 });
    expect(yandex.calls).toHaveLength(3);

    yandex.queue = [{ status: 420, body: { status: 'ERROR', errors: [{ code: 'LIMIT' }] }, headers: { 'X-RateLimit-Resource-Remaining': '0' } }];
    const limited = await runSync();
    expect(limited.error).toContain('лимит');
    yandex.queue = [{ status: 200, body: { nothing: true } }];
    expect((await runSync()).error).toContain('без списка orders');
    expect(await prisma.marketplace_orders.count({ where: { external_number: String(o.orderId) } })).toBe(1);
  });

  it('the token never leaks: not in runs, details, system errors or answers — even when Yandex echoes it', async () => {
    yandex.queue = [{ status: 401, body: { status: 'ERROR', errors: [{ code: 'UNAUTHORIZED', message: `token ${KEY} is invalid` }] } }];
    const run = await runSync();
    expect(run.error).toContain('не принял токен');
    expect(yandex.calls[0].headers['Api-Key']).toBe(KEY); // it was sent to Yandex, and only there
    const everything = JSON.stringify([
      await prisma.yandex_sync_runs.findMany(),
      await prisma.system_errors.findMany({ where: { service: 'yandex-sync' } }),
      await prisma.marketplace_external_orders.findMany(),
      await prisma.notifications.findMany({ where: { template: { startsWith: 'staff.yandex' } } }),
      (await as('admin').get('/staff/yandex-sync').expect(200)).body,
    ], (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    expect(everything).not.toContain('e2eSecretKey');
    expect(everything).not.toContain(WEBHOOK_SECRET);
  });

  it('no token: the run says so and makes no request', async () => {
    process.env.YANDEX_API_KEY = '';
    try {
      const run = await runSync();
      expect(run.error).toContain('YANDEX_API_KEY');
      expect(yandex.calls).toHaveLength(0);
    } finally {
      process.env.YANDEX_API_KEY = KEY;
    }
  });

  it('webhook: off by default (404); on: secret path, Yandex networks, PING, same processing as the poll', async () => {
    const url = `/api/yandex/notifications/${WEBHOOK_SECRET}`;
    await http().post(url).send({ notificationType: 'PING', time: new Date().toISOString() }).expect(404);
    process.env.YANDEX_WEBHOOK_ENABLED = 'true';
    try {
      await http().post('/api/yandex/notifications/wrong-secret-0123456789').set('X-Real-IP', '5.45.207.10').send({ notificationType: 'PING' }).expect(404);
      await http().post(url).send({ notificationType: 'PING' }).expect(403); // not from Yandex networks
      const ping = (await http().post(url).set('X-Real-IP', '5.45.207.10').send({ notificationType: 'PING', time: new Date().toISOString() }).expect(200)).body;
      expect(ping).toEqual({ version: expect.any(String), name: 'VITALO', time: expect.any(String) });
      expect((await http().post(url).set('X-Real-IP', '5.45.207.10').send({ notificationType: 'ORDER_CREATED' }).expect(400)).body.error.type).toBe('WRONG_EVENT_FORMAT');

      const p = await stocked(['2028-01-01']);
      const o = yOrder([{ sku: p.sku, count: 1 }]);
      await http().post(url).set('X-Real-IP', '141.8.142.5').send({ notificationType: 'ORDER_CREATED', orderId: o.orderId, campaignId: CAMPAIGN, createdAt: new Date().toISOString(), items: [{ offerId: p.sku, count: 1 }] }).expect(200);
      await sync.lastWebhookJob;
      expect(yandex.calls.at(-1)!.body.orderIds).toEqual([o.orderId]); // the order is read from the API, not taken from the notification
      expect((await ourOrder(o))!.units).toHaveLength(1);
      const runs = await prisma.yandex_sync_runs.findMany({ where: { trigger: 'webhook' }, orderBy: { started_at: 'desc' }, take: 1 });
      expect(runs[0]).toMatchObject({ created: 1 });
      // a duplicate notification: still one order
      await http().post(url).set('X-Real-IP', '141.8.142.5').send({ notificationType: 'ORDER_STATUS_UPDATED', orderId: o.orderId, campaignId: CAMPAIGN, status: 'PROCESSING', substatus: 'STARTED', updatedAt: new Date().toISOString() }).expect(200);
      await sync.lastWebhookJob;
      expect(await prisma.marketplace_orders.count({ where: { external_number: String(o.orderId) } })).toBe(1);
    } finally {
      process.env.YANDEX_WEBHOOK_ENABLED = 'false';
    }
  });
});
