import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { StockService } from '../src/inventory/stock.service';
import { attachLegacyOrders, planLegacyOrders } from '../src/orders/attach-legacy-units';
import { OrderUnitsService } from '../src/orders/order-units.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUnits, moveUnits } from '../src/receiving/units';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
/** Money that must never reach manager / warehouse in the assembly block. */
const LEAK = /cost|profit|money/;
const keysOf = (body: unknown) => (JSON.stringify(body).match(/"([A-Za-z_]+)":/g) ?? []).map((k) => k.slice(1, -2));

describe('Stage 2E: physical units for Mini App orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let warehouseId: string;
  let supplierId: string;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let tg = 985_000_000 + (Date.now() % 100_000) * 10;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
  });

  /** A unit-tracked product with units IN_STOCK (expiries in this order, cost 30 000) and the same shelf stock. */
  async function stocked(expiries: string[], opts: { tracked?: boolean; price?: number } = {}) {
    const p = await createTestProduct(prisma, { price: opts.price ?? 100_000, stock: 0, name: `Банки 2E ${RUN}` });
    if (opts.tracked ?? true) await prisma.products.update({ where: { id: p.id }, data: { unit_tracking: true } });
    const units = await addUnits(p.id, expiries);
    return { product: p, units };
  }
  async function addUnits(productId: string, expiries: string[]) {
    const session = await prisma.receiving_sessions.findFirstOrThrow({ where: { supplier_id: supplierId, status: 'OPEN' } });
    return prisma.$transaction(async (tx) => {
      const created = await createUnits(tx, session.id, expiries.map((expiry) => ({ product_id: productId, purchase_id: null, purchase_line_id: null, cost: 30_000n, expiry })), null);
      await moveUnits(tx, { id: { in: created.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
      await stock.receiveUnits(tx, { warehouseId, productId, qty: created.length, referenceType: 'receiving_session', referenceId: session.id, reason: 'e2e', staffId: null });
      return created;
    });
  }
  /** The stock says one more than there are jars (what «не хватает банок» looks like in real life). */
  const phantomStock = (productId: string, n = 1) =>
    prisma.inventory.update({ where: { product_id_warehouse_id: { product_id: productId, warehouse_id: warehouseId } }, data: { actual_qty: { increment: n } } });
  const shelf = async (productId: string) => {
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { product_id_warehouse_id: { product_id: productId, warehouse_id: warehouseId } } });
    return { actual: inv.actual_qty, reserved: inv.reserved_qty };
  };
  const statusOf = async (id: string) => (await prisma.physical_units.findUniqueOrThrow({ where: { id } })).status;
  /** A customer buys `qty` of the product in the Mini App. */
  async function placeOrder(productId: string, qty = 1) {
    const customer = await loginCustomer(app, ++tg);
    const res = await http()
      .post('/api/orders')
      .set(bearer(customer))
      .set('Idempotency-Key', randomUUID())
      .send({ source: 'buy_now', buy_now: { product_id: productId, qty }, recipient_name: 'Клиент Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. Тестовая, 1', payment_method: 'bank_transfer' })
      .expect(201);
    return { id: res.body.id as string, number: res.body.order_number as string, customer };
  }
  const pay = (id: string) => as('manager').post(`/staff/orders/${id}/confirm-payment`);
  const card = async (r: Role, id: string) => (await as(r).get(`/staff/orders/${id}`).expect(200)).body;
  const pick = (r: Role, id: string, body: object) => as(r).post(`/staff/orders/${id}/units/pick`, body);
  const step = (r: Role, id: string, status: string) => as(r).post(`/staff/orders/${id}/status`, { status });
  const active = (orderId: string) => prisma.order_item_units.findMany({ where: { order_id: orderId, released_at: null }, include: { unit: true }, orderBy: { assigned_at: 'asc' } });
  /** paid → all units confirmed → picking → handed to delivery */
  async function ship(orderId: string) {
    for (const a of await active(orderId)) await pick('warehouse', orderId, { physical_id: a.unit.physical_id }).expect(200);
    await step('warehouse', orderId, 'picking').expect(200);
    await step('warehouse', orderId, 'handed_to_delivery').expect(200);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    warehouseId = await stock.mainWarehouseId();
    addr = await seededAddresses(prisma);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    supplierId = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик 2E ${RUN}` }).expect(201)).body.id;
    await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('payment confirmed: units reserved by FEFO, quantity stays reserved (no write-off at payment); repeating reserves nothing twice; the customer sees no units', async () => {
    const { product, units } = await stocked(['2029-01-01', '2027-05-01', '2028-01-01']);
    const o = await placeOrder(product.id, 2);
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 }); // the usual 12-hour reservation by quantity
    expect(await active(o.id)).toHaveLength(0);

    const paid = (await pay(o.id).expect(200)).body;
    expect(paid.status).toBe('paid');
    const mine = await active(o.id);
    expect(mine.map((a) => a.unit.physical_id)).toEqual([units[1].physical_id, units[2].physical_id]); // 2027, 2028
    expect(await statusOf(units[1].id)).toBe('ASSIGNED');
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 }); // not written off: that happens at the handover
    const ev = await prisma.physical_unit_events.findFirstOrThrow({ where: { physical_unit_id: units[1].id, type: 'ASSIGNED' } });
    expect(ev).toMatchObject({ reference_type: 'order', reference_id: o.id });
    expect(ev.note).toContain(`Заказ VITALO ${o.number}`);

    await pay(o.id).expect(200); // a double click
    expect(await active(o.id)).toHaveLength(2);
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 });

    const c = await card('warehouse', o.id);
    expect(c.assembly).toMatchObject({ attention: null, assembling: true, all_picked: false, legacy: false });
    expect(c.assembly.lines[0]).toMatchObject({ qty: 2, picked: 0, recommended: { physical_id: units[1].physical_id, expiry_date: '2027-05-01' } });
    const customerView = (await http().get(`/api/orders/${o.id}`).set(bearer(o.customer)).expect(200)).body;
    expect(JSON.stringify(customerView)).not.toMatch(/V-\d{6}|assembly|units_attention/);
  });

  it('not enough jars: the payment still goes through, «Нужно внимание склада», staff notified, the customer gets the usual «оплачен»; later «Зарезервировать банки»', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    await phantomStock(product.id); // stock 2, jars 1
    const o = await placeOrder(product.id, 2);
    const paid = (await pay(o.id).expect(200)).body;
    expect(paid).toMatchObject({ status: 'paid', payment_status: 'payment_success' });
    expect(await active(o.id)).toHaveLength(0); // all or nothing
    expect(await statusOf(units[0].id)).toBe('IN_STOCK');
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 2 }); // still held: the Mini App cannot sell it again
    const c = await card('warehouse', o.id);
    expect(c.assembly.attention).toContain('нужно банок: 2, свободных на складе: 1');
    const notes = await prisma.notifications.findMany({ where: { template: 'staff.order_units_attention', payload: { path: ['order_number'], equals: o.number } }, include: { staff: true } });
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.staff!.role))).toEqual(new Set(['admin', 'manager']));
    expect(await prisma.notifications.count({ where: { template: 'order.paid', payload: { path: ['order_number'], equals: o.number } } })).toBe(1);

    // nothing can be shipped without units
    expect((await pick('warehouse', o.id, { physical_id: units[0].physical_id }).expect(409)).body.code).toBe('RESERVE_FIRST');
    await step('warehouse', o.id, 'picking').expect(200);
    expect((await step('warehouse', o.id, 'handed_to_delivery').expect(409)).body.code).toBe('UNITS_ATTENTION');
    expect((await as('warehouse').post(`/staff/orders/${o.id}/units/reserve`).expect(409)).body.code).toBe('NOT_ENOUGH_UNITS');

    // the missing jar is found / received (here: the phantom becomes a real unit)
    const session = await prisma.receiving_sessions.findFirstOrThrow({ where: { supplier_id: supplierId, status: 'OPEN' } });
    await prisma.$transaction(async (tx) => {
      const created = await createUnits(tx, session.id, [{ product_id: product.id, purchase_id: null, purchase_line_id: null, cost: 30_000n, expiry: '2028-06-01' }], null);
      await moveUnits(tx, { id: created[0].id }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
    });
    const r = (await as('warehouse').post(`/staff/orders/${o.id}/units/reserve`).expect(200)).body;
    expect(r.assembly.attention).toBeNull();
    expect(r.assembly.lines[0].units).toHaveLength(2);
    await as('manager').post(`/staff/orders/${o.id}/units/reserve`).expect(403);
  });

  it('two payments at the same moment for the last jar: one order gets it, the other waits for the warehouse', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    await phantomStock(product.id); // two orders fit by quantity, one jar exists
    const [a, b] = [await placeOrder(product.id, 1), await placeOrder(product.id, 1)];
    const res = await Promise.all([pay(a.id), pay(b.id)]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.order_item_units.count({ where: { physical_unit_id: units[0].id, released_at: null } })).toBe(1);
    const attention = await prisma.orders.findMany({ where: { id: { in: [a.id, b.id] } }, select: { units_attention: true } });
    expect(attention.filter((x) => x.units_attention).length).toBe(1);
  });

  it('cancel: before payment the quantity is released as before; after payment the jars go back «На складе»', async () => {
    const { product, units } = await stocked(['2028-01-01', '2028-02-01']);
    const unpaid = await placeOrder(product.id, 1);
    await http().post(`/api/orders/${unpaid.id}/cancel`).set(bearer(unpaid.customer)).send({}).expect((r) => expect(r.status).toBeLessThan(300));
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 0 });

    const o = await placeOrder(product.id, 2);
    await pay(o.id).expect(200);
    await pick('warehouse', o.id, { physical_id: units[0].physical_id }).expect(200); // half assembled
    await as('manager').post(`/staff/orders/${o.id}/cancel`, { reason: 'Клиент передумал' }).expect(200);
    for (const u of units) expect(await statusOf(u.id)).toBe('IN_STOCK');
    expect(await active(o.id)).toHaveLength(0);
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 0 }); // nothing was written off, nothing to return twice
    expect((await prisma.physical_unit_events.findFirstOrThrow({ where: { physical_unit_id: units[1].id, type: 'RELEASED' } })).note).toContain('Клиент передумал');
    expect(await prisma.manager_tasks.count({ where: { order_id: o.id, type: 'refund' } })).toBe(1);
    // free again for the next order
    const next = await placeOrder(product.id, 2);
    await pay(next.id).expect(200);
    expect(await active(next.id)).toHaveLength(2);
  });

  it('assembly: rights, wrong input, soft FEFO with a reason, swap; handover only when all jars are confirmed; written off ONCE at the handover; sold at delivery', async () => {
    const { product, units } = await stocked(['2027-01-01', '2028-01-01', '2029-01-01']);
    const other = await stocked(['2028-01-01']);
    const o = await placeOrder(product.id, 2); // reserves 2027 and 2028
    await pay(o.id).expect(200);

    // rights: assembly is for warehouse and admin; the manager only looks; the marketer sees no orders
    expect((await pick('manager', o.id, { physical_id: units[0].physical_id }).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    await as('marketer').get(`/staff/orders/${o.id}`).expect(403);
    expect((await card('manager', o.id)).actions).toMatchObject({ units: false, return_order: false });
    expect((await card('warehouse', o.id)).actions.units).toBe(true);

    expect((await pick('warehouse', o.id, { physical_id: 'абв' }).expect(400)).body.code).toBe('BAD_PHYSICAL_ID');
    expect((await pick('warehouse', o.id, { physical_id: '999999999' }).expect(404)).body.code).toBe('UNIT_NOT_FOUND');
    expect((await pick('warehouse', o.id, { physical_id: other.units[0].physical_id }).expect(409)).body.code).toBe('WRONG_PRODUCT');
    await pick('warehouse', o.id, { physical_id: units[0].physical_id.replace('V-', 'v') }).expect(200); // the suggested jar

    // 2029 instead of the reserved 2028: warning, then a reason
    const fefo = await pick('warehouse', o.id, { physical_id: units[2].physical_id }).expect(409);
    expect(fefo.body).toMatchObject({ code: 'FEFO_REASON_REQUIRED', recommended: { physical_id: units[1].physical_id } });
    expect((await step('warehouse', o.id, 'picking').expect(200)).body.status).toBe('picking');
    expect((await step('warehouse', o.id, 'handed_to_delivery').expect(409)).body.code).toBe('NOT_ALL_PICKED');
    const swapped = (await pick('warehouse', o.id, { physical_id: units[2].physical_id, fefo_reason: 'Банка 2028 с мятой крышкой' }).expect(200)).body;
    expect(swapped.message).toContain('вместо');
    expect(swapped.assembly).toMatchObject({ all_picked: true });
    expect(await statusOf(units[1].id)).toBe('IN_STOCK');
    expect(await shelf(product.id)).toEqual({ actual: 3, reserved: 2 }); // the swap changes no quantities

    // handed to delivery: the only write-off
    await step('warehouse', o.id, 'handed_to_delivery').expect(200);
    expect(await shelf(product.id)).toEqual({ actual: 1, reserved: 0 });
    expect(await statusOf(units[0].id)).toBe('VITALO_DELIVERY');
    const moves = await prisma.inventory_movements.findMany({ where: { reference_type: 'order', reference_id: o.id, movement_type: 'deduct' } });
    expect(moves.map((m) => m.qty)).toEqual([2]); // one deduct of 2, not at payment and not twice
    const snap = await active(o.id);
    expect(snap.every((a) => a.cost_snapshot_uzs === 30_000n)).toBe(true);

    await step('manager', o.id, 'in_transit').expect(200);
    await step('manager', o.id, 'delivered').expect(200);
    expect(await statusOf(units[2].id)).toBe('VITALO_SOLD');
    expect(await shelf(product.id)).toEqual({ actual: 1, reserved: 0 });

    // money: admin sees the cost of the very jars and the profit; manager and warehouse never
    const admin = await card('admin', o.id);
    expect(admin.assembly.lines[0].money).toEqual({ paid_uzs: 200_000, cost_uzs: 60_000, profit_uzs: 140_000 });
    expect(admin.assembly.lines[0].units[0].cost_uzs).toBe(30_000);
    for (const r of ['manager', 'warehouse'] as Role[]) expect(keysOf((await card(r, o.id)).assembly).filter((k) => LEAK.test(k))).toEqual([]);
  });

  it('products without unit tracking work exactly as before: written off at payment, no assembly block', async () => {
    const { product } = await stocked([], { tracked: false });
    await prisma.inventory.update({ where: { product_id_warehouse_id: { product_id: product.id, warehouse_id: warehouseId } }, data: { actual_qty: 5 } }).catch(async () => {
      await prisma.inventory.updateMany({ where: { product_id: product.id }, data: { actual_qty: 5 } });
    });
    const o = await placeOrder(product.id, 2);
    await pay(o.id).expect(200);
    const inv = await prisma.inventory.findFirstOrThrow({ where: { product_id: product.id, actual_qty: { gt: 0 } } });
    expect([inv.actual_qty, inv.reserved_qty]).toEqual([3, 0]);
    expect((await card('warehouse', o.id)).assembly).toBeNull();
    await step('warehouse', o.id, 'picking').expect(200);
    await step('warehouse', o.id, 'handed_to_delivery').expect(200);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: inv.id } })).actual_qty).toBe(3);
  });

  it('a jar cannot be in a Mini App order and a Yandex order at once', async () => {
    const { product, units } = await stocked(['2028-01-01']);
    await phantomStock(product.id);
    const o = await placeOrder(product.id, 1);
    await pay(o.id).expect(200);
    expect(await statusOf(units[0].id)).toBe('ASSIGNED');
    const yandex = (n: string) => as('warehouse').post('/staff/yandex-orders', { external_number: n, order_date: '2026-10-10', lines: [{ product_id: product.id, qty: 1, unit_price_uzs: 150_000 }] });
    expect((await yandex(`YM-2E-${RUN}-1`).expect(409)).body.code).toBe('NOT_ENOUGH_UNITS'); // the only jar is taken by the Mini App order
    // the database refuses it too
    const second = await stocked(['2028-01-01']);
    const y = (await as('warehouse').post('/staff/yandex-orders', { external_number: `YM-2E-${RUN}-2`, order_date: '2026-10-10', lines: [{ product_id: second.product.id, qty: 1, unit_price_uzs: 1 }] }).expect(201)).body;
    await expect(prisma.marketplace_order_units.create({ data: { order_id: y.id, line_id: y.lines[0].id, physical_unit_id: units[0].id } })).rejects.toThrow(/already in a VITALO order/);
    const item = await prisma.order_items.findFirstOrThrow({ where: { order_id: o.id } });
    await expect(prisma.order_item_units.create({ data: { order_id: o.id, order_item_id: item.id, physical_unit_id: second.units[0].id } })).rejects.toThrow(/already in a Yandex order/);
    // and the Yandex order cannot type the Mini App jar
    expect((await as('warehouse').post(`/staff/yandex-orders/${y.id}/pick`, { physical_id: units[0].physical_id }).expect(409)).body.code).toBe('WRONG_PRODUCT');
  });

  it('return after the handover: order cancelled / return, jars «Возврат на проверке», decided on the warehouse screen', async () => {
    const { product, units } = await stocked(['2028-01-01', '2028-02-01']);
    const o = await placeOrder(product.id, 1);
    await pay(o.id).expect(200);
    await ship(o.id);
    await as('manager').post(`/staff/orders/${o.id}/return`, { reason: 'Не забрал' }).expect(403);
    const r = (await as('warehouse').post(`/staff/orders/${o.id}/return`, { reason: 'Клиент не забрал заказ' }).expect(200)).body;
    expect(r.status).toBe('cancelled');
    expect(await statusOf(units[0].id)).toBe('RETURNED');
    expect(await shelf(product.id)).toEqual({ actual: 1, reserved: 0 });
    const pending = (await as('warehouse').get('/staff/units/returns/pending').expect(200)).body;
    expect(pending.find((p: { id: string }) => p.id === units[0].id).vitalo_order).toMatchObject({ id: o.id, order_number: o.number });
    await as('warehouse').post(`/staff/units/${units[0].id}/return-decision`, { decision: 'ACCEPT', reason: 'Банка целая', checked: true }).expect(200);
    expect(await statusOf(units[0].id)).toBe('IN_STOCK');
    expect(await shelf(product.id)).toEqual({ actual: 2, reserved: 0 });
    expect(await active(o.id)).toHaveLength(0);
    expect(await prisma.manager_tasks.count({ where: { order_id: o.id, type: 'refund' } })).toBe(1);

    // a delivered order: «Возврат»
    const d = await placeOrder(product.id, 1);
    await pay(d.id).expect(200);
    await ship(d.id);
    await step('manager', d.id, 'in_transit').expect(200);
    await step('manager', d.id, 'delivered').expect(200);
    expect((await as('admin').post(`/staff/orders/${d.id}/return`, { reason: 'Брак' }).expect(200)).body.status).toBe('return');
    const before = await placeOrder(product.id, 1);
    expect((await as('warehouse').post(`/staff/orders/${before.id}/return`, { reason: 'Рано' }).expect(409)).body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('«Сверка» converges through the whole life of a Mini App order; reserve = jars of both channels + quantity of unpaid orders', async () => {
    const { product } = await stocked(['2028-01-01', '2028-02-01', '2028-03-01', '2028-04-01']);
    const rec = async () => (await as('warehouse').get('/staff/units/reconcile').expect(200)).body.items.find((i: { product_id: string }) => i.product_id === product.id);
    const o = await placeOrder(product.id, 1);
    const unpaid = await placeOrder(product.id, 1);
    await as('warehouse').post('/staff/yandex-orders', { external_number: `YM-2E-${RUN}-R`, order_date: '2026-10-10', lines: [{ product_id: product.id, qty: 1, unit_price_uzs: 1 }] }).expect(201);
    await pay(o.id).expect(200);
    expect(await rec()).toMatchObject({ units_in_stock: 4, units_reserved_yandex: 1, units_reserved_vitalo: 1, actual_qty: 4, reserved_qty: 3, reserved_vitalo: 1, difference: 0, state: 'ok' });
    await ship(o.id);
    expect(await rec()).toMatchObject({ units_in_stock: 3, units_reserved_vitalo: 0, actual_qty: 3, reserved_qty: 2, difference: 0, state: 'ok' });
    expect(unpaid.id).toBeTruthy();
  });

  it('orders paid before 2E (no jars): recognised, shown as «старые заказы без банок», still work the old way; the script attaches jars to the not yet shipped ones', async () => {
    // the old world: the product is not unit-tracked yet, the order is written off at payment
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Старый заказ 2E ${RUN}` });
    await addUnits(p.id, ['2028-01-01', '2028-02-01', '2028-03-01']);
    const [open, shipped] = [await placeOrder(p.id, 1), await placeOrder(p.id, 1)];
    await pay(open.id).expect(200);
    await pay(shipped.id).expect(200);
    await step('warehouse', shipped.id, 'picking').expect(200);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });
    // … then the product becomes unit-tracked (stage 2E is switched on)
    await prisma.products.update({ where: { id: p.id }, data: { unit_tracking: true } });
    expect((await card('warehouse', open.id)).assembly).toMatchObject({ legacy: true, attention: null });
    // the old way still works: handover without jars, nothing written off again
    await step('warehouse', shipped.id, 'handed_to_delivery').expect(200);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });

    const units = app.get(OrderUnitsService);
    const plan = await planLegacyOrders(prisma, stock);
    expect(plan.attach.map((o) => o.order_number)).toContain(open.number);
    expect(plan.shipped.map((o) => o.order_number)).toContain(shipped.number);
    expect(await active(open.id)).toHaveLength(0); // the plan writes nothing

    const mine = { attach: plan.attach.filter((o) => o.id === open.id), shipped: [] };
    const res = await attachLegacyOrders(prisma, stock, units, mine);
    expect(res).toMatchObject({ done: [{ order_number: open.number }], failed: [] });
    expect(await active(open.id)).toHaveLength(1);
    expect(await shelf(p.id)).toEqual({ actual: 2, reserved: 1 }); // back on the shelf and held by the order
    expect((await card('warehouse', open.id)).assembly).toMatchObject({ legacy: false });
    // … and now it is shipped like any 2E order, written off once
    await ship(open.id);
    expect(await shelf(p.id)).toEqual({ actual: 1, reserved: 0 });
    // again: nothing more to attach for it
    expect((await planLegacyOrders(prisma, stock)).attach.map((o) => o.id)).not.toContain(open.id);
  });
});
