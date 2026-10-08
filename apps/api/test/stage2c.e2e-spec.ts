import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { StockService } from '../src/inventory/stock.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUnits, moveUnits } from '../src/receiving/units';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
/** Money that must never reach the warehouse in Yandex order and unit answers. */
const LEAK = /cost|commission|profit|money/;
const keysOf = (body: unknown) => (JSON.stringify(body).match(/"([A-Za-z_]+)":/g) ?? []).map((k) => k.slice(1, -2));

describe('Stage 2C: Yandex orders and the unit life cycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let warehouseId: string;
  let supplierId: string;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}, key: string | null = randomUUID()) => {
      const req = http().post(`/api${p}`).set(bearer(tokens[r]));
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    },
    patch: (p: string, body: object) => http().patch(`/api${p}`).set(bearer(tokens[r])).send(body),
  });

  /** A unit-tracked product with units IN_STOCK (expiries in this order, cost 10 000 each) and the same shelf stock. */
  async function stocked(expiries: string[], cost = 10_000n) {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Банки 2C ${RUN}` });
    await prisma.products.update({ where: { id: p.id }, data: { unit_tracking: true } });
    const session = await prisma.receiving_sessions.findFirstOrThrow({ where: { supplier_id: supplierId, status: 'OPEN' } });
    const units = await prisma.$transaction(async (tx) => {
      const created = await createUnits(tx, session.id, expiries.map((expiry) => ({ product_id: p.id, purchase_id: null, purchase_line_id: null, cost, expiry })), null);
      await moveUnits(tx, { id: { in: created.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
      await stock.receiveUnits(tx, { warehouseId, productId: p.id, qty: created.length, referenceType: 'receiving_session', referenceId: session.id, reason: 'e2e', staffId: null });
      return created;
    });
    return { product: p, units };
  }
  const shelf = async (productId: string) => {
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { product_id_warehouse_id: { product_id: productId, warehouse_id: warehouseId } } });
    return { actual: inv.actual_qty, reserved: inv.reserved_qty };
  };
  const statusOf = async (id: string) => (await prisma.physical_units.findUniqueOrThrow({ where: { id } })).status;
  let orderNo = 0;
  const newOrder = (r: Role, lines: { product_id: string; qty: number; unit_price_uzs?: number }[], extra: object = {}, key?: string) =>
    as(r).post('/staff/yandex-orders', { external_number: `YM-${RUN}-${++orderNo}`, order_date: '2026-10-10', lines: lines.map((l) => ({ unit_price_uzs: 200_000, ...l })), ...extra }, key);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    warehouseId = await stock.mainWarehouseId();
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    supplierId = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик 2C ${RUN}` }).expect(201)).body.id;
    await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('roles: Yandex orders for warehouse and admin; manager only views (no money); write-off and correction for admin only', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    expect((await as('marketer').get('/staff/yandex-orders').expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    await as('manager').get('/staff/yandex-orders').expect(200);
    await as('manager').get(`/staff/yandex-orders/price-hints?product_ids=${product.id}`).expect(403);
    for (const r of ['manager', 'marketer'] as Role[]) {
      await newOrder(r, [{ product_id: product.id, qty: 1 }]).expect(403);
      await as(r).post(`/staff/units/${units[0].id}/missing`, { reason: 'не нашли' }).expect(403);
      await as(r).post(`/staff/units/${units[0].id}/return-decision`, { decision: 'ACCEPT', reason: 'проверена', checked: true }).expect(403);
    }
    await as('warehouse').get('/staff/yandex-orders').expect(200);
    await as('warehouse').post(`/staff/units/${units[0].id}/write-off`, { reason: 'разбита' }).expect(403);
    await as('warehouse').post(`/staff/units/${units[0].id}/correct`, { reason: 'ошибка', expiry_date: '2029-01-01' }).expect(403);
    expect((await newOrder('warehouse', [{ product_id: product.id, qty: 1 }], { commission_percent: 10 }).expect(403)).body.code).toBe('COMMISSION_FORBIDDEN');
    expect(await statusOf(units[0].id)).toBe('IN_STOCK'); // nothing happened
  });

  it('create: units reserved at once by FEFO, stock reserved (Mini App sees less); idempotent; unique number; all or nothing', async () => {
    const { product, units } = await stocked(['2029-06-01', '2027-03-01', '2028-01-01']);
    const key = randomUUID();
    const body = { external_number: `YM-${RUN}-fefo`, order_date: '2026-10-10', customer_name: 'Покупатель Я.', lines: [{ product_id: product.id, qty: 2, unit_price_uzs: 150_000 }] };
    const o = (await as('warehouse').post('/staff/yandex-orders', body, key).expect(201)).body;
    expect(o.status).toBe('NEW');
    expect(o.lines[0].units.map((u: { physical_id: string }) => u.physical_id)).toEqual([units[1].physical_id, units[2].physical_id]); // 2027, 2028
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 });
    expect((await stock.availability([product.id])).get(product.id)).toBe(1); // what the Mini App can sell
    expect(await statusOf(units[1].id)).toBe('ASSIGNED');

    const again = (await as('warehouse').post('/staff/yandex-orders', body, key).expect(201)).body;
    expect(again).toMatchObject({ id: o.id, replayed: true });
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 }); // no double reservation
    expect((await as('warehouse').post('/staff/yandex-orders', body).expect(409)).body.code).toBe('ORDER_EXISTS');
    await as('warehouse').post('/staff/yandex-orders', body, null).expect(400); // Idempotency-Key is required

    const tooMany = await newOrder('warehouse', [{ product_id: product.id, qty: 2 }]).expect(409);
    expect(tooMany.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 }); // all or nothing
    expect(await prisma.marketplace_orders.count({ where: { external_number: `YM-${RUN}-${orderNo}` } })).toBe(0);
  });

  it('no selling beyond the shelf: VITALO reservations (by quantity) and Yandex units share one «available»', async () => {
    const { product } = await stocked(['2028-01-01', '2028-02-01']);
    await prisma.inventory.update({ where: { product_id_warehouse_id: { product_id: product.id, warehouse_id: warehouseId } }, data: { reserved_qty: 2 } }); // VITALO orders hold both
    expect((await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(409)).body.code).toBe('INSUFFICIENT_STOCK');
    await prisma.inventory.update({ where: { product_id_warehouse_id: { product_id: product.id, warehouse_id: warehouseId } }, data: { reserved_qty: 1 } });
    await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201);
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 2 });
    expect((await stock.availability([product.id])).get(product.id)).toBe(0); // the Mini App cannot sell it any more
  });

  it('parallel: one unit never goes to two orders (create and pick at the same time)', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    const results = await Promise.all([1, 2, 3].map(() => newOrder('warehouse', [{ product_id: product.id, qty: 1 }])));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.marketplace_order_units.count({ where: { physical_unit_id: units[0].id, released_at: null } })).toBe(1);
    expect(await shelf(product.id)).toEqual({ actual: 1, reserved: 1 });

    // two orders type the same free unit at the same time
    const other = await stocked(['2028-01-01', '2028-01-01', '2028-01-01']);
    const a = (await newOrder('warehouse', [{ product_id: other.product.id, qty: 1 }]).expect(201)).body;
    const b = (await newOrder('warehouse', [{ product_id: other.product.id, qty: 1 }]).expect(201)).body;
    const free = other.units.find((u) => ![a, b].some((o) => o.lines[0].units[0].unit_id === u.id))!;
    const picks = await Promise.all([a, b].map((o) => as('warehouse').post(`/staff/yandex-orders/${o.id}/pick`, { physical_id: free.physical_id })));
    expect(picks.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.marketplace_order_units.count({ where: { physical_unit_id: free.id, released_at: null } })).toBe(1);
    expect(await shelf(other.product.id)).toEqual({ actual: 3, reserved: 2 });
  });

  it('pick: wrong input, wrong product, taken, not on stock; soft FEFO with a reason; swap keeps the reservation', async () => {
    const { product, units } = await stocked(['2027-01-01', '2028-01-01', '2029-01-01', '2030-01-01']);
    const strange = await stocked(['2028-01-01']);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201)).body;
    const other = (await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201)).body; // takes 2028
    const pick = (id: string, body: object) => as('warehouse').post(`/staff/yandex-orders/${id}/pick`, body);

    expect((await pick(o.id, { physical_id: 'абв' }).expect(400)).body.code).toBe('BAD_PHYSICAL_ID');
    expect((await pick(o.id, { physical_id: '999999999' }).expect(404)).body.code).toBe('UNIT_NOT_FOUND');
    expect((await pick(o.id, { physical_id: strange.units[0].physical_id }).expect(409)).body.code).toBe('WRONG_PRODUCT');
    expect((await pick(o.id, { physical_id: units[1].physical_id }).expect(409)).body.code).toBe('UNIT_TAKEN');
    await as('warehouse').post(`/staff/units/${units[3].id}/missing`, { reason: 'не нашли на полке' }).expect(200);
    expect((await pick(o.id, { physical_id: units[3].physical_id }).expect(409)).body.code).toBe('UNIT_NOT_AVAILABLE');

    // 2029 instead of the reserved 2027: a reason is needed, then the swap happens
    const fefo = await pick(o.id, { physical_id: units[2].physical_id.replace('V-', 'v') }).expect(409);
    expect(fefo.body).toMatchObject({ code: 'FEFO_REASON_REQUIRED', recommended: { physical_id: units[0].physical_id, expiry_date: '2027-01-01' } });
    const swapped = (await pick(o.id, { physical_id: units[2].physical_id, fefo_reason: 'Банка 2027 с мятой крышкой' }).expect(200)).body;
    expect(swapped.lines[0].units).toMatchObject([{ physical_id: units[2].physical_id, picked: true, fefo_override: 'Банка 2027 с мятой крышкой' }]);
    expect(await statusOf(units[0].id)).toBe('IN_STOCK');
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 }); // 4 − 1 missing; two orders hold one each
    const ev = await prisma.physical_unit_events.findFirstOrThrow({ where: { physical_unit_id: units[2].id, type: 'PICKED' } });
    expect(ev.note).toContain('мятой крышкой');
    expect((await pick(o.id, { physical_id: units[0].physical_id }).expect(409)).body.code).toBe('LINE_COMPLETE');

    // the reserved unit itself: just confirmed, no warning
    expect((await pick(other.id, { physical_id: String(Number(units[1].physical_id.slice(2))) }).expect(200)).body.message).toContain('собрана');
  });

  it('flow: assembled only when all picked → handed over (stock down) → delivered (sold); wrong transitions refused; audit with author', async () => {
    const { product, units } = await stocked(['2027-05-01', '2027-06-01']);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 2 }]).expect(201)).body;
    const act = (a: string, body: object = {}) => as('warehouse').post(`/staff/yandex-orders/${o.id}/${a}`, body);
    expect((await act('deliver').expect(409)).body.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await act('hand-over').expect(409)).body.code).toBe('INVALID_STATUS_TRANSITION');
    await act('pick', { physical_id: units[0].physical_id }).expect(200);
    expect((await act('assemble').expect(409)).body.code).toBe('NOT_ALL_PICKED');
    await act('pick', { physical_id: units[1].physical_id }).expect(200);
    const key = randomUUID();
    expect((await as('warehouse').post(`/staff/yandex-orders/${o.id}/assemble`, {}, key).expect(200)).body.status).toBe('ASSEMBLED');
    expect((await as('warehouse').post(`/staff/yandex-orders/${o.id}/assemble`, {}, key).expect(200)).body.replayed).toBe(true);
    expect((await act('assemble').expect(409)).body.code).toBe('INVALID_STATUS_TRANSITION');

    expect((await act('hand-over').expect(200)).body.status).toBe('HANDED_TO_DELIVERY');
    expect(await shelf(product.id)).toEqual({ actual: 0, reserved: 0 });
    expect(await statusOf(units[0].id)).toBe('YANDEX_DELIVERY');
    expect((await act('deliver').expect(200)).body.status).toBe('DELIVERED');
    expect(await statusOf(units[1].id)).toBe('YANDEX_SOLD');

    const audit = await prisma.audit_logs.findMany({ where: { entity_type: 'marketplace_order', entity_id: o.id, action: 'yandex_order.status' }, include: { staff: true }, orderBy: { created_at: 'asc' } });
    expect(audit.map((a) => (a.after_json as { status: string }).status)).toEqual(['ASSEMBLED', 'HANDED_TO_DELIVERY', 'DELIVERED']);
    expect(audit.every((a) => Number(a.staff!.telegram_user_id) === STAFF_TG.warehouse)).toBe(true);
    const card = (await as('warehouse').get(`/staff/yandex-orders/${o.id}`).expect(200)).body;
    expect(card.history.length).toBeGreaterThanOrEqual(4);
  });

  it('cancel before the handover (also half picked): CANCELLED, units back on stock, reservation released with the reason', async () => {
    const { product, units } = await stocked(['2027-05-01', '2027-06-01']);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 2 }]).expect(201)).body;
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/pick`, { physical_id: units[0].physical_id }).expect(200);
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/cancel`, { reason: 'x' }).expect(400); // a reason is required
    const c = (await as('warehouse').post(`/staff/yandex-orders/${o.id}/cancel`, { reason: 'Покупатель отменил на Яндексе' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Покупатель отменил на Яндексе' });
    expect(c.released.map((r: { physical_id: string }) => r.physical_id).sort()).toEqual(units.map((u) => u.physical_id).sort());
    for (const u of units) expect(await statusOf(u.id)).toBe('IN_STOCK');
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 0 });
    expect((await prisma.physical_unit_events.findFirstOrThrow({ where: { physical_unit_id: units[1].id, type: 'RELEASED' } })).note).toContain('Покупатель отменил');
    expect((await as('warehouse').post(`/staff/yandex-orders/${o.id}/cancel`, { reason: 'ещё раз' }).expect(409)).body.code).toBe('INVALID_STATUS_TRANSITION');
    // the freed units can go to a new order
    await newOrder('warehouse', [{ product_id: product.id, qty: 2 }]).expect(201);
  });

  it('return: after the handover → RETURNED, units wait for a check; back on stock (checked) or written off', async () => {
    const { product, units } = await stocked(['2028-05-01', '2028-06-01']);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 2 }]).expect(201)).body;
    for (const u of units) await as('warehouse').post(`/staff/yandex-orders/${o.id}/pick`, { physical_id: u.physical_id }).expect(200);
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/assemble`).expect(200);
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/hand-over`).expect(200);
    const r = (await as('warehouse').post(`/staff/yandex-orders/${o.id}/cancel`, { reason: 'Покупатель не забрал' }).expect(200)).body;
    expect(r.status).toBe('RETURNED');
    for (const u of units) expect(await statusOf(u.id)).toBe('RETURNED');
    expect(await shelf(product.id)).toEqual({ actual: 0, reserved: 0 });
    const pending = (await as('warehouse').get('/staff/units/returns/pending').expect(200)).body;
    expect(pending.filter((p: { id: string }) => units.some((u) => u.id === p.id))).toHaveLength(2);
    expect(pending.find((p: { id: string }) => p.id === units[0].id).order.external_number).toBe(o.external_number);

    const decide = (id: string, body: object) => as('warehouse').post(`/staff/units/${id}/return-decision`, body);
    expect((await decide(units[0].id, { decision: 'ACCEPT', reason: 'Банка целая' }).expect(400)).body.code).toBe('CHECK_REQUIRED');
    await decide(units[0].id, { decision: 'ACCEPT', reason: 'Банка целая, срок в порядке', checked: true }).expect(200);
    await decide(units[1].id, { decision: 'WRITE_OFF', reason: 'Вскрыта' }).expect(200);
    expect(await statusOf(units[0].id)).toBe('IN_STOCK');
    expect(await statusOf(units[1].id)).toBe('WRITTEN_OFF');
    expect(await shelf(product.id)).toEqual({ actual: 1, reserved: 0 });
    expect((await decide(units[0].id, { decision: 'WRITE_OFF', reason: 'повтор' }).expect(409)).body.code).toBe('UNIT_TRANSITION');
    const decisions = await prisma.marketplace_order_units.findMany({ where: { order_id: o.id } });
    const decisionOf = (unitId: string) => decisions.find((d) => d.physical_unit_id === unitId)!;
    expect([decisionOf(units[0].id), decisionOf(units[1].id)].map((d) => [d.return_decision, !!d.released_at])).toEqual([['ACCEPTED', true], ['WRITTEN_OFF', true]]);
    // the accepted unit is free for a new order
    await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201);

    // a delivered order can be returned too
    const d = await stocked(['2028-01-01']);
    const o2 = (await newOrder('warehouse', [{ product_id: d.product.id, qty: 1 }]).expect(201)).body;
    await as('warehouse').post(`/staff/yandex-orders/${o2.id}/pick`, { physical_id: d.units[0].physical_id }).expect(200);
    for (const a of ['assemble', 'hand-over', 'deliver']) await as('warehouse').post(`/staff/yandex-orders/${o2.id}/${a}`).expect(200);
    expect((await as('warehouse').post(`/staff/yandex-orders/${o2.id}/cancel`, { reason: 'Возврат по браку' }).expect(200)).body.status).toBe('RETURNED');
    expect(await statusOf(d.units[0].id)).toBe('RETURNED');
  });

  it('MISSING and found; write-off (admin, reason); correction (admin, reason, never a unit of an order)', async () => {
    const { product, units } = await stocked(['2028-01-01', '2028-02-01', '2028-03-01']);
    await as('warehouse').post(`/staff/units/${units[0].id}/missing`, { reason: 'н' }).expect(400);
    await as('warehouse').post(`/staff/units/${units[0].id}/missing`, { reason: 'Не нашли при пересчёте' }).expect(200);
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 0 });
    expect((await as('warehouse').post(`/staff/units/${units[0].id}/missing`, { reason: 'ещё раз' }).expect(409)).body.code).toBe('UNIT_TRANSITION');
    await as('warehouse').post(`/staff/units/${units[0].id}/found`, { reason: 'Лежала на другой полке' }).expect(200);
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 0 });
    const card = (await as('warehouse').get(`/staff/units/${units[0].id}`).expect(200)).body;
    expect(card.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['MISSING', 'FOUND']));

    await as('admin').post(`/staff/units/${units[1].id}/write-off`, { reason: 'Истёк срок' }).expect(200);
    expect(await statusOf(units[1].id)).toBe('WRITTEN_OFF');
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 0 });
    expect((await as('admin').post(`/staff/units/${units[1].id}/write-off`, { reason: 'Истёк срок' }).expect(409)).body.code).toBe('UNIT_TRANSITION');

    // correction: a mistaken write-off back on stock, an expiry date; a unit of an order cannot be corrected
    await as('admin').post(`/staff/units/${units[1].id}/correct`, { status: 'IN_STOCK', reason: 'Списали не ту банку' }).expect(200);
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 0 });
    await as('admin').post(`/staff/units/${units[2].id}/correct`, { expiry_date: '2029-03-01', reason: 'Опечатка при приёмке' }).expect(200);
    expect((await prisma.physical_units.findUniqueOrThrow({ where: { id: units[2].id } })).expiry_date.toISOString().slice(0, 10)).toBe('2029-03-01');
    await as('admin').post(`/staff/units/${units[2].id}/correct`, { reason: 'пусто' }).expect(400);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201)).body;
    const assigned = o.lines[0].units[0].unit_id;
    expect((await as('admin').post(`/staff/units/${assigned}/correct`, { status: 'MISSING', reason: 'ошибка' }).expect(409)).body.code).toBe('UNIT_TRANSITION');
    expect((await as('warehouse').post(`/staff/units/${assigned}/missing`, { reason: 'не нашли' }).expect(409)).body.code).toBe('UNIT_TRANSITION');
    const audit = await prisma.audit_logs.findMany({ where: { entity_type: 'physical_unit', entity_id: { in: units.map((u) => u.id) } } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['unit.missing', 'unit.found', 'unit.written_off', 'unit.corrected']));
  });

  it('a unit cannot leave the shelf while VITALO orders hold the whole stock', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    await prisma.inventory.update({ where: { product_id_warehouse_id: { product_id: product.id, warehouse_id: warehouseId } }, data: { reserved_qty: 1 } });
    expect((await as('warehouse').post(`/staff/units/${units[0].id}/missing`, { reason: 'не нашли' }).expect(409)).body.code).toBe('STOCK_RESERVED');
    expect(await statusOf(units[0].id)).toBe('IN_STOCK');
  });

  it('money: warehouse never gets cost, commission or profit; admin sees profit = price − commission − unit cost and edits them', async () => {
    const { product } = await stocked(['2028-01-01', '2028-02-01'], 40_000n);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 2, unit_price_uzs: 100_000 }]).expect(201)).body;
    expect(keysOf(o).filter((k) => LEAK.test(k))).toEqual([]);
    const card = (await as('warehouse').get(`/staff/yandex-orders/${o.id}`).expect(200)).body;
    const list = (await as('warehouse').get('/staff/yandex-orders').expect(200)).body;
    const unit = (await as('warehouse').get(`/staff/units/${o.lines[0].units[0].unit_id}`).expect(200)).body;
    for (const b of [card, list, unit]) expect(keysOf(b).filter((k) => LEAK.test(k))).toEqual([]);
    expect((await as('warehouse').patch(`/staff/yandex-orders/${o.id}`, { commission_percent: 10 }).expect(403)).body.code).toBe('COMMISSION_FORBIDDEN');

    // manager: list and card without money, no actions at all
    const mCard = (await as('manager').get(`/staff/yandex-orders/${o.id}`).expect(200)).body;
    const mList = (await as('manager').get('/staff/yandex-orders').expect(200)).body;
    expect(mCard.lines[0].units).toHaveLength(2);
    for (const b of [mCard, mList]) expect(keysOf(b).filter((k) => LEAK.test(k))).toEqual([]);
    for (const a of ['pick', 'assemble', 'hand-over', 'deliver', 'cancel']) {
      expect((await as('manager').post(`/staff/yandex-orders/${o.id}/${a}`, { physical_id: '1', reason: 'проверка' }).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    }
    await as('manager').patch(`/staff/yandex-orders/${o.id}`, { note: 'x' }).expect(403);
    expect((await as('warehouse').patch(`/staff/yandex-orders/${o.id}`, { note: 'Позвонить курьеру' }).expect(200)).body.note).toBe('Позвонить курьеру');

    const admin = (await as('admin').get(`/staff/yandex-orders/${o.id}`).expect(200)).body;
    // 200 000 − 18.5 % (37 000) − 2 × 40 000 = 83 000
    expect(admin).toMatchObject({ commission_percent: 18.5, money: { revenue_uzs: 200_000, commission_uzs: 37_000, cost_uzs: 80_000, profit_uzs: 83_000 } });
    const edited = (await as('admin').patch(`/staff/yandex-orders/${o.id}`, { commission_percent: 10, prices: [{ line_id: o.lines[0].id, unit_price_uzs: 120_000 }] }).expect(200)).body;
    expect(edited.money).toEqual({ revenue_uzs: 240_000, commission_uzs: 24_000, cost_uzs: 80_000, profit_uzs: 136_000 });
  });

  it('defaults from the product card: Yandex price and commission (else 18.5 %); editable at creation; price hints for the form', async () => {
    const a = await stocked(['2028-01-01', '2028-02-01']);
    const b = await stocked(['2028-01-01']);
    const c = await stocked(['2028-01-01']);
    await prisma.products.update({ where: { id: a.product.id }, data: { yandex_price_uzs: 120_000n, yandex_commission_percent: 15 } });
    await prisma.products.update({ where: { id: b.product.id }, data: { yandex_price_uzs: 80_000n, yandex_commission_percent: null } });
    const create = (lines: object[]) =>
      as('warehouse').post('/staff/yandex-orders', { external_number: `YM-${RUN}-${++orderNo}`, order_date: '2026-10-10', lines });

    const hints = (await as('warehouse').get(`/staff/yandex-orders/price-hints?product_ids=${a.product.id},${c.product.id}`).expect(200)).body;
    expect(hints).toEqual(expect.arrayContaining([{ product_id: a.product.id, yandex_price_uzs: 120_000 }, { product_id: c.product.id, yandex_price_uzs: null }]));

    // price and commission from the card
    const one = (await create([{ product_id: a.product.id, qty: 1 }]).expect(201)).body;
    expect(one.lines[0].unit_price_uzs).toBe(120_000);
    expect((await as('admin').get(`/staff/yandex-orders/${one.id}`).expect(200)).body.commission_percent).toBe(15);
    // the warehouse types another price at creation
    const typed = (await create([{ product_id: a.product.id, qty: 1, unit_price_uzs: 110_000 }]).expect(201)).body;
    expect(typed.lines[0].unit_price_uzs).toBe(110_000);
    // no commission in the card -> 18.5
    const plain = (await create([{ product_id: b.product.id, qty: 1 }]).expect(201)).body;
    expect((await as('admin').get(`/staff/yandex-orders/${plain.id}`).expect(200)).body.commission_percent).toBe(18.5);
    // no Yandex price in the card and none typed -> a clear error, nothing reserved
    expect((await create([{ product_id: c.product.id, qty: 1 }]).expect(400)).body.code).toBe('PRICE_REQUIRED');
    expect(await shelf(c.product.id)).toEqual({ actual: 1, reserved: 0 });
    // the admin sets the commission at creation explicitly
    const own = (await as('admin').post('/staff/yandex-orders', { external_number: `YM-${RUN}-${++orderNo}`, order_date: '2026-10-10', commission_percent: 12, lines: [{ product_id: c.product.id, qty: 1, unit_price_uzs: 50_000 }] }).expect(201)).body;
    expect(own.commission_percent).toBe(12);
  });

  it('the database itself refuses a wrong unit transition and deleting an order', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    await expect(prisma.physical_units.update({ where: { id: units[0].id }, data: { status: 'YANDEX_SOLD' } })).rejects.toThrow(/not allowed/);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201)).body;
    await expect(prisma.marketplace_orders.delete({ where: { id: o.id } })).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.marketplace_orders.update({ where: { id: o.id }, data: { status: 'DELIVERED' } })).rejects.toThrow(/not allowed/);
    await expect(prisma.marketplace_order_units.create({ data: { order_id: o.id, line_id: o.lines[0].id, physical_unit_id: units[0].id } })).rejects.toThrow(/Unique constraint/);
  });

  it('«Сверка»: Yandex orders keep units and stock in step; a VITALO sale (old mechanism) is marked, not an error', async () => {
    const { product, units } = await stocked(['2028-01-01', '2028-02-01', '2028-03-01']);
    const o = (await newOrder('warehouse', [{ product_id: product.id, qty: 1 }]).expect(201)).body;
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/pick`, { physical_id: o.lines[0].units[0].physical_id }).expect(200);
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/assemble`).expect(200);
    const rec = async () => (await as('warehouse').get('/staff/units/reconcile').expect(200)).body.items.find((i: { product_id: string }) => i.product_id === product.id);
    expect(await rec()).toMatchObject({ units_in_stock: 3, units_reserved_yandex: 1, actual_qty: 3, reserved_qty: 1, reserved_vitalo: 0, difference: 0, state: 'ok' });
    await as('warehouse').post(`/staff/yandex-orders/${o.id}/hand-over`).expect(200);
    expect(await rec()).toMatchObject({ units_in_stock: 2, actual_qty: 2, difference: 0, state: 'ok' });
    expect(units).toHaveLength(3);
  });
});
