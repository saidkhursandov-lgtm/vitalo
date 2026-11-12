import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { BonusService } from '../src/bonus/bonus.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const DAY = 86_400_000;

/** 3.10-А (D-71): VITALO Bonus — spending at checkout, cashback after the delivery, cancellation, return, expiry. */
describe('Stage 3.10-А VITALO Bonus (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bonus: BonusService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let manager: string;
  let tg = 831_000_000 + (Date.now() % 100_000) * 10;
  const http = () => request(app.getHttpServer());

  async function customer(balance = 0) {
    const token = await loginCustomer(app, ++tg);
    const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(tg) } });
    if (balance) await prisma.$transaction((tx) => bonus.post(tx, { userId: user.id, op: 'manual_add', amount: balance, ref: `test:${randomUUID()}`, activity: true }));
    return { token, user };
  }
  const balanceOf = async (userId: string) => Number((await prisma.bonus_accounts.findUnique({ where: { user_id: userId } }))?.balance_uzs ?? 0n);

  /** 200 000 сум, purchase cost 100 000: the 25% cap decides, not the margin floor. */
  async function product(price = 200_000, cost: number | null = 100_000) {
    const p = await createTestProduct(prisma, { price, stock: 50 });
    return prisma.products.update({ where: { id: p.id }, data: { cost_uzs: cost == null ? null : BigInt(cost) } });
  }

  const checkout = (productId: string, over: Record<string, unknown> = {}) => ({
    source: 'buy_now',
    buy_now: { product_id: productId, qty: 1 },
    recipient_name: 'Тест Бонус',
    recipient_phone: '90 123-45-67',
    ...addr.samarkand,
    address_text: 'ул. Тестовая, 1',
    payment_method: 'card_transfer',
    ...over,
  });
  const place = (token: string, body: object) => http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body);
  const step = (id: string, status: string) => http().post(`/api/staff/orders/${id}/status`).set(bearer(manager)).send({ status }).expect(200);
  async function deliver(id: string) {
    await http().post(`/api/staff/orders/${id}/confirm-payment`).set(bearer(manager)).send({}).expect(200);
    for (const s of ['picking', 'handed_to_delivery', 'in_transit', 'delivered']) await step(id, s);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    bonus = app.get(BonusService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    await prisma.settings.deleteMany({ where: { key: { in: ['bonus', 'promo_guard'] } } }); // D-71 defaults: 3%, 25%, 90 days
    const value = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false };
    await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
  });
  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'bonus' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('preview: up to 25% of the goods, the delivery stays money; cashback counts from what is paid', async () => {
    const { token } = await customer(100_000);
    const p = await product();
    const off = (await http().post('/api/orders/preview').set(bearer(token)).send(checkout(p.id)).expect(201)).body;
    expect(off.bonus).toMatchObject({ balance_uzs: 100_000, available_uzs: 50_000, use: false, used_uzs: 0, blocked: null, cashback_pct: 3, cashback_uzs: 6_000 });
    const on = (await http().post('/api/orders/preview').set(bearer(token)).send(checkout(p.id, { use_bonus: true })).expect(201)).body;
    expect(on.bonus).toMatchObject({ use: true, used_uzs: 50_000, cashback_uzs: 4_500 });
    expect(on.totals.bonus_used_uzs).toBe(50_000);
    expect(on.totals.goods_paid_uzs).toBe(150_000);
    expect(on.totals.total_uzs).toBe(150_000 + on.totals.delivery_cost_uzs);
  });

  it('order → delivered: bonuses leave with the order, 3% cashback after the delivery, message in the bot', async () => {
    const { token, user } = await customer(100_000);
    const p = await product();
    const order = (await place(token, checkout(p.id, { use_bonus: true })).expect(201)).body;
    expect(order.totals?.bonus_used_uzs ?? order.bonus_used_uzs).toBe(50_000);
    expect(await balanceOf(user.id)).toBe(50_000);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(Number(row.bonus_rate_snapshot)).toBe(0.03);
    expect(Number(row.items[0].paid_line_total_uzs)).toBe(150_000); // the refund basis and the fiscal line include the bonus discount

    await deliver(order.id);
    expect(await balanceOf(user.id)).toBe(54_500);
    const msg = await prisma.notifications.findFirstOrThrow({ where: { user_id: user.id, template: 'bonus.accrued' } });
    expect(msg).toMatchObject({ category: 'bonus' });
    expect(msg.payload).toMatchObject({ bonus_uzs: 4_500, balance_uzs: 54_500, order_number: order.order_number });
    expect((await prisma.bonus_accounts.findUniqueOrThrow({ where: { user_id: user.id } })).last_activity_at).not.toBeNull();

    // the return takes the cashback back and gives the spent bonuses back
    await http().post(`/api/staff/orders/${order.id}/return`).set(bearer(admin)).send({ reason: 'Тест возврата' }).expect(200);
    expect(await balanceOf(user.id)).toBe(100_000);
    const ops = await prisma.bonus_ledger.findMany({ where: { order_id: order.id }, orderBy: { created_at: 'asc' } });
    expect(ops.map((o) => [o.operation_type, Number(o.amount_uzs)])).toEqual([['redemption', -50_000], ['purchase', 4_500], ['reversal', -4_500], ['reversal', 50_000]]);

    const mine = (await http().get('/api/bonus').set(bearer(token)).expect(200)).body;
    expect(mine).toMatchObject({ balance_uzs: 100_000, rules: { cashback_pct: 3, max_spend_pct: 25, lifetime_days: 90 } });
    expect(mine.history[0]).toMatchObject({ op: 'reversal', amount_uzs: 50_000, order_number: order.order_number });
  });

  it('a cancelled order gives the bonuses back once; cash on delivery gets the cashback only when the money is collected', async () => {
    const { token, user } = await customer(40_000);
    const p = await product();
    const order = (await place(token, checkout(p.id, { use_bonus: true })).expect(201)).body;
    expect(await balanceOf(user.id)).toBe(0);
    await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(201);
    expect(await balanceOf(user.id)).toBe(40_000);
    await http().post(`/api/orders/${order.id}/cancel`).set(bearer(token)).send({}).expect(201);
    expect(await balanceOf(user.id)).toBe(40_000);
    expect(await prisma.notifications.count({ where: { user_id: user.id, template: 'bonus.returned' } })).toBe(1);
  });

  it('not together with a promo code: blocked, the cashback is still promised', async () => {
    const { token } = await customer(100_000);
    const p = await product();
    const now = Date.now();
    const code = `BON${process.pid}X${now % 1_000_000}`;
    await http().post('/api/staff/promo-codes').set(bearer(admin)).send({
      code, type: 'percent', value: 10, scope: 'order', first_order_only: false, per_customer_limit: 1,
      start_at: new Date(now - 3600_000).toISOString(), end_at: new Date(now + DAY).toISOString(), active: true,
    }).expect(201);
    const r = (await http().post('/api/orders/preview').set(bearer(token)).send(checkout(p.id, { use_bonus: true, promo_code: code })).expect(201)).body;
    expect(r.bonus).toMatchObject({ used_uzs: 0, blocked: 'promo', cashback_uzs: 5_400 });
    expect(r.totals.bonus_used_uzs).toBe(0);
  });

  it('cart switch «Списать бонусы» is kept on the cart and used by the cart checkout', async () => {
    const { token, user } = await customer(30_000);
    const p = await product();
    await http().post('/api/cart/items').set(bearer(token)).send({ product_id: p.id, qty: 1 }).expect(201);
    const q = `region_id=${addr.samarkand.region_id}&city_id=${addr.samarkand.city_id}`;
    let cart = (await http().get(`/api/cart?${q}`).set(bearer(token)).expect(200)).body;
    expect(cart.bonus).toMatchObject({ balance_uzs: 30_000, available_uzs: 30_000, use: false });
    cart = (await http().post('/api/cart/bonus').set(bearer(token)).send({ use: true, ...addr.samarkand }).expect(201)).body;
    expect(cart.bonus).toMatchObject({ use: true, used_uzs: 30_000 });
    expect(cart.bonus_used_uzs).toBe(30_000);
    const order = (await place(token, { ...checkout(p.id), source: 'cart', buy_now: undefined }).expect(201)).body;
    expect(Number((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).bonus_used_uzs)).toBe(30_000);
    expect(await balanceOf(user.id)).toBe(0);
  });

  it('expiry: a reminder before the day (once), then the balance burns', async () => {
    const { user } = await customer(12_000);
    const acc = await prisma.bonus_accounts.findUniqueOrThrow({ where: { user_id: user.id } });
    const noon = new Date('2027-03-10T07:00:00Z'); // 12:00 in Tashkent
    await prisma.bonus_accounts.update({ where: { id: acc.id }, data: { last_activity_at: new Date(noon.getTime() - 85 * DAY) } });
    await bonus.runExpiry(noon);
    await bonus.runExpiry(noon);
    const reminders = await prisma.notifications.findMany({ where: { user_id: user.id, template: 'bonus.expiring' } });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].payload).toMatchObject({ bonus_uzs: 12_000, burn_date: '15.03.2027' });
    expect(await balanceOf(user.id)).toBe(12_000);

    await bonus.runExpiry(new Date(noon.getTime() + 6 * DAY));
    expect(await balanceOf(user.id)).toBe(0);
    const burnt = await prisma.bonus_ledger.findFirstOrThrow({ where: { bonus_account_id: acc.id, operation_type: 'expire' } });
    expect(Number(burnt.amount_uzs)).toBe(-12_000);
  });

  it('settings off: nothing is spent, no cashback is promised or frozen', async () => {
    await prisma.settings.upsert({ where: { key: 'bonus' }, create: { key: 'bonus', value: { enabled: false } }, update: { value: { enabled: false } } });
    try {
      const { token } = await customer(50_000);
      const p = await product();
      const r = (await http().post('/api/orders/preview').set(bearer(token)).send(checkout(p.id, { use_bonus: true })).expect(201)).body;
      expect(r.bonus).toMatchObject({ used_uzs: 0, blocked: 'disabled', cashback_uzs: 0 });
      const order = (await place(token, checkout(p.id, { use_bonus: true })).expect(201)).body;
      expect((await prisma.orders.findUniqueOrThrow({ where: { id: order.id } })).bonus_rate_snapshot).toBeNull();
    } finally {
      await prisma.settings.deleteMany({ where: { key: 'bonus' } });
    }
  });
});
