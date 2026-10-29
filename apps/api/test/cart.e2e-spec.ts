import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  archiveTestProducts,
  bearer,
  createTestApp,
  createTestProduct,
  loginCustomer,
  seededAddresses,
  setStock,
} from './helpers';

interface Line { product_id: string; status: string; qty: number; unit_price_uzs: number; line_total_uzs: number; available_qty: number }

describe('Cart (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  const cartApi = (token: string) => ({
    get: (query = '') => http().get(`/api/cart${query}`).set(bearer(token)),
    add: (product_id: string, qty?: number) => http().post('/api/cart/items').set(bearer(token)).send({ product_id, qty }),
    set: (product_id: string, qty: number) => http().patch(`/api/cart/items/${product_id}`).set(bearer(token)).send({ qty }),
    remove: (product_id: string) => http().delete(`/api/cart/items/${product_id}`).set(bearer(token)),
  });
  const line = (body: { items: Line[] }, productId: string) => body.items.find((i) => i.product_id === productId)!;

  it('requires login', async () => {
    await http().get('/api/cart').expect(401);
  });

  it('empty cart', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_001));
    const { body } = await cart.get().expect(200);
    expect(body).toMatchObject({ items: [], goods_total_uzs: 0, can_checkout: false, delivery: null });
  });

  it('add, increase, change qty and remove; totals follow', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_002));
    const a = await createTestProduct(prisma, { price: 50_000, stock: 10 });
    const b = await createTestProduct(prisma, { price: 30_000, stock: 10 });

    await cart.add(a.id, 2).expect(201);
    let { body } = await cart.add(a.id).expect(201); // +1 (default)
    expect(line(body, a.id).qty).toBe(3);

    ({ body } = await cart.add(b.id, 1).expect(201));
    expect(body).toMatchObject({ goods_total_uzs: 3 * 50_000 + 30_000, items_count: 4, can_checkout: true });

    ({ body } = await cart.set(a.id, 1).expect(200));
    expect(body.goods_total_uzs).toBe(80_000);

    ({ body } = await cart.remove(b.id).expect(200));
    expect(body.items.map((i: Line) => i.product_id)).toEqual([a.id]);
  });

  it('adding more than available is reduced to stock with a warning', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_003));
    const p = await createTestProduct(prisma, { price: 10_000, stock: 5, reserved: 2 }); // available 3

    const { body } = await cart.add(p.id, 10).expect(201);
    expect(line(body, p.id)).toMatchObject({ qty: 3, available_qty: 3 });
    expect(body.warnings).toEqual([{ code: 'qty_reduced', product_id: p.id, requested_qty: 10, available_qty: 3 }]);
  });

  it('out-of-stock and unknown products cannot be added', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_004));
    const p = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    const res = await cart.add(p.id).expect(409);
    expect(res.body.code).toBe('OUT_OF_STOCK');
    await cart.add('00000000-0000-4000-8000-000000000000').expect(404);
    await cart.add(p.id, 0).expect(400);
  });

  it('opening the cart picks up a new price and warns once', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_005));
    const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
    await cart.add(p.id, 2).expect(201);

    await prisma.products.update({ where: { id: p.id }, data: { price_uzs: 90_000n } });
    let { body } = await cart.get().expect(200);
    expect(line(body, p.id)).toMatchObject({ unit_price_uzs: 90_000, line_total_uzs: 180_000 });
    expect(body.warnings).toEqual([{ code: 'price_changed', product_id: p.id, old_price_uzs: 100_000, new_price_uzs: 90_000 }]);

    ({ body } = await cart.get().expect(200));
    expect(body.warnings).toEqual([]);
  });

  it('opening the cart reduces qty when stock went down', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_006));
    const p = await createTestProduct(prisma, { price: 10_000, stock: 10 });
    await cart.add(p.id, 6).expect(201);

    await setStock(prisma, p.id, 4);
    const { body } = await cart.get().expect(200);
    expect(line(body, p.id).qty).toBe(4);
    expect(body.warnings).toEqual([{ code: 'qty_reduced', product_id: p.id, requested_qty: 6, available_qty: 4 }]);
    expect((await cart.get().expect(200)).body.warnings).toEqual([]); // reduction was saved
  });

  it('a product that ran out stays in the cart as unavailable and is excluded from totals', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_007));
    const gone = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    const ok = await createTestProduct(prisma, { price: 20_000, stock: 5 });
    await cart.add(gone.id, 2).expect(201);
    await cart.add(ok.id, 1).expect(201);

    await setStock(prisma, gone.id, 0);
    const { body } = await cart.get().expect(200);
    expect(line(body, gone.id)).toMatchObject({ status: 'unavailable', qty: 2, available_qty: 0 });
    expect(body).toMatchObject({ goods_total_uzs: 20_000, items_count: 1, can_checkout: true });
    expect(body.warnings).toContainEqual({ code: 'out_of_stock', product_id: gone.id });

    await cart.remove(ok.id).expect(200);
    expect((await cart.get().expect(200)).body.can_checkout).toBe(false);
  });

  it('an archived product becomes unavailable', async () => {
    const cart = cartApi(await loginCustomer(app, 700_000_008));
    const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    await cart.add(p.id).expect(201);
    await prisma.products.update({ where: { id: p.id }, data: { status: 'archived' } });
    expect(line((await cart.get().expect(200)).body, p.id).status).toBe('unavailable');
  });

  it('GET /cart/count counts orderable units and does not consume warnings', async () => {
    const token = await loginCustomer(app, 700_000_013);
    const cart = cartApi(token);
    const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
    const gone = await createTestProduct(prisma, { price: 5_000, stock: 5 });
    await cart.add(p.id, 3).expect(201);
    await cart.add(gone.id, 2).expect(201);
    await setStock(prisma, gone.id, 0);
    await setStock(prisma, p.id, 2);
    await prisma.products.update({ where: { id: p.id }, data: { price_uzs: 90_000n } });

    const count = await http().get('/api/cart/count').set(bearer(token)).expect(200);
    // 3 wanted, 2 available; the out-of-stock line is not counted; the sum is at the current price (for the floating cart bar)
    expect(count.body).toEqual({ items_count: 2, goods_total_uzs: 180_000 });

    const { body } = await cart.get().expect(200); // warnings are still there for the cart screen
    expect(body.warnings.map((w: { code: string }) => w.code).sort()).toEqual(['out_of_stock', 'price_changed', 'qty_reduced']);
  });

  it('the cart survives a new session', async () => {
    const tg = 700_000_009;
    const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    await cartApi(await loginCustomer(app, tg)).add(p.id, 2).expect(201);

    const { body } = await cartApi(await loginCustomer(app, tg)).get().expect(200);
    expect(line(body, p.id).qty).toBe(2);
  });

  it('carts are private', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
    await cartApi(await loginCustomer(app, 700_000_010)).add(p.id).expect(201);
    const other = await cartApi(await loginCustomer(app, 700_000_011)).get().expect(200);
    expect(other.body.items).toEqual([]);
  });

  it('shows the delivery quote and free-shipping progress for the chosen city', async () => {
    const { tashkent } = await seededAddresses(prisma);
    const cart = cartApi(await loginCustomer(app, 700_000_012));
    const p = await createTestProduct(prisma, { price: 100_000, stock: 10 });
    await cart.add(p.id, 2).expect(201);

    const q = `?region_id=${tashkent.region_id}&city_id=${tashkent.city_id}`;
    let { body } = await cart.get(q).expect(200);
    expect(body.delivery).toMatchObject({ cost_uzs: 20_000, is_free: false, remaining_for_free_uzs: 100_000 });
    expect(body.delivery.message_ru).toBe('Добавьте ещё на 100 000 сум — доставка будет бесплатной');

    await cart.set(p.id, 3).expect(200);
    ({ body } = await cart.get(q).expect(200));
    expect(body.delivery).toMatchObject({ cost_uzs: 0, is_free: true });
  });
});
