import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { tashkentDateString } from '../src/common/tashkent';
import { StockService } from '../src/inventory/stock.service';
import type { FetchLike } from '../src/marketplace/yandex/yandex-client';
import { YANDEX_CLIENT_OPTIONS } from '../src/marketplace/yandex/yandex-sync';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUnits, moveUnits } from '../src/receiving/units';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff, stockOf } from './helpers';

/**
 * S2B-10: a receiving by purchase switches a product to unit tracking when its stock equals its units on the shelf;
 * otherwise the product stays as is and every screen says why (receiving, «Сверка», Yandex orders, the sync).
 */
const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
const CAMPAIGN = 149165806;
const ENV_KEYS = ['YANDEX_API_KEY', 'YANDEX_SYNC_DRY_RUN', 'YANDEX_CAMPAIGN_IDS', 'YANDEX_BUSINESS_ID'];

// ---------------------------------------------------------------- fake Yandex
const yandex = { orders: new Map<number, Record<string, unknown>>(), hiddenFromWindow: new Set<number>() };
const fakeFetch: FetchLike = async (_url, init) => {
  const body = JSON.parse(init.body ?? '{}') as { orderIds?: number[] };
  const orders = [...yandex.orders.values()].filter((o) =>
    body.orderIds ? body.orderIds.includes(o.orderId as number) : !yandex.hiddenFromWindow.has(o.orderId as number),
  );
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ orders, paging: {} }) };
};
let nextId = 90_000_000 + (Date.now() % 1_000_000);
const yOrder = (offerId: string, count = 1) => {
  const o = {
    orderId: ++nextId,
    campaignId: CAMPAIGN,
    status: 'PROCESSING',
    substatus: 'STARTED',
    creationDate: '2026-10-10T09:00:00+05:00',
    updateDate: new Date().toISOString(),
    fake: false,
    items: [{ id: 1, offerId, count, prices: { payment: { value: 150_000 * count, currencyId: 'UZS' } } }],
  };
  yandex.orders.set(o.orderId, o);
  return o;
};

/** Date in Tashkent `days` from today as ДД.ММ.ГГГГ (how the warehouse types it). */
const inDays = (days: number) => {
  const d = tashkentDateString(new Date(Date.now() + days * 86_400_000));
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
};

describe('S2B-10: unit tracking after a receiving by purchase (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let warehouseId: string;
  const saved: Record<string, string | undefined> = {};
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
  });
  const runSync = async () => (await as('admin').post('/staff/yandex-sync/run').expect(200)).body;
  const external = (o: { orderId: number }) => prisma.marketplace_external_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(o.orderId) } } });
  const ours = (o: { orderId: number }) => prisma.marketplace_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(o.orderId) } } });
  const tracked = async (id: string) => (await prisma.products.findUniqueOrThrow({ where: { id } })).unit_tracking;

  /** Purchase of `qty` from a new supplier, received and completed through the API; returns the completed session. */
  async function receiveByPurchase(productId: string, qty: number) {
    const supplier = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик S2B-10 ${RUN} ${randomUUID().slice(0, 6)}` }).expect(201)).body;
    await as('admin').post('/staff/purchases', { source_type: 'SUPPLIER', supplier_id: supplier.id, purchase_date: '2026-10-01', lines: [{ product_id: productId, ordered_qty: qty, unit_price_original_uzs: 40_000 }] }).expect(201);
    const session = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplier.id }).expect(200)).body;
    await as('warehouse').post(`/staff/receiving/sessions/${session.id}/accept`, { product_id: productId, qty, expiry_groups: [{ expiry: inDays(400), qty }] }).expect(200);
    return (await as('warehouse').post(`/staff/receiving/sessions/${session.id}/complete`).expect(200)).body;
  }

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { YANDEX_API_KEY: `ACMA:trackTest${RUN}:1`, YANDEX_SYNC_DRY_RUN: 'false', YANDEX_CAMPAIGN_IDS: String(CAMPAIGN), YANDEX_BUSINESS_ID: '216755072' });
    app = await createTestApp((b) => b.overrideProvider(YANDEX_CLIENT_OPTIONS).useValue({ fetch: fakeFetch, retryDelaysMs: [0, 0, 0] }));
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    warehouseId = await stock.mainWarehouseId();
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    await archiveTestProducts(prisma);
    await app.close();
  });
  beforeEach(() => {
    yandex.orders.clear();
    yandex.hiddenFromWindow.clear();
  });

  it('a product without stock: «Завершить» by purchase switches it to unit tracking (audit); Yandex orders take it', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Учёт S2B-10 ${RUN} новый` });
    const done = await receiveByPurchase(p.id, 3);
    expect(done).toMatchObject({ status: 'COMPLETED', not_unit_tracked: [] });
    expect(await tracked(p.id)).toBe(true);
    expect(await stockOf(prisma, p.id)).toEqual({ actual: 3, reserved: 0 });
    const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: p.id, action: 'product.unit_tracking_started' } });
    expect(audit.after_json).toMatchObject({ unit_tracking: true, actual_qty: 3, units_on_shelf: 3, receiving_session_id: done.id });
    const completed = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: done.id, action: 'receiving.completed' } });
    expect(completed.after_json).toMatchObject({ unit_tracking: { started: [p.sku], not_started: [] } });

    await as('admin').post('/staff/yandex-orders', { external_number: `YM-${RUN}-1`, order_date: '2026-10-10', lines: [{ product_id: p.id, qty: 2, unit_price_uzs: 150_000 }] }).expect(201);
    expect(await prisma.physical_units.count({ where: { product_id: p.id, status: 'ASSIGNED' } })).toBe(2);

    // the next receiving of an already tracked product changes nothing about tracking
    await receiveByPurchase(p.id, 1);
    expect(await prisma.audit_logs.count({ where: { entity_id: p.id, action: 'product.unit_tracking_started' } })).toBe(1);
  });

  it('a product with an old stock without units: stays not tracked; the receiving, «Сверка» and the Yandex order say why', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 5, name: `Учёт S2B-10 ${RUN} старый` });
    const done = await receiveByPurchase(p.id, 2);
    expect(await tracked(p.id)).toBe(false);
    expect(await stockOf(prisma, p.id)).toEqual({ actual: 7, reserved: 0 });
    expect(done.not_unit_tracked).toEqual([{ product_id: p.id, sku: p.sku, reason: expect.stringContaining('банок на полке: 2, остаток: 7') }]);
    expect(done.not_unit_tracked[0].reason).toContain('нужен начальный остаток');
    expect(await prisma.audit_logs.count({ where: { entity_id: p.id, action: 'product.unit_tracking_started' } })).toBe(0);
    const completed = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: done.id, action: 'receiving.completed' } });
    expect(completed.after_json).toMatchObject({ unit_tracking: { started: [], not_started: [{ sku: p.sku, actual_qty: 7, units_on_shelf: 2 }] } });
    // the session screen says it again later
    expect((await as('warehouse').get(`/staff/receiving/sessions/${done.id}`).expect(200)).body.not_unit_tracked).toHaveLength(1);

    const rec = (await as('warehouse').get('/staff/units/reconcile').expect(200)).body.items.find((i: { product_id: string }) => i.product_id === p.id);
    expect(rec).toMatchObject({ unit_tracking: false, units_in_stock: 2, actual_qty: 7, state: 'not_tracked', explained: false });

    const refused = (await as('admin').post('/staff/yandex-orders', { external_number: `YM-${RUN}-2`, order_date: '2026-10-10', lines: [{ product_id: p.id, qty: 1, unit_price_uzs: 150_000 }] }).expect(409)).body;
    expect(refused.code).toBe('NOT_UNIT_TRACKED');
    expect(refused.message).toBe(`${p.sku} не переведён на учёт по банкам (банок на полке: 2, остаток: 7) — остаток не равен числу банок: нужен начальный остаток (пересчёт) по этому товару`);
    expect(await prisma.marketplace_orders.count({ where: { external_number: `YM-${RUN}-2` } })).toBe(0);

    // the admin button refuses with the same reason: the stock is not the units
    const no = (await as('admin').post(`/staff/units/start-tracking/${p.id}`).expect(409)).body;
    expect(no.code).toBe('CANNOT_START_TRACKING');
    expect(no.message).toContain('нужен начальный остаток');
    expect(await tracked(p.id)).toBe(false);
  });

  it('sync: «Товар без учёта по банкам» with the reason; once tracking is on, the next poll creates it even outside the date window', async () => {
    // units that came in before S2B-10: the stock equals the units, the flag was never set (OZN-A019)
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Учёт S2B-10 ${RUN} яндекс` });
    await prisma.products.update({ where: { id: p.id }, data: { yandex_price_uzs: 150_000n } });
    const supplier = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик S2B-10 ${RUN} старый` }).expect(201)).body;
    const session = await prisma.receiving_sessions.create({ data: { type: 'PURCHASE', supplier_id: supplier.id, status: 'COMPLETED', completed_at: new Date() } });
    await prisma.$transaction(async (tx) => {
      const created = await createUnits(tx, session.id, Array.from({ length: 3 }, () => ({ product_id: p.id, purchase_id: null, purchase_line_id: null, cost: 40_000n, expiry: '2028-01-01' })), null);
      await moveUnits(tx, { id: { in: created.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
      await stock.receiveUnits(tx, { warehouseId, productId: p.id, qty: 3, referenceType: 'receiving_session', referenceId: session.id, reason: 'e2e', staffId: null });
    });

    const o = yOrder(p.sku);
    expect(await runSync()).toMatchObject({ created: 0, attention: 1, errors: 0 });
    const ext = await external(o);
    expect(ext).toMatchObject({ attention_kind: 'NOT_UNIT_TRACKED', order_id: null });
    expect(ext!.attention_reason).toBe(`${p.sku} не переведён на учёт по банкам (банок на полке: 3, остаток: 3) — остаток равен числу банок, но учёт не включён (банки приняты до решения S2B-10): администратор включает его кнопкой «Включить учёт по банкам» в «Склад → Сверка»`);
    const note = await prisma.notifications.findFirstOrThrow({ where: { template: 'staff.yandex_attention', payload: { path: ['order_number'], equals: String(o.orderId) } } });
    expect((note.payload as { reason: string }).reason).toContain('банок на полке: 3, остаток: 3');

    // «Включить учёт по банкам» in «Сверка» (admin only) turns the flag on; Yandex no longer changes the order
    yandex.hiddenFromWindow.add(o.orderId);
    await as('manager').post(`/staff/units/start-tracking/${p.id}`).expect(403);
    await as('warehouse').post(`/staff/units/start-tracking/${p.id}`).expect(403);
    expect((await as('admin').post(`/staff/units/start-tracking/${p.id}`).expect(200)).body).toEqual({ sku: p.sku, unit_tracking: true, changed: true });
    expect((await as('admin').post(`/staff/units/start-tracking/${p.id}`).expect(200)).body.changed).toBe(false);
    const fix = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: p.id, action: 'product.unit_tracking_fix' } });
    expect(fix.after_json).toMatchObject({ unit_tracking: true, actual_qty: 3, units_on_shelf: 3 });
    expect(await runSync()).toMatchObject({ created: 1, errors: 0 });
    expect(await ours(o)).toMatchObject({ status: 'NEW', stock_shortage: false });
    expect(await external(o)).toMatchObject({ attention_kind: null });
    expect(await prisma.physical_units.count({ where: { product_id: p.id, status: 'ASSIGNED' } })).toBe(1);
  });
});
