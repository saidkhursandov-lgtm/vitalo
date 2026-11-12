import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
const MONEY = /unit_price|_uzs|allocated|final_actual|unit_cost|lines_total|difference|final_total/;

describe('Stage 2A: purchases (e2e)', () => {
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
  let account: { id: string; name_ru: string };
  let account2: { id: string };
  let supplier: { id: string };
  let p1: { id: string; sku: string };
  let p2: { id: string; sku: string };
  let p3: { id: string; sku: string };
  const ozon = (number: string, lines: object[], extra: object = {}) => ({
    source_type: 'OZON',
    ozon_account_id: account.id,
    ozon_order_number: number,
    purchase_date: '2026-10-08',
    lines,
    ...extra,
  });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    account = (await as('admin').post('/staff/dictionaries/ozon_accounts', { name_ru: `Сиадкомол ${RUN}` }).expect(201)).body;
    account2 = (await as('admin').post('/staff/dictionaries/ozon_accounts', { name_ru: `Хадича ${RUN}` }).expect(201)).body;
    supplier = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Тест-поставщик Glorious ${RUN}`, note: 'Ташкент' }).expect(201)).body;
    [p1, p2, p3] = await Promise.all([1, 2, 3].map(() => createTestProduct(prisma, { price: 100_000, stock: 0 })));
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ 2A.1 dictionaries
  it('2A.1: Ozon accounts and suppliers — unique names ignoring case and spaces, archive instead of delete', async () => {
    const dup = await as('admin').post('/staff/dictionaries/ozon_accounts', { name_ru: `  сиадкомол   ${RUN} ` }).expect(409);
    expect(dup.body.code).toBe('DICTIONARY_DUPLICATE');
    const list = (await as('admin').get('/staff/dictionaries/suppliers').expect(200)).body;
    expect(list.find((s: { id: string }) => s.id === supplier.id)).toMatchObject({ name_ru: `Тест-поставщик Glorious ${RUN}`, note: 'Ташкент', products: 0 });
    await as('manager').get('/staff/dictionaries/ozon_accounts').expect(200);
    // D-61: the names are seen by everyone who sees products (the supplier tabs); the notes only with purchases
    for (const r of ['warehouse', 'marketer'] as Role[]) {
      const seen = (await as(r).get('/staff/dictionaries/suppliers').expect(200)).body;
      expect(seen.find((s: { id: string }) => s.id === supplier.id)).toMatchObject({ name_ru: `Тест-поставщик Glorious ${RUN}`, note: null });
      await as(r).get('/staff/dictionaries/ozon_accounts').expect(403);
    }
    await as('manager').post('/staff/dictionaries/suppliers', { name_ru: 'X' }).expect(403);

    const old = (await as('admin').post('/staff/dictionaries/ozon_accounts', { name_ru: `Старый ${RUN}` }).expect(201)).body;
    await as('admin').patch(`/staff/dictionaries/ozon_accounts/${old.id}`, { status: 'archived' }).expect(200);
    const refused = await as('admin').post('/staff/purchases', { ...ozon(`ARCH-${RUN}`, [{ product_id: p1.id, ordered_qty: 1, unit_price_original_uzs: 1 }]), ozon_account_id: old.id }, randomUUID()).expect(400);
    expect(refused.body.code).toBe('UNKNOWN_OZON_ACCOUNT');
    await expect(prisma.ozon_accounts.delete({ where: { id: old.id } })).rejects.toThrow(/cannot be deleted/);
  });

  // ------------------------------------------------------------------ 2A.2–2A.4 create, costs, events, audit
  let purchaseId: string;
  const number = `OZ-${RUN}-1`;

  it('creates an Ozon purchase once per Idempotency-Key; the final total is spread over the lines exactly', async () => {
    const key = randomUUID();
    const body = ozon(number, [
      { product_id: p1.id, ordered_qty: 10, unit_price_original_uzs: 10_000 },
      { product_id: p2.id, ordered_qty: 5, unit_price_original_uzs: 4_000 },
      { product_id: p3.id, ordered_qty: 1, unit_price_original_uzs: 3_333 },
    ], { final_actual_total_uzs: 100_000, comment: 'Первая' });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => as('admin').post('/staff/purchases', body, key)));
    expect([a.status, b.status, c.status].every((s) => s === 201)).toBe(true);
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);
    expect(await prisma.purchases.count({ where: { ozon_order_number: number } })).toBe(1);
    purchaseId = a.body.id;

    const p = a.body;
    expect(p).toMatchObject({ source_type: 'OZON', status: 'EXPECTED', purchase_date: '2026-10-08', final_actual_total_uzs: 100_000, lines_total_uzs: 123_333, difference_uzs: -23_333 });
    expect(p.ozon_account).toMatchObject({ id: account.id });
    expect(p.lines.map((l: { allocated_total_uzs: number }) => l.allocated_total_uzs)).toEqual([81_081, 16_216, 2_703]);
    expect(p.lines[0].unit_cost_uzs).toEqual({ min: 8_108, max: 8_109 });
    expect(p.progress).toMatchObject({ ordered: 16, received: 0, expected: 16, fully_cancelled: false });

    const reused = await as('admin').post('/staff/purchases', { ...body, comment: 'другая' }, key).expect(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await as('admin').post('/staff/purchases', body).expect(400); // no Idempotency-Key

    const events = (await as('admin').get(`/staff/purchases/${purchaseId}`).expect(200)).body.events.map((e: { type: string }) => e.type);
    expect(events).toEqual(expect.arrayContaining(['CREATED', 'RECALCULATED']));
    expect(await prisma.audit_logs.count({ where: { entity_id: purchaseId, action: 'purchase.created' } })).toBe(1);
  });

  it('validates the source, the unique Ozon number per account and the lines', async () => {
    const line = [{ product_id: p1.id, ordered_qty: 1, unit_price_original_uzs: 1_000 }];
    const code = async (body: object, status: number) => (await as('admin').post('/staff/purchases', body, randomUUID()).expect(status)).body.code;
    expect(await code({ ...ozon('', line), ozon_order_number: undefined }, 400)).toBe('OZON_FIELDS_REQUIRED');
    expect(await code({ source_type: 'SUPPLIER', purchase_date: '2026-10-08', lines: line }, 400)).toBe('SUPPLIER_REQUIRED');
    expect(await code({ source_type: 'SUPPLIER', supplier_id: supplier.id, ozon_order_number: 'X', purchase_date: '2026-10-08', lines: line }, 400)).toBe('OZON_FIELDS_NOT_ALLOWED');
    expect(await code(ozon(`  oz-${RUN}-1 `, line), 409)).toBe('OZON_ORDER_EXISTS'); // same number, other case and spaces
    await as('admin').post('/staff/purchases', { ...ozon(number, line), ozon_account_id: account2.id }, randomUUID()).expect(201); // other account: fine
    expect(await code(ozon(`DUP-${RUN}`, [line[0], line[0]]), 400)).toBe('DUPLICATE_PRODUCT');
    await as('admin').post('/staff/purchases', ozon(`ZERO-${RUN}`, [{ product_id: p1.id, ordered_qty: 0, unit_price_original_uzs: 1 }]), randomUUID()).expect(400);
    await as('admin').post('/staff/purchases', ozon(`NEG-${RUN}`, line, { final_actual_total_uzs: -1 }), randomUUID()).expect(400);
    await as('admin').post('/staff/purchases', ozon(`DATE-${RUN}`, line, { purchase_date: '08.10.2026' }), randomUUID()).expect(400);
    const sup = await as('admin').post('/staff/purchases', { source_type: 'SUPPLIER', supplier_id: supplier.id, purchase_date: '2026-10-01', lines: line }, randomUUID()).expect(201);
    expect(sup.body).toMatchObject({ supplier: { id: supplier.id }, ozon_order_number: null, final_total_missing: true });
    expect(sup.body.lines[0].allocated_total_uzs).toBe(1_000); // no final total: the line price
  });

  // ------------------------------------------------------------------ Ozon cancellation
  it('«Отмена Ozon»: found by account + number, adds to the cancelled quantity once per key, never more than allowed', async () => {
    const found = (await as('admin').get(`/staff/purchases/find-ozon?ozon_account_id=${account.id}&ozon_order_number=${encodeURIComponent(number.toLowerCase())}`).expect(200)).body;
    expect(found.id).toBe(purchaseId);
    await as('admin').get(`/staff/purchases/find-ozon?ozon_account_id=${account2.id}&ozon_order_number=NOPE`).expect(404);

    const key = randomUUID();
    const body = { ozon_account_id: account.id, ozon_order_number: number, product_id: p1.id, cancelled_qty: 4, note: 'Ozon отменил' };
    const first = await as('admin').post('/staff/purchases/cancel', body, key).expect(200);
    await as('admin').post('/staff/purchases/cancel', body, key).expect(200); // repeat: nothing more
    const line = first.body.lines.find((l: { product: { id: string } }) => l.product.id === p1.id);
    expect(line).toMatchObject({ ordered_qty: 10, cancelled_qty: 4, remaining_qty: 6 });
    expect((await prisma.purchase_lines.findFirstOrThrow({ where: { purchase_id: purchaseId, product_id: p1.id } })).cancelled_qty).toBe(4);

    const p = (await as('admin').get(`/staff/purchases/${purchaseId}`).expect(200)).body;
    const allocated = p.lines.map((l: { allocated_total_uzs: number }) => l.allocated_total_uzs);
    expect(allocated.reduce((s: number, n: number) => s + n, 0)).toBe(100_000); // recalculated, still exact
    expect(allocated[0]).toBeLessThan(81_081); // fewer units on this line now
    expect(p.events.filter((e: { type: string }) => e.type === 'CANCELLED')).toHaveLength(1);

    const tooMuch = await as('admin').post('/staff/purchases/cancel', { ...body, cancelled_qty: 7 }, randomUUID()).expect(409);
    expect(tooMuch.body).toMatchObject({ code: 'CANCEL_TOO_MUCH', available: 6 });
    await as('admin').post('/staff/purchases/cancel', { ...body, ozon_order_number: 'NO-SUCH' }, randomUUID()).expect(404);
    await as('admin').post('/staff/purchases/cancel', body).expect(400); // no Idempotency-Key
    const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: purchaseId, action: 'purchase.cancelled' } });
    expect(audit.after_json).toMatchObject({ product_id: p1.id, cancelled_qty: 4 });
  });

  it('lines: ordered not below cancelled + received; a line with received goods stays; header and final total recalculate', async () => {
    const p = (await as('admin').get(`/staff/purchases/${purchaseId}`).expect(200)).body;
    const l1 = p.lines.find((l: { product: { id: string } }) => l.product.id === p1.id);
    const l2 = p.lines.find((l: { product: { id: string } }) => l.product.id === p2.id);
    await prisma.purchase_lines.update({ where: { id: l1.id }, data: { received_qty: 3 } }); // receiving comes in 2B

    const low = await as('admin').patch(`/staff/purchases/${purchaseId}/lines/${l1.id}`, { ordered_qty: 6 }).expect(409);
    expect(low.body).toMatchObject({ code: 'QTY_BELOW_CANCELLED_RECEIVED', minimum: 7 });
    await as('admin').patch(`/staff/purchases/${purchaseId}/lines/${l1.id}`, { ordered_qty: 7 }).expect(200);
    expect((await as('admin').delete(`/staff/purchases/${purchaseId}/lines/${l1.id}`).expect(409)).body.code).toBe('LINE_HAS_RECEIVED');
    await as('admin').delete(`/staff/purchases/${purchaseId}/lines/${l2.id}`).expect(200);
    expect((await as('admin').post(`/staff/purchases/${purchaseId}/lines`, { product_id: p3.id, ordered_qty: 1, unit_price_original_uzs: 1 }).expect(409)).body.code).toBe('LINE_EXISTS');
    await as('admin').post(`/staff/purchases/${purchaseId}/lines`, { product_id: p2.id, ordered_qty: 2, unit_price_original_uzs: 5_000 }).expect(201);

    const noTotal = (await as('admin').patch(`/staff/purchases/${purchaseId}`, { final_actual_total_uzs: null, comment: 'Без итога' }).expect(200)).body;
    expect(noTotal.final_total_missing).toBe(true);
    for (const l of noTotal.lines) expect(l.allocated_total_uzs).toBe(l.base_total_uzs);
    const withTotal = (await as('admin').patch(`/staff/purchases/${purchaseId}`, { final_actual_total_uzs: 50_001 }).expect(200)).body;
    expect(withTotal.lines.reduce((s: number, l: { allocated_total_uzs: number }) => s + l.allocated_total_uzs, 0)).toBe(50_001);
    const types = withTotal.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['LINE_EDITED', 'LINE_REMOVED', 'LINE_ADDED', 'EDITED', 'FINAL_TOTAL_SET']));
  });

  it('status: «отменена полностью» is computed (still EXPECTED); RECEIVED once nothing is expected and something arrived', async () => {
    const created = (await as('admin').post('/staff/purchases', ozon(`FULL-${RUN}`, [{ product_id: p1.id, ordered_qty: 2, unit_price_original_uzs: 1_000 }]), randomUUID()).expect(201)).body;
    const cancelled = (await as('admin').post('/staff/purchases/cancel', { ozon_account_id: account.id, ozon_order_number: `FULL-${RUN}`, product_id: p1.id, cancelled_qty: 2 }, randomUUID()).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'EXPECTED', progress: { fully_cancelled: true, remaining: 0 } });
    expect(cancelled.lines[0].allocated_total_uzs).toBe(0);

    const p = (await as('admin').get(`/staff/purchases/${purchaseId}`).expect(200)).body;
    for (const l of p.lines) await prisma.purchase_lines.update({ where: { id: l.id }, data: { received_qty: l.ordered_qty - l.cancelled_qty } });
    const after = (await as('admin').patch(`/staff/purchases/${purchaseId}`, { comment: 'Всё пришло (тест)' }).expect(200)).body;
    expect(after.status).toBe('RECEIVED');
    expect((await as('admin').get(`/staff/purchases?status=RECEIVED&q=${encodeURIComponent(number)}`).expect(200)).body.items.map((i: { id: string }) => i.id)).toContain(purchaseId);
    expect(created.id).toBeTruthy();
  });

  it('аудит 2.7: filters «частично», «отменена полностью», «просрочена» are computed from the lines', async () => {
    const ids = async (state: string) =>
      (await as('admin').get(`/staff/purchases?state=${state}&q=${RUN}`).expect(200)).body.items.map((i: { id: string }) => i.id);
    const make = async (n: string, date: string) =>
      (await as('admin').post('/staff/purchases', ozon(`${n}-${RUN}`, [{ product_id: p2.id, ordered_qty: 3, unit_price_original_uzs: 1_000 }], { purchase_date: date }), randomUUID()).expect(201)).body;
    const old = await make('OLD', '2026-09-01'); // nothing arrived, waited for months
    const half = await make('HALF', '2026-10-08');
    await prisma.purchase_lines.updateMany({ where: { purchase_id: half.id }, data: { received_qty: 1 } });
    const full = (await as('admin').get(`/staff/purchases?q=FULL-${RUN}`).expect(200)).body.items[0];

    expect(await ids('overdue')).toEqual(expect.arrayContaining([old.id, half.id]));
    expect(await ids('overdue')).not.toContain(full.id); // fully cancelled: nothing to wait for
    expect(await ids('partial')).toContain(half.id);
    expect(await ids('partial')).not.toContain(old.id);
    expect(await ids('cancelled')).toContain(full.id);
    expect(await ids('cancelled')).not.toContain(half.id);
    await as('admin').get('/staff/purchases?state=lost').expect(400);
  });

  // ------------------------------------------------------------------ history and permissions
  it('the history is append-only and a purchase is never deleted', async () => {
    const e = await prisma.purchase_events.findFirstOrThrow({ where: { purchase_id: purchaseId } });
    await expect(prisma.purchase_events.update({ where: { id: e.id }, data: { note: 'x' } })).rejects.toThrow(/append-only/);
    await expect(prisma.purchase_events.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.purchases.delete({ where: { id: purchaseId } })).rejects.toThrow(/cannot be deleted/);
  });

  it('manager sees quantities but no money anywhere; changes are admin only; warehouse and marketer get 403', async () => {
    const list = (await as('manager').get('/staff/purchases').expect(200)).body;
    const card = (await as('manager').get(`/staff/purchases/${purchaseId}`).expect(200)).body;
    const found = (await as('manager').get(`/staff/purchases/find-ozon?ozon_account_id=${account.id}&ozon_order_number=${encodeURIComponent(number)}`).expect(200)).body;
    for (const body of [list, card, found]) {
      const keys = JSON.stringify(body).match(/"([a-z_]+)":/g) ?? [];
      expect(keys.filter((k) => MONEY.test(k))).toEqual([]);
    }
    expect(card.lines[0]).toHaveProperty('ordered_qty');
    expect(card.events.length).toBeGreaterThan(0);

    await as('manager').post('/staff/purchases', ozon(`M-${RUN}`, [{ product_id: p1.id, ordered_qty: 1, unit_price_original_uzs: 1 }]), randomUUID()).expect(403);
    await as('manager').patch(`/staff/purchases/${purchaseId}`, { comment: 'm' }).expect(403);
    await as('manager').post('/staff/purchases/cancel', { ozon_account_id: account.id, ozon_order_number: number, product_id: p1.id, cancelled_qty: 1 }, randomUUID()).expect(403);
    await as('manager').post('/staff/purchases/cost-preview', { lines: [] }).expect(403);
    for (const r of ['warehouse', 'marketer'] as Role[]) {
      await as(r).get('/staff/purchases').expect(403);
      await as(r).get(`/staff/purchases/${purchaseId}`).expect(403);
    }
  });

  it('cost preview gives the same numbers as saving', async () => {
    const res = (await as('admin').post('/staff/purchases/cost-preview', { lines: [{ ordered_qty: 2, unit_price_original_uzs: 50_000 }, { ordered_qty: 1, unit_price_original_uzs: 50_000 }], final_actual_total_uzs: 160_001 }).expect(200)).body;
    expect(res).toMatchObject({ lines_total_uzs: 150_000, difference_uzs: 10_001 });
    expect(res.lines.map((l: { allocated_total_uzs: number }) => l.allocated_total_uzs)).toEqual([106_667, 53_334]);
    expect(res.lines[0].unit_cost_uzs).toEqual({ min: 53_333, max: 53_334 });
  });
});
