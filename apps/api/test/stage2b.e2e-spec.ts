import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { tashkentDateString } from '../src/common/tashkent';
import { applyOpeningStock, planOpeningStock } from '../src/import/opening-stock';
import { PrismaService } from '../src/prisma/prisma.service';
import { OPENING_REASON } from '../src/receiving/admin-receiving';
import { createUnits } from '../src/receiving/units';
import { AuditService } from '../src/staff/audit.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff, stockOf } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
/** Keys that must never reach manager / warehouse in receiving and units answers. */
const LEAK = /cost|_uzs|price|ozon_order_number|^purchase|^final_actual|allocated/;
const keysOf = (body: unknown) => (JSON.stringify(body).match(/"([A-Za-z_]+)":/g) ?? []).map((k) => k.slice(1, -2));
const PHYSICAL_ID = /^V-\d{6}$/;

/** Date in Tashkent `days` from today as ДД.ММ.ГГГГ (how the warehouse types it). */
const inDays = (days: number) => {
  const d = tashkentDateString(new Date(Date.now() + days * 86_400_000));
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
};

describe('Stage 2B: Physical ID, receiving, labels (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}, key?: string) => {
      const req = http().post(`/api${p}`).set(bearer(tokens[r]));
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    },
    patch: (p: string, body: object) => http().patch(`/api${p}`).set(bearer(tokens[r])).send(body),
    delete: (p: string) => http().delete(`/api${p}`).set(bearer(tokens[r])),
  });
  const accept = (r: Role, sessionId: string, body: object, key: string = randomUUID()) => as(r).post(`/staff/receiving/sessions/${sessionId}/accept`, body, key);
  const complete = (r: Role, sessionId: string, key: string = randomUUID()) => as(r).post(`/staff/receiving/sessions/${sessionId}/complete`, {}, key);

  let account: { id: string };
  let supplier: { id: string };
  let p1: { id: string; sku: string; name_ru: string };
  let p2: { id: string; sku: string; name_ru: string };
  let p3: { id: string; sku: string; name_ru: string };
  const OZON_OLD = `OZ2B-${RUN}-OLD`;
  const OZON_NEW = `OZ2B-${RUN}-NEW`;
  let oldPurchase: { id: string; lines: { id: string; product: { id: string } }[] };
  let newPurchase: { id: string; lines: { id: string; product: { id: string } }[] };
  let sessionId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    account = (await as('admin').post('/staff/dictionaries/ozon_accounts', { name_ru: `Мастура ${RUN}` }).expect(201)).body;
    supplier = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик 2B ${RUN}` }).expect(201)).body;
    [p1, p2, p3] = await Promise.all([1, 2, 3].map((i) => createTestProduct(prisma, { price: 100_000, stock: 0, name: `Омега 2B ${RUN} ${i}` })));
    await prisma.products.update({ where: { id: p1.id }, data: { label_composition_ru: 'Рыбий жир, желатин', label_composition_uz: 'Baliq yog‘i, jelatin' } });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ 2B.0
  it('2B.0: purchase lines keep the input order in position (1, 2, 3; an added line goes last)', async () => {
    const lines = [p3, p1, p2].map((p, i) => ({ product_id: p.id, ordered_qty: i + 1, unit_price_original_uzs: 1_000 }));
    const created = (await as('admin').post('/staff/purchases', { source_type: 'SUPPLIER', supplier_id: supplier.id, purchase_date: '2026-01-01', lines }, randomUUID()).expect(201)).body;
    expect(created.lines.map((l: { product: { id: string } }) => l.product.id)).toEqual([p3.id, p1.id, p2.id]);
    const rows = await prisma.purchase_lines.findMany({ where: { purchase_id: created.id }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => [r.product_id, r.position])).toEqual([[p3.id, 1], [p1.id, 2], [p2.id, 3]]);
    await as('admin').delete(`/staff/purchases/${created.id}/lines/${rows[0].id}`).expect(200);
    const p4 = await createTestProduct(prisma, { price: 1, stock: 0 });
    const after = (await as('admin').post(`/staff/purchases/${created.id}/lines`, { product_id: p4.id, ordered_qty: 1, unit_price_original_uzs: 1 }).expect(201)).body;
    expect(after.lines.map((l: { product: { id: string } }) => l.product.id)).toEqual([p1.id, p2.id, p4.id]);
    expect((await prisma.purchase_lines.findFirstOrThrow({ where: { purchase_id: created.id, product_id: p4.id } })).position).toBe(4);
    // This supplier purchase (p1 2, p2 3, p4 1 expected) is used by the «unfinished receiving» test below.
  });

  // ------------------------------------------------------------------ 2B.1 numbers
  it('Physical ID: 20 creations at the same time give 20 different numbers V-000184 style; numbers only grow', async () => {
    const s = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplier.id }).expect(200)).body;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$transaction((tx) => createUnits(tx, s.id, [{ product_id: p3.id, purchase_id: null, purchase_line_id: null, cost: 0n, expiry: '2030-01-01' }], null)),
      ),
    );
    const ids = results.flat().map((u) => u.physical_id);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id).toMatch(PHYSICAL_ID);
    const units = await prisma.physical_units.findMany({ where: { physical_id: { in: ids } } });
    expect(new Set(units.map((u) => u.seq)).size).toBe(20);
    for (const u of units) expect(u.physical_id).toBe(`V-${String(u.seq).padStart(6, '0')}`);
    // a rolled back creation leaves a gap, never a reused number
    const maxBefore = Math.max(...units.map((u) => u.seq));
    await expect(
      prisma.$transaction(async (tx) => {
        await createUnits(tx, s.id, [{ product_id: p3.id, purchase_id: null, purchase_line_id: null, cost: 0n, expiry: '2030-01-01' }], null);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const next = await prisma.$transaction((tx) => createUnits(tx, s.id, [{ product_id: p3.id, purchase_id: null, purchase_line_id: null, cost: 0n, expiry: '2030-01-01' }], null));
    expect(Number(next[0].physical_id.slice(2))).toBeGreaterThan(maxBefore + 1);
    // the test units go away the normal way: the session is cancelled, units become VOIDED
    await as('warehouse').post(`/staff/receiving/sessions/${s.id}/cancel`, { reason: 'тест нумерации' }).expect(200);
    expect(await prisma.physical_units.count({ where: { receiving_session_id: s.id, status: { not: 'VOIDED' } } })).toBe(0);
  });

  // ------------------------------------------------------------------ 2B.2 receiving by purchase
  it('sources and expected positions: warehouse sees SKUs and quantities, no prices and no Ozon order numbers', async () => {
    const ozon = (number: string, date: string, lines: object[], extra: object = {}) =>
      as('admin').post('/staff/purchases', { source_type: 'OZON', ozon_account_id: account.id, ozon_order_number: number, purchase_date: date, lines, ...extra }, randomUUID()).expect(201);
    oldPurchase = (await ozon(OZON_OLD, '2026-09-01', [
      { product_id: p1.id, ordered_qty: 5, unit_price_original_uzs: 1_000 },
      { product_id: p2.id, ordered_qty: 2, unit_price_original_uzs: 500 },
    ], { final_actual_total_uzs: 6_001 })).body;
    newPurchase = (await ozon(OZON_NEW, '2026-09-15', [{ product_id: p1.id, ordered_qty: 3, unit_price_original_uzs: 2_000 }])).body;

    const sources = (await as('warehouse').get('/staff/receiving/sources').expect(200)).body;
    expect(sources.ozon_accounts.find((a: { id: string }) => a.id === account.id)).toMatchObject({ expected_qty: 10, open_session_id: null });
    const expected = (await as('warehouse').get(`/staff/receiving/expected?ozon_account_id=${account.id}`).expect(200)).body;
    expect(expected.items.map((i: { product: { sku: string }; remaining_qty: number }) => [i.product.sku, i.remaining_qty])).toEqual([[p1.sku, 8], [p2.sku, 2]]);
    expect(expected.items[0].product).toMatchObject({ name_ru: p1.name_ru, label_ready: true });
    for (const body of [sources, expected]) {
      expect(keysOf(body).filter((k) => LEAK.test(k))).toEqual([]);
      expect(JSON.stringify(body)).not.toContain(OZON_OLD);
    }
    const forAdmin = (await as('admin').get(`/staff/receiving/expected?ozon_account_id=${account.id}`).expect(200)).body;
    expect(forAdmin.items[0].purchases.map((p: { ozon_order_number: string }) => p.ozon_order_number)).toEqual([OZON_OLD, OZON_NEW]);
    await as('warehouse').get('/staff/receiving/expected').expect(400);
    await as('marketer').get('/staff/receiving/sources').expect(403);
  });

  it('a session per source: «Начать» twice gives the same open session', async () => {
    const a = (await as('warehouse').post('/staff/receiving/sessions', { ozon_account_id: account.id }).expect(200)).body;
    const b = (await as('manager').post('/staff/receiving/sessions', { ozon_account_id: account.id }).expect(200)).body;
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ type: 'PURCHASE', status: 'OPEN', source: { type: 'OZON', id: account.id } });
    sessionId = a.id;
    const open = (await as('warehouse').get('/staff/receiving/sessions').expect(200)).body;
    expect(open.map((s: { id: string }) => s.id)).toContain(sessionId);
    await as('warehouse').post('/staff/receiving/sessions', { ozon_account_id: account.id, supplier_id: supplier.id }).expect(400);
  });

  it('expiry: required, ДД.ММ.ГГГГ, not in the past, Σ = quantity; under 90 days needs a confirmation', async () => {
    const base = { product_id: p1.id, qty: 6 };
    await accept('warehouse', sessionId, { ...base, expiry_groups: [] }).expect(400);
    expect((await accept('warehouse', sessionId, { ...base, expiry_groups: [{ expiry: inDays(-1), qty: 6 }] }).expect(400)).body.code).toBe('EXPIRY_IN_PAST');
    expect((await accept('warehouse', sessionId, { ...base, expiry_groups: [{ expiry: '31.02.2028', qty: 6 }] }).expect(400)).body.code).toBe('EXPIRY_INVALID');
    expect((await accept('warehouse', sessionId, { ...base, expiry_groups: [{ expiry: inDays(400), qty: 5 }] }).expect(400)).body.code).toBe('EXPIRY_QTY_MISMATCH');
    const short = await accept('warehouse', sessionId, { ...base, expiry_groups: [{ expiry: inDays(400), qty: 4 }, { expiry: inDays(30), qty: 2 }] }).expect(409);
    expect(short.body.code).toBe('SHORT_EXPIRY');
    expect(await prisma.physical_units.count({ where: { receiving_session_id: sessionId } })).toBe(0);
  });

  it('accept: N units spread over the purchases (oldest first), exactly once per key; costs follow the line', async () => {
    const key = randomUUID();
    const body = { product_id: p1.id, qty: 6, expiry_groups: [{ expiry: inDays(400), qty: 4 }, { expiry: inDays(30), qty: 2 }], confirm_short_expiry: true };
    const [a, b] = await Promise.all([accept('warehouse', sessionId, body, key), accept('warehouse', sessionId, body, key)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.created).toHaveLength(6);
    expect(b.body.created).toEqual(a.body.created);
    for (const id of a.body.created) expect(id).toMatch(PHYSICAL_ID);
    expect(await prisma.physical_units.count({ where: { receiving_session_id: sessionId } })).toBe(6);

    const oldLine = oldPurchase.lines.find((l) => l.product.id === p1.id)!;
    const newLine = newPurchase.lines[0];
    const units = await prisma.physical_units.findMany({ where: { receiving_session_id: sessionId }, orderBy: { seq: 'asc' } });
    expect(units.filter((u) => u.purchase_line_id === oldLine.id)).toHaveLength(5); // the old purchase is filled first
    expect(units.filter((u) => u.purchase_line_id === newLine.id)).toHaveLength(1);
    expect(units.every((u) => u.status === 'RECEIVED')).toBe(true);
    // earliest expiry goes first
    expect(units.slice(0, 2).map((u) => u.expiry_date.toISOString().slice(0, 10))).toEqual(Array(2).fill(tashkentDateString(new Date(Date.now() + 30 * 86_400_000))));
    // Σ unit costs of the old line = its allocated total (6 001 spread: p1 5 001, p2 1 000)
    const line = await prisma.purchase_lines.findUniqueOrThrow({ where: { id: oldLine.id } });
    expect(line.allocated_total_uzs).toBe(5_001n);
    expect(units.filter((u) => u.purchase_line_id === oldLine.id).reduce((s, u) => s + u.actual_cost_uzs, 0n)).toBe(5_001n);
    expect(units.find((u) => u.purchase_line_id === newLine.id)!.actual_cost_uzs).toBe(2_000n);
    // a line with units cannot be removed from its purchase
    expect((await as('admin').delete(`/staff/purchases/${newPurchase.id}/lines/${newLine.id}`).expect(409)).body.code).toBe('LINE_HAS_UNITS');
  });

  it('more than expected: confirmation, then the rest is a discrepancy on the last line with an event', async () => {
    const body = { product_id: p1.id, qty: 4, expiry_groups: [{ expiry: inDays(500), qty: 4 }] };
    const over = await accept('warehouse', sessionId, body).expect(409);
    expect(over.body).toMatchObject({ code: 'OVER_EXPECTED', expected_qty: 2, over_qty: 2 });
    const ok = (await accept('warehouse', sessionId, { ...body, confirm_over_expected: true }).expect(200)).body;
    expect(ok.warnings.join(' ')).toContain('Расхождение');
    expect(ok.summary.discrepancy_qty).toBe(2);
    const newLine = newPurchase.lines[0];
    const sessionLine = await prisma.receiving_session_lines.findFirstOrThrow({ where: { session_id: sessionId, purchase_line_id: newLine.id, discrepancy_qty: { not: null } } });
    expect(sessionLine).toMatchObject({ qty: 4, discrepancy_qty: 2 });
    expect(await prisma.purchase_events.count({ where: { purchase_id: newPurchase.id, type: 'DISCREPANCY', qty: 2 } })).toBe(1);
    // the new line: 3 expected (2 000 each), 5 units -> 3 × 2 000 = its allocated total, 2 extra at the average
    const costs = (await prisma.physical_units.findMany({ where: { purchase_line_id: newLine.id }, orderBy: { seq: 'asc' } })).map((u) => u.actual_cost_uzs);
    expect(costs).toEqual([2_000n, 2_000n, 2_000n, 2_000n, 2_000n]);
    // less than expected is fine: 1 of 2
    await accept('warehouse', sessionId, { product_id: p2.id, qty: 1, expiry_groups: [{ expiry: inDays(700), qty: 1 }] }).expect(200);
    expect((await accept('warehouse', sessionId, { product_id: p3.id, qty: 1, expiry_groups: [{ expiry: inDays(700), qty: 1 }] }).expect(409)).body.code).toBe('NOT_EXPECTED');
  });

  it('manager and warehouse never get unit costs, purchase prices, sums or Ozon order numbers; admin does', async () => {
    const unit = await prisma.physical_units.findFirstOrThrow({ where: { receiving_session_id: sessionId }, orderBy: { seq: 'asc' } });
    for (const r of ['warehouse', 'manager'] as Role[]) {
      const bodies = [
        (await as(r).get(`/staff/receiving/sessions/${sessionId}`).expect(200)).body,
        (await as(r).get(`/staff/units?session_id=${sessionId}`).expect(200)).body,
        (await as(r).get(`/staff/units/${unit.id}`).expect(200)).body,
        (await as(r).get(`/staff/units/find?code=${unit.seq}`).expect(200)).body,
        (await as(r).get(`/staff/units?purchase_id=${oldPurchase.id}`).expect(200)).body, // the filter is ignored for them
      ];
      for (const body of bodies) {
        expect(keysOf(body).filter((k) => LEAK.test(k))).toEqual([]);
        expect(JSON.stringify(body)).not.toMatch(new RegExp(`${OZON_OLD}|${OZON_NEW}`));
      }
    }
    const admin = (await as('admin').get(`/staff/units/${unit.id}`).expect(200)).body;
    expect(admin).toMatchObject({ actual_cost_uzs: 1_001, purchase: { id: oldPurchase.id, ozon_order_number: OZON_OLD } });
    const adminSession = (await as('admin').get(`/staff/receiving/sessions/${sessionId}`).expect(200)).body;
    expect(adminSession.lines.map((l: { purchase: { ozon_order_number: string } }) => l.purchase.ozon_order_number)).toEqual(expect.arrayContaining([OZON_OLD, OZON_NEW]));
    expect((await as('admin').get(`/staff/units?purchase_id=${oldPurchase.id}`).expect(200)).body.total).toBe(6);
    await as('marketer').get(`/staff/units/${unit.id}`).expect(403);
  });

  it('a changed final total moves the unit costs of the line; Σ still equals the allocated total', async () => {
    await as('admin').patch(`/staff/purchases/${oldPurchase.id}`, { final_actual_total_uzs: 7_001 }).expect(200);
    const line = await prisma.purchase_lines.findFirstOrThrow({ where: { purchase_id: oldPurchase.id, product_id: p1.id } });
    const units = await prisma.physical_units.findMany({ where: { purchase_line_id: line.id } });
    expect(units.reduce((s, u) => s + u.actual_cost_uzs, 0n)).toBe(line.allocated_total_uzs);
    expect(await prisma.physical_unit_events.count({ where: { physical_unit_id: { in: units.map((u) => u.id) }, type: 'COST_CHANGED' } })).toBeGreaterThan(0);
    const wh = (await as('warehouse').get(`/staff/units/${units[0].id}`).expect(200)).body;
    expect(wh.events.map((e: { type: string }) => e.type)).not.toContain('COST_CHANGED');
  });

  it('labels: Physical ID, SKU, composition RU/UZ, expiry — no product name; every print is counted', async () => {
    const res = (await as('warehouse').post('/staff/units/labels', { session_id: sessionId }).expect(200)).body;
    expect(res.labels).toHaveLength(11);
    expect(res.labels[0]).toEqual({
      id: expect.any(String),
      physical_id: expect.stringMatching(PHYSICAL_ID),
      sku: p1.sku,
      composition_ru: 'Рыбий жир, желатин',
      composition_uz: 'Baliq yog‘i, jelatin',
      expiry_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(JSON.stringify(res)).not.toContain(p1.name_ru);
    expect(JSON.stringify(res)).not.toMatch(/OZ2B/);
    expect(res.warnings.join(' ')).toContain(`${p2.sku}: не заполнен короткий состав`);
    const again = (await as('warehouse').post('/staff/units/labels', { unit_ids: [res.labels[0].id] }).expect(200)).body;
    expect(again.labels).toHaveLength(1);
    const unit = await prisma.physical_units.findUniqueOrThrow({ where: { id: res.labels[0].id } });
    expect(unit.label_print_count).toBe(2);
    expect(unit.last_printed_at).not.toBeNull();
    expect(await prisma.physical_unit_events.count({ where: { physical_unit_id: unit.id, type: 'LABEL_PRINTED' } })).toBe(2);
    await as('warehouse').post('/staff/units/labels', {}).expect(400);
  });

  it('«Завершить»: one transaction — IN_STOCK, received quantities, purchase status, stock with a receipt; repeat changes nothing', async () => {
    const before = { p1: await stockOf(prisma, p1.id), p2: await stockOf(prisma, p2.id) };
    const key = randomUUID();
    const done = (await complete('warehouse', sessionId, key).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', replayed: false });
    expect(await prisma.physical_units.count({ where: { receiving_session_id: sessionId, status: 'IN_STOCK' } })).toBe(11);
    expect(await stockOf(prisma, p1.id)).toEqual({ actual: before.p1.actual + 10, reserved: before.p1.reserved });
    expect(await stockOf(prisma, p2.id)).toEqual({ actual: before.p2.actual + 1, reserved: before.p2.reserved });
    const moves = await prisma.inventory_movements.findMany({ where: { reference_type: 'receiving_session', reference_id: sessionId } });
    expect(moves.map((m) => [m.product_id, m.movement_type, m.qty]).sort()).toEqual([[p1.id, 'receipt', 10], [p2.id, 'receipt', 1]].sort());

    const old = (await as('admin').get(`/staff/purchases/${oldPurchase.id}`).expect(200)).body;
    expect(old.status).toBe('EXPECTED'); // p2: 1 of 2 still expected
    expect(old.lines.map((l: { received_qty: number }) => l.received_qty)).toEqual([5, 1]);
    const fresh = (await as('admin').get(`/staff/purchases/${newPurchase.id}`).expect(200)).body;
    expect(fresh).toMatchObject({ status: 'RECEIVED', progress: { received: 5, ordered: 3 } });
    expect(fresh.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['RECEIVED', 'DISCREPANCY']));
    expect(await prisma.audit_logs.count({ where: { entity_id: sessionId, action: 'receiving.completed' } })).toBe(1);
    const unit = await prisma.physical_units.findFirstOrThrow({ where: { receiving_session_id: sessionId } });
    expect(await prisma.physical_unit_events.count({ where: { physical_unit_id: unit.id, type: 'IN_STOCK', from_status: 'RECEIVED', to_status: 'IN_STOCK' } })).toBe(1);

    expect((await complete('warehouse', sessionId, key).expect(200)).body.replayed).toBe(true);
    expect((await complete('manager', sessionId).expect(200)).body.replayed).toBe(true); // another key: still once
    expect(await stockOf(prisma, p1.id)).toEqual({ actual: before.p1.actual + 10, reserved: before.p1.reserved });
    expect(await prisma.inventory_movements.count({ where: { reference_type: 'receiving_session', reference_id: sessionId } })).toBe(2);
    expect((await accept('warehouse', sessionId, { product_id: p2.id, qty: 1, expiry_groups: [{ expiry: inDays(700), qty: 1 }] }).expect(409)).body.code).toBe('SESSION_NOT_OPEN');
    await complete('warehouse', sessionId, 'short').expect(400); // Idempotency-Key is required (8+ chars)
  });

  it('unfinished receiving: continue later, or cancel — units VOIDED (kept, numbers never reused), stock untouched', async () => {
    // the supplier's oldest purchase is the 2B.0 one (p1 2, p2 3, p4 1 still expected)
    const s = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplier.id }).expect(200)).body;
    const first = (await accept('warehouse', s.id, { product_id: p2.id, qty: 2, expiry_groups: [{ expiry: inDays(365), qty: 2 }] }).expect(200)).body;
    const again = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplier.id }).expect(200)).body; // «Продолжить»
    expect(again.id).toBe(s.id);
    expect(again.units.map((u: { physical_id: string }) => u.physical_id)).toEqual(first.created);
    const stock = await stockOf(prisma, p2.id);

    const cancelled = (await as('warehouse').post(`/staff/receiving/sessions/${s.id}/cancel`, { reason: 'ошиблись источником' }).expect(200)).body;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.units.every((u: { status: string }) => u.status === 'VOIDED')).toBe(true);
    expect(await stockOf(prisma, p2.id)).toEqual(stock);
    expect(await prisma.physical_unit_events.count({ where: { physical_unit_id: { in: cancelled.units.map((u: { id: string }) => u.id) }, type: 'VOIDED' } })).toBe(2);
    await as('warehouse').post(`/staff/receiving/sessions/${s.id}/cancel`, {}).expect(409);
    await as('warehouse').post('/staff/units/labels', { unit_ids: [cancelled.units[0].id] }).expect(409); // VOIDED is not printed

    // a new session gets new, higher numbers; three «Завершить» at once — the stock moves once
    const s2 = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplier.id }).expect(200)).body;
    expect(s2.id).not.toBe(s.id);
    const next = (await accept('warehouse', s2.id, { product_id: p2.id, qty: 3, expiry_groups: [{ expiry: inDays(365), qty: 3 }] }).expect(200)).body;
    const max = (ids: string[]) => Math.max(...ids.map((i) => Number(i.slice(2))));
    expect(Math.min(...next.created.map((i: string) => Number(i.slice(2))))).toBeGreaterThan(max(first.created));
    const results = await Promise.all([1, 2, 3].map(() => complete('warehouse', s2.id)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(await stockOf(prisma, p2.id)).toEqual({ actual: stock.actual + 3, reserved: stock.reserved });
  });

  it('the unit history is append-only; a unit is never deleted and its number never changes', async () => {
    const unit = await prisma.physical_units.findFirstOrThrow({ where: { receiving_session_id: sessionId } });
    const e = await prisma.physical_unit_events.findFirstOrThrow({ where: { physical_unit_id: unit.id } });
    await expect(prisma.physical_unit_events.update({ where: { id: e.id }, data: { note: 'x' } })).rejects.toThrow(/append-only/);
    await expect(prisma.physical_unit_events.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.physical_units.delete({ where: { id: unit.id } })).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.physical_units.update({ where: { id: unit.id }, data: { physical_id: 'V-999998', seq: 999_998 } })).rejects.toThrow(/never change/);
  });

  it('«Единицы»: V-000184, v-000184, 000184 and 184 find the same unit', async () => {
    const unit = await prisma.physical_units.findFirstOrThrow({ where: { receiving_session_id: sessionId } });
    const n = String(unit.seq);
    for (const code of [unit.physical_id, unit.physical_id.toLowerCase(), n.padStart(6, '0'), n, ` ${n} `]) {
      expect((await as('warehouse').get(`/staff/units/find?code=${encodeURIComponent(code)}`).expect(200)).body.id).toBe(unit.id);
    }
    expect((await as('warehouse').get('/staff/units/find?code=VTL-1').expect(400)).body.code).toBe('BAD_PHYSICAL_ID');
    await as('warehouse').get('/staff/units/find?code=V-999997').expect(404);
    const list = (await as('warehouse').get(`/staff/units?q=${n}`).expect(200)).body;
    expect(list.items.map((u: { id: string }) => u.id)).toContain(unit.id);
  });

  // ------------------------------------------------------------------ 2B.3 opening balance
  describe('opening balance and the old quantity operations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitalo-opening-'));
    let o1: { id: string; sku: string }; // cost 12 000, stock 7
    let o2: { id: string; sku: string }; // no cost
    let o3: { id: string; sku: string }; // reserved 4 > 3 on the sheet
    let o4: { id: string; sku: string }; // cost 5 000, stock 0
    async function sheet(name: string, rows: unknown[][]) {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('Каталог').addRow(['ignored']);
      const ws = wb.addWorksheet('Начальные остатки (банки)');
      ws.addRow(['Инвентаризация 09.10.2026']);
      ws.addRow(['SKU', 'Название (для сверки)', 'Срок годности (ДД.ММ.ГГГГ)', 'Количество банок']);
      for (const r of rows) ws.addRow(r);
      const file = join(dir, name);
      await wb.xlsx.writeFile(file);
      return file;
    }
    const counts = async () => ({ units: await prisma.physical_units.count(), sessions: await prisma.receiving_sessions.count(), audit: await prisma.audit_logs.count() });

    beforeAll(async () => {
      o1 = await createTestProduct(prisma, { price: 1, stock: 7 });
      o2 = await createTestProduct(prisma, { price: 1, stock: 0 });
      o3 = await createTestProduct(prisma, { price: 1, stock: 5, reserved: 4 });
      o4 = await createTestProduct(prisma, { price: 1, stock: 0 });
      await prisma.products.update({ where: { id: o1.id }, data: { cost_uzs: 12_000n } });
      await prisma.products.update({ where: { id: o3.id }, data: { cost_uzs: 1n } });
      await prisma.products.update({ where: { id: o4.id }, data: { cost_uzs: 5_000n } });
    });

    it('dry run writes nothing; errors: no cost, reserved above the sheet, past expiry, unknown SKU — all or nothing', async () => {
      const file = await sheet('bad.xlsx', [
        [o1.sku, 'x', '31.12.2027', 4],
        [o1.sku, 'x', new Date(Date.UTC(2028, 5, 30)), 6],
        [o2.sku, 'x', '01.01.2028', 2],
        [o3.sku, 'x', '01.01.2028', 3],
        [`NOPE-${RUN}`, 'x', '01.01.2028', 1],
        [o4.sku, 'x', '01.01.2020', 1],
        [o4.sku, 'x', '01.01.2028', 'два'],
      ]);
      const before = await counts();
      const plan = await planOpeningStock(prisma, file);
      const text = plan.errors.map((e) => `${e.sku}: ${e.message}`).join('\n');
      expect(text).toContain(`${o2.sku}: не заполнена себестоимость`);
      expect(text).toContain(`${o3.sku}: в резерве по заказам 4 шт., а банок на листе 3`);
      expect(text).toContain(`NOPE-${RUN}: товара с таким SKU нет`);
      expect(text).toContain(`${o4.sku}: срок годности 01.01.2020 уже прошёл`);
      expect(text).toContain(`${o4.sku}: «Количество банок»`);
      const row = plan.rows.find((r) => r.sku === o1.sku)!;
      expect(row).toMatchObject({ actual: 7, reserved: 0, sheetQty: 10, difference: 3, cost: 12_000, newUnits: 10 });
      expect(row.groups).toEqual([{ expiry: '2027-12-31', qty: 4 }, { expiry: '2028-06-30', qty: 6 }]);
      await expect(applyOpeningStock(prisma, new AuditService(prisma), plan)).rejects.toThrow(/Ничего не записано/);
      expect(await counts()).toEqual(before);
    });

    it('--confirm: an open opening session with RECEIVED units at cost_uzs; running again creates nothing', async () => {
      const file = await sheet('ok.xlsx', [
        [o1.sku, 'x', '31.12.2027', 4],
        [o1.sku, 'x', new Date(Date.UTC(2028, 5, 30)), 6],
        [o4.sku, 'x', '01.01.2028', 2],
      ]);
      const plan = await planOpeningStock(prisma, file);
      expect(plan.errors).toEqual([]);
      const res = await applyOpeningStock(prisma, new AuditService(prisma), plan);
      expect(res.created.map((c) => [c.sku, c.units])).toEqual([[o1.sku, 10], [o4.sku, 2]]);
      const session = await prisma.receiving_sessions.findUniqueOrThrow({ where: { id: res.sessionId! } });
      expect(session).toMatchObject({ type: 'OPENING_BALANCE', status: 'OPEN' });
      const units = await prisma.physical_units.findMany({ where: { receiving_session_id: session.id, product_id: o1.id } });
      expect(units).toHaveLength(10);
      expect(units.every((u) => u.status === 'RECEIVED' && u.actual_cost_uzs === 12_000n)).toBe(true);
      expect((await prisma.products.findUniqueOrThrow({ where: { id: o1.id } })).unit_tracking).toBe(false); // only after «Завершить»
      expect(await stockOf(prisma, o1.id)).toEqual({ actual: 7, reserved: 0 });

      const again = await planOpeningStock(prisma, file);
      expect(again.rows.every((r) => r.action === 'skip')).toBe(true);
      expect((await applyOpeningStock(prisma, new AuditService(prisma), again)).created).toEqual([]);
      expect(await prisma.physical_units.count({ where: { receiving_session_id: session.id } })).toBe(12);
      sessionId = session.id;
    });

    it('«Завершить» the opening balance: admin only; refused while orders hold more than the units; then stock = units', async () => {
      await complete('warehouse', sessionId).expect(403);
      await prisma.inventory.updateMany({ where: { product_id: o4.id }, data: { actual_qty: 3, reserved_qty: 3 } }); // orders hold 3, units 2
      const refused = await complete('admin', sessionId).expect(409);
      expect(refused.body).toMatchObject({ code: 'STOCK_RESERVED', reserved_qty: 3, target: 2 });
      expect(await prisma.physical_units.count({ where: { receiving_session_id: sessionId, status: 'RECEIVED' } })).toBe(12); // nothing moved
      await prisma.inventory.updateMany({ where: { product_id: o4.id }, data: { reserved_qty: 0 } });

      await complete('admin', sessionId).expect(200);
      expect(await stockOf(prisma, o1.id)).toEqual({ actual: 10, reserved: 0 });
      expect(await stockOf(prisma, o4.id)).toEqual({ actual: 2, reserved: 0 });
      const adj = await prisma.inventory_movements.findMany({ where: { reference_type: 'receiving_session', reference_id: sessionId }, orderBy: { qty: 'asc' } });
      expect(adj.map((m) => [m.product_id, m.movement_type, m.qty, m.reason])).toEqual([
        [o4.id, 'adjustment', -1, OPENING_REASON],
        [o1.id, 'adjustment', 3, OPENING_REASON],
      ]);
      for (const id of [o1.id, o4.id]) expect((await prisma.products.findUniqueOrThrow({ where: { id } })).unit_tracking).toBe(true);
      const rec = (await as('manager').get('/staff/units/reconcile').expect(200)).body;
      expect(rec.hint).toContain('До этапа 2C');
      expect(rec.items.find((i: { product_id: string }) => i.product_id === o1.id)).toMatchObject({ units_in_stock: 10, actual_qty: 10, difference: 0, explained: true });
    });

    it('old operations on a unit-tracked product: 409 for warehouse; admin only with override_unit_tracking and a reason', async () => {
      const wh = await prisma.warehouses.findFirstOrThrow({ orderBy: { name: 'asc' } });
      const t = { product_id: o1.id, warehouse_id: wh.id };
      for (const [path, body] of [
        ['receipt', { ...t, qty: 1 }],
        ['writeoff', { ...t, qty: 1, reason: 'бой' }],
        ['adjustment', { ...t, actual_qty: 9, reason: 'пересчёт' }],
        ['return', { ...t, qty: 1, condition: 'resellable', reason: 'возврат' }],
      ] as const) {
        const res = await as('warehouse').post(`/staff/inventory/${path}`, body).expect(409);
        expect(res.body).toMatchObject({ code: 'UNIT_TRACKED', message: 'Товар учитывается по единицам: используйте «Приёмка»' });
      }
      await as('warehouse').post('/staff/inventory/receipt', { ...t, qty: 1, override_unit_tracking: true, override_reason: 'хочу' }).expect(409);
      await as('manager').post('/staff/inventory/receipt', { ...t, qty: 1 }).expect(403); // manager never had stock operations
      await as('admin').post('/staff/inventory/receipt', { ...t, qty: 1 }).expect(409);
      expect((await as('admin').post('/staff/inventory/receipt', { ...t, qty: 1, override_unit_tracking: true }).expect(400)).body.code).toBe('OVERRIDE_REASON_REQUIRED');
      expect(await stockOf(prisma, o1.id)).toEqual({ actual: 10, reserved: 0 });

      await as('admin').post('/staff/inventory/receipt', { ...t, qty: 1, override_unit_tracking: true, override_reason: 'найдена банка без этикетки' }).expect(201);
      expect(await stockOf(prisma, o1.id)).toEqual({ actual: 11, reserved: 0 });
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: o1.id, action: 'inventory.unit_tracking_override' } });
      expect(audit.after_json).toMatchObject({ operation: 'inventory.receipt', reason: 'найдена банка без этикетки' });
      const rec = (await as('admin').get('/staff/units/reconcile').expect(200)).body;
      expect(rec.items.find((i: { product_id: string }) => i.product_id === o1.id)).toMatchObject({ units_in_stock: 10, actual_qty: 11, difference: -1, explained: false });

      // a product without unit tracking works as before
      await as('warehouse').post('/staff/inventory/receipt', { product_id: o2.id, warehouse_id: wh.id, qty: 2 }).expect(201);
      expect(await stockOf(prisma, o2.id)).toEqual({ actual: 2, reserved: 0 });
    });

    it('the opening script refuses a database without _dev / _test', () => {
      const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ts-node', 'scripts/import-opening-stock.ts'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/vitalo' }, // nothing listens on port 1
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}${res.stderr}`).toContain('без отдельного разрешения');
    }, 90_000);
  });

  it('product card: short label composition by admin and manager, not by warehouse; unit tracking is shown', async () => {
    const saved = (await as('manager').patch(`/staff/products/${p2.id}/label`, { label_composition_ru: ' Витамин D3 ', label_composition_uz: 'D3 vitamini' }).expect(200)).body;
    expect(saved).toMatchObject({ label_composition_ru: 'Витамин D3', label_composition_uz: 'D3 vitamini', unit_tracking: false });
    await as('admin').patch(`/staff/products/${p2.id}/label`, { label_composition_uz: '' }).expect(200);
    expect((await prisma.products.findUniqueOrThrow({ where: { id: p2.id } })).label_composition_uz).toBeNull();
    await as('warehouse').patch(`/staff/products/${p2.id}/label`, { label_composition_ru: 'x' }).expect(403);
    await as('admin').patch(`/staff/products/${p2.id}/label`, { label_composition_ru: 'x'.repeat(301) }).expect(400);
    expect(await prisma.audit_logs.count({ where: { entity_id: p2.id, action: 'product.label_updated' } })).toBe(2);
  });
});
