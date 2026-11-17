import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses, setStock } from './helpers';

const ADMIN_TG = 222_222_221;

/** 4.3 «Сеты от врача»: the margin rule of the admin, the Mini App list, the set discount in the cart and the order. */
describe('Release 4.3 doctor sets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let tg = 847_000_000 + (Date.now() % 100_000) * 10;
  let codeNo = 0;
  const made: string[] = [];
  const http = () => request(app.getHttpServer());

  async function product(price: number, cost: number | null, extra: { pack?: number; perDay?: number } = {}) {
    const p = await createTestProduct(prisma, { price, stock: 20 });
    return prisma.products.update({ where: { id: p.id }, data: { cost_uzs: cost == null ? null : BigInt(cost), pack_count: extra.pack ?? 60, servings_per_day: extra.perDay ?? 1 } });
  }

  const body = (items: { id: string; qty?: number }[], over: Record<string, unknown> = {}) => ({
    title_ru: `Сет теста ${Date.now() % 100_000}-${++codeNo}`,
    title_uz: 'Test to‘plami',
    goal: 'immunity',
    doctor_text_ru: 'D3 и K2 работают вместе.',
    doctor_text_uz: 'D3 va K2 birga ishlaydi.',
    discount_pct: 10,
    items: items.map((i) => ({ product_id: i.id, qty: i.qty ?? 1 })),
    ...over,
  });
  const create = async (b: ReturnType<typeof body>) => {
    const res = (await http().post('/api/staff/bundles').set(bearer(admin)).send(b).expect(201)).body as { id: string; slug: string };
    made.push(res.id);
    return res;
  };
  const customer = () => loginCustomer(app, ++tg);
  const cart = async (token: string, lines: [string, number][]) => {
    for (const [id, qty] of lines) await http().post('/api/cart/items').set(bearer(token)).send({ product_id: id, qty }).expect(201);
    return (await http().get('/api/cart').set(bearer(token)).expect(200)).body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    addr = await seededAddresses(prisma);
    const value = { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false };
    await prisma.settings.upsert({ where: { key: 'checkout_options' }, create: { key: 'checkout_options', value }, update: { value } });
  });
  afterAll(async () => {
    await prisma.bundles.updateMany({ where: { id: { in: made } }, data: { is_active: false } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('admin: the margin after the discount is shown; below 30% or without a cost the set is not saved; admin only', async () => {
    const d3 = await product(100_000, 50_000);
    const k2 = await product(150_000, 75_000);
    const check = (await http().post('/api/staff/bundles/check').set(bearer(admin)).send(body([{ id: d3.id }, { id: k2.id }])).expect(200)).body;
    expect(check).toMatchObject({ list_total_uzs: 250_000, sale_total_uzs: 225_000, cost_total_uzs: 125_000, margin_pct: 44.4, too_low: false, hidden_because: [], no_cost: [] });

    const dear = await product(100_000, 85_000); // cost 135 000 of 180 000 → 25%
    const low = await http().post('/api/staff/bundles').set(bearer(admin)).send(body([{ id: d3.id }, { id: dear.id }], { discount_pct: 10 })).expect(422);
    expect(low.body).toMatchObject({ code: 'BUNDLE_MARGIN_LOW', min_pct: 30 });
    const noCost = await product(100_000, null);
    expect((await http().post('/api/staff/bundles').set(bearer(admin)).send(body([{ id: d3.id }, { id: noCost.id }])).expect(422)).body.code).toBe('BUNDLE_NO_COST');
    await http().post('/api/staff/bundles').set(bearer(admin)).send(body([{ id: d3.id }])).expect(400); // one product
    await http().post('/api/staff/bundles').set(bearer(admin)).send(body([{ id: d3.id }, { id: k2.id }], { discount_pct: 11 })).expect(400);
    await http().post('/api/staff/bundles').set(bearer(admin)).send(body([{ id: d3.id }, { id: d3.id }])).expect(422);
    await http().get('/api/staff/bundles').set(bearer(manager)).expect(403);

    const b = await create(body([{ id: d3.id }, { id: k2.id }]));
    const got = (await http().get(`/api/staff/bundles/${b.id}`).set(bearer(admin)).expect(200)).body;
    expect(got).toMatchObject({ discount_pct: 10, is_active: true, items: [{ product_id: d3.id, qty: 1 }, { product_id: k2.id, qty: 1 }] });
    await http().put(`/api/staff/bundles/${b.id}`).set(bearer(admin)).send(body([{ id: d3.id }, { id: k2.id }], { discount_pct: 5 })).expect(200);
    expect((await prisma.bundles.findUniqueOrThrow({ where: { id: b.id } })).discount_pct).toBe(5);
    expect(await prisma.audit_logs.count({ where: { entity_id: b.id } })).toBe(2);
  });

  it('Mini App: the set with its price and days; hidden when a jar runs out or the set is off', async () => {
    const d3 = await product(100_000, 40_000, { pack: 60, perDay: 1 });
    const k2 = await product(100_000, 40_000, { pack: 90, perDay: 2 });
    const b = await create(body([{ id: d3.id }, { id: k2.id }]));
    const page = (await http().get(`/api/catalog/bundles/${b.slug}`).expect(200)).body;
    expect(page).toMatchObject({ slug: b.slug, list_total_uzs: 200_000, sale_total_uzs: 180_000, days: 45, doctor_text_uz: 'D3 va K2 birga ishlaydi.' });
    expect(page.items.map((i: { product: { id: string } }) => i.product.id)).toEqual([d3.id, k2.id]);
    expect((await http().get('/api/catalog/bundles').expect(200)).body.some((x: { id: string }) => x.id === b.id)).toBe(true);

    await setStock(prisma, k2.id, 0);
    await http().get(`/api/catalog/bundles/${b.slug}`).expect(404);
    await setStock(prisma, k2.id, 20);
    await http().post(`/api/staff/bundles/${b.id}/status`).set(bearer(admin)).send({ active: false }).expect(200);
    expect((await http().get('/api/catalog/bundles').expect(200)).body.some((x: { id: string }) => x.id === b.id)).toBe(false);
  });

  it('cart: the full set gets «Скидка сета»; one jar short — none; two sets; the order keeps the discount on its lines', async () => {
    const d3 = await product(100_000, 40_000);
    const k2 = await product(150_000, 60_000);
    const b = await create(body([{ id: d3.id }, { id: k2.id }]));

    const partial = await customer();
    expect((await cart(partial, [[d3.id, 1]])).bundle_discount_uzs).toBe(0);

    const token = await customer();
    const view = await cart(token, [[d3.id, 2], [k2.id, 2]]);
    expect(view).toMatchObject({ goods_total_uzs: 500_000, bundle_discount_uzs: 50_000, discount_total_uzs: 50_000 });
    expect(view.bundles).toEqual([expect.objectContaining({ bundle_id: b.id, times: 2, amount_uzs: 50_000 })]);

    const order = (
      await http()
        .post('/api/orders')
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ source: 'cart', recipient_name: 'Тест Сет', recipient_phone: '90 123-45-67', ...addr.samarkand, address_text: 'ул. Тестовая, 1', payment_method: 'card_transfer' })
        .expect(201)
    ).body;
    expect(order.totals).toMatchObject({ goods_total_uzs: 500_000, discount_total_uzs: 50_000, bundle_discount_uzs: 50_000 });
    expect(order.bundles).toEqual([expect.objectContaining({ bundle_id: b.id, amount_uzs: 50_000 })]);
    const rows = await prisma.order_items.findMany({ where: { order_id: order.id } });
    expect(rows.reduce((s, r) => s + Number(r.discount_uzs), 0)).toBe(50_000);
    expect(Number(rows.find((r) => r.product_id === d3.id)!.paid_line_total_uzs)).toBe(180_000);
  });

  it('with a promo code: the code takes only what is left above the margin floor', async () => {
    // cost 80 000 → the floor of a jar is 88 000 (+10%); the set takes 10 000, the code may take 2 000 more per jar
    const a = await product(100_000, 80_000);
    const c = await product(100_000, 80_000);
    await prisma.bundles.create({ data: { slug: `promo-set-${randomUUID()}`, title_ru: 'Сет с промокодом', discount_pct: 10, items: { create: [{ product_id: a.id }, { product_id: c.id, sort_order: 1 }] } } }).then((b) => made.push(b.id));
    const hour = 3600_000;
    const code = `SET${process.pid}X${Date.now() % 1_000_000}`;
    await http()
      .post('/api/staff/promo-codes')
      .set(bearer(admin))
      .send({ code, type: 'percent', value: 20, scope: 'order', first_order_only: false, per_customer_limit: 1, start_at: new Date(Date.now() - hour).toISOString(), end_at: new Date(Date.now() + hour).toISOString(), active: true })
      .expect(201);
    const token = await customer();
    await cart(token, [[a.id, 1], [c.id, 1]]);
    await http().post('/api/cart/promo').set(bearer(token)).send({ code }).expect(201);
    const view = (await http().get('/api/cart').set(bearer(token)).expect(200)).body;
    expect(view).toMatchObject({ bundle_discount_uzs: 20_000, discount_total_uzs: 24_000 });
    expect(view.promo).toMatchObject({ code, discount_uzs: 4_000, capped: true });
  });
});
