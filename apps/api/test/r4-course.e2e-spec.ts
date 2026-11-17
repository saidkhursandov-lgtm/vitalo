import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { courseDedupKey, CourseReminderService } from '../src/course/course-reminder.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses, setStock } from './helpers';
import { TEST_ENV } from './test-env';

const DAY = 86_400_000;
/** 12:00 in Tashkent */
const NOW = new Date('2027-03-10T07:00:00Z');

/** 4.2: «Курс заканчивается» 5 days before the jars of a delivered order run out. */
describe('Release 4.2 course reminder (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let course: CourseReminderService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let manager: string;
  let tg = 846_000_000 + (Date.now() % 100_000) * 10;
  const http = () => request(app.getHttpServer());

  async function customer(language: 'ru' | 'uz' = 'ru') {
    const token = await loginCustomer(app, ++tg);
    const user = await prisma.users.update({ where: { telegram_user_id: BigInt(tg) }, data: { language } });
    return { token, user, tg };
  }

  /** 60 capsules, 2 a day: 30 days a jar */
  const product = async () => {
    const p = await createTestProduct(prisma, { price: 120_000, stock: 50, name: 'Магний B6 тест курса' });
    return prisma.products.update({ where: { id: p.id }, data: { pack_count: 60, servings_per_day: 2, short_name_ru: 'Магний B6', short_name_uz: 'Magniy B6' } });
  };

  /** An order of `qty` jars delivered `daysAgo` days before NOW. */
  async function order(token: string, productId: string, qty = 1, daysAgo = 26, deliver = true) {
    const res = await http()
      .post('/api/orders')
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ source: 'buy_now', buy_now: { product_id: productId, qty }, recipient_name: 'Тест Курс', recipient_phone: '90 123-45-67', ...addr.samarkand, address_text: 'ул. Тестовая, 1', payment_method: 'card_transfer' })
      .expect(201);
    const id: string = res.body.id ?? res.body.order?.id;
    if (deliver) {
      await http().post(`/api/staff/orders/${id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
      for (const s of ['picking', 'handed_to_delivery', 'in_transit', 'delivered']) await http().post(`/api/staff/orders/${id}/status`).set(bearer(manager)).send({ status: s }).expect(200);
      await prisma.orders.update({ where: { id }, data: { delivered_at: new Date(NOW.getTime() - daysAgo * DAY) } });
    }
    return id;
  }

  const reminder = (orderId: string, productId: string) => prisma.notifications.findUnique({ where: { dedup_key: courseDedupKey(orderId, productId) } });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    course = app.get(CourseReminderService);
    addr = await seededAddresses(prisma);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    const value = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false };
    await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('5 days before the end: one message in the customer’s language with «Повторить»; once; not at night, not too early', async () => {
    const p = await product();
    const ru = await customer('ru');
    const uz = await customer('uz');
    const due = await order(ru.token, p.id); // 30-day course, delivered 26 days ago → 4 days left
    const dueUz = await order(uz.token, p.id, 1, 27);
    const early = await order((await customer()).token, p.id, 2, 26); // 2 jars = 60 days

    expect(await course.run(new Date('2027-03-10T19:00:00Z'))).toBe(0); // 00:00 in Tashkent
    await course.run(NOW);
    const n = await reminder(due, p.id);
    expect(n).toMatchObject({ template: 'course.ending', user_id: ru.user.id, product_id: p.id, status: 'queued' });
    expect(n!.payload).toMatchObject({ lang: 'ru', product: 'Магний B6', days: 4, open_path: `/product/${p.id}`, open_button: 'repeat' });
    expect((await reminder(dueUz, p.id))!.payload).toMatchObject({ lang: 'uz', product: 'Magniy B6', days: 3 });
    expect(await reminder(early, p.id)).toBeNull();

    await course.run(NOW);
    expect(await prisma.notifications.count({ where: { dedup_key: courseDedupKey(due, p.id) } })).toBe(1);
  });

  it('not sent: bought again, the line returned, «Не напоминать», no card data; out of stock → «Сообщить о поступлении»', async () => {
    const p = await product();
    const again = await customer();
    const first = await order(again.token, p.id);
    await order(again.token, p.id, 1, 0, false); // a new order of the same jar, not delivered yet

    const ret = await customer();
    const returned = await order(ret.token, p.id);
    const item = await prisma.order_items.findFirstOrThrow({ where: { order_id: returned } });
    await prisma.returns.create({
      data: { order_id: returned, user_id: ret.user.id, reason: 'changed_mind', status: 'approved', items: { create: { order_item_id: item.id, qty: 1, refund_amount_uzs: 120_000n } } },
    });

    const off = await customer();
    const offOrder = await order(off.token, p.id);
    // «Не напоминать» in the bot; the profile switch turns it back on and off
    await http().post(`/api/internal/bot/users/${off.tg}/course-reminders`).set('x-bot-secret', TEST_ENV.BOT_API_SECRET).send({ on: false }).expect(200, { saved: true, on: false });
    await http().post(`/api/internal/bot/users/${off.tg}/course-reminders`).set('x-bot-secret', 'wrong').send({ on: true }).expect(401);
    await http().patch('/api/auth/me').set(bearer(off.token)).send({ course_reminders: true }).expect(200);
    expect((await prisma.users.findUniqueOrThrow({ where: { id: off.user.id } })).course_reminders).toBe(true);
    expect(JSON.stringify((await http().get('/api/auth/me').set(bearer(off.token)).expect(200)).body)).toContain('"course_reminders":true');
    await http().patch('/api/auth/me').set(bearer(off.token)).send({ course_reminders: false }).expect(200);

    const gone = await product();
    const out = await customer();
    const outOrder = await order(out.token, gone.id);
    await setStock(prisma, gone.id, 0);

    await course.run(NOW);
    expect(await reminder(first, p.id)).toBeNull();
    expect(await reminder(returned, p.id)).toBeNull();
    expect(await reminder(offOrder, p.id)).toBeNull();
    expect((await reminder(outOrder, gone.id))!.payload).toMatchObject({ open_button: 'waitlist' });

    // without «порций в день» there is no course
    const noData = await product();
    await prisma.products.update({ where: { id: noData.id }, data: { servings_per_day: null } });
    const nd = await order((await customer()).token, noData.id);
    await course.run(NOW);
    expect(await reminder(nd, noData.id)).toBeNull();
  });
});
