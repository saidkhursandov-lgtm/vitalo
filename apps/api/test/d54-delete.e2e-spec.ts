import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer, loginStaff, setStock } from './helpers';

const ADMIN_TG = 222_222_221;
const CUSTOMER_TG = 555_054_001;

/** D-54: «Удалить» a product or a brand in the admin panel. */
describe('D-54: deleting products and brands (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let customer: string;
  let userId: string;
  const banners: string[] = [];
  const http = () => request(app.getHttpServer());
  const run = Date.now().toString(36);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    customer = await loginCustomer(app, CUSTOMER_TG);
    userId = (await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(CUSTOMER_TG) } })).id;
  });
  afterAll(async () => {
    await prisma.home_banners.deleteMany({ where: { id: { in: banners } } });
    await prisma.cart_items.deleteMany({ where: { cart: { user_id: userId } } });
    await archiveTestProducts(prisma);
    await prisma.brands.updateMany({ where: { name_ru: { startsWith: 'E2E D54' } }, data: { status: 'archived' } });
    await app.close();
  });

  const banner = async (link_type: string, link_value: string) => {
    const b = await prisma.home_banners.create({ data: { kind: 'delivery', enabled: false, sort_order: 99, link_type, link_value } });
    banners.push(b.id);
    return b.id;
  };

  it('the database still refuses a DELETE that does not come through «Удалить»', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    await expect(prisma.$executeRaw`DELETE FROM products WHERE id = ${p.id}::uuid`).rejects.toThrow(/cannot be deleted/);
  });

  it('a product without history is erased from everywhere', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    const other = await createTestProduct(prisma, { price: 12_000, stock: 1 });
    const category = await prisma.categories.findFirstOrThrow({ where: { status: 'active' } });
    await prisma.product_categories.create({ data: { product_id: p.id, category_id: category.id } });
    await prisma.product_media.create({ data: { product_id: p.id, media_type: 'image', url: `/uploads/products/${p.id}/x.webp`, is_main: true } });
    await prisma.product_relations.create({ data: { product_id: other.id, related_product_id: p.id, relation_type: 'also_bought' } });
    await prisma.favorites.create({ data: { user_id: userId, product_id: p.id } });
    await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: p.id, qty: 1 }).expect(201);
    const bannerId = await banner('product', p.id);
    await setStock(prisma, p.id, 0);

    const res = await http().delete(`/api/staff/products/${p.id}`).set(bearer(admin)).expect(200);
    expect(res.body).toEqual({ result: 'deleted', history: [] });

    expect(await prisma.products.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await prisma.product_media.count({ where: { product_id: p.id } })).toBe(0);
    expect(await prisma.product_categories.count({ where: { product_id: p.id } })).toBe(0);
    expect(await prisma.product_relations.count({ where: { related_product_id: p.id } })).toBe(0);
    expect(await prisma.favorites.count({ where: { product_id: p.id } })).toBe(0);
    expect(await prisma.cart_items.count({ where: { product_id: p.id } })).toBe(0);
    expect(await prisma.home_banners.findUniqueOrThrow({ where: { id: bannerId } })).toMatchObject({ link_type: null, link_value: null });
    expect(await prisma.audit_logs.count({ where: { action: 'product.deleted', entity_id: p.id } })).toBe(1);
    await http().get(`/api/catalog/products/${p.id}`).expect(404);
    // the delete permission ends with the transaction
    await expect(prisma.$executeRaw`DELETE FROM products WHERE id = ${other.id}::uuid`).rejects.toThrow(/cannot be deleted/);
  });

  it('a product with history (stock on hand) is archived and hidden, the history stays', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 3 });
    await http().post('/api/cart/items').set(bearer(customer)).send({ product_id: p.id, qty: 1 }).expect(201);
    const res = await http().delete(`/api/staff/products/${p.id}`).set(bearer(admin)).expect(200);
    expect(res.body).toEqual({ result: 'archived', history: ['stock'] });
    expect((await prisma.products.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('archived');
    expect(await prisma.cart_items.count({ where: { product_id: p.id } })).toBe(0);
    expect(await prisma.inventory.count({ where: { product_id: p.id } })).toBe(1);
  });

  it('a brand: refused while the shop has its products, then erased; archived products keep the name', async () => {
    const created = await http()
      .post('/api/staff/dictionaries/brands')
      .set(bearer(admin))
      .send({ name_ru: `E2E D54 ${run}` })
      .expect(201);
    const brandId = created.body.id as string;
    expect((await prisma.brands.findUniqueOrThrow({ where: { id: brandId } })).slug).toBeTruthy(); // the brand page address is made at once
    const p = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    await prisma.products.update({ where: { id: p.id }, data: { brand_id: brandId, brand: `E2E D54 ${run}` } });
    const bannerId = await banner('brand', `E2E D54 ${run}`);

    const refused = await http().delete(`/api/staff/brands/${brandId}`).set(bearer(admin)).expect(409);
    expect(refused.body.code).toBe('BRAND_HAS_PRODUCTS');
    expect(refused.body.message).toContain('1 товар');

    await http().delete(`/api/staff/products/${p.id}`).set(bearer(admin)).expect(200); // no history: erased
    const archived = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    await prisma.products.update({ where: { id: archived.id }, data: { brand_id: brandId, brand: `E2E D54 ${run}`, status: 'archived' } });

    await http().delete(`/api/staff/brands/${brandId}`).set(bearer(admin)).expect(200);
    expect(await prisma.brands.findUnique({ where: { id: brandId } })).toBeNull();
    expect(await prisma.products.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({ brand_id: null, brand: `E2E D54 ${run}` });
    expect(await prisma.home_banners.findUniqueOrThrow({ where: { id: bannerId } })).toMatchObject({ link_type: null, link_value: null });
    const list = (await http().get('/api/staff/brands').set(bearer(admin)).expect(200)).body.items as { id: string }[];
    expect(list.some((b) => b.id === brandId)).toBe(false);
  });
});
