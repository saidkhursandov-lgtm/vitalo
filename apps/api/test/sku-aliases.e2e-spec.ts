import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'child_process';
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { applySkuAliases, planSkuAliases } from '../src/import/sku-aliases-import';
import { StockService } from '../src/inventory/stock.service';
import type { FetchLike } from '../src/marketplace/yandex/yandex-client';
import { YANDEX_CLIENT_OPTIONS } from '../src/marketplace/yandex/yandex-sync';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUnits, moveUnits } from '../src/receiving/units';
import { AuditService } from '../src/staff/audit.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

/** Alternative SKUs (old codes): admin card, search, the Yandex sync (fake Yandex) and the xlsx import. */
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
let nextId = 80_000_000 + (Date.now() % 1_000_000);
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

describe('Alternative SKUs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let warehouseId: string;
  let supplierId: string;
  const saved: Record<string, string | undefined> = {};
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).send(body),
    delete: (p: string) => http().delete(`/api${p}`).set(bearer(tokens[r])),
  });
  const runSync = async () => (await as('admin').post('/staff/yandex-sync/run').expect(200)).body;
  const external = (o: { orderId: number }) => prisma.marketplace_external_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(o.orderId) } } });
  const ours = (o: { orderId: number }) => prisma.marketplace_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: String(o.orderId) } } });

  async function product(units = 0) {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Псевдонимы ${RUN}` });
    await prisma.products.update({ where: { id: p.id }, data: { unit_tracking: true } });
    if (units) {
      const session = await prisma.receiving_sessions.findFirstOrThrow({ where: { supplier_id: supplierId, status: 'OPEN' } });
      await prisma.$transaction(async (tx) => {
        const created = await createUnits(tx, session.id, Array.from({ length: units }, () => ({ product_id: p.id, purchase_id: null, purchase_line_id: null, cost: 40_000n, expiry: '2028-01-01' })), null);
        await moveUnits(tx, { id: { in: created.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
        await stock.receiveUnits(tx, { warehouseId, productId: p.id, qty: units, referenceType: 'receiving_session', referenceId: session.id, reason: 'e2e', staffId: null });
      });
    }
    return p;
  }

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { YANDEX_API_KEY: `ACMA:aliasTest${RUN}:1`, YANDEX_SYNC_DRY_RUN: 'false', YANDEX_CAMPAIGN_IDS: String(CAMPAIGN), YANDEX_BUSINESS_ID: '216755072' });
    app = await createTestApp((b) => b.overrideProvider(YANDEX_CLIENT_OPTIONS).useValue({ fetch: fakeFetch, retryDelaysMs: [0, 0, 0] }));
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    warehouseId = await stock.mainWarehouseId();
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    supplierId = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик алиасов ${RUN}` }).expect(201)).body.id;
    await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200);
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

  it('card: everyone with products.view sees the list; only the admin adds and removes (audit)', async () => {
    const p = await product();
    const alias = `TPRD-${RUN}1`;
    for (const r of ['manager', 'warehouse', 'marketer'] as Role[]) {
      await as(r).get(`/staff/products/${p.id}/aliases`).expect(200);
      expect((await as(r).post(`/staff/products/${p.id}/aliases`, { alias, source: 'internal' }).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    }
    const added = (await as('admin').post(`/staff/products/${p.id}/aliases`, { alias, source: 'internal' }).expect(201)).body;
    expect((await as('warehouse').get(`/staff/products/${p.id}/aliases`).expect(200)).body).toEqual([{ id: added.id, alias, source: 'internal', created_at: expect.any(String) }]);
    await as('manager').delete(`/staff/products/${p.id}/aliases/${added.id}`).expect(403);
    await as('admin').delete(`/staff/products/${p.id}/aliases/${added.id}`).expect(200);
    expect((await as('admin').get(`/staff/products/${p.id}/aliases`).expect(200)).body).toEqual([]);
    const audit = await prisma.audit_logs.findMany({ where: { entity_id: p.id, action: { in: ['product.alias_added', 'product.alias_removed'] } }, orderBy: { created_at: 'asc' } });
    expect(audit.map((a) => [a.action, Number(!!a.staff_user_id)])).toEqual([['product.alias_added', 1], ['product.alias_removed', 1]]);
  });

  it('conflicts: unique for the whole catalog ignoring case, never a product SKU, not SKU-like text refused; the database guards it too', async () => {
    const a = await product();
    const b = await product();
    const alias = `YM-OLD-${RUN}`;
    await as('admin').post(`/staff/products/${a.id}/aliases`, { alias, source: 'yandex' }).expect(201);
    expect((await as('admin').post(`/staff/products/${b.id}/aliases`, { alias: alias.toLowerCase(), source: 'yandex' }).expect(409)).body.code).toBe('ALIAS_TAKEN');
    expect((await as('admin').post(`/staff/products/${a.id}/aliases`, { alias, source: 'internal' }).expect(409)).body.code).toBe('ALIAS_EXISTS');
    expect((await as('admin').post(`/staff/products/${b.id}/aliases`, { alias: a.sku.toLowerCase(), source: 'internal' }).expect(409)).body.code).toBe('ALIAS_IS_SKU');
    expect((await as('admin').post(`/staff/products/${a.id}/aliases`, { alias: a.sku, source: 'internal' }).expect(409)).body.code).toBe('ALIAS_IS_OWN_SKU');
    await as('admin').post(`/staff/products/${a.id}/aliases`, { alias: 'НА ЯНДЕКС ЕЩЁ НЕ ВЫСТАВЛЕН', source: 'yandex' }).expect(400);
    await as('admin').post(`/staff/products/${a.id}/aliases`, { alias: 'NO-DIGITS', source: 'yandex' }).expect(400);
    await as('admin').post(`/staff/products/${a.id}/aliases`, { alias: 'X-1', source: 'other' }).expect(400);
    // directly in the database: an alias equal to a SKU, a SKU equal to another product's alias
    await expect(prisma.product_sku_aliases.create({ data: { product_id: a.id, alias: b.sku, alias_norm: b.sku.toUpperCase(), source: 'yandex' } })).rejects.toThrow(/equals the SKU/);
    await expect(prisma.products.update({ where: { id: b.id }, data: { sku: alias } })).rejects.toThrow(/alternative SKU of another product/);
  });

  it('search in the admin panel (also the picker of a manual Yandex order) finds the product by an old code', async () => {
    const p = await product();
    const alias = `TPRD-${RUN}7`;
    await as('admin').post(`/staff/products/${p.id}/aliases`, { alias, source: 'internal' }).expect(201);
    const found = (await as('warehouse').get(`/staff/products?q=${encodeURIComponent(alias.toLowerCase())}`).expect(200)).body.items;
    expect(found).toEqual([expect.objectContaining({ id: p.id, sku: p.sku, matched_alias: alias })]);
    const bySku = (await as('warehouse').get(`/staff/products?q=${encodeURIComponent(p.sku)}`).expect(200)).body.items;
    expect(bySku.find((x: { id: string }) => x.id === p.id).matched_alias).toBeNull();
  });

  it('Yandex sync: SKU first, then an alias (any case); «найден по старому SKU» in the run log', async () => {
    const p = await product(2);
    const alias = `YM-${RUN}-OLD1`;
    await as('admin').post(`/staff/products/${p.id}/aliases`, { alias, source: 'yandex' }).expect(201);
    const byAlias = yOrder(alias.toLowerCase());
    const bySku = yOrder(p.sku);
    const run = await runSync();
    expect(run).toMatchObject({ created: 2, errors: 0 });
    expect(await ours(byAlias)).toMatchObject({ status: 'NEW', stock_shortage: false });
    const line = await prisma.marketplace_order_lines.findFirstOrThrow({ where: { order: { external_number: String(byAlias.orderId) } } });
    expect(line.product_id).toBe(p.id);
    const details = (await as('admin').get(`/staff/yandex-sync/runs/${run.id}`).expect(200)).body.details.items;
    expect(details.find((d: { number: string }) => d.number === String(byAlias.orderId)).reason).toContain(`найден по старому SKU: ${alias.toLowerCase()} → ${p.sku}`);
    expect(details.find((d: { number: string }) => d.number === String(bySku.orderId)).reason).not.toContain('старому SKU');
  });

  it('«неизвестный SKU» is picked up by the next poll once the alias exists — even outside the date window; a closed one is not', async () => {
    const p = await product(2);
    const oldCode = `YM-${RUN}-OLD2`;
    const waiting = yOrder(oldCode);
    const closed = yOrder(oldCode);
    expect(await runSync()).toMatchObject({ created: 0, attention: 2 });
    expect(await external(waiting)).toMatchObject({ attention_kind: 'UNKNOWN_SKU' });
    const closedRow = (await external(closed))!;
    await as('admin').post(`/staff/yandex-sync/attention/${closedRow.id}/close`, { reason: 'Закрыт вручную' }).expect(200);
    const notesBefore = await prisma.notifications.count({ where: { template: { startsWith: 'staff.yandex' }, payload: { path: ['order_number'], equals: String(closed.orderId) } } });

    // Yandex does not change these orders any more: the date window of the poll no longer returns them
    yandex.hiddenFromWindow.add(waiting.orderId);
    yandex.hiddenFromWindow.add(closed.orderId);
    await as('admin').post(`/staff/products/${p.id}/aliases`, { alias: oldCode, source: 'yandex' }).expect(201);
    const run = await runSync();
    expect(run).toMatchObject({ created: 1, errors: 0 });
    expect(await ours(waiting)).toMatchObject({ status: 'NEW' });
    expect(await external(waiting)).toMatchObject({ attention_kind: null });
    expect(await ours(closed)).toBeNull();
    expect(await external(closed)).toMatchObject({ closed_at: expect.any(Date) });
    expect(await prisma.notifications.count({ where: { template: { startsWith: 'staff.yandex' }, payload: { path: ['order_number'], equals: String(closed.orderId) } } })).toBe(notesBefore);
  });

  it('import from the xlsx: created, already there, same as SKU, not a SKU (warning), unknown product, conflicts not overwritten; all or nothing', async () => {
    const [p1, p2, p3, other] = [await product(), await product(), await product(), await product()];
    const taken = `TAKEN-${RUN}9`;
    await as('admin').post(`/staff/products/${other.id}/aliases`, { alias: taken, source: 'yandex' }).expect(201);
    const dir = mkdtempSync(join(tmpdir(), 'vitalo-aliases-'));
    const file = join(dir, 'VITALO_SKU_для_Яндекса.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SKU для Яндекса');
    ws.addRow(['SKU', 'Название', 'Цена', 'Прежний SKU у нас', 'Старый SKU в Яндексе']);
    ws.addRow([p1.sku, 'Товар 1', 1, `TPRD-${RUN}1`, `ym-${RUN}-a`]);
    ws.addRow([p2.sku, 'Товар 2', 1, p2.sku, 'НА ЯНДЕКС ЕЩЁ НЕ ВЫСТАВЛЕН (выставить позже)']);
    ws.addRow([p3.sku, 'Товар 3', 1, null, taken]);
    ws.addRow([`NO-SUCH-${RUN}1`, 'Нет товара', 1, `TPRD-${RUN}2`, null]);
    ws.addRow([p3.sku, 'Товар 3 ещё раз', 1, `TPRD-${RUN}1`, null]); // the same old code for two products in the file
    await wb.xlsx.writeFile(file);

    const plan = await planSkuAliases(prisma, file);
    expect(plan.errors).toEqual([]);
    expect(plan.create.map((c) => [c.sku, c.alias, c.source])).toEqual([
      [p1.sku, `TPRD-${RUN}1`, 'internal'],
      [p1.sku, `ym-${RUN}-a`, 'yandex'],
    ]);
    expect(plan.same).toEqual([{ row: 3, sku: p2.sku }]);
    expect(plan.notSku).toEqual([expect.objectContaining({ row: 3, sku: p2.sku, column: 'Старый SKU в Яндексе' })]);
    expect(plan.unknownProduct).toEqual([{ row: 5, sku: `NO-SUCH-${RUN}1` }]);
    expect(plan.conflicts.map((c) => [c.row, c.alias])).toEqual([[4, taken], [6, `TPRD-${RUN}1`]]);
    expect(await prisma.product_sku_aliases.count({ where: { product_id: p1.id } })).toBe(0); // the plan writes nothing

    expect(await applySkuAliases(prisma, new AuditService(prisma), plan)).toBe(2);
    expect((await prisma.product_sku_aliases.findMany({ where: { product_id: p1.id }, orderBy: { alias: 'asc' } })).map((a) => [a.alias, a.source])).toEqual([
      [`TPRD-${RUN}1`, 'internal'],
      [`ym-${RUN}-a`, 'yandex'],
    ]);
    expect((await prisma.product_sku_aliases.findUniqueOrThrow({ where: { alias_norm: taken } })).product_id).toBe(other.id); // not overwritten
    const again = await planSkuAliases(prisma, file);
    expect(again.create).toEqual([]);
    expect(again.existing.map((e) => e.alias)).toEqual([`TPRD-${RUN}1`, `ym-${RUN}-a`]);

    // all or nothing: a conflict appearing between the plan and the write stops everything
    const late = await planSkuAliases(prisma, file);
    late.create.push({ row: 99, sku: p2.sku, product_id: p2.id, alias: `LATE-${RUN}1`, source: 'yandex' }, { row: 100, sku: p3.sku, product_id: p3.id, alias: taken, source: 'yandex' });
    await expect(applySkuAliases(prisma, new AuditService(prisma), late)).rejects.toThrow(/Строка 100/);
    expect(await prisma.product_sku_aliases.count({ where: { alias_norm: `LATE-${RUN}1` } })).toBe(0);

    expect((await planSkuAliases(prisma, join(dir, 'nope.xlsx'))).errors[0].message).toContain('Не удалось открыть');
  });

  it('the import script refuses a database that is not *_dev / *_test without --allow-production', () => {
    const r = spawnSync('npx', ['ts-node', 'scripts/import-yandex-aliases.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: 'postgresql://vitalo:vitalo@localhost:5432/vitalo' },
      encoding: 'utf8',
      shell: true,
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('отказывается работать с базой');
  });
});
