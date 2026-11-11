import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { StockService } from '../src/inventory/stock.service';
import type { FetchLike } from '../src/marketplace/yandex/yandex-client';
import { YANDEX_CLIENT_OPTIONS, YandexSyncService } from '../src/marketplace/yandex/yandex-sync';
import { renderNotification } from '../src/notifications/notification-templates';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';
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
/** Personal data put into every fake Yandex order. */
const PII = { firstName: 'Дилноза', lastName: 'Юсупова', phone: '+998971112233', email: 'dilnoza.e2e@example.com', city: 'Самарканд', street: 'Регистан-кўчаси' };
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
    // personal data of the customer: must never be stored, logged or sent (see PII below)
    notes: `Позвоните ${PII.phone}, спросить ${PII.firstName}`,
    buyer: { firstName: PII.firstName, lastName: PII.lastName, phone: PII.phone, email: PII.email },
    delivery: { type: 'DELIVERY', address: { city: PII.city, street: PII.street, house: '7', recipient: { name: `${PII.firstName} ${PII.lastName}` }, phone: PII.phone } },
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
    const late = [yOrder([{ sku: p.sku, count: 1 }], { status: 'DELIVERED', substatus: null }), yOrder([{ sku: p.sku, count: 1 }], { status: 'CANCELLED', substatus: 'SHOP_FAILED' })];
    // аудит 10.11, п. 1.3: отменён самим покупателем ещё до нас — не «требует внимания»
    const byCustomer = yOrder([{ sku: p.sku, count: 1 }], { status: 'CANCELLED', substatus: 'USER_CHANGED_MIND' });
    const before = await prisma.notifications.count({ where: { template: 'staff.yandex_late_summary' } });
    expect(await runSync()).toMatchObject({ created: 0, attention: 2 });
    for (const o of late) expect(await external(o)).toMatchObject({ attention_kind: 'FIRST_SEEN_LATE', order_id: null });
    expect(await external(byCustomer)).toMatchObject({ attention_kind: null, order_id: null });
    expect(await prisma.notifications.count({ where: { template: 'staff.yandex_late_summary' } })).toBe(before + activeAdmins);
    await runSync(); // seen again: no new summary
    expect(await prisma.notifications.count({ where: { template: 'staff.yandex_late_summary' } })).toBe(before + activeAdmins);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });
  });

  it('«Закрыть выбранные»: admin only, up to 100, all or nothing, entries with an order refused, idempotent, never raised again', async () => {
    const p = await stocked(['2028-01-01']);
    const late = [
      yOrder([{ sku: p.sku, count: 1 }], { status: 'DELIVERED', substatus: null }),
      yOrder([{ sku: p.sku, count: 1 }], { status: 'PICKUP', substatus: null }),
      yOrder([{ sku: p.sku, count: 1 }], { status: 'CANCELLED', substatus: 'SHOP_FAILED' }),
    ];
    const reserved = yOrder([{ sku: p.sku, count: 1 }]); // created with a unit
    const shortage = yOrder([{ sku: p.sku, count: 5 }]); // created without units, in «Требует внимания»
    await runSync();
    const ext = async (o: { orderId: number }) => (await external(o))!;
    const lateIds = await Promise.all(late.map(async (o) => (await ext(o)).id));
    expect((await ext(shortage)).attention_kind).toBe('NOT_ENOUGH_STOCK');
    const close = (r: Role, body: object) => http().post('/api/staff/yandex-sync/attention/close-batch').set(bearer(tokens[r])).send(body);
    const reason = 'Старый заказ, уже обработан вручную';

    // rights and limits
    for (const r of ['manager', 'warehouse', 'marketer'] as Role[]) expect((await close(r, { ids: lateIds, reason }).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    await close('admin', { ids: lateIds, reason: 'x' }).expect(400);
    await close('admin', { ids: [], reason }).expect(400);
    await close('admin', { ids: Array.from({ length: 101 }, () => randomUUID()), reason }).expect(400);

    // an entry that already became our order (with or without units) → nothing at all is closed
    const withOrder = [(await ext(shortage)).id, (await ext(reserved)).id];
    const refused = (await close('admin', { ids: [...lateIds, ...withOrder], reason }).expect(409)).body;
    expect(refused.code).toBe('BATCH_REJECTED');
    expect(refused.rejected.map((r: { reason: string }) => r.reason).sort()).toEqual([expect.stringContaining('есть резерв банок'), expect.stringContaining('уже превращён в заказ')].sort());
    const unknown = (await close('admin', { ids: [lateIds[0], randomUUID()], reason }).expect(409)).body;
    expect(unknown.rejected).toEqual([expect.objectContaining({ reason: 'не найден' })]);
    for (const o of late) expect((await ext(o)).closed_at).toBeNull();

    // a failure in the middle rolls everything back
    const audit = app.get(AuditService);
    const original = audit.log.bind(audit);
    let calls = 0;
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (entry, db) => {
      if (entry.action === 'yandex_sync.closed' && ++calls === 2) throw new Error('simulated failure');
      return original(entry, db);
    });
    try {
      await close('admin', { ids: lateIds, reason }).expect(500);
    } finally {
      spy.mockRestore();
    }
    for (const o of late) expect((await ext(o)).closed_at).toBeNull();
    expect(await prisma.audit_logs.count({ where: { action: 'yandex_sync.closed', entity_id: { in: lateIds } } })).toBe(0);

    // the batch: all closed, one audit row each with the shared reason
    expect((await close('admin', { ids: lateIds, reason }).expect(200)).body).toMatchObject({ closed: 3, skipped: 0 });
    const rows = await prisma.audit_logs.findMany({ where: { action: 'yandex_sync.closed', entity_id: { in: lateIds } } });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.after_json).toMatchObject({ reason });
    for (const o of late) expect(await ext(o)).toMatchObject({ closed_at: expect.any(Date), close_reason: reason });

    // repeated: nothing more, no error
    expect((await close('admin', { ids: lateIds, reason }).expect(200)).body).toMatchObject({ closed: 0, skipped: 3 });
    expect(await prisma.audit_logs.count({ where: { action: 'yandex_sync.closed', entity_id: { in: lateIds } } })).toBe(3);

    // later polls do not raise them and send nothing
    const before = await prisma.notifications.count({ where: { template: { startsWith: 'staff.yandex' } } });
    await runSync();
    await runSync();
    const screen = (await as('admin').get('/staff/yandex-sync').expect(200)).body;
    expect(screen.attention.some((a: { id: string }) => lateIds.includes(a.id))).toBe(false);
    expect(await prisma.notifications.count({ where: { template: { startsWith: 'staff.yandex' } } })).toBe(before);
    for (const o of late) expect(await ext(o)).toMatchObject({ closed_at: expect.any(Date) });
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
    // 420 and 503 retried, then the answer (orders still «Требует внимания» from the tests above are read again too)
    expect(yandex.calls.filter((c) => !c.body.orderIds)).toHaveLength(3);

    yandex.queue = [{ status: 420, body: { status: 'ERROR', errors: [{ code: 'LIMIT' }] }, headers: { 'X-RateLimit-Resource-Remaining': '0' } }];
    const limited = await runSync();
    expect(limited.error).toContain('лимит');
    yandex.queue = [{ status: 200, body: { nothing: true } }];
    expect((await runSync()).error).toContain('без списка orders');
    expect(await prisma.marketplace_orders.count({ where: { external_number: String(o.orderId) } })).toBe(1);
  });

  describe('«Отгрузить до» (delivery.shipment of Yandex)', () => {
    const shipment = (s: object | null) => ({
      delivery: { type: 'DELIVERY', address: { city: PII.city, street: PII.street, phone: PII.phone }, transfer: { courier: { fullName: PII.lastName, phone: PII.phone } }, ...(s && { shipment: s }) },
    });
    const message = async (o: { orderId: number }) =>
      prisma.notifications.findFirstOrThrow({ where: { template: 'staff.yandex_new_order', payload: { path: ['order_number'], equals: String(o.orderId) } } });
    const textOf = (n: { template: string; payload: unknown }) => renderNotification(n.template, n.payload as Parameters<typeof renderNotification>[1]);

    it('date and time: in the message to warehouse and admins, in the card and the list; only the two values of delivery are stored', async () => {
      const p = await stocked(['2028-01-01', '2028-02-01']);
      const o = yOrder([{ sku: p.sku, count: 1 }], shipment({ id: 777, shipmentDate: '2026-10-14', shipmentTime: '12:00:00' }));
      expect(await runSync()).toMatchObject({ created: 1, errors: 0 });
      const ours = (await ourOrder(o))!;
      expect(ours.ship_by_date!.toISOString().slice(0, 10)).toBe('2026-10-14');
      expect(ours.ship_by_time).toBe('12:00');

      const msg = await message(o);
      expect(msg.payload).toMatchObject({ ship_by: '14.10.2026 12:00', items: `${p.sku} × 1` });
      expect(textOf(msg)).toBe(`🟡 Новый заказ Яндекс № ${o.orderId}, отгрузить до 14.10.2026 12:00\n${p.sku} × 1\nБанки зарезервированы, можно собирать.`);
      const sent = await prisma.notifications.findMany({ where: { template: 'staff.yandex_new_order', payload: { path: ['order_number'], equals: String(o.orderId) } }, include: { staff: true } });
      expect(new Set(sent.map((n) => n.staff!.role))).toEqual(new Set(['admin', 'warehouse'])); // not the manager, not the marketer
      expect(sent).toHaveLength(activeAdminsAndWarehouse);

      const card = (await as('warehouse').get(`/staff/yandex-orders/${ours.id}`).expect(200)).body;
      expect(card.ship_by).toEqual({ date: '2026-10-14', time: '12:00' });
      const row = (await as('manager').get(`/staff/yandex-orders?q=${o.orderId}`).expect(200)).body.items[0];
      expect(row.ship_by).toEqual({ date: '2026-10-14', time: '12:00' });

      // of delivery nothing but the deadline is kept: no address, no courier, not even the block or the shipment id
      const ext = (await external(o))!;
      expect(ext.raw).toMatchObject({ shipment: { shipmentDate: '2026-10-14', shipmentTime: '12:00' } });
      expect(Object.keys((ext.raw as { shipment: object }).shipment).sort()).toEqual(['shipmentDate', 'shipmentTime']);
      const stored = JSON.stringify([ext, ours, sent.map((n) => n.payload)], (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
      for (const value of Object.values(PII)) expect(stored).not.toContain(value);
      for (const field of ['"delivery"', '"address"', '"courier"', '"transfer"', '"phone"']) expect(stored).not.toContain(field);
    });

    it('no time → only the date; no shipment block or a broken date → the order is created as usual, the old text, «срок не указан», no attention', async () => {
      const p = await stocked(['2028-01-01', '2028-02-01', '2028-03-01', '2028-04-01']);
      const dateOnly = yOrder([{ sku: p.sku, count: 1 }], shipment({ shipmentDate: '2026-10-15', shipmentTime: null }));
      const short = yOrder([{ sku: p.sku, count: 1 }], shipment({ shipmentDate: '2026-10-16', shipmentTime: '09:30' }));
      const none = yOrder([{ sku: p.sku, count: 1 }], shipment(null));
      const broken = yOrder([{ sku: p.sku, count: 1 }], shipment({ shipmentDate: '14-10-2026', shipmentTime: 'утром' }));
      expect(await runSync()).toMatchObject({ created: 4, attention: 0, errors: 0 });

      expect(textOf(await message(dateOnly))).toContain(`Новый заказ Яндекс № ${dateOnly.orderId}, отгрузить до 15.10.2026\n`);
      expect((await ourOrder(dateOnly))!).toMatchObject({ ship_by_time: null });
      expect(textOf(await message(short))).toContain('отгрузить до 16.10.2026 09:30\n');
      for (const o of [none, broken]) {
        const ours = (await ourOrder(o))!;
        expect(ours).toMatchObject({ status: 'NEW', ship_by_date: null, ship_by_time: null });
        expect(ours.units).toHaveLength(1);
        const msg = await message(o);
        expect(msg.payload).not.toHaveProperty('ship_by');
        expect(textOf(msg)).toBe(`🟡 Новый заказ Яндекса № ${o.orderId}\n${p.sku} × 1\nБанки зарезервированы, можно собирать.`);
        expect((await as('warehouse').get(`/staff/yandex-orders/${ours.id}`).expect(200)).body.ship_by).toBeNull();
        expect((await external(o))!.attention_kind).toBeNull();
        expect((await external(o))!.raw).not.toHaveProperty('shipment');
      }
    });

    it('one message per order whatever comes again (poll, both webhook paths); a deadline that appears or moves later is updated quietly', async () => {
      const p = await stocked(['2028-01-01']);
      const o = yOrder([{ sku: p.sku, count: 1 }], shipment(null));
      await runSync();
      expect(await notes(o, 'staff.yandex_new_order')).toBe(activeAdminsAndWarehouse);
      expect((await ourOrder(o))!.ship_by_date).toBeNull();

      // Yandex adds the deadline later, then moves it; the order comes by the poll and by notifications on both paths
      Object.assign(o, shipment({ shipmentDate: '2026-10-20', shipmentTime: '18:00' }));
      await runSync();
      expect((await ourOrder(o))!).toMatchObject({ ship_by_time: '18:00' });
      Object.assign(o, shipment({ shipmentDate: '2026-10-21' }));
      process.env.YANDEX_WEBHOOK_ENABLED = 'true';
      try {
        for (const path of [`/api/yandex/notifications/${WEBHOOK_SECRET}`, `/api/yandex/notifications/${WEBHOOK_SECRET}/notification`]) {
          await http().post(path).set('X-Real-IP', '5.45.207.43').send({ notificationType: 'ORDER_STATUS_UPDATED', orderId: o.orderId, campaignId: CAMPAIGN }).expect(200);
          await sync.lastWebhookJob;
        }
      } finally {
        process.env.YANDEX_WEBHOOK_ENABLED = 'false';
      }
      const ours = (await ourOrder(o))!;
      expect(ours.ship_by_date!.toISOString().slice(0, 10)).toBe('2026-10-21');
      expect(ours.ship_by_time).toBeNull();
      // an answer without the block does not erase what we know
      Object.assign(o, shipment(null));
      await runSync();
      expect((await ourOrder(o))!.ship_by_date!.toISOString().slice(0, 10)).toBe('2026-10-21');

      expect(await prisma.marketplace_orders.count({ where: { external_number: String(o.orderId) } })).toBe(1);
      expect(await notes(o, 'staff.yandex_new_order')).toBe(activeAdminsAndWarehouse); // still the one message
      expect(ours.units).toHaveLength(1);
    });

    it('DRY_RUN: no order and no message, with or without a deadline; «требует внимания» goes to admins only', async () => {
      const p = await stocked(['2028-01-01']);
      const dry = yOrder([{ sku: p.sku, count: 1 }], shipment({ shipmentDate: '2026-10-14' }));
      process.env.YANDEX_SYNC_DRY_RUN = 'true';
      try {
        await runSync();
      } finally {
        process.env.YANDEX_SYNC_DRY_RUN = 'false';
      }
      expect(await ourOrder(dry)).toBeNull();
      expect(await notes(dry, 'staff.yandex_new_order')).toBe(0);

      const unknown = yOrder([{ sku: `NONE-SHIP-${RUN}`, count: 1 }], shipment({ shipmentDate: '2026-10-14' }));
      await runSync();
      expect(await notes(unknown, 'staff.yandex_new_order')).toBe(0);
      const attention = await prisma.notifications.findMany({ where: { template: 'staff.yandex_attention', payload: { path: ['order_number'], equals: String(unknown.orderId) } }, include: { staff: true } });
      expect(attention.length).toBeGreaterThan(0);
      expect(new Set(attention.map((n) => n.staff!.role))).toEqual(new Set(['admin']));
    });
  });

  it('personal data of the customer never reaches the database, the run log or Telegram (DRY_RUN and LIVE)', async () => {
    const p = await stocked(['2028-01-01']);
    const made = yOrder([{ sku: p.sku, count: 1 }]);
    const late = yOrder([{ sku: p.sku, count: 1 }], { status: 'DELIVERED', substatus: null });
    const unknown = yOrder([{ sku: `NONE-${RUN}`, count: 1 }]);
    process.env.YANDEX_SYNC_DRY_RUN = 'true';
    const dry = await runSync();
    process.env.YANDEX_SYNC_DRY_RUN = 'false';
    const live = await runSync();
    expect(live).toMatchObject({ created: 1, attention: 2, errors: 0 });
    const ids = [made, late, unknown].map((o) => String(o.orderId));
    const stored = JSON.stringify(
      [
        await prisma.yandex_sync_runs.findMany({ where: { id: { in: [dry.id, live.id] } } }),
        await prisma.marketplace_external_orders.findMany({ where: { external_number: { in: ids } } }),
        await prisma.marketplace_orders.findMany({ where: { external_number: { in: ids } }, include: { lines: true } }),
        await prisma.notifications.findMany({ where: { template: { startsWith: 'staff.yandex' } } }),
        await prisma.audit_logs.findMany({ where: { action: { startsWith: 'yandex' } } }),
        await prisma.system_errors.findMany({ where: { service: 'yandex-sync' } }),
        (await as('admin').get('/staff/yandex-sync').expect(200)).body,
        (await as('admin').get(`/staff/yandex-sync/runs/${dry.id}`).expect(200)).body,
      ],
      (_k, v) => (typeof v === 'bigint' ? Number(v) : v),
    );
    for (const value of Object.values(PII)) expect(stored).not.toContain(value);
    for (const field of ['"buyer"', '"delivery"', '"notes"', '"address"', '"phone"', '"email"']) expect(stored).not.toContain(field);
    // what is needed for the work is still there
    const ext = await external(made);
    expect(ext!.raw).toMatchObject({ orderId: made.orderId, status: 'PROCESSING', items: [{ offerId: p.sku, count: 1, prices: { payment: { currencyId: 'UZS' } } }] });
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

      // S-E-12: Yandex calls «POST /notification» relative to the address typed in the cabinet — the same handler
      const tail = `${url}/notification`;
      const started = Date.now();
      const ping2 = await http().post(tail).set('X-Real-IP', '5.45.207.43').send({ notificationType: 'PING', time: new Date().toISOString() }).expect(200);
      expect(Date.now() - started).toBeLessThan(1000); // PING must be answered within a second
      expect(ping2.headers['content-type']).toMatch(/application\/json/);
      expect(Object.keys(ping2.body).sort()).toEqual(['name', 'time', 'version']);
      expect(ping2.body.version).toMatch(/^.{1,100}$/);
      expect(ping2.body.name).toMatch(/^.{1,100}$/);
      expect(ping2.body.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/); // UTC
      await http().post('/api/yandex/notifications/wrong-secret-0123456789/notification').set('X-Real-IP', '5.45.207.43').send({ notificationType: 'PING' }).expect(404);
      await http().post(tail).send({ notificationType: 'PING' }).expect(403); // the right secret, not Yandex
      await http().post(tail).set('X-Real-IP', '8.8.8.8').send({ notificationType: 'PING' }).expect(403);
      // nothing else exists under the secret
      await http().post(`${url}/notification/more`).set('X-Real-IP', '5.45.207.43').send({ notificationType: 'PING' }).expect(404);
      await http().post(`${url}/other`).set('X-Real-IP', '5.45.207.43').send({ notificationType: 'PING' }).expect(404);
      await http().get(tail).set('X-Real-IP', '5.45.207.43').expect(404);
      await http().get(url).set('X-Real-IP', '5.45.207.43').expect(404);
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

      // the same on …/notification: one read of exactly this order, one order, no duplicate — also when repeated on both paths
      const p2 = await stocked(['2028-01-01', '2028-02-01']);
      const o2 = yOrder([{ sku: p2.sku, count: 1 }]);
      const created = { notificationType: 'ORDER_CREATED', orderId: o2.orderId, campaignId: CAMPAIGN, createdAt: new Date().toISOString(), items: [{ offerId: p2.sku, count: 1 }] };
      const callsBefore = yandex.calls.length;
      const runsBefore = await prisma.yandex_sync_runs.count({ where: { trigger: 'webhook' } });
      const answer = (await http().post(tail).set('X-Real-IP', '5.45.207.46').send(created).expect(200)).body;
      expect(Object.keys(answer).sort()).toEqual(['name', 'time', 'version']);
      await sync.lastWebhookJob;
      expect(yandex.calls.length).toBe(callsBefore + 1);
      expect(yandex.calls.at(-1)!.body.orderIds).toEqual([o2.orderId]);
      expect(await prisma.yandex_sync_runs.count({ where: { trigger: 'webhook' } })).toBe(runsBefore + 1);
      expect((await ourOrder(o2))!.units).toHaveLength(1);
      await http().post(tail).set('X-Real-IP', '5.45.207.46').send(created).expect(200);
      await sync.lastWebhookJob;
      await http().post(url).set('X-Real-IP', '5.45.207.46').send(created).expect(200);
      await sync.lastWebhookJob;
      expect(await prisma.marketplace_orders.count({ where: { external_number: String(o2.orderId) } })).toBe(1);
      expect((await ourOrder(o2))!.units).toHaveLength(1); // no second jar reserved
      expect(await prisma.physical_units.count({ where: { product_id: p2.id, status: 'ASSIGNED' } })).toBe(1);
      // S2D-12: nothing personal from the notification or the order is stored
      const ext = await prisma.marketplace_external_orders.findFirstOrThrow({ where: { external_number: String(o2.orderId) } });
      expect(JSON.stringify(ext, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(/buyer|phone|address|recipient|email|lastName|firstName/i);
    } finally {
      process.env.YANDEX_WEBHOOK_ENABLED = 'false';
    }
  });
});
