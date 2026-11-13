import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReviewsService } from '../src/reviews/reviews.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const DAY = 86_400_000;

/** 3.10-Б: verified reviews — only after the delivery, premoderation, the bonus on publication, the bot's request. */
describe('Stage 3.10-Б reviews (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reviews: ReviewsService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let manager: string;
  let png: Buffer;
  let tg = 832_000_000 + (Date.now() % 100_000) * 10;
  const http = () => request(app.getHttpServer());

  async function customer(first = 'Саидкомол', last: string | null = 'Хурсандов') {
    const token = await loginCustomer(app, ++tg);
    const user = await prisma.users.update({ where: { telegram_user_id: BigInt(tg) }, data: { first_name: first, last_name: last } });
    return { token, user };
  }

  async function order(token: string, productId: string, delivered = true) {
    const res = await http()
      .post('/api/orders')
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ source: 'buy_now', buy_now: { product_id: productId, qty: 1 }, recipient_name: 'Тест Отзыв', recipient_phone: '90 123-45-67', ...addr.samarkand, address_text: 'ул. Тестовая, 1', payment_method: 'card_transfer' })
      .expect(201);
    const id: string = res.body.id ?? res.body.order?.id;
    if (delivered) {
      await http().post(`/api/staff/orders/${id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      for (const s of ['picking', 'handed_to_delivery', 'in_transit', 'delivered']) await http().post(`/api/staff/orders/${id}/status`).set(bearer(manager)).send({ status: s }).expect(200);
    }
    return id;
  }

  const send = (token: string, f: { order_id: string; product_id: string; rating?: number; text?: string; tags?: string; show_name?: string; photos?: number }) => {
    const r = http()
      .post('/api/reviews')
      .set(bearer(token))
      .field('order_id', f.order_id)
      .field('product_id', f.product_id)
      .field('rating', String(f.rating ?? 5))
      .field('text', f.text ?? 'Принимаю месяц, удобно глотать, упаковка целая.')
      .field('show_name', f.show_name ?? 'true');
    if (f.tags) r.field('tags', f.tags);
    for (let i = 0; i < (f.photos ?? 0); i++) r.attach('photos', png, { filename: `p${i}.png`, contentType: 'image/png' });
    return r;
  };
  const balanceOf = async (userId: string) => Number((await prisma.bonus_accounts.findUnique({ where: { user_id: userId } }))?.balance_uzs ?? 0n);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    reviews = app.get(ReviewsService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    await prisma.settings.deleteMany({ where: { key: 'bonus' } }); // D-71: 3 000 / 5 000 with a photo
    const value = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false };
    await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
    png = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#e5edf7' } })
      .withMetadata({ exif: { IFD0: { Make: 'Phone', Model: 'Secret' } } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('only after the delivery and only for a bought product; the text and the photos are checked', async () => {
    const { token } = await customer();
    const p = await createTestProduct(prisma, { price: 120_000, stock: 20 });
    const other = await createTestProduct(prisma, { price: 50_000, stock: 20 });
    const waiting = await order(token, p.id, false);
    expect((await send(token, { order_id: waiting, product_id: p.id }).expect(422)).body.code).toBe('REVIEW_NOT_DELIVERED');
    const done = await order(token, p.id);
    expect((await send(token, { order_id: done, product_id: other.id }).expect(404)).body.code).toBe('REVIEW_NOT_BOUGHT');
    expect((await send(token, { order_id: done, product_id: p.id, text: 'Хорошо' }).expect(400)).body.code).toBe('REVIEW_TEXT');
    await send(token, { order_id: done, product_id: p.id, photos: 3 }).expect(400);

    const pending = (await http().get('/api/reviews/pending').set(bearer(token)).expect(200)).body;
    expect(pending.find((x: { order_id: string }) => x.order_id === done)).toMatchObject({ product_id: p.id, review_status: null });
    expect(pending.some((x: { order_id: string }) => x.order_id === waiting)).toBe(false);
    // the form: how the name is signed (short) and the bonus amounts
    const form = (await http().get('/api/reviews/form').set(bearer(token)).expect(200)).body;
    expect(form).toMatchObject({ author_name: 'Саидкомол Х.', anonymous_name: 'Покупатель VITALO' });

    const { token: stranger } = await customer('Чужой', null);
    expect((await send(stranger, { order_id: done, product_id: p.id }).expect(404)).body.code).toBe('REVIEW_NOT_BOUGHT');
  });

  it('with a photo: on moderation → «Опубликовать и начислить» — 5 000 bonuses, stars on the card, the photo public without EXIF', async () => {
    const { token, user } = await customer();
    const p = await createTestProduct(prisma, { price: 125_000, stock: 20 });
    const o = await order(token, p.id);
    const created = (await send(token, { order_id: o, product_id: p.id, rating: 4, tags: 'effect,easy', photos: 1 }).expect(201)).body;
    expect(created.status).toBe('pending');
    await send(token, { order_id: o, product_id: p.id }).expect(409);
    // not on the card yet
    expect((await http().get(`/api/catalog/products/${p.id}/reviews`).expect(200)).body.items).toEqual([]);

    await http().get('/api/staff/reviews').set(bearer(manager)).expect(403);
    const list = (await http().get('/api/staff/reviews?status=pending').set(bearer(admin)).expect(200)).body;
    const row = list.items.find((x: { id: string }) => x.id === created.id);
    expect(row).toMatchObject({ rating: 4, tags: ['effect', 'easy'], author: 'Саидкомол Х.', bonus_uzs: 5000, medical_hint: false, customer: { name: 'Саидкомол Хурсандов' } });
    const photo = await http().get(`/api/staff/reviews/${created.id}/media/${row.media[0]}`).set(bearer(admin)).buffer(true).expect(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(photo.body as Buffer).metadata()).exif).toBeUndefined();

    const cashback = await balanceOf(user.id); // 3% for the order itself
    const pub = (await http().post(`/api/staff/reviews/${created.id}/publish`).set(bearer(admin)).expect(201)).body;
    expect(pub).toMatchObject({ status: 'published', bonus_uzs: 5000, first: true });
    await http().post(`/api/staff/reviews/${created.id}/publish`).set(bearer(admin)).expect(409);
    expect(await balanceOf(user.id)).toBe(cashback + 5000);
    const ledger = await prisma.bonus_ledger.findUniqueOrThrow({ where: { idempotency_ref: `review:${created.id}` } });
    expect(ledger).toMatchObject({ operation_type: 'review', order_id: o });
    expect(await prisma.notifications.count({ where: { user_id: user.id, template: 'review.published' } })).toBe(1);
    expect(await prisma.audit_logs.count({ where: { entity_id: created.id, action: 'review.published' } })).toBe(1);

    const card = (await http().get(`/api/catalog/products/${p.id}/reviews`).expect(200)).body;
    expect(card.summary).toEqual({ avg: 4, count: 1, stars: [0, 1, 0, 0, 0] });
    expect(card.items[0]).toMatchObject({ rating: 4, author: 'Саидкомол Х.', verified: true, reply: null });
    expect(card.items[0].photos[0].url).toMatch(/^\/uploads\/reviews\//);
    expect(JSON.stringify(card)).not.toMatch(/Хурсандов|username|phone/);
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.rating).toEqual({ avg: 4, count: 1 });

    // the specialist answers; «Скрыть» takes it off the card, the bonus stays; publishing again posts nothing new
    await http().put(`/api/staff/reviews/${created.id}/reply`).set(bearer(admin)).send({ text: 'Спасибо! Магний лучше принимать вечером.' }).expect(200);
    expect((await http().get(`/api/catalog/products/${p.id}/reviews`).expect(200)).body.items[0].reply.text).toBe('Спасибо! Магний лучше принимать вечером.');
    await http().post(`/api/staff/reviews/${created.id}/hide`).set(bearer(admin)).expect(201);
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.rating).toBeNull();
    expect(await balanceOf(user.id)).toBe(cashback + 5000);
    expect((await http().post(`/api/staff/reviews/${created.id}/publish`).set(bearer(admin)).expect(201)).body).toMatchObject({ first: false, bonus_uzs: 5000 });
    expect(await balanceOf(user.id)).toBe(cashback + 5000);
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.rating).toEqual({ avg: 4, count: 1 });
  });

  it('a promise to cure is flagged; rejected with the reason → the customer writes again → 3 000 without a photo; anonymous', async () => {
    const { token, user } = await customer();
    const p = await createTestProduct(prisma, { price: 90_000, stock: 20 });
    const o = await order(token, p.id);
    const first = (await send(token, { order_id: o, product_id: p.id, text: 'Вылечил давление, бросил таблетки!', show_name: 'false' }).expect(201)).body;
    const row = (await http().get('/api/staff/reviews').set(bearer(admin)).expect(200)).body.items.find((x: { id: string }) => x.id === first.id);
    expect(row).toMatchObject({ medical_hint: true, author: 'Покупатель VITALO', bonus_uzs: 3000 });
    await http().post(`/api/staff/reviews/${first.id}/reject`).set(bearer(admin)).send({ reason: 'nonsense' }).expect(400);
    await http().post(`/api/staff/reviews/${first.id}/reject`).set(bearer(admin)).send({ reason: 'medical', note: 'обещание лечения' }).expect(201);
    const msg = await prisma.notifications.findFirstOrThrow({ where: { user_id: user.id, template: 'review.rejected' } });
    expect((msg.payload as { reason: string }).reason).toBe('обещания лечения: для БАД так писать нельзя');
    expect((await http().get('/api/reviews/mine').set(bearer(token)).expect(200)).body[0]).toMatchObject({ id: first.id, status: 'rejected', reject_reason: 'medical' });

    const cashback = await balanceOf(user.id);
    const again = (await send(token, { order_id: o, product_id: p.id, text: 'Пью курсом, спится спокойнее, капсулы небольшие.', show_name: 'false' }).expect(201)).body;
    expect(again).toEqual({ id: first.id, status: 'pending' });
    expect((await http().post(`/api/staff/reviews/${first.id}/publish`).set(bearer(admin)).expect(201)).body.bonus_uzs).toBe(3000);
    expect(await balanceOf(user.id)).toBe(cashback + 3000);
  });

  it('the bonus programme is off: published without a bonus', async () => {
    const { token, user } = await customer();
    const p = await createTestProduct(prisma, { price: 70_000, stock: 20 });
    const o = await order(token, p.id);
    const r = (await send(token, { order_id: o, product_id: p.id }).expect(201)).body;
    const cashback = await balanceOf(user.id);
    await prisma.settings.upsert({ where: { key: 'bonus' }, create: { key: 'bonus', value: { enabled: false } }, update: { value: { enabled: false } } });
    try {
      expect((await http().post(`/api/staff/reviews/${r.id}/publish`).set(bearer(admin)).expect(201)).body.bonus_uzs).toBe(0);
      expect(await balanceOf(user.id)).toBe(cashback);
    } finally {
      await prisma.settings.deleteMany({ where: { key: 'bonus' } });
    }
  });

  it('«Как вам …? Оставьте отзыв»: 3–14 days after the delivery, once, in the daytime, not when switched off', async () => {
    const now = new Date('2026-12-01T07:00:00Z'); // 12:00 in Tashkent
    const { token, user } = await customer();
    const p = await createTestProduct(prisma, { price: 60_000, stock: 20 });
    const fresh = await order(token, p.id);
    const old = await order(token, p.id);
    const reviewed = await order(token, p.id);
    await prisma.orders.update({ where: { id: fresh }, data: { delivered_at: new Date(now.getTime() - 4 * DAY) } });
    await prisma.orders.update({ where: { id: old }, data: { delivered_at: new Date(now.getTime() - 20 * DAY) } });
    await prisma.orders.update({ where: { id: reviewed }, data: { delivered_at: new Date(now.getTime() - 5 * DAY) } });
    await send(token, { order_id: reviewed, product_id: p.id }).expect(201);

    expect(await reviews.runAsk(new Date('2026-12-01T19:00:00Z'))).toBe(0); // 00:00 in Tashkent
    await reviews.runAsk(now);
    const asked = await prisma.notifications.findMany({ where: { user_id: user.id, template: 'review.ask' } });
    expect(asked.map((n) => n.order_id)).toEqual([fresh]);
    expect(asked[0].payload).toMatchObject({ open_path: `/review/${fresh}`, open_button: 'review', bonus_uzs: 5000 });
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: reviewed } })).review_asked_at).not.toBeNull();
    await reviews.runAsk(now);
    expect(await prisma.notifications.count({ where: { user_id: user.id, template: 'review.ask' } })).toBe(1);

    // switched off in the profile
    const { token: quiet, user: quietUser } = await customer();
    await http().patch('/api/auth/me').set(bearer(quiet)).send({ review_requests: false }).expect(200);
    const q = await order(quiet, p.id);
    await prisma.orders.update({ where: { id: q }, data: { delivered_at: new Date(now.getTime() - 4 * DAY) } });
    await reviews.runAsk(now);
    expect(await prisma.notifications.count({ where: { user_id: quietUser.id, template: 'review.ask' } })).toBe(0);
  });
});
