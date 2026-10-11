import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { printTicketKey, signPrintTicket } from '../src/receiving/print-ticket';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`;
/** The customer's data: on the label only — never in the audit log, the errors or the answers of other endpoints. */
const PII = { name: `Получатель Наклейкин ${RUN}`, phone: '+998935550199', address: `ул. Секретная ${RUN}, дом 7, кв. 12` };

describe('Shipping label of a Mini App order, 75×120 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let tg = 987_000_000 + (Date.now() % 100_000) * 10;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
    patch: (p: string, body: object) => http().patch(`/api${p}`).set(bearer(tokens[r])).send(body),
  });
  /** The print page: no staff token, only the ticket. */
  const print = (ticket: unknown) => http().post('/api/print/order-label').send({ ticket });
  const ticketOf = async (r: Role, id: string) => (await as(r).post(`/staff/orders/${id}/label/ticket`).expect(200)).body.ticket as string;

  async function order(opts: { paid?: boolean; items?: number } = {}) {
    const customerToken = await loginCustomer(app, ++tg);
    const products = [];
    for (let i = 0; i < (opts.items ?? 1); i++) products.push(await createTestProduct(prisma, { price: 60_000 + i * 1000, stock: 5, name: `Товар для наклейки ${RUN}-${i}` }));
    if (products.length > 1) for (const p of products) await http().post('/api/cart/items').set(bearer(customerToken)).send({ product_id: p.id, qty: 2 }).expect((r) => expect([200, 201]).toContain(r.status));
    const body = {
      ...(products.length === 1 ? { source: 'buy_now', buy_now: { product_id: products[0].id, qty: 3 } } : { source: 'cart' }),
      recipient_name: PII.name,
      recipient_phone: PII.phone,
      ...addr.tashkent,
      address_text: PII.address,
      payment_method: 'bank_transfer',
    };
    const res = await http().post('/api/orders').set(bearer(customerToken)).set('Idempotency-Key', randomUUID()).send(body).expect(201);
    if (opts.paid ?? true) await as('manager').post(`/staff/orders/${res.body.id}/confirm-payment`).expect(200);
    return { id: res.body.id as string, number: res.body.order_number as string, products, customerToken };
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('roles: manager, warehouse and admin print; only warehouse and admin edit the waybill; marketer nothing; the card says what is allowed', async () => {
    const o = await order();
    for (const r of ['admin', 'manager', 'warehouse'] as Role[]) expect(await ticketOf(r, o.id)).toMatch(/^[\w-]+\.[\w-]+$/);
    expect((await as('marketer').post(`/staff/orders/${o.id}/label/ticket`).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    await http().post(`/api/staff/orders/${o.id}/label/ticket`).expect(401); // not signed in

    for (const r of ['manager', 'marketer'] as Role[]) await as(r).patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: 'BTS-1' }).expect(403);
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).delivery_waybill).toBeNull();
    await as('warehouse').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: 'BTS-1' }).expect(200);
    await as('admin').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: 'YGO 22/7' }).expect(200);

    expect((await as('manager').get(`/staff/orders/${o.id}`).expect(200)).body).toMatchObject({ delivery_waybill: 'YGO 22/7', actions: { print_label: true, waybill: false } });
    expect((await as('warehouse').get(`/staff/orders/${o.id}`).expect(200)).body.actions).toMatchObject({ print_label: true, waybill: true });
    // the existing rights are as they were
    await as('manager').post(`/staff/orders/${o.id}/units/pick`, { physical_id: 'V-000001' }).expect(403);
    await as('warehouse').post(`/staff/orders/${o.id}/confirm-payment`).expect(403);
  });

  it('the label: number, date, «предоплачено», recipient, phone, address, items (SKU × qty); the waybill only when filled in', async () => {
    const o = await order({ items: 3 });
    const first = (await print(await ticketOf('warehouse', o.id)).expect(200)).body.label;
    const stored = await prisma.orders.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } });
    expect(first).toEqual({
      order_number: o.number,
      order_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      prepaid: true,
      recipient: { name: PII.name, phone: PII.phone },
      address: { region: expect.any(String), city: expect.any(String), text: PII.address },
      items: expect.any(Array),
      waybill: null,
    });
    expect(o.number).toMatch(/^VTL-/);
    expect(first.items).toHaveLength(stored.items.length);
    for (const i of stored.items) expect(first.items).toContainEqual({ sku: i.sku_snapshot, name: i.name_ru_snapshot, qty: i.qty });
    // nothing about money, costs or jars on the label
    expect(JSON.stringify(first)).not.toMatch(/uzs|price|cost|total|physical|V-\d{6}/i);

    await as('warehouse').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: '  BTS-12345678  ' }).expect(200);
    expect((await print(await ticketOf('manager', o.id)).expect(200)).body.label.waybill).toBe('BTS-12345678');
    await as('admin').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: '' }).expect(200); // cleared
    expect((await print(await ticketOf('admin', o.id)).expect(200)).body.label.waybill).toBeNull();
    // the customer does not see the waybill field
    expect(JSON.stringify((await http().get(`/api/orders/${o.id}`).set(bearer(o.customerToken)).expect(200)).body)).not.toContain('waybill');
  });

  it('personal data stays on the label: the audit log gets only «наклейка напечатана» with the order number', async () => {
    const o = await order();
    const before = await prisma.system_errors.count();
    const queued = await prisma.notifications.count();
    await print(await ticketOf('warehouse', o.id)).expect(200);
    await print(await ticketOf('manager', o.id)).expect(200);
    await as('warehouse').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: 'BTS-777' }).expect(200);

    const printed = await prisma.audit_logs.findMany({ where: { entity_type: 'order', entity_id: o.id, action: 'order.label_printed' }, include: { staff: true }, orderBy: { created_at: 'asc' } });
    expect(printed).toHaveLength(2); // every print is recorded
    expect(printed.map((p) => p.staff!.role)).toEqual(['warehouse', 'manager']); // who printed
    for (const p of printed) {
      expect(p.after_json).toEqual({ order_number: o.number }); // the fact and the number — nothing else
      expect(p.before_json).toBeNull();
    }
    const everything = JSON.stringify([
      await prisma.audit_logs.findMany({ where: { action: { in: ['order.label_printed', 'order.waybill_changed'] } } }),
      await prisma.system_errors.findMany({ orderBy: { created_at: 'desc' }, take: 50 }),
    ], (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    for (const value of [PII.name, PII.phone, PII.phone.slice(1), PII.address]) expect(everything).not.toContain(value);
    expect(await prisma.system_errors.count()).toBe(before);
    expect(await prisma.notifications.count()).toBe(queued); // printing sends nobody anything
    const waybill = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: o.id, action: 'order.waybill_changed' } });
    expect(waybill).toMatchObject({ before_json: { delivery_waybill: null }, after_json: { delivery_waybill: 'BTS-777' } });
  });

  it('only a paid, not cancelled Mini App order; Yandex orders have no such label', async () => {
    const unpaid = await order({ paid: false });
    expect((await as('warehouse').post(`/staff/orders/${unpaid.id}/label/ticket`).expect(409)).body.code).toBe('LABEL_NOT_AVAILABLE');
    expect((await as('warehouse').get(`/staff/orders/${unpaid.id}`).expect(200)).body.actions.print_label).toBe(false);

    const cancelled = await order();
    const ticket = await ticketOf('warehouse', cancelled.id);
    await as('manager').post(`/staff/orders/${cancelled.id}/cancel`, { reason: 'Клиент передумал' }).expect(200);
    expect((await print(ticket).expect(409)).body.code).toBe('LABEL_NOT_AVAILABLE'); // a ticket issued before the cancellation prints nothing
    expect((await as('warehouse').post(`/staff/orders/${cancelled.id}/label/ticket`).expect(409)).body.code).toBe('LABEL_NOT_AVAILABLE');
    expect((await as('warehouse').patch(`/staff/orders/${cancelled.id}/waybill`, { delivery_waybill: 'BTS-1' }).expect(409)).body.code).toBe('ORDER_CANCELLED');
    expect(await prisma.audit_logs.count({ where: { entity_id: cancelled.id, action: 'order.label_printed' } })).toBe(0);

    await as('admin').post(`/staff/orders/${randomUUID()}/label/ticket`).expect(404);
    await as('admin').post(`/staff/yandex-orders/${randomUUID()}/label/ticket`).expect(404); // no such route for Yandex
    await as('admin').patch(`/staff/yandex-orders/${randomUUID()}/waybill`, { delivery_waybill: 'X' }).expect(404);
  });

  it('the print ticket: this order only, forged / foreign / expired tickets and a closed session print nothing', async () => {
    const o = await order();
    const other = await order();
    const key = printTicketKey(app.get(ConfigService).get<string>('TELEGRAM_BOT_TOKEN')!);
    const session = await prisma.staff_sessions.findFirstOrThrow({ where: { staff_user: { telegram_user_id: BigInt(STAFF_TG.warehouse) }, revoked_at: null }, orderBy: { created_at: 'desc' } });
    const soon = Math.floor(Date.now() / 1000) + 600;

    const ticket = await ticketOf('warehouse', o.id);
    expect((await print(ticket).expect(200)).body.label.order_number).toBe(o.number); // never another order
    expect(JSON.stringify((await print(ticket).expect(200)).body)).not.toContain(other.number);

    const [body, sig] = ticket.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), order_id: other.id })).toString('base64url');
    for (const bad of [`${forged}.${sig}`, `${body}.AAAA`, 'nonsense', '']) expect((await print(bad)).status).toBeGreaterThanOrEqual(400);
    expect((await print(`${forged}.${sig}`).expect(401)).body.code).toBe('PRINT_TICKET_INVALID');
    expect((await print(signPrintTicket(key, { v: 1, ss: session.id, exp: soon - 1200, order_id: o.id })).expect(401)).body.code).toBe('PRINT_TICKET_EXPIRED');
    // a ticket for jar labels does not open an order, and an order ticket does not print jar labels
    expect((await print(signPrintTicket(key, { v: 1, ss: session.id, exp: soon, unit_ids: [randomUUID()] })).expect(401)).body.code).toBe('PRINT_TICKET_INVALID');
    expect((await http().post('/api/print/labels').send({ ticket })).status).toBeGreaterThanOrEqual(400);
    // two scopes in one ticket are refused
    expect((await print(signPrintTicket(key, { v: 1, ss: session.id, exp: soon, order_id: o.id, unit_ids: [randomUUID()] })).expect(401)).body.code).toBe('PRINT_TICKET_INVALID');
    // a marketer's session cannot print even with a correctly signed ticket
    const marketer = await prisma.staff_sessions.findFirstOrThrow({ where: { staff_user: { telegram_user_id: BigInt(STAFF_TG.marketer) }, revoked_at: null }, orderBy: { created_at: 'desc' } });
    await print(signPrintTicket(key, { v: 1, ss: marketer.id, exp: soon, order_id: o.id })).expect(403);

    // logout ends the ticket at once
    const own = await loginStaff(app, STAFF_TG.warehouse);
    const mine = (await http().post(`/api/staff/orders/${o.id}/label/ticket`).set(bearer(own)).expect(200)).body.ticket;
    await print(mine).expect(200);
    await http().post('/api/staff/auth/logout').set(bearer(own)).expect((r) => expect([200, 201, 204]).toContain(r.status));
    expect((await print(mine).expect(401)).body.code).toBe('PRINT_TICKET_INVALID');
    expect(await prisma.audit_logs.count({ where: { entity_id: other.id, action: 'order.label_printed' } })).toBe(0);
  });

  it('the waybill: optional, a short number (not a free text), trimmed, cleared with an empty value; an unchanged value writes no audit row', async () => {
    const o = await order();
    for (const bad of ['x'.repeat(65), 'две\nстроки', '<b>BTS</b>', '-начинается с дефиса', 123]) {
      await as('warehouse').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: bad }).expect(400);
    }
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).delivery_waybill).toBeNull();
    for (const good of ['BTS-12345678', 'YGO 22/7', '№ 00451', 'A'.repeat(64)]) {
      expect((await as('warehouse').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: good }).expect(200)).body.delivery_waybill).toBe(good);
    }
    const rows = await prisma.audit_logs.count({ where: { entity_id: o.id, action: 'order.waybill_changed' } });
    await as('warehouse').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: 'A'.repeat(64) }).expect(200); // the same again
    expect(await prisma.audit_logs.count({ where: { entity_id: o.id, action: 'order.waybill_changed' } })).toBe(rows);
    expect((await as('admin').patch(`/staff/orders/${o.id}/waybill`, { delivery_waybill: null }).expect(200)).body.delivery_waybill).toBeNull();
    expect((await as('admin').patch(`/staff/orders/${o.id}/waybill`, {}).expect(200)).body.delivery_waybill).toBeNull();
    // the order itself is untouched by all this
    expect(await prisma.orders.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'paid', recipient_name: PII.name, address_text: PII.address });
  });
});
