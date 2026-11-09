import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { tashkentDateString } from '../src/common/tashkent';
import { StockService } from '../src/inventory/stock.service';
import { CrossBorderService } from '../src/orders/cross-border.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
const inDays = (days: number) => {
  const d = tashkentDateString(new Date(Date.now() + days * 86_400_000));
  return { dmy: `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`, iso: d };
};

describe('D-60/D-61: «под заказ» (iHerb из США, a local supplier) and its tracking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let cb: CrossBorderService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let tg = 986_000_000 + (Date.now() % 100_000) * 10;
  const tokens = {} as Record<Role, string>;
  const sup = {} as Record<'iherb' | 'ozon' | 'local', { id: string }>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
    put: (p: string, body: object = {}) => http().put(`/api${p}`).set(bearer(tokens[r])).send(body),
    patch: (p: string, body: object = {}) => http().patch(`/api${p}`).set(bearer(tokens[r])).send(body),
  });

  /** A product with nothing in Tashkent, bought from `from` and — eligible — «под заказ» there when the stock is zero. */
  async function underOrder(from: 'iherb' | 'local', opts: { eligible?: boolean; stock?: number; price?: number } = {}) {
    const p = await createTestProduct(prisma, { price: opts.price ?? 200_000, stock: opts.stock ?? 0, name: `Под заказ ${from} ${RUN}` });
    await prisma.product_suppliers.create({ data: { product_id: p.id, supplier_id: sup[from].id } });
    return prisma.products.update({ where: { id: p.id }, data: { on_zero_supplier_id: opts.eligible === false ? null : sup[from].id } });
  }
  const usa = (opts: { eligible?: boolean; stock?: number; price?: number } = {}) => underOrder('iherb', opts);
  const checkout = (extra: object) => ({ recipient_name: 'Клиент Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. Тестовая, 1', payment_method: 'bank_transfer', ...extra });
  async function placeOrder(lines: { product_id: string; qty: number }[], method = 'bank_transfer') {
    const customer = await loginCustomer(app, ++tg);
    for (const l of lines) await http().post('/api/cart/items').set(bearer(customer)).send(l).expect(201);
    const res = await http().post('/api/orders').set(bearer(customer)).set('Idempotency-Key', randomUUID()).send(checkout({ source: 'cart', payment_method: method }));
    return { res, customer, id: res.body.id as string, number: res.body.order_number as string };
  }
  const pay = (id: string) => as('manager').post(`/staff/orders/${id}/confirm-payment`).expect(200);
  const mine = async (o: { id: string; customer: string }) => (await http().get(`/api/orders/${o.id}`).set(bearer(o.customer)).expect(200)).body;
  const messages = (orderId: string, template: string) => prisma.notifications.findMany({ where: { order_id: orderId, template }, orderBy: { created_at: 'asc' } });
  const itemOf = async (orderId: string, productId: string) => prisma.order_items.findFirstOrThrow({ where: { order_id: orderId, product_id: productId } });

  async function receiveByPurchase(productId: string, qty: number, expiryDays = 400) {
    const supplier = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `iHerb ${RUN} ${randomUUID().slice(0, 6)}` }).expect(201)).body;
    const purchase = (await as('admin').post('/staff/purchases', { source_type: 'SUPPLIER', supplier_id: supplier.id, purchase_date: inDays(0).iso, lines: [{ product_id: productId, ordered_qty: qty, unit_price_original_uzs: 90_000 }] }).expect(201)).body;
    const session = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplier.id }).expect(200)).body;
    await as('warehouse').post(`/staff/receiving/sessions/${session.id}/accept`, { product_id: productId, qty, expiry_groups: [{ expiry: inDays(expiryDays).dmy, qty }] }).expect(200);
    await as('warehouse').post(`/staff/receiving/sessions/${session.id}/complete`).expect(200);
    return purchase;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    cb = app.get(CrossBorderService);
    addr = await seededAddresses(prisma);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    // the migration made them: Ozon (stock only), iHerb (from abroad, «из США»), Glorious Healthy Nutrition (local)
    sup.iherb = await prisma.suppliers.findUniqueOrThrow({ where: { code: 'iherb' } });
    sup.ozon = await prisma.suppliers.findUniqueOrThrow({ where: { code: 'ozon' } });
    sup.local = await prisma.suppliers.findFirstOrThrow({ where: { kind: 'local', name: { startsWith: 'Glorious' } } });
    // the default terms: from abroad 7–14 days, guarantee 21; local 1–2 days, guarantee 7
    await prisma.suppliers.updateMany({ where: { id: { in: [sup.iherb.id, sup.local.id] } }, data: { days_min: null, days_max: null, guarantee_days: null, status: 'active' } });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('shop: nothing in Tashkent + switched on → «из США» (up to 99, prepayment only); switched off or iHerb has none → out of stock', async () => {
    const p = await usa();
    const off = await usa({ eligible: false });
    const card = (await http().get(`/api/catalog/products/${p.id}`).expect(200)).body;
    expect(card).toMatchObject({ in_stock: false, cross_border: true, available_qty: 99 });
    expect((await http().get(`/api/catalog/products/${off.id}`).expect(200)).body).toMatchObject({ in_stock: false, cross_border: false, available_qty: 0 });

    const customer = await loginCustomer(app, ++tg);
    const cart = (await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: p.id, qty: 3 }).expect(201)).body;
    expect(cart.items[0]).toMatchObject({ status: 'available', qty: 3, cross_border: true });
    expect(cart.cross_border).toMatchObject({ expected_from: inDays(7).iso, expected_to: inDays(14).iso, guarantee_days: 21 });
    expect((await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: off.id, qty: 1 }).expect(409)).body.code).toBe('OUT_OF_STOCK');

    const preview = (await http().post('/api/orders/preview').set(bearer(customer)).send(checkout({ source: 'cart' })).expect(200)).body;
    expect(preview).toMatchObject({ can_place: true, payment_options: { cod: false, cod_unavailable: 'cross_border' } });
    expect(preview.items[0].cross_border).toBe(true);
    expect(preview.cross_border.expected_to).toBe(inDays(14).iso);

    // iHerb itself has none: the newest snapshot says «нет в наличии»
    const upload = await prisma.iherb_uploads.create({ data: {} });
    await prisma.iherb_price_snapshots.create({ data: { upload_id: upload.id, product_id: p.id, iherb_product_id: `e2e-${RUN}`, price_uzs: 150_000n, in_stock: false } });
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.cross_border).toBe(false);
    await prisma.iherb_price_snapshots.create({ data: { upload_id: upload.id, product_id: p.id, iherb_product_id: `e2e-${RUN}`, price_uzs: 150_000n, in_stock: true } });
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.cross_border).toBe(true);
  });

  it('a new product: VTL-H… → iHerb «под заказ», VTL-GH… → iHerb + Glorious, OZN-… → Ozon; the card changes it', async () => {
    const n = String(Date.now()).slice(-7);
    const brand = (await as('admin').post('/staff/dictionaries/brands', { name_ru: `E2E Поставщики ${n}` }).expect(201)).body;
    const create = async (sku: string) =>
      (await as('admin').post('/staff/products', { sku, name_ru: `Поставщики ${sku}`, brand: brand.name_ru, brand_id: brand.id, manufacturer: 'Test', price_uzs: 100_000 }).expect(201)).body;
    const h = await create(`VTL-H${n}`);
    const gh = await create(`VTL-GH${n}`);
    const oz = await create(`OZN-${n}`);
    const other = await create(`VTL-HAIR${n}`);
    expect(h).toMatchObject({ supplier_ids: [sup.iherb.id], on_zero_supplier_id: sup.iherb.id });
    expect(new Set(gh.supplier_ids)).toEqual(new Set([sup.iherb.id, sup.local.id]));
    expect(gh.on_zero_supplier_id).toBe(sup.iherb.id);
    expect(oz).toMatchObject({ supplier_ids: [sup.ozon.id], on_zero_supplier_id: null });
    expect(other).toMatchObject({ supplier_ids: [], on_zero_supplier_id: null });

    // «Если на складе ноль»: only one of the product's suppliers, and not Ozon
    expect((await as('admin').patch(`/staff/products/${oz.id}`, { on_zero_supplier_id: sup.iherb.id }).expect(400)).body.code).toBe('ON_ZERO_NOT_SUPPLIER');
    expect((await as('admin').patch(`/staff/products/${oz.id}`, { on_zero_supplier_id: sup.ozon.id }).expect(400)).body.code).toBe('ON_ZERO_NOT_ORDERABLE');
    // the owner picks the local supplier for GH: «под заказ • 1–2 дня»
    expect((await as('admin').patch(`/staff/products/${gh.id}`, { on_zero_supplier_id: sup.local.id }).expect(200)).body.on_zero_supplier_id).toBe(sup.local.id);
    // removing the supplier from «Где берём» also removes it from «под заказ»
    expect((await as('admin').patch(`/staff/products/${h.id}`, { supplier_ids: [sup.ozon.id] }).expect(200)).body).toMatchObject({ supplier_ids: [sup.ozon.id], on_zero_supplier_id: null });

    // the supplier tabs of the products and the brands
    const list = (await as('admin').get(`/staff/products?q=${n}&supplier_id=${sup.local.id}`).expect(200)).body;
    expect(list.items.map((i: { sku: string }) => i.sku)).toEqual([`VTL-GH${n}`]);
    expect(list.items[0].suppliers.map((s: { name: string }) => s.name).sort()).toEqual(['Glorious Healthy Nutrition', 'iHerb'].sort());
    expect((await as('admin').get(`/staff/products?q=${n}&supplier_id=none`).expect(200)).body.items.map((i: { sku: string }) => i.sku)).toEqual([`VTL-HAIR${n}`]);
    const brands = (await as('admin').get(`/staff/dictionaries/brands?supplier_id=${sup.local.id}`).expect(200)).body;
    expect(brands.find((b: { id: string }) => b.id === brand.id)?.products).toBe(1); // only VTL-GH… is bought from Glorious
  });

  it('local supplier «под заказ»: 1–2 days, payment on delivery allowed, short stages, no «отправлена»; one supplier per delivery', async () => {
    const p = await underOrder('local');
    const card = (await http().get(`/api/catalog/products/${p.id}`).expect(200)).body;
    expect(card).toMatchObject({ in_stock: false, cross_border: true, available_qty: 99, cross_border_terms: { kind: 'local', days_min: 1, days_max: 2, guarantee_days: 7, from_ru: null } });
    const customer = await loginCustomer(app, ++tg);
    await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: p.id, qty: 1 }).expect(201);
    const preview = (await http().post('/api/orders/preview').set(bearer(customer)).send(checkout({ source: 'cart' })).expect(200)).body;
    expect(preview.payment_options.cod_unavailable).not.toBe('cross_border');
    expect(preview.cross_border).toMatchObject({ expected_from: inDays(1).iso, expected_to: inDays(2).iso, guarantee_days: 7, foreign: false });

    const o = await placeOrder([{ product_id: p.id, qty: 2 }], 'cod');
    expect(o.res.status).toBe(201);
    expect((await itemOf(o.id, p.id)).supplier_id).toBe(sup.local.id);
    await pay(o.id); // the manager confirms a cash-on-delivery order
    const confirmed = await messages(o.id, 'order.cod_confirmed');
    expect(confirmed[0].payload).toMatchObject({ cb_kind: 'local' });
    expect(await messages(o.id, 'order.cb_paid')).toHaveLength(0);
    let view = await mine(o);
    expect(view.cross_border).toMatchObject({ stage: 'paid', kind: 'local' });
    expect(view.cross_border.steps.map((s: { stage: string }) => s.stage)).toEqual(['paid', 'ordered', 'in_stock']);
    expect(view.cross_border.steps[0].at).not.toBeNull();
    expect(view.cross_border_cancel).toMatchObject({ allowed: true, reason: 'not_ordered', guarantee_date: inDays(7).iso });

    const item = await itemOf(o.id, p.id);
    const waiting = (await as('manager').get('/staff/cross-border/waiting').expect(200)).body;
    expect(waiting.find((w: { item_id: string }) => w.item_id === item.id)).toMatchObject({ cod: true, supplier: { id: sup.local.id, kind: 'local' } });
    // a line from iHerb cannot go into the same delivery
    const u = await placeOrder([{ product_id: (await usa()).id, qty: 1 }]);
    await pay(u.id);
    const usaItem = (await prisma.order_items.findFirstOrThrow({ where: { order_id: u.id } })).id;
    expect((await as('manager').post('/staff/cross-border/batches', { item_ids: [item.id, usaItem] }).expect(409)).body.code).toBe('MIXED_SUPPLIERS');
    const batch = (await as('manager').post('/staff/cross-border/batches', { item_ids: [item.id] }).expect(201)).body;
    expect((await as('manager').post(`/staff/cross-border/batches/${batch.id}/items`, { item_ids: [usaItem] }).expect(409)).body.code).toBe('MIXED_SUPPLIERS');
    expect((await as('manager').post(`/staff/cross-border/batches/${batch.id}/stage`, { stage: 'shipped' }).expect(409)).body.code).toBe('LOCAL_BATCH');
    expect((await as('manager').get('/staff/cross-border/batches').expect(200)).body.find((b: { id: string }) => b.id === batch.id).supplier).toMatchObject({ id: sup.local.id, kind: 'local' });
    view = await mine(o);
    expect(view.cross_border.stage).toBe('ordered');
    expect((await messages(o.id, 'order.cb_stage'))[0].payload).toMatchObject({ stage: 'ordered', cb_kind: 'local' });

    const purchase = await receiveByPurchase(p.id, 2);
    await as('manager').put(`/staff/cross-border/batches/${batch.id}/purchase`, { purchase_id: purchase.id }).expect(200);
    expect((await mine(o)).cross_border.stage).toBe('in_stock');
    await as('warehouse').post(`/staff/orders/${o.id}/status`, { status: 'picking' }).expect(200);
  });

  it('local, payment on delivery: the customer cancels before the order → cancelled; the usual cash-on-delivery task', async () => {
    const p = await underOrder('local');
    const o = await placeOrder([{ product_id: p.id, qty: 1 }], 'cod');
    await pay(o.id);
    await http().post(`/api/orders/${o.id}/cancel`).set(bearer(o.customer)).send({}).expect(200);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled');
    expect((await prisma.manager_tasks.findFirstOrThrow({ where: { order_id: o.id, type: 'refund' } })).note).toContain('с оплатой при получении');
  });

  it('the whole path: order → paid («заказываем в США») → parcel → stages → moved date → receiving gives the jars → picking', async () => {
    const p = await usa();
    const local = await createTestProduct(prisma, { price: 50_000, stock: 5, name: `Склад ${RUN}` });
    expect((await placeOrder([{ product_id: p.id, qty: 2 }], 'cod')).res.status).toBe(422);
    const o = await placeOrder([{ product_id: p.id, qty: 2 }, { product_id: local.id, qty: 1 }]);
    expect(o.res.status).toBe(201);
    expect(o.res.body.items.find((i: { product_id: string }) => i.product_id === p.id).cross_border).toBe(true);
    expect(o.res.body.cross_border).toMatchObject({ stage: null, expected_to: inDays(14).iso });
    expect(await stock.heldByProduct(prisma as never, o.id)).toEqual(new Map([[local.id, 1]])); // nothing reserved for the USA line

    await pay(o.id);
    expect((await messages(o.id, 'order.cb_paid')).length).toBe(1);
    expect(await messages(o.id, 'order.paid')).toHaveLength(0);
    let view = await mine(o);
    expect(view.cross_border).toMatchObject({ stage: 'paid', lines_waiting: 1 });
    expect(view.cross_border_cancel).toMatchObject({ allowed: true, reason: 'not_ordered', guarantee_date: inDays(21).iso });
    expect((await as('warehouse').post(`/staff/orders/${o.id}/status`, { status: 'picking' }).expect(409)).body.code).toBe('CROSS_BORDER_WAITING');

    // the parcel: only the manager (and admin) manage it; the warehouse only looks
    const item = await itemOf(o.id, p.id);
    const waiting = (await as('warehouse').get('/staff/cross-border/waiting').expect(200)).body;
    expect(waiting.find((w: { item_id: string }) => w.item_id === item.id)).toMatchObject({ order_number: o.number, qty: 2 });
    await as('warehouse').post('/staff/cross-border/batches', { item_ids: [item.id] }).expect(403);
    const batch = (await as('manager').post('/staff/cross-border/batches', { item_ids: [item.id], note: 'iHerb #123' }).expect(201)).body;
    await as('manager').post('/staff/cross-border/batches', { item_ids: [item.id] }).expect(409); // already in a parcel
    view = await mine(o);
    expect(view.cross_border.stage).toBe('ordered');
    expect(view.cross_border_cancel.allowed).toBe(false);
    expect((await http().post(`/api/orders/${o.id}/cancel`).set(bearer(o.customer)).send({}).expect(409)).body.code).toBe('ORDER_NOT_CANCELLABLE');

    await as('manager').post(`/staff/cross-border/batches/${batch.id}/stage`, { stage: 'shipped' }).expect(200);
    await as('manager').post(`/staff/cross-border/batches/${batch.id}/stage`, { stage: 'shipped' }).expect(409); // only forward
    await as('manager').post(`/staff/cross-border/batches/${batch.id}/stage`, { stage: 'arrived_uz' }).expect(200);
    const stages = (await messages(o.id, 'order.cb_stage')).map((m) => (m.payload as { stage: string }).stage);
    expect(stages).toEqual(['ordered', 'shipped', 'arrived_uz']);

    // the date is moved with a reason the customer reads
    await as('manager').post('/staff/cross-border/move-date', { batch_id: batch.id, expected_to: inDays(20).iso, reason: 'задержка на таможне' }).expect(200);
    view = await mine(o);
    expect(view.cross_border).toMatchObject({ expected_to: inDays(20).iso, delays: [{ expected_to: inDays(20).iso, reason: 'задержка на таможне' }] });
    expect((await messages(o.id, 'order.cb_delay'))[0].payload).toMatchObject({ reason: 'задержка на таможне', expected_to: inDays(20).iso });
    await as('manager').post('/staff/cross-border/move-date', { order_id: o.id, expected_to: inDays(-1).iso, reason: 'вчера' }).expect(409);

    // the parcel is received: the jars go to the order (the product becomes unit-tracked: its jars are reserved by FEFO)
    const purchase = await receiveByPurchase(p.id, 2, 500);
    await as('manager').put(`/staff/cross-border/batches/${batch.id}/purchase`, { purchase_id: purchase.id }).expect(200);
    expect((await itemOf(o.id, p.id)).arrived_at).not.toBeNull();
    const reserved = await prisma.order_item_units.findMany({ where: { order_id: o.id, released_at: null }, include: { unit: true } });
    expect(reserved).toHaveLength(2);
    view = await mine(o);
    expect(view.cross_border).toMatchObject({ stage: 'in_stock', lines_waiting: 0 });
    const inStock = (await messages(o.id, 'order.cb_stage')).at(-1)!.payload as { stage: string; expiry: string };
    expect(inStock).toMatchObject({ stage: 'in_stock', expiry: inDays(500).iso });
    expect((await as('manager').get(`/staff/cross-border/batches/${batch.id}`).expect(200)).body).toMatchObject({ stage: 'received', jars: 2, jars_arrived: 2 });
    await as('warehouse').post(`/staff/orders/${o.id}/status`, { status: 'picking' }).expect(200);
  });

  it('the customer cancels before the order in the USA → cancelled, a refund task; after the guarantee term → may cancel again', async () => {
    const p = await usa();
    const a = await placeOrder([{ product_id: p.id, qty: 1 }]);
    await pay(a.id);
    await http().post(`/api/orders/${a.id}/cancel`).set(bearer(a.customer)).send({}).expect(200);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('cancelled');
    expect(await prisma.manager_tasks.findFirst({ where: { order_id: a.id, type: 'refund' } })).not.toBeNull();
    expect((await messages(a.id, 'order.cancelled'))[0].payload).toMatchObject({ reason: '@cb_customer_cancel' });

    const b = await placeOrder([{ product_id: p.id, qty: 1 }]);
    await pay(b.id);
    await as('manager').post('/staff/cross-border/batches', { item_ids: [(await itemOf(b.id, p.id)).id] }).expect(201);
    expect((await mine(b)).cross_border_cancel.allowed).toBe(false);
    await prisma.orders.update({ where: { id: b.id }, data: { paid_at: new Date(Date.now() - 22 * 86_400_000) } });
    expect((await mine(b)).cross_border_cancel).toMatchObject({ allowed: true, reason: 'guarantee' });
    await http().post(`/api/orders/${b.id}/cancel`).set(bearer(b.customer)).send({}).expect(200);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
  });

  it('staff: the promised day passed → one reminder per date; «Отдать банки со склада» gives the Tashkent stock early', async () => {
    const p = await usa();
    const o = await placeOrder([{ product_id: p.id, qty: 1 }]);
    await pay(o.id);
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: o.id } });
    await prisma.orders.update({ where: { id: o.id }, data: { expected_to: new Date(`${inDays(-2).iso}T00:00:00Z`) } });
    const staffCount = () => prisma.notifications.count({ where: { template: 'staff.cb_overdue', payload: { path: ['order_number'], equals: order.order_number } } });
    await cb.remindOverdue();
    const first = await staffCount();
    expect(first).toBeGreaterThan(0);
    await cb.remindOverdue();
    expect(await staffCount()).toBe(first);

    const item = await itemOf(o.id, p.id);
    expect((await as('manager').post(`/staff/cross-border/items/${item.id}/attach`).expect(409)).body.code).toBe('INSUFFICIENT_STOCK');
    await prisma.inventory.updateMany({ where: { product_id: p.id }, data: { actual_qty: 1 } });
    await as('manager').post(`/staff/cross-border/items/${item.id}/attach`).expect(200);
    expect((await mine(o)).cross_border.stage).toBe('in_stock');
    expect(await prisma.inventory.findFirstOrThrow({ where: { product_id: p.id } })).toMatchObject({ actual_qty: 0, reserved_qty: 0 }); // written off: the order is paid
  });

  it('the terms live with each supplier: only the admin changes them; the window follows; the longest supplier wins', async () => {
    await as('manager').patch(`/staff/dictionaries/suppliers/${sup.iherb.id}`, { days_min: 10 }).expect(403);
    expect((await as('admin').patch(`/staff/dictionaries/suppliers/${sup.iherb.id}`, { days_max: 5, days_min: 10 }).expect(400)).body.code).toBe('BAD_TERMS');
    expect((await as('admin').patch(`/staff/dictionaries/suppliers/${sup.iherb.id}`, { kind: 'local' }).expect(400)).body.code).toBe('SUPPLIER_KIND_FIXED');
    const saved = (await as('admin').patch(`/staff/dictionaries/suppliers/${sup.iherb.id}`, { days_min: 10, days_max: 20, guarantee_days: 30 }).expect(200)).body;
    expect(saved).toMatchObject({ kind: 'foreign', from_ru: 'из США', days_min: 10, days_max: 20, guarantee_days: 30 });
    const p = await usa();
    const l = await underOrder('local');
    const customer = await loginCustomer(app, ++tg);
    await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: l.id, qty: 1 }).expect(201);
    const cart = (await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: p.id, qty: 1 }).expect(201)).body;
    expect(cart.cross_border).toMatchObject({ expected_from: inDays(10).iso, expected_to: inDays(20).iso, guarantee_days: 30, foreign: true, from_ru: 'из США' });
    // a foreign line in the order: prepayment only
    const preview = (await http().post('/api/orders/preview').set(bearer(customer)).send(checkout({ source: 'cart' })).expect(200)).body;
    expect(preview.payment_options).toMatchObject({ cod: false, cod_unavailable: 'cross_border' });
    await prisma.suppliers.update({ where: { id: sup.iherb.id }, data: { days_min: null, days_max: null, guarantee_days: null } });
  });
});
