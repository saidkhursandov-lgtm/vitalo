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

/**
 * «Склад → Единицы → Напечатать этикетки выбранных» (S2B-9): labels of EXISTING units in one print, through the
 * same print ticket as one label. The admin panel only collects the chosen ids; these tests pin what the print does
 * and — above all — what it does not do.
 */
describe('Reprinting labels of existing units in a batch (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let warehouseId: string;
  let productId: string;
  let sessionId: string;
  let unitIds: string[] = [];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).set('Idempotency-Key', randomUUID()).send(body),
  });
  const print = (ticket: string) => http().post('/api/print/labels').send({ ticket }); // the label page: no staff token
  const ticketFor = async (r: Role, ids: string[]) => (await as(r).post('/staff/units/labels/ticket', { unit_ids: ids }).expect(200)).body.ticket as string;

  /** Everything a reprint must leave alone. */
  const snapshot = async () => ({
    units: await prisma.physical_units.count(),
    ours: (
      await prisma.physical_units.findMany({
        where: { id: { in: unitIds } },
        orderBy: { seq: 'asc' },
        select: { id: true, physical_id: true, status: true, expiry_date: true, actual_cost_uzs: true, product_id: true, receiving_session_id: true },
      })
    ).map((u) => ({ ...u, actual_cost_uzs: String(u.actual_cost_uzs) })),
    inventory: await prisma.inventory.findUniqueOrThrow({ where: { product_id_warehouse_id: { product_id: productId, warehouse_id: warehouseId } }, select: { actual_qty: true, reserved_qty: true } }),
    movements: await prisma.inventory_movements.count({ where: { product_id: productId } }),
    sessions: await prisma.receiving_sessions.count(),
    otherEvents: await prisma.physical_unit_events.count({ where: { physical_unit_id: { in: unitIds }, type: { not: 'LABEL_PRINTED' } } }),
  });
  const printed = async (ids: string[]) =>
    (await prisma.physical_units.findMany({ where: { id: { in: ids } }, orderBy: { seq: 'asc' }, select: { label_print_count: true } })).map((u) => u.label_print_count);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    warehouseId = await stock.mainWarehouseId();
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);

    // 49 jars received long ago: the receiving is finished, so its «Напечатать этикетки» button is out of reach
    const product = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Перепечатка ${RUN}` });
    productId = product.id;
    await prisma.products.update({ where: { id: productId }, data: { unit_tracking: true } });
    const supplierId = (await as('admin').post('/staff/dictionaries/suppliers', { name_ru: `Поставщик перепечатки ${RUN}` }).expect(201)).body.id;
    sessionId = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200)).body.id;
    const created = await prisma.$transaction(async (tx) => {
      const rows = Array.from({ length: 49 }, (_, i) => ({ product_id: productId, purchase_id: null, purchase_line_id: null, cost: 30_000n, expiry: `2028-${String((i % 12) + 1).padStart(2, '0')}-01` }));
      const made = await createUnits(tx, sessionId, rows, null);
      await moveUnits(tx, { id: { in: made.map((u) => u.id) } }, 'RECEIVED', 'IN_STOCK', { type: 'IN_STOCK', staffId: null });
      await stock.receiveUnits(tx, { warehouseId, productId, qty: made.length, referenceType: 'receiving_session', referenceId: sessionId, reason: 'e2e', staffId: null });
      return made;
    });
    await prisma.receiving_sessions.update({ where: { id: sessionId }, data: { status: 'COMPLETED', completed_at: new Date() } });
    unitIds = created.map((u) => u.id);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('49 existing jars in one print: the same IDs, a history line and +1 on the counter for each — no new jar, no stock change', async () => {
    const before = await snapshot();
    expect(before.ours).toHaveLength(49);
    expect(before.inventory).toEqual({ actual_qty: 49, reserved_qty: 0 });
    expect(await printed(unitIds)).toEqual(Array(49).fill(0));

    // the finished receiving is not in the list of the receiving screen: the batch goes by the chosen units
    const open = (await as('warehouse').get('/staff/receiving/sessions').expect(200)).body as { id: string }[];
    expect(open.map((s) => s.id)).not.toContain(sessionId);
    // the «Единицы» tab gives the ids the check boxes collect
    const page = (await as('warehouse').get(`/staff/units?product_id=${productId}`).expect(200)).body;
    expect(page.items).toHaveLength(49);
    expect(new Set(page.items.map((u: { id: string }) => u.id))).toEqual(new Set(unitIds));

    const res = (await print(await ticketFor('warehouse', unitIds)).expect(200)).body;
    expect(res.labels).toHaveLength(49);
    expect(res.labels.map((l: { physical_id: string }) => l.physical_id)).toEqual(before.ours.map((u) => u.physical_id)); // the very same IDs, in order

    expect(await printed(unitIds)).toEqual(Array(49).fill(1));
    const events = await prisma.physical_unit_events.findMany({ where: { physical_unit_id: { in: unitIds }, type: 'LABEL_PRINTED' }, include: { staff: true } });
    expect(events).toHaveLength(49); // one line in the history of every jar
    expect(new Set(events.map((e) => e.physical_unit_id)).size).toBe(49);
    expect(new Set(events.map((e) => e.staff!.role))).toEqual(new Set(['warehouse'])); // who printed
    expect(events.every((e) => e.note === 'Печать этикетки №1')).toBe(true);
    expect(await snapshot()).toEqual(before); // jars, IDs, statuses, costs, stock, movements, receivings: untouched

    // once more: the counter grows again, still nothing else
    await print(await ticketFor('admin', unitIds)).expect(200);
    expect(await printed(unitIds)).toEqual(Array(49).fill(2));
    expect(await prisma.physical_unit_events.count({ where: { physical_unit_id: { in: unitIds }, type: 'LABEL_PRINTED' } })).toBe(98);
    expect(await snapshot()).toEqual(before);
  });

  it('a part of the page: only the chosen jars are printed and counted', async () => {
    const chosen = [unitIds[3], unitIds[10], unitIds[48]];
    const counts = await printed(unitIds);
    const res = (await print(await ticketFor('manager', [...chosen, chosen[0]])).expect(200)).body; // a doubled id is one label
    expect(res.labels).toHaveLength(3);
    const after = await printed(unitIds);
    unitIds.forEach((id, i) => expect(after[i]).toBe(counts[i] + (chosen.includes(id) ? 1 : 0)));
  });

  it('limits and refusals: 50 at most, a cancelled jar stops the whole print, unknown ids print nothing', async () => {
    const before = await printed(unitIds);
    expect((await as('warehouse').post('/staff/units/labels/ticket', { unit_ids: [...unitIds, randomUUID(), randomUUID()] }).expect(400)).body.code).toBe('TOO_MANY_UNITS'); // 51
    await as('warehouse').post('/staff/units/labels/ticket', { unit_ids: [...unitIds, randomUUID()] }).expect(200); // exactly 50 is fine
    await as('warehouse').post('/staff/units/labels/ticket', { unit_ids: [] }).expect(400);
    await as('warehouse').post('/staff/units/labels/ticket', { unit_ids: ['not-an-id'] }).expect(400);
    expect((await print(await ticketFor('warehouse', [randomUUID()])).expect(404)).body.code).toBe('UNIT_NOT_FOUND');

    // a cancelled jar among the chosen ones: all or nothing
    const supplierId = (await prisma.receiving_sessions.findUniqueOrThrow({ where: { id: sessionId } })).supplier_id;
    const session = (await as('warehouse').post('/staff/receiving/sessions', { supplier_id: supplierId }).expect(200)).body.id;
    const voided = await prisma.$transaction(async (tx) => {
      const [u] = await createUnits(tx, session, [{ product_id: productId, purchase_id: null, purchase_line_id: null, cost: 30_000n, expiry: '2028-01-01' }], null);
      await moveUnits(tx, { id: u.id }, 'RECEIVED', 'VOIDED', { type: 'VOIDED', staffId: null });
      return u;
    });
    expect((await print(await ticketFor('warehouse', [unitIds[0], voided.id])).expect(409)).body.code).toBe('UNIT_VOIDED');
    expect(await printed(unitIds)).toEqual(before); // nothing was counted
    expect((await prisma.physical_units.findUniqueOrThrow({ where: { id: voided.id } })).label_print_count).toBe(0);
  });

  it('roles: the same as for one label — admin, manager, warehouse; the marketer is refused and nothing is printed', async () => {
    const before = await printed(unitIds);
    expect((await as('marketer').post('/staff/units/labels/ticket', { unit_ids: unitIds.slice(0, 5) }).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    await as('marketer').get('/staff/units').expect(403); // no «Единицы» tab at all
    await http().post('/api/staff/units/labels/ticket').send({ unit_ids: unitIds.slice(0, 5) }).expect(401);
    expect(await printed(unitIds)).toEqual(before);
    for (const r of ['admin', 'manager', 'warehouse'] as Role[]) expect(await ticketFor(r, unitIds.slice(0, 5))).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(await printed(unitIds)).toEqual(before); // a ticket alone prints nothing: only the opened label page does
  });
});
