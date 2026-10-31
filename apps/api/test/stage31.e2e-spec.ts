import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TEST_ENV } from './test-env';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const WAREHOUSE_TG = 831_000_001;
// a tiny valid JPEG header is enough: the API stores the bytes as they are
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

/** 3.1: «Скриншот чека в боте» — the bot sends what it got, the API decides; confirm / reject from the bot. */
describe('Stage 3.1 receipts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let manager: string;
  let tg = 831_100_000;
  const http = () => request(app.getHttpServer());
  const secret = { 'x-bot-secret': TEST_ENV.BOT_API_SECRET };

  /** A new customer with a card-transfer order waiting for payment. */
  async function cardOrder(method = 'card_transfer') {
    const telegram = ++tg;
    const token = await loginCustomer(app, telegram);
    const p = await createTestProduct(prisma, { price: 90_000, stock: 10 });
    const body = {
      source: 'buy_now',
      buy_now: { product_id: p.id, qty: 1 },
      recipient_name: 'Тест Покупатель',
      recipient_phone: '90 123-45-67',
      ...(method === 'cod' ? addr.tashkent : addr.samarkand),
      address_text: 'ул. Тестовая, 1',
      payment_method: method,
    };
    const order = (await http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body).expect(201)).body;
    return { telegram, token, order };
  }
  const send = (telegram: number, orderId: string | null, uniqueId = randomUUID(), mime = 'image/jpeg') =>
    http()
      .post('/api/internal/bot/receipts')
      .set(secret)
      .field('telegram_id', String(telegram))
      .field('order_id', orderId ?? '')
      .field('file_unique_id', uniqueId)
      .field('file_id', `file-${uniqueId}`)
      .field('mime', mime)
      .attach('file', JPEG, { filename: 'receipt.jpg', contentType: mime });
  const confirm = (staffTg: number, id: string) => http().post(`/api/internal/bot/receipts/${id}/confirm`).set(secret).send({ telegram_id: String(staffTg) });
  const reject = (staffTg: number, id: string, reason: object) => http().post(`/api/internal/bot/receipts/${id}/reject`).set(secret).send({ telegram_id: String(staffTg), ...reason });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    await loginStaff(app, ADMIN_TG);
    await prisma.staff_users.upsert({
      where: { telegram_user_id: BigInt(WAREHOUSE_TG) },
      create: { telegram_user_id: BigInt(WAREHOUSE_TG), name: 'Склад E2E', role: 'warehouse' },
      update: { status: 'active', role: 'warehouse' },
    });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('the payment screen gives the bot link with this order (card transfer only)', async () => {
    const { token, order } = await cardOrder();
    const details = (await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(token)).expect(200)).body;
    expect(details.receipt).toEqual({ bot_url: `https://t.me/vitalo_e2e_bot?start=rc_${order.id.replace(/-/g, '')}`, last: null });
  });

  it('the bot link works only for the order owner and an order waiting for the transfer', async () => {
    const { telegram, order } = await cardOrder();
    const ok = (await http().post('/api/internal/bot/receipts/start').set(secret).send({ telegram_id: String(telegram), order_id: order.id }).expect(200)).body;
    expect(ok).toMatchObject({ order_id: order.id, order_number: order.order_number });

    const stranger = await cardOrder();
    const res = await http().post('/api/internal/bot/receipts/start').set(secret).send({ telegram_id: String(stranger.telegram), order_id: order.id }).expect(409);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
    await http().post('/api/internal/bot/receipts/start').send({ telegram_id: String(telegram), order_id: order.id }).expect(401); // no bot secret

    const cod = await cardOrder('cod');
    expect((await send(cod.telegram, cod.order.id).expect(409)).body.code).toBe('NOT_CARD_TRANSFER');
  });

  it('a receipt is stored privately, counts as «Я оплатил(а)», goes to managers and admins only, and is not stored twice', async () => {
    const { telegram, token, order } = await cardOrder();
    const unique = randomUUID();
    const first = (await send(telegram, order.id, unique).expect(200)).body;
    expect(first).toMatchObject({ result: 'saved', order_number: order.order_number, check_hours: { from: '08:00', to: '22:00' } });
    const staffIds = first.staff.map((s: { telegram_id: string }) => s.telegram_id);
    expect(staffIds).toEqual(expect.arrayContaining([String(DEV_MANAGER_TG), String(ADMIN_TG)]));
    expect(staffIds).not.toContain(String(WAREHOUSE_TG));
    expect(first.caption).toContain(order.order_number);

    const row = await prisma.payment_receipts.findUniqueOrThrow({ where: { id: first.receipt_id } });
    const path = join(TEST_ENV.RECEIPTS_DIR, row.file_key);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).equals(JPEG)).toBe(true);
    expect(row.file_key.startsWith(`${order.id}/`)).toBe(true);

    const details = (await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(token)).expect(200)).body;
    expect(details.customer_reported_paid_at).not.toBeNull();
    expect(details.receipt.last).toMatchObject({ status: 'pending' });
    // the receipt message has its own buttons: no extra «Клиент сообщил об оплате» text
    expect(await prisma.notifications.count({ where: { template: 'staff.customer_paid', payload: { path: ['order_number'], equals: order.order_number } } })).toBe(0);
    expect(await prisma.analytics_events.count({ where: { event: 'receipt_sent', props: { path: ['order_id'], equals: order.id } } })).toBe(1);

    const again = (await send(telegram, order.id, unique).expect(200)).body;
    expect(again).toMatchObject({ result: 'duplicate', receipt_id: first.receipt_id, staff: [] });
    expect(await prisma.payment_receipts.count({ where: { order_id: order.id } })).toBe(1);

    // without the link, the latest order waiting for a transfer is used
    expect((await send(telegram, null).expect(200)).body).toMatchObject({ result: 'saved', order_id: order.id });

    const stranger = await cardOrder();
    expect((await send(stranger.telegram, order.id).expect(409)).body.code).toBe('ORDER_NOT_FOUND');
    expect((await send(telegram, order.id, randomUUID(), 'text/plain').expect(400)).body.code).toBe('FILE_TYPE');
  });

  it('confirm from the bot = the admin panel confirmation; only managers and admins', async () => {
    const { telegram, token, order } = await cardOrder();
    const { receipt_id } = (await send(telegram, order.id).expect(200)).body;

    expect((await confirm(WAREHOUSE_TG, receipt_id).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');
    expect((await confirm(tg + 1000, receipt_id).expect(403)).body.code).toBe('FORBIDDEN_FOR_ROLE');

    expect((await confirm(DEV_MANAGER_TG, receipt_id).expect(200)).body).toEqual({ result: 'confirmed', order_number: order.order_number });
    const view = (await http().get(`/api/orders/${order.id}`).set(bearer(token)).expect(200)).body;
    expect(view).toMatchObject({ status: 'paid', payment_status: 'payment_success' });
    expect((await prisma.payment_receipts.findUniqueOrThrow({ where: { id: receipt_id } })).status).toBe('confirmed');
    expect(await prisma.audit_logs.count({ where: { action: 'order.bank_transfer_confirmed', entity_id: order.id } })).toBe(1);
    expect(await prisma.notifications.count({ where: { template: 'order.paid', payload: { path: ['order_number'], equals: order.order_number } } })).toBe(1);
    expect(await prisma.analytics_events.count({ where: { event: 'receipt_confirmed', props: { path: ['order_id'], equals: order.id } } })).toBe(1);

    // the second manager presses too: nothing happens twice
    expect((await confirm(ADMIN_TG, receipt_id).expect(200)).body).toMatchObject({ result: 'already_confirmed' });
    expect((await reject(ADMIN_TG, receipt_id, { code: 'amount' }).expect(200)).body).toMatchObject({ result: 'already_confirmed' });
    // a paid order takes no more receipts
    expect((await send(telegram, order.id).expect(409)).body.code).toBe('ORDER_PAID');
  });

  it('reject: reason kept, «Я оплатил(а)» off again, time to resend, the customer is told why', async () => {
    const { telegram, token, order } = await cardOrder();
    const { receipt_id } = (await send(telegram, order.id).expect(200)).body;
    // the reservation is almost over: a rejection still leaves at least 2 hours
    await prisma.orders.update({ where: { id: order.id }, data: { reserved_until: new Date(Date.now() + 10 * 60_000) } });

    expect((await reject(DEV_MANAGER_TG, receipt_id, {}).expect(400)).body.code).toBe('REASON_REQUIRED');
    expect((await reject(DEV_MANAGER_TG, receipt_id, { code: 'amount' }).expect(200)).body).toEqual({ result: 'rejected', order_number: order.order_number, reason: 'Сумма не совпадает' });

    const row = await prisma.payment_receipts.findUniqueOrThrow({ where: { id: receipt_id } });
    expect(row).toMatchObject({ status: 'rejected', reject_reason: 'Сумма не совпадает' });
    const details = (await http().get(`/api/orders/${order.id}/payment/bank-transfer`).set(bearer(token)).expect(200)).body;
    expect(details.customer_reported_paid_at).toBeNull();
    expect(details.receipt.last).toMatchObject({ status: 'rejected', reject_reason: 'Сумма не совпадает' });
    expect(new Date(details.pay_until).getTime()).toBeGreaterThan(Date.now() + 110 * 60_000);
    const note = await prisma.notifications.findFirstOrThrow({ where: { template: 'order.receipt_rejected', payload: { path: ['order_number'], equals: order.order_number } } });
    expect(note.payload).toMatchObject({ reason: 'Сумма не совпадает', open_path: `/orders/${order.id}/pay` });
    expect(await prisma.audit_logs.count({ where: { action: 'order.receipt_rejected', entity_id: order.id } })).toBe(1);
    expect(await prisma.analytics_events.count({ where: { event: 'receipt_rejected', props: { path: ['order_id'], equals: order.id } } })).toBe(1);

    // a new receipt is accepted; a typed reason works too
    const second = (await send(telegram, order.id).expect(200)).body;
    expect((await reject(ADMIN_TG, second.receipt_id, { text: '  Перевод от другого человека  ' }).expect(200)).body.reason).toBe('Перевод от другого человека');
    expect(await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'awaiting_payment', payment_status: 'payment_pending' });
  });

  it('«Подтвердить оплату» in the admin panel settles the receipts sent to the bot', async () => {
    const { telegram, order } = await cardOrder();
    const { receipt_id } = (await send(telegram, order.id).expect(200)).body;
    await http().post(`/api/staff/orders/${order.id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    expect((await prisma.payment_receipts.findUniqueOrThrow({ where: { id: receipt_id } })).status).toBe('confirmed');
    expect((await confirm(ADMIN_TG, receipt_id).expect(200)).body).toMatchObject({ result: 'already_confirmed' });
  });

  it('the admin panel lists the receipts and shows the file to employees only, never cached', async () => {
    const { telegram, token, order } = await cardOrder();
    const { receipt_id } = (await send(telegram, order.id).expect(200)).body;
    const list = (await http().get(`/api/staff/orders/${order.id}/receipts`).set(bearer(manager)).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: receipt_id, status: 'pending', mime: 'image/jpeg', reject_reason: null })]);

    const file = await http().get(`/api/staff/orders/${order.id}/receipts/${receipt_id}/file`).set(bearer(manager)).buffer(true).expect(200);
    expect(file.headers['content-type']).toContain('image/jpeg');
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(file.body).equals(JPEG)).toBe(true);

    await http().get(`/api/staff/orders/${order.id}/receipts/${receipt_id}/file`).set(bearer(token)).expect(401);
    await http().get(`/api/staff/orders/${randomUUID()}/receipts/${receipt_id}/file`).set(bearer(manager)).expect(404);
    // never under the public /uploads
    await http().get(`/uploads/receipts/${order.id}/${receipt_id}.jpg`).expect(404);
  });
});
