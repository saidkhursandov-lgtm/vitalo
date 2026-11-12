import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { FinanceRemindersService } from '../src/finance/finance-reminders.service';
import { FinanceService } from '../src/finance/finance.service';
import { markTestOrders, planTestOrders } from '../src/finance/mark-test-orders';
import { StockService } from '../src/inventory/stock.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUnits, moveUnits } from '../src/receiving/units';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const OTHERS: Role[] = ['manager', 'warehouse', 'marketer'];
const RUN = `${process.pid}${Date.now() % 100000}`;

/**
 * Sales are moved into past months of their own (2021, 2022, …) by setting delivered_at directly: other e2e files
 * deliver orders «now», so those months belong to this file only and the sums can be checked to the last сум.
 */
describe('Stage 3: expenses, tax, payroll, analytics — admin only (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let finance: FinanceService;
  let warehouseId: string;
  let supplierId: string;
  let adminId: string;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let tg = 986_000_000 + (Date.now() % 100_000) * 10;
  let yNo = 0;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
    patch: (p: string, body: object) => http().patch(`/api${p}`).set(bearer(tokens[r])).send(body),
    del: (p: string) => http().delete(`/api${p}`).set(bearer(tokens[r])),
  });
  const noon = (day: string) => new Date(`${day}T07:00:00Z`); // 12:00 in Tashkent

  /** A product (price 100 000) with jars IN_STOCK, cost 30 000 each. */
  async function stocked(expiries: string[], tracked = true) {
    const p = await createTestProduct(prisma, { price: 100_000, stock: tracked ? 0 : expiries.length, name: `Финансы ${RUN}` });
    if (!tracked) return { product: p, units: [] };
    await prisma.products.update({ where: { id: p.id }, data: { unit_tracking: true } });
    const session = await prisma.receiving_sessions.findFirstOrThrow({ where: { supplier_id: supplierId, status: 'OPEN' } });
    const units = await prisma.$transaction(async (tx) => {
      const created = await createUnits(tx, session.id, expiries.map((expiry) => ({ product_id: p.id, purchase_id: null, purchase_line_id: null, cost: 30_000n, expiry })), null);
      await moveUnits(tx, { id: { in: created.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
      await stock.receiveUnits(tx, { warehouseId, productId: p.id, qty: created.length, referenceType: 'receiving_session', referenceId: session.id, reason: 'e2e', staffId: null });
      return created;
    });
    return { product: p, units };
  }

  /** A Yandex order delivered on `day`: qty × 200 000, commission 10 %. */
  async function yandexSale(productId: string, qty: number, day: string, number = `S3-${RUN}-${++yNo}`) {
    const o = (await as('admin').post('/staff/yandex-orders', { external_number: number, order_date: day, commission_percent: 10, lines: [{ product_id: productId, qty, unit_price_uzs: 200_000 }] }).expect(201)).body;
    for (const l of o.lines) for (const u of l.units) await as('warehouse').post(`/staff/yandex-orders/${o.id}/pick`, { physical_id: u.physical_id }).expect(200);
    for (const step of ['assemble', 'hand-over', 'deliver']) await as('warehouse').post(`/staff/yandex-orders/${o.id}/${step}`).expect(200);
    await prisma.marketplace_orders.update({ where: { id: o.id }, data: { delivered_at: noon(day) } });
    return { id: o.id as string, number };
  }
  async function yandexReturn(id: string, day: string) {
    await as('warehouse').post(`/staff/yandex-orders/${id}/cancel`, { reason: 'Клиент вернул' }).expect(200);
    await prisma.marketplace_orders.update({ where: { id }, data: { closed_at: noon(day) } });
  }

  /** A Mini App order delivered on `day`: qty × 100 000 (+ the delivery the customer pays). */
  async function vitaloOrder(productId: string, qty = 1) {
    const customer = await loginCustomer(app, ++tg);
    const res = await http()
      .post('/api/orders')
      .set(bearer(customer))
      .set('Idempotency-Key', randomUUID())
      .send({ source: 'buy_now', buy_now: { product_id: productId, qty }, recipient_name: 'Клиент Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. Тестовая, 1', payment_method: 'bank_transfer' })
      .expect(201);
    return { id: res.body.id as string, number: res.body.order_number as string };
  }
  async function vitaloSale(productId: string, qty: number, day: string) {
    const o = await vitaloOrder(productId, qty);
    await as('manager').post(`/staff/orders/${o.id}/confirm-payment`).expect(200);
    const mine = await prisma.order_item_units.findMany({ where: { order_id: o.id, released_at: null }, include: { unit: true } });
    for (const a of mine) await as('warehouse').post(`/staff/orders/${o.id}/units/pick`, { physical_id: a.unit.physical_id }).expect(200);
    for (const [r, status] of [['warehouse', 'picking'], ['warehouse', 'handed_to_delivery'], ['manager', 'in_transit'], ['manager', 'delivered']] as [Role, string][]) {
      await as(r).post(`/staff/orders/${o.id}/status`, { status }).expect(200);
    }
    await prisma.orders.update({ where: { id: o.id }, data: { delivered_at: noon(day) } });
    return o;
  }
  async function vitaloReturn(id: string, day: string) {
    await as('admin').post(`/staff/orders/${id}/return`, { reason: 'Клиент вернул товар' }).expect(200);
    await prisma.order_status_history.updateMany({ where: { order_id: id, to_status: 'return' }, data: { created_at: noon(day) } });
  }
  const analytics = async (from: string, to: string, channel?: string) => (await as('admin').get(`/staff/finance/analytics?from=${from}&to=${to}${channel ? `&channel=${channel}` : ''}`).expect(200)).body;
  const taxMonth = async (month: string, today?: string) => (await finance.tax(today)).months.find((m) => m.month === month)!;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    finance = app.get(FinanceService);
    warehouseId = await stock.mainWarehouseId();
    addr = await seededAddresses(prisma);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    adminId = (await prisma.staff_users.findFirstOrThrow({ where: { telegram_user_id: BigInt(STAFF_TG.admin) } })).id;
    supplierId = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик S3 ${RUN}` }).expect(201)).body.id;
    await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('rights: every money screen and action is refused to manager, warehouse and marketer; the order card shows them no finance block', async () => {
    const { product } = await stocked(['2029-01-01']);
    const o = await vitaloOrder(product.id);
    const MISSING = randomUUID();
    for (const r of OTHERS) {
      for (const p of ['/staff/finance/analytics?from=2021-01-01&to=2021-01-31', '/staff/finance/expenses', '/staff/finance/expense-categories', '/staff/finance/tax', '/staff/finance/payroll']) {
        expect((await as(r).get(p).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
      }
      await as(r).post('/staff/finance/expenses', {}).expect(403);
      await as(r).post('/staff/finance/expense-categories', { name: 'Чужая' }).expect(403);
      await as(r).post('/staff/finance/tax/rate', { from_month: '2099-01', percent: 5 }).expect(403);
      await as(r).post('/staff/finance/tax/2021-01/pay', {}).expect(403);
      await as(r).post('/staff/finance/payroll/employees', { name: 'Чужой', start_month: '2026-11', amount_uzs: 1 }).expect(403);
      await as(r).post(`/staff/finance/payroll/employees/${MISSING}/pay`, {}).expect(403);
      await as(r).patch(`/staff/finance/orders/${o.id}`, { is_test: true }).expect(403);
      await as(r).patch(`/staff/finance/yandex-orders/${MISSING}`, { own_delivery_cost_uzs: 5 }).expect(403);
      const me = (await as(r).get('/staff/auth/me').expect(200)).body;
      expect(me.permissions).not.toContain('finance.manage');
    }
    expect((await as('admin').get('/staff/auth/me').expect(200)).body.permissions).toContain('finance.manage');
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).is_test).toBe(false); // nothing happened
    const managerCard = (await as('manager').get(`/staff/orders/${o.id}`).expect(200)).body;
    expect(JSON.stringify(managerCard)).not.toMatch(/own_delivery_cost|"finance"/);
    expect(managerCard.is_test).toBe(false); // the «ТЕСТ» badge itself is not money
    expect((await as('admin').get(`/staff/orders/${o.id}`).expect(200)).body.finance).toEqual({ own_delivery_cost_uzs: 0 });
  });

  it('control set (March 2021): net profit by the formula, channels add up to the total, unknown cost is flagged; a test order is out and comes back when unflagged', async () => {
    const y = await stocked(['2029-01-01', '2029-02-01']);
    const v = await stocked(['2029-01-01']);
    const loose = await stocked(['x'], false); // sold by quantity: the cost is unknown
    const yo = await yandexSale(y.product.id, 2, '2021-03-05');
    const vo = await vitaloSale(v.product.id, 1, '2021-03-10');
    await vitaloSale(loose.product.id, 1, '2021-03-12');
    await as('admin').patch(`/staff/finance/yandex-orders/${yo.id}`, { own_delivery_cost_uzs: 15_000 }).expect(200);
    await as('admin').patch(`/staff/finance/orders/${vo.id}`, { own_delivery_cost_uzs: 20_000 }).expect(200);
    await as('admin').patch(`/staff/finance/orders/${vo.id}`, { own_delivery_cost_uzs: -1 }).expect(400);
    const cats = (await as('admin').get('/staff/finance/expense-categories').expect(200)).body;
    await as('admin').post('/staff/finance/expenses', { spent_on: '2021-03-10', category_id: cats[0].id, amount_uzs: 25_000, comment: 'Коробки' }).expect(201);
    await finance.addEmployee(adminId, { name: `Контроль ${RUN}`, start_month: '2021-03', amount_uzs: 100_000 }, '2021-03-20');
    await prisma.payroll_employees.updateMany({ where: { name: `Контроль ${RUN}` }, data: { end_month: '2021-03' } });

    const a = await analytics('2021-03-01', '2021-03-31');
    expect(a.channels.yandex).toMatchObject({ revenue: 400_000, cost: 60_000, commission: 40_000, delivery: 15_000, tax: 4_000, profit: 281_000, orders: 1, units: 2 });
    // the delivery the customer paid (20 000 to Tashkent) is neither revenue nor expense
    expect(a.channels.vitalo).toMatchObject({ revenue: 200_000, cost: 30_000, revenue_without_cost: 100_000, commission: 0, delivery: 20_000, tax: 2_000, profit: 148_000, orders: 2 });
    expect(a.sales).toMatchObject({ revenue: 600_000, cost: 90_000, commission: 40_000, delivery: 35_000, tax: 6_000, profit: 429_000 });
    expect(a).toMatchObject({ other_expenses: 25_000, salaries: 100_000, incomplete: true });
    expect(a.net_profit).toBe(600_000 - 90_000 - 40_000 - 35_000 - 6_000 - 25_000 - 100_000);
    for (const k of Object.keys(a.sales)) expect(a.channels.yandex[k] + a.channels.vitalo[k]).toBe(a.sales[k]); // channels = total
    const row = a.products.find((p: { product_id: string }) => p.product_id === y.product.id);
    expect(row).toMatchObject({ qty: 2, revenue: 400_000, cost: 60_000, profit: 300_000, margin_percent: 75, incomplete: false });
    expect(a.products.find((p: { product_id: string }) => p.product_id === loose.product.id)).toMatchObject({ incomplete: true, revenue_without_cost: 100_000 });
    expect(a.top_products[0].sku).toBe(y.product.sku);

    // one channel: the same row, shared expenses and salaries are not mixed in
    const onlyY = await analytics('2021-03-01', '2021-03-31', 'yandex');
    expect(onlyY.sales).toEqual(a.channels.yandex);
    expect(onlyY).toMatchObject({ other_expenses: 0, salaries: 0, shared_expenses_included: false });
    // half of the month: half of the salary
    expect((await analytics('2021-03-01', '2021-03-15')).salaries).toBe(Math.round((100_000 * 15) / 31));
    // the tax screen counts the same way
    expect(await taxMonth('2021-03')).toMatchObject({ turnover_uzs: 600_000, rate_percent: 1, tax_uzs: 6_000, due_day: '2021-04-14', status: 'overdue' });

    // test order: admin flags it → out of analytics and tax, «ТЕСТ» in the list, hidden by the filter, audit
    await as('admin').patch(`/staff/finance/yandex-orders/${yo.id}`, { is_test: true }).expect(200);
    const b = await analytics('2021-03-01', '2021-03-31');
    expect(b.sales).toMatchObject({ revenue: 200_000, commission: 0 });
    expect((await taxMonth('2021-03')).turnover_uzs).toBe(200_000);
    const listed = (await as('warehouse').get(`/staff/yandex-orders?q=${yo.number}`).expect(200)).body.items;
    expect(listed[0]).toMatchObject({ external_number: yo.number, is_test: true });
    expect((await as('warehouse').get(`/staff/yandex-orders?q=${yo.number}&hide_test=true`).expect(200)).body.items).toHaveLength(0);
    expect((await as('manager').get(`/staff/yandex-orders/${yo.id}`).expect(200)).body.is_test).toBe(true);
    const log = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: 'marketplace_order', entity_id: yo.id, action: 'order.marked_test' } });
    expect(log.staff_user_id).toBe(adminId);
    // …and unflagging brings it back
    await as('admin').patch(`/staff/finance/yandex-orders/${yo.id}`, { is_test: false }).expect(200);
    expect((await analytics('2021-03-01', '2021-03-31')).sales.revenue).toBe(600_000);
    expect(await prisma.audit_logs.count({ where: { entity_id: yo.id, action: 'order.unmarked_test' } })).toBe(1);

    // the same for a Mini App order
    await as('admin').patch(`/staff/finance/orders/${vo.id}`, { is_test: true }).expect(200);
    expect((await analytics('2021-03-01', '2021-03-31')).channels.vitalo.revenue).toBe(100_000);
    const vl = (await as('manager').get(`/staff/orders?q=${vo.number}`).expect(200)).body.items;
    expect(vl[0].is_test).toBe(true);
    expect((await as('manager').get(`/staff/orders?q=${vo.number}&hide_test=true`).expect(200)).body.items).toHaveLength(0);
    await as('admin').patch(`/staff/finance/orders/${vo.id}`, { is_test: false }).expect(200);
    expect(await prisma.audit_logs.count({ where: { entity_type: 'order', entity_id: vo.id, action: { in: ['order.marked_test', 'order.unmarked_test', 'order.own_delivery_cost_changed'] } } })).toBe(3);
  });

  it('tax: a return counts in the month it was registered; a paid month never changes (only the difference is shown); the rate changes from a month on', async () => {
    const p = await stocked(['2029-01-01', '2029-02-01', '2029-03-01']);
    const feb = await vitaloSale(p.product.id, 1, '2022-02-20');
    await vitaloSale(p.product.id, 2, '2022-03-10');
    await vitaloReturn(feb.id, '2022-03-03'); // sold in February, came back in March

    expect(await taxMonth('2022-02')).toMatchObject({ turnover_uzs: 100_000, tax_uzs: 1_000, payment: null }); // February is not rewritten
    expect(await taxMonth('2022-03')).toMatchObject({ turnover_uzs: 100_000, tax_uzs: 1_000 }); // 200 000 sold − 100 000 returned
    const march = await analytics('2022-03-01', '2022-03-31');
    expect(march.sales).toMatchObject({ revenue: 100_000, cost: 30_000, units: 1 });

    // mark paid: date + the amount really paid
    await as('admin').post('/staff/finance/tax/2022-02/pay', { paid_on: '2022-03-10' }).expect(400);
    const paid = (await as('admin').post('/staff/finance/tax/2022-02/pay', { paid_on: '2022-03-10', paid_amount_uzs: 1_000 }).expect(200)).body;
    expect(paid.months.find((m: { month: string }) => m.month === '2022-02')).toMatchObject({ status: 'paid', payment: { paid_on: '2022-03-10', paid_amount_uzs: 1_000, tax_at_payment_uzs: 1_000, difference_uzs: 0 } });
    expect((await as('admin').post('/staff/finance/tax/2022-02/pay', { paid_on: '2022-03-11', paid_amount_uzs: 5 }).expect(409)).body.code).toBe('ALREADY_PAID');
    const thisMonth = finance.today().slice(0, 7);
    expect((await as('admin').post(`/staff/finance/tax/${thisMonth}/pay`, { paid_on: finance.today(), paid_amount_uzs: 0 }).expect(409)).body.code).toBe('MONTH_NOT_CLOSED');
    expect(await prisma.audit_logs.count({ where: { action: 'finance.tax_paid', after_json: { path: ['month'], equals: '2022-02' } } })).toBe(1);

    // the numbers of February change after the payment: the paid record stays, the difference is shown
    await as('admin').patch(`/staff/finance/orders/${feb.id}`, { is_test: true }).expect(200);
    const after = await taxMonth('2022-02');
    expect(after).toMatchObject({ turnover_uzs: 0, tax_uzs: 0, status: 'paid', payment: { paid_amount_uzs: 1_000, tax_at_payment_uzs: 1_000, difference_uzs: -1_000 } });
    const stored = await prisma.tax_payments.findUniqueOrThrow({ where: { month: '2022-02' } });
    expect(stored).toMatchObject({ paid_amount_uzs: 1_000n, turnover_uzs: 100_000n, tax_uzs: 1_000n });
    await as('admin').patch(`/staff/finance/orders/${feb.id}`, { is_test: false }).expect(200);

    // rate 2 % from March 2022 («today» is 5 March 2022): February keeps 1 %, a past month is refused
    await expect(finance.setTaxRate(adminId, '2022-02', 3, '2022-03-05')).rejects.toMatchObject({ response: { code: 'PAST_MONTH' } });
    await finance.setTaxRate(adminId, '2022-03', 2, '2022-03-05');
    expect(await taxMonth('2022-02')).toMatchObject({ rate_percent: 1, tax_uzs: 1_000 });
    expect(await taxMonth('2022-03')).toMatchObject({ rate_percent: 2, tax_uzs: 2_000 });
    expect((await analytics('2022-03-01', '2022-03-31')).sales.tax).toBe(2_000);
    expect(await prisma.audit_logs.count({ where: { action: 'finance.tax_rate_changed' } })).toBeGreaterThan(0);
    await finance.setTaxRate(adminId, '2022-04', 1, '2022-03-05'); // back to 1 % for everything later
    expect((await as('admin').post('/staff/finance/tax/rate', { from_month: '2022-01', percent: 5 }).expect(400)).body.code).toBe('PAST_MONTH');
    expect((await finance.taxRates()).map((r) => `${r.from}:${r.value}`)).toEqual(['2000-01:1', '2022-03:2', '2022-04:1']);
  });

  it('a Yandex return after the delivery takes the revenue, the commission and the cost back in its month', async () => {
    const p = await stocked(['2029-01-01']);
    const o = await yandexSale(p.product.id, 1, '2023-05-20');
    await yandexReturn(o.id, '2023-06-02');
    expect((await analytics('2023-05-01', '2023-05-31')).channels.yandex).toMatchObject({ revenue: 200_000, commission: 20_000, cost: 30_000, tax: 2_000 });
    expect((await analytics('2023-06-01', '2023-06-30')).channels.yandex).toMatchObject({ revenue: -200_000, commission: -20_000, cost: -30_000, tax: 0, orders: -1 });
    expect((await analytics('2023-05-01', '2023-06-30')).channels.yandex).toMatchObject({ revenue: 0, commission: 0, cost: 0 });
  });

  it('payroll: accrued from the start month (November 2026, 400 000), a new amount from a month on, statuses, «Отметить выплаченной»', async () => {
    const name = `Сотрудник ${RUN}`;
    expect((await as('admin').post('/staff/finance/payroll/employees', { name, start_month: '2026-13', amount_uzs: 400_000 }).expect(400)).body).toBeDefined();
    const created = (await as('admin').post('/staff/finance/payroll/employees', { name, start_month: '2026-11', amount_uzs: 400_000 }).expect(201)).body;
    const id = created.employees.find((e: { name: string }) => e.name === name).id as string;
    const mine = async (today: string) => (await finance.payroll(today)).employees.find((e) => e.id === id)!;

    expect((await mine('2026-10-10')).months).toEqual([]); // nothing before November
    expect((await mine('2026-11-20')).months).toEqual([{ month: '2026-11', amount_uzs: 400_000, due_day: '2026-12-14', status: 'due', payment: null }]);
    expect((await mine('2026-12-14')).months.map((m) => `${m.month}:${m.status}`)).toEqual(['2026-12:due', '2026-11:due']);
    expect((await mine('2026-12-15')).months.map((m) => `${m.month}:${m.status}`)).toEqual(['2026-12:due', '2026-11:overdue']);

    // 500 000 from January 2027 («today» is 15 December 2026): November and December keep 400 000
    await expect(finance.updateEmployee(adminId, id, { amount_uzs: 999, from_month: '2026-11' }, '2026-12-15')).rejects.toMatchObject({ response: { code: 'PAST_MONTH' } });
    await finance.updateEmployee(adminId, id, { amount_uzs: 500_000, from_month: '2027-01' }, '2026-12-15');
    expect((await mine('2027-01-20')).months.map((m) => `${m.month}:${m.amount_uzs}`)).toEqual(['2027-01:500000', '2026-12:400000', '2026-11:400000']);

    await finance.paySalary(adminId, id, { month: '2026-11', paid_on: '2026-12-10', amount_uzs: 400_000 }, '2026-12-15');
    expect((await mine('2026-12-15')).months[1]).toMatchObject({ month: '2026-11', status: 'paid', payment: { paid_on: '2026-12-10', amount_uzs: 400_000 } });
    await expect(finance.paySalary(adminId, id, { month: '2026-11', paid_on: '2026-12-11', amount_uzs: 1 }, '2026-12-15')).rejects.toMatchObject({ response: { code: 'ALREADY_PAID' } });
    await expect(finance.paySalary(adminId, id, { month: '2026-10', paid_on: '2026-12-11', amount_uzs: 1 }, '2026-12-15')).rejects.toMatchObject({ response: { code: 'NO_ACCRUAL' } });
    // a paid month cannot get another amount
    await finance.paySalary(adminId, id, { month: '2026-12', paid_on: '2026-12-15', amount_uzs: 400_000 }, '2026-12-15');
    await expect(finance.updateEmployee(adminId, id, { amount_uzs: 1, from_month: '2026-12' }, '2026-12-15')).rejects.toMatchObject({ response: { code: 'MONTH_PAID' } });

    // switched off in January: January is the last accrued month; the name can be changed
    await finance.updateEmployee(adminId, id, { active: false, name: `${name} (ушёл)` }, '2027-01-25');
    const off = await mine('2027-04-01');
    expect(off).toMatchObject({ active: false, end_month: '2027-01', name: `${name} (ушёл)` });
    expect(off.months[0].month).toBe('2027-01');
    expect(await prisma.audit_logs.count({ where: { entity_type: 'payroll_employee', entity_id: id } })).toBe(5); // added, amount, 2 × paid, switched off
  });

  it('expenses: default categories, add / rename / hide (no deletion with records), list with filters and the total, delete with a reason, audit', async () => {
    const cats = (await as('admin').get('/staff/finance/expense-categories').expect(200)).body as { id: string; name: string }[];
    expect(cats.map((c) => c.name)).toEqual(expect.arrayContaining(['Упаковка', 'Реклама', 'Непредвиденные', 'Прочее']));
    expect((await as('admin').post('/staff/finance/expense-categories', { name: 'реклама' }).expect(409)).body.code).toBe('CATEGORY_EXISTS');
    const withNew = (await as('admin').post('/staff/finance/expense-categories', { name: `Аренда ${RUN}` }).expect(201)).body as { id: string; name: string }[];
    const rent = withNew.find((c) => c.name === `Аренда ${RUN}`)!;
    const empty = ((await as('admin').post('/staff/finance/expense-categories', { name: `Пустая ${RUN}` }).expect(201)).body as { id: string; name: string }[]).find((c) => c.name === `Пустая ${RUN}`)!;

    await as('admin').post('/staff/finance/expenses', { spent_on: '2024-07-03', category_id: rent.id, amount_uzs: 0 }).expect(400);
    const e1 = (await as('admin').post('/staff/finance/expenses', { spent_on: '2024-07-03', category_id: rent.id, amount_uzs: 300_000, comment: 'Июль' }).expect(201)).body.id;
    const e2 = (await as('admin').post('/staff/finance/expenses', { spent_on: '2024-07-20', category_id: cats[0].id, amount_uzs: 50_000 }).expect(201)).body.id;
    await as('admin').post('/staff/finance/expenses', { spent_on: '2024-08-01', category_id: rent.id, amount_uzs: 7_000 }).expect(201);

    const july = (await as('admin').get('/staff/finance/expenses?from=2024-07-01&to=2024-07-31').expect(200)).body;
    expect(july.total_uzs).toBe(350_000);
    expect(july.items.map((i: { id: string }) => i.id)).toEqual([e2, e1]);
    expect((await as('admin').get(`/staff/finance/expenses?from=2024-07-01&to=2024-07-31&category_id=${rent.id}`).expect(200)).body.total_uzs).toBe(300_000);
    expect((await analytics('2024-07-01', '2024-07-31')).other_expenses).toBe(350_000);

    await as('admin').patch(`/staff/finance/expenses/${e1}`, { amount_uzs: 320_000 }).expect(200);
    await as('admin').post(`/staff/finance/expenses/${e2}/delete`, {}).expect(400); // a reason is required
    await as('admin').post(`/staff/finance/expenses/${e2}/delete`, { reason: 'Внесли дважды' }).expect(200);
    expect((await as('admin').get('/staff/finance/expenses?from=2024-07-01&to=2024-07-31').expect(200)).body.total_uzs).toBe(320_000);
    expect(await prisma.expenses.findUniqueOrThrow({ where: { id: e2 } })).toMatchObject({ delete_reason: 'Внесли дважды' }); // kept in the database
    await as('admin').post(`/staff/finance/expenses/${e2}/delete`, { reason: 'Ещё раз' }).expect(404);
    expect(await prisma.audit_logs.count({ where: { entity_type: 'expense', entity_id: { in: [e1, e2] } } })).toBe(4); // 2 × added, changed, deleted

    // category: rename, hide; with records it cannot be deleted, an empty one can
    const renamed = (await as('admin').patch(`/staff/finance/expense-categories/${rent.id}`, { name: `Аренда склада ${RUN}`, hidden: true }).expect(200)).body as { id: string; name: string; hidden: boolean }[];
    expect(renamed.find((c) => c.id === rent.id)).toMatchObject({ name: `Аренда склада ${RUN}`, hidden: true, expenses: 2 });
    expect((await as('admin').del(`/staff/finance/expense-categories/${rent.id}`).expect(409)).body.code).toBe('CATEGORY_IN_USE');
    await as('admin').del(`/staff/finance/expense-categories/${empty.id}`).expect(200);
    expect(await prisma.expense_categories.count({ where: { id: empty.id } })).toBe(0);
  });

  it('reminders to admins: the 12th «14-го к оплате», the 14th «не отмечено»; once each, also after a restart; nobody but admins', async () => {
    const reminders = app.get(FinanceRemindersService);
    await finance.addEmployee(adminId, { name: `Напоминание ${RUN}`, start_month: '2031-04', amount_uzs: 400_000 }, '2031-04-01');
    const at = (day: string) => new Date(`${day}T04:00:00Z`);
    const count = (template: string, since: Date) => prisma.notifications.count({ where: { template, created_at: { gte: since } } });
    const admins = await prisma.staff_users.count({ where: { status: 'active', role: 'admin' } });
    const start = new Date();

    expect(await reminders.runOnce(at('2031-05-11'))).toBeNull();
    expect(await reminders.runOnce(at('2031-05-12'))).toBe('before_due');
    expect(await reminders.runOnce(at('2031-05-12'))).toBeNull(); // the same day again
    expect(await app.get(FinanceRemindersService).runOnce(at('2031-05-13'))).toBeNull(); // «after a restart»: the fact is in the database
    expect(await count('staff.finance_before_due', start)).toBe(admins);
    expect(await reminders.runOnce(at('2031-05-14'))).toBe('due_day');
    expect(await reminders.runOnce(at('2031-05-14'))).toBeNull();
    expect(await reminders.runOnce(at('2031-05-16'))).toBeNull();
    expect(await count('staff.finance_due_day', start)).toBe(admins);
    expect(await reminders.runOnce(at('2031-05-22'))).toBeNull();

    const sent = await prisma.notifications.findMany({ where: { template: { in: ['staff.finance_before_due', 'staff.finance_due_day'] }, created_at: { gte: start } }, include: { staff: true } });
    expect(new Set(sent.map((n) => n.staff!.role))).toEqual(new Set(['admin']));
    const payload = sent[0].payload as { tax_uzs: number; salaries_uzs: number };
    expect(payload.salaries_uzs).toBeGreaterThanOrEqual(400_000); // April 2031 is unpaid
    expect(payload.tax_uzs).toBeGreaterThanOrEqual(0);
    expect(await prisma.finance_reminders.count({ where: { day: { gte: new Date('2031-05-01'), lte: new Date('2031-05-31') } } })).toBe(2);
    await prisma.payroll_employees.updateMany({ where: { name: `Напоминание ${RUN}` }, data: { end_month: '2031-04' } });
  });

  it('«Нужно внимание склада»: counter and filter in the Mini App order list; analytics shows these orders, jars expiring within 90 days and stale goods', async () => {
    const { product, units } = await stocked(['2029-01-01']);
    await prisma.inventory.update({ where: { product_id_warehouse_id: { product_id: product.id, warehouse_id: warehouseId } }, data: { actual_qty: { increment: 1 } } }); // stock 2, jars 1
    const o = await vitaloOrder(product.id, 2);
    await as('manager').post(`/staff/orders/${o.id}/confirm-payment`).expect(200);

    const list = (await as('warehouse').get('/staff/orders?units_attention=true').expect(200)).body;
    expect(list.attention_count).toBeGreaterThan(0);
    const mine = list.items.find((i: { id: string }) => i.id === o.id);
    expect(mine.units_attention).toContain('нужно банок: 2');
    expect(list.items.every((i: { units_attention: string | null }) => i.units_attention)).toBe(true);
    expect((await as('warehouse').get('/staff/orders').expect(200)).body.attention_count).toBe(list.attention_count); // the counter does not depend on the filters

    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const exp = await stocked([soon]);
    const today = finance.today();
    const a = await analytics(`${today.slice(0, 7)}-01`, today);
    expect(a.attention.orders_waiting_units.map((x: { id: string }) => x.id)).toContain(o.id);
    expect(a.attention.expiring.map((x: { physical_id: string }) => x.physical_id)).toContain(exp.units[0].physical_id);
    expect(a.attention.expiring.map((x: { physical_id: string }) => x.physical_id)).not.toContain(units[0].physical_id); // 2029
    expect(a.attention.stale.map((x: { product_id: string }) => x.product_id)).toContain(exp.product.id); // on the shelf, never sold
    expect(a.attention.stale.find((x: { product_id: string }) => x.product_id === exp.product.id).cost_uzs).toBeGreaterThan(0); // аудит 4.9: the frozen money
  });

  it('npm run orders:mark-test: lists Yandex TEST-… and every Mini App order, marks only TEST-… and the numbers named by the owner', async () => {
    const p = await stocked(['2029-01-01', '2029-02-01', '2029-03-01']);
    const number = `TEST-${RUN}`;
    await as('admin').post('/staff/yandex-orders', { external_number: number, order_date: '2026-10-10', lines: [{ product_id: p.product.id, qty: 1, unit_price_uzs: 1 }] }).expect(201);
    const named = await vitaloOrder(p.product.id);
    const other = await vitaloOrder(p.product.id);

    const plan = await planTestOrders(prisma, [named.number.toLowerCase(), 'VTL-НЕТ-ТАКОГО']);
    expect(plan.yandexTest.map((r) => r.number)).toContain(number);
    expect(plan.vitaloAll.map((r) => r.number)).toEqual(expect.arrayContaining([named.number, other.number])); // listed, not guessed
    expect(plan.named.map((r) => r.number)).toEqual([named.number]);
    expect(plan.unknown).toEqual(['VTL-НЕТ-ТАКОГО']);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: named.id } })).is_test).toBe(false); // a dry run writes nothing

    const done = await markTestOrders(prisma, plan);
    expect(done.map((r) => r.number)).toEqual(expect.arrayContaining([number, named.number]));
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: named.id } })).is_test).toBe(true);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: other.id } })).is_test).toBe(false);
    expect((await prisma.marketplace_orders.findFirstOrThrow({ where: { external_number: number } })).is_test).toBe(true);
    expect(await prisma.audit_logs.count({ where: { entity_id: named.id, action: 'order.marked_test' } })).toBe(1);
    expect((await planTestOrders(prisma)).yandexTest.map((r) => r.number)).not.toContain(number); // already marked
  });
});
