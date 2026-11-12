import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, seededAddresses } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;

/** Генплан, этап 2: one list of orders of both channels with «Канал» and «Отгрузить сегодня». */
describe('All orders: Mini App and Yandex in one list (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const run = Date.now().toString(36).toUpperCase();
  let vitaloId: string;
  let vitaloNumber: string;
  let shipNow: string;
  let shipLater: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    const addr = await seededAddresses(prisma);
    const token = await loginCustomer(app, 975_100_001);
    const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 2 }, recipient_name: 'Канал Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: 'card_transfer' })
        .expect(201)
    ).body;
    vitaloId = order.id;
    vitaloNumber = order.order_number;
    // confirmed and waiting to be packed; a test order so that no other summary counts it
    await prisma.orders.update({ where: { id: vitaloId }, data: { status: 'paid', is_test: true } });
    const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 5 * 3600_000 + 3 * 86_400_000).toISOString().slice(0, 10);
    shipNow = (await prisma.marketplace_orders.create({ data: { external_number: `ALL-${run}-1`, order_date: new Date(`${today}T00:00:00Z`), status: 'NEW', ship_by_date: new Date(`${today}T00:00:00Z`), ship_by_time: '12:00', customer_name: 'Яндекс Тест', is_test: true } })).id;
    shipLater = (await prisma.marketplace_orders.create({ data: { external_number: `ALL-${run}-2`, order_date: new Date(`${today}T00:00:00Z`), status: 'NEW', ship_by_date: new Date(`${later}T00:00:00Z`), is_test: true } })).id;
  });
  afterAll(async () => {
    await prisma.marketplace_orders.updateMany({ where: { id: { in: [shipNow, shipLater] } }, data: { status: 'CANCELLED' } });
    await prisma.orders.update({ where: { id: vitaloId }, data: { status: 'cancelled' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  const list = (r: Role, query = '') => http().get(`/api/staff/all-orders${query}`).set(bearer(tokens[r]));

  it('both channels in one list, newest first, with the channel of each row', async () => {
    const { body } = await list('admin').expect(200);
    const mine = body.items.filter((i: { id: string }) => [vitaloId, shipNow, shipLater].includes(i.id));
    expect(mine.map((i: { channel: string }) => i.channel).sort()).toEqual(['vitalo', 'yandex', 'yandex']);
    expect(mine.find((i: { id: string }) => i.id === vitaloId)).toMatchObject({ number: vitaloNumber, status: 'paid', qty: 2, customer: 'Канал Тест', ship_by: null });
    expect(mine.find((i: { id: string }) => i.id === shipNow)).toMatchObject({ number: `ALL-${run}-1`, status: 'NEW', ship_by: { date: expect.any(String), time: '12:00' } });
    const times = body.items.map((i: { created_at: string }) => Date.parse(i.created_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(typeof body.ship_today).toBe('number');
  });

  it('«Отгрузить сегодня»: confirmed Mini App orders and Yandex orders due today or earlier', async () => {
    const ids = (await list('admin', '?ship_today=true').expect(200)).body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([vitaloId, shipNow]));
    expect(ids).not.toContain(shipLater);
  });

  it('channel switch, search by number, hiding tests', async () => {
    const yandexOnly = (await list('admin', '?channel=yandex').expect(200)).body.items;
    expect(yandexOnly.every((i: { channel: string }) => i.channel === 'yandex')).toBe(true);
    const found = (await list('admin', `?q=ALL-${run}`).expect(200)).body;
    expect(found.items.map((i: { id: string }) => i.id).sort()).toEqual([shipNow, shipLater].sort());
    const hidden = (await list('admin', `?q=ALL-${run}&hide_test=true`).expect(200)).body;
    expect(hidden.total).toBe(0);
  });

  it('аудит 10.11, п. 1.6: a cancelled order says who cancelled it (expired reserve / Yandex)', async () => {
    const o = await prisma.orders.findUniqueOrThrow({ where: { id: vitaloId } });
    await prisma.orders.update({ where: { id: vitaloId }, data: { status: 'cancelled' } });
    await prisma.order_status_history.create({ data: { order_id: vitaloId, from_status: o.status, to_status: 'cancelled', reason: 'Reservation expired: not paid in time', changed_by_type: 'system' } });
    // a Yandex order that is already cancelled (a status never goes back from CANCELLED, so a separate one)
    const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    await prisma.marketplace_orders.create({
      data: { external_number: `ALL-${run}-3`, order_date: new Date(`${today}T00:00:00Z`), status: 'CANCELLED', cancel_reason: 'Отменён в Яндексе (USER_CHANGED_MIND)', is_test: true },
    });
    try {
      const v = (await list('admin', `?q=${vitaloNumber}`).expect(200)).body.items[0];
      expect(v.cancel).toEqual({ by: 'system', reason: 'Reservation expired: not paid in time', staff_name: null });
      const y = (await list('admin', `?q=ALL-${run}-3`).expect(200)).body.items[0];
      expect(y.cancel).toEqual({ by: 'yandex', reason: 'Отменён в Яндексе (USER_CHANGED_MIND)', staff_name: null });
      const active = (await list('admin', `?q=ALL-${run}-1`).expect(200)).body.items[0];
      expect(active.cancel).toBeNull();
    } finally {
      await prisma.orders.update({ where: { id: vitaloId }, data: { status: o.status } });
    }
  });

  it('аудит 2.1: search by phone and name, filters by status, payment method and period, totals of the filter', async () => {
    const ids = async (query: string) => (await list('admin', query).expect(200)).body.items.map((i: { id: string }) => i.id);
    // phone in another form, the recipient's name, the Yandex customer's name
    expect(await ids('?q=90 111-22-33')).toContain(vitaloId);
    expect(await ids('?q=Канал Тест')).toContain(vitaloId);
    expect(await ids('?q=Яндекс Тест')).toContain(shipNow);
    // statuses of one channel leave the other channel out; both channels together
    const paid = await ids(`?status=paid&q=${vitaloNumber}`);
    expect(paid).toEqual([vitaloId]);
    expect(await ids(`?status=cancelled&q=${vitaloNumber}`)).toEqual([]);
    expect(await ids(`?status=NEW&q=ALL-${run}`)).toEqual(expect.arrayContaining([shipNow, shipLater]));
    expect((await list('admin', '?status=paid').expect(200)).body.items.every((i: { channel: string }) => i.channel === 'vitalo')).toBe(true);
    expect((await list('admin', '?status=paid,NEW').expect(200)).body.items.map((i: { channel: string }) => i.channel)).toEqual(expect.arrayContaining(['vitalo', 'yandex']));
    await list('admin', '?status=lost').expect(400);
    // a payment method is Mini App only
    expect(await ids(`?payment_method=card_transfer&q=${vitaloNumber}`)).toEqual([vitaloId]);
    expect(await ids(`?payment_method=payme&q=${vitaloNumber}`)).toEqual([]);
    expect((await list('admin', '?payment_method=card_transfer').expect(200)).body.items.every((i: { channel: string }) => i.channel === 'vitalo')).toBe(true);
    // the period by the day of creation in Tashkent
    const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    expect(await ids(`?date_from=${today}&date_to=${today}&q=${vitaloNumber}`)).toEqual([vitaloId]);
    expect(await ids(`?date_to=2020-01-01&q=${vitaloNumber}`)).toEqual([]);
    // totals of the whole filter and the page size
    const one = (await list('admin', `?q=${vitaloNumber}`).expect(200)).body;
    expect(one).toMatchObject({ total: 1, total_sum_uzs: one.items[0].total_uzs });
    expect((await list('admin', '?page_size=100').expect(200)).body.page_size).toBe(100);
    await list('admin', '?page_size=7').expect(400);
  });

  it('who sees what: warehouse and manager see both, marketer nothing', async () => {
    for (const r of ['warehouse', 'manager'] as Role[]) {
      const ids = (await list(r, `?q=${vitaloNumber}`).expect(200)).body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual([vitaloId]);
    }
    await list('marketer').expect(403);
    await list('admin', '?channel=ozon').expect(400);
  });
});
