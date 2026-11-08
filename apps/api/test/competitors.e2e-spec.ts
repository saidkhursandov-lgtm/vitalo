import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff, TEST_BRAND } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;

/** Генплан, этап 5, ветка iherb-4-competitors (D-57, узел 4): competitor prices with the strict «1-в-1» match. */
describe('competitor prices (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  let productId: string;
  const http = () => request(app.getHttpServer());
  const iherbId = String(700_000 + (Date.now() % 100_000));
  const same = { brand: TEST_BRAND, match_form: 'Бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90 };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, MANAGER_TG);
    const p = await createTestProduct(prisma, { price: 200_000, stock: 0 });
    productId = p.id;
    await prisma.products.update({
      where: { id: p.id },
      data: { brand: TEST_BRAND, match_form: 'бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90, iherb_url: `https://uz.iherb.com/pr/x/${iherbId}`, iherb_product_id: iherbId, cost_uzs: BigInt(120_000) },
    });
  });

  afterAll(async () => {
    await prisma.products.update({ where: { id: productId }, data: { iherb_url: null, iherb_product_id: null } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  const add = (body: object) => http().post(`/api/staff/competitors/${productId}`).set(bearer(admin)).send(body);

  it('saves a matching price and «не тот товар» with the reason; the list shows both', async () => {
    const ok = (await add({ platform: 'uzum', seller: 'Shop A', price_uzs: 185_000, ...same, dose_amount: 0.2, dose_unit: 'g' }).expect(201)).body;
    expect(ok).toMatchObject({ platform: 'uzum', price_uzs: 185_000, match_status: 'match', mismatch_reasons: [], match_form: 'бисглицинат' });
    const bad = (await add({ platform: 'pharmacy', price_uzs: 99_000, ...same, pack_count: 60 }).expect(201)).body;
    expect(bad).toMatchObject({ match_status: 'mismatch', mismatch_reasons: ['в банке: 90 / 60'] });
    const part = (await add({ platform: 'social', price_uzs: 150_000, brand: TEST_BRAND }).expect(201)).body;
    expect(part.match_status).toBe('incomplete');
    const list = (await http().get(`/api/staff/competitors?product_id=${productId}`).set(bearer(admin)).expect(200)).body;
    expect(list.items).toHaveLength(3);
    expect(await prisma.audit_logs.count({ where: { action: 'competitor_price.added', entity_id: productId } })).toBe(3);
  });

  it('only «1-в-1» prices go to the market minimum and the chart; «Убрать» hides, never deletes', async () => {
    await add({ platform: 'yandex_market', price_uzs: 179_000, ...same }).expect(201);
    let row = (await http().get('/api/staff/iherb/products').set(bearer(admin)).expect(200)).body.find((p: { id: string }) => p.id === productId);
    expect(row).toMatchObject({ market_min_uzs: 179_000, competitors_count: 2 });
    const hist = (await http().get(`/api/staff/iherb/products/${productId}/history`).set(bearer(admin)).expect(200)).body;
    expect(hist.competitors_latest.map((c: { platform: string }) => c.platform).sort()).toEqual(['uzum', 'yandex_market']);

    const ym = (await http().get(`/api/staff/competitors?product_id=${productId}`).set(bearer(admin))).body.items.find((i: { platform: string }) => i.platform === 'yandex_market');
    await http().delete(`/api/staff/competitors/${ym.id}`).set(bearer(admin)).expect(200);
    await http().delete(`/api/staff/competitors/${ym.id}`).set(bearer(admin)).expect(404);
    expect(await prisma.competitor_prices.count({ where: { id: ym.id, hidden_at: { not: null } } })).toBe(1);
    row = (await http().get('/api/staff/iherb/products').set(bearer(admin)).expect(200)).body.find((p: { id: string }) => p.id === productId);
    expect(row).toMatchObject({ market_min_uzs: 185_000, competitors_count: 1 });
  });

  it('the match follows the product: fixing our pack count turns «не тот товар» into a match', async () => {
    await prisma.products.update({ where: { id: productId }, data: { pack_count: 60 } });
    try {
      const items = (await http().get(`/api/staff/competitors?product_id=${productId}`).set(bearer(admin))).body.items;
      expect(items.find((i: { platform: string }) => i.platform === 'pharmacy').match_status).toBe('match');
      expect(items.find((i: { platform: string }) => i.platform === 'uzum').match_status).toBe('mismatch');
    } finally {
      await prisma.products.update({ where: { id: productId }, data: { pack_count: 90 } });
    }
  });

  it('wrong input and access', async () => {
    await add({ platform: 'ozon', price_uzs: 100_000 }).expect(400);
    await add({ platform: 'uzum', price_uzs: 10 }).expect(400);
    expect((await add({ platform: 'uzum', price_uzs: 100_000, dose_amount: 5 }).expect(400)).body.code).toBe('DOSE_INCOMPLETE');
    expect((await add({ platform: 'uzum', price_uzs: 100_000, observed_on: '2099-01-01' }).expect(400)).body.code).toBe('DATE_IN_FUTURE');
    await http().get(`/api/staff/competitors?product_id=${productId}`).set(bearer(manager)).expect(403);
    await http().post(`/api/staff/competitors/${productId}`).set(bearer(manager)).send({ platform: 'uzum', price_uzs: 100_000 }).expect(403);
  });
});
