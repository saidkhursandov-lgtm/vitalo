import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;
const MARKETER_TG = 222_222_224;

/** Генплан, этап 5, ветка iherb-1-fields (D-57): iHerb settings and the «1-в-1» match fields of a product. */
describe('iHerb fields of a product (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  let marketer: string;
  const http = () => request(app.getHttpServer());
  const n = Date.now() % 1_000_000;
  const url = (id: string) => '/api/staff/products/' + id;
  const link = (id: number) => `https://uz.iherb.com/pr/now-foods-magnesium-bisglycinate-180-tablets/${id}?rcode=XYZ`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, MANAGER_TG);
    marketer = await loginStaff(app, MARKETER_TG);
  });
  afterAll(async () => {
    await prisma.products.updateMany({ where: { iherb_url: { contains: 'now-foods-magnesium-bisglycinate' } }, data: { iherb_url: null, iherb_product_id: null } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('new product: all off by default, markup 80%, rounding 1000, stock price frozen', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0 });
    const { body } = await http().get(`/api/staff/products/${p.id}`).set(bearer(admin)).expect(200);
    expect(body).toMatchObject({ iherb_url: null, iherb_product_id: null, cross_border_eligible: false, auto_pricing_enabled: false, markup_percent: 80, price_round_to: 1000, stock_price_mode: 'freeze', dose_amount: null, match_form: null });
  });

  it('admin saves the link (cleaned, number taken), the auto pricing settings and the match fields', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0 });
    const { body } = await http()
      .patch(`/api/staff/products/${p.id}`)
      .set(bearer(admin))
      .send({ iherb_url: link(900000 + n), auto_pricing_enabled: true, markup_percent: 75, price_round_to: 500, stock_price_mode: 'dynamic', dose_amount: 200.5, dose_unit: 'mg', dose_per: 'tablet', match_form: '  Бисглицинат ' })
      .expect(200);
    expect(body).toMatchObject({
      iherb_url: `https://uz.iherb.com/pr/now-foods-magnesium-bisglycinate-180-tablets/${900000 + n}`,
      iherb_product_id: String(900000 + n),
      auto_pricing_enabled: true,
      markup_percent: 75,
      price_round_to: 500,
      stock_price_mode: 'dynamic',
      dose_amount: 200.5,
      dose_unit: 'mg',
      dose_per: 'tablet',
      match_form: 'бисглицинат',
    });
    // the same iHerb product cannot be linked twice
    const other = await createTestProduct(prisma, { price: 100_000, stock: 0 });
    const dup = await http().patch(`/api/staff/products/${other.id}`).set(bearer(admin)).send({ iherb_url: link(900000 + n) }).expect(409);
    expect(dup.body.code).toBe('IHERB_TAKEN');
    // clearing the link clears the number
    const cleared = await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ iherb_url: '' }).expect(200);
    expect(cleared.body).toMatchObject({ iherb_url: null, iherb_product_id: null });
  });

  it('refuses a link that is not an iHerb product page and wrong units', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0 });
    expect((await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ iherb_url: 'https://uz.iherb.com/c/vitamins' }).expect(400)).body.code).toBe('BAD_IHERB_URL');
    await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ dose_unit: 'kg' }).expect(400);
    await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ stock_price_mode: 'always' }).expect(400);
  });

  it('manager sees the link and the match fields but not the auto pricing; only the admin edits products', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 0 });
    await http().patch(url(p.id)).set(bearer(admin)).send({ iherb_url: link(800000 + n), dose_amount: 25, dose_unit: 'mg', dose_per: 'capsule', match_form: 'цитрат', markup_percent: 70 }).expect(200);
    const seen = (await http().get(url(p.id)).set(bearer(manager)).expect(200)).body;
    expect(seen).toMatchObject({ iherb_product_id: String(800000 + n), dose_amount: 25, match_form: 'цитрат', cross_border_eligible: false });
    for (const k of ['auto_pricing_enabled', 'markup_percent', 'price_round_to', 'stock_price_mode']) expect(seen).not.toHaveProperty(k);
    await http().patch(url(p.id)).set(bearer(manager)).send({ dose_amount: 30 }).expect(403);
    // the marketer changes only texts and categories
    await http().patch(url(p.id)).set(bearer(marketer)).send({ iherb_url: link(700000 + n) }).expect(403);
  });

  it('the shop does not show iHerb settings to customers', async () => {
    const p = await createTestProduct(prisma, { price: 100_000, stock: 1 });
    await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ iherb_url: link(600000 + n), markup_percent: 90, auto_pricing_enabled: true }).expect(200);
    const { body } = await http().get(`/api/catalog/products/${p.id}`).expect(200);
    const text = JSON.stringify(body);
    for (const k of ['iherb', 'markup', 'auto_pricing', 'stock_price_mode', 'price_round_to']) expect(text).not.toContain(k);
  });
});
