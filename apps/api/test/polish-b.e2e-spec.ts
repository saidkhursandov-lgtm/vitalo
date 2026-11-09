import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

/**
 * 6а-Б (D-62): the home strips and «Проверенные бренды».
 * «Популярное» — only products on the Tashkent shelf; «Новинки» — newest first, «под заказ из США» included,
 * without products already in «Популярное»; a brand with only «из США» products is in the showcase.
 */
describe('6а-Б: home strips and brands (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const run = Date.now();
  const http = () => request(app.getHttpServer());
  const ids = (list: { id: string }[]) => list.map((p) => p.id);

  let hit: { id: string };
  let hitOut: { id: string };
  let usa: { id: string };
  let usaGone: { id: string };
  let plainNew: { id: string };
  let brand: { id: string };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    const iherb = await prisma.suppliers.findUniqueOrThrow({ where: { code: 'iherb' } });
    await prisma.suppliers.update({ where: { id: iherb.id }, data: { status: 'active' } });
    const top = 50_000_000;

    // a hit in stock and a «hit» with an empty shelf and no supplier
    hit = await createTestProduct(prisma, { price: 100_000, stock: 5 });
    await prisma.products.update({ where: { id: hit.id }, data: { popularity_30d: top } });
    hitOut = await createTestProduct(prisma, { price: 100_000, stock: 0 });
    await prisma.products.update({ where: { id: hitOut.id }, data: { popularity_30d: top + 1 } });

    // the newest: one in stock (not a hit), one «из США», one from iHerb that iHerb has run out of
    plainNew = await createTestProduct(prisma, { price: 90_000, stock: 2 });
    usa = await createTestProduct(prisma, { price: 270_000, stock: 0 });
    await prisma.products.update({ where: { id: usa.id }, data: { on_zero_supplier_id: iherb.id } });
    usaGone = await createTestProduct(prisma, { price: 270_000, stock: 0 });
    await prisma.products.update({ where: { id: usaGone.id }, data: { on_zero_supplier_id: iherb.id } });
    const upload = await prisma.iherb_uploads.create({ data: {} });
    await prisma.iherb_price_snapshots.create({ data: { upload_id: upload.id, product_id: usaGone.id, iherb_product_id: 'E2E-' + run, price_uzs: 270_000n, in_stock: false } });
    // the hit is also the newest product: it must not repeat in «Новинки»
    await prisma.products.update({ where: { id: hit.id }, data: { created_at: new Date(Date.now() + 60_000) } });

    // a showcase brand whose only product comes «из США»
    brand = (await http().post('/api/staff/dictionaries/brands').set(bearer(admin)).send({ name_ru: `E2E USA Brand ${run}` }).expect(201)).body;
    await prisma.brands.update({ where: { id: brand.id }, data: { show_in_showcase: true, status: 'active' } });
    const b = await prisma.brands.findUniqueOrThrow({ where: { id: brand.id } });
    await prisma.products.update({ where: { id: usa.id }, data: { brand_id: b.id, brand: b.name_ru } });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('«Популярное»: in stock only; «Новинки»: newest, «из США» included, no repeats, no unavailable iHerb', async () => {
    const home = (await http().get('/api/catalog/home').expect(200)).body as { popular: { id: string; in_stock: boolean }[]; fresh: { id: string; cross_border: boolean }[] };
    expect(home.popular.length).toBeLessThanOrEqual(10);
    expect(home.fresh.length).toBeLessThanOrEqual(10);
    expect(home.popular.every((p) => p.in_stock)).toBe(true);
    expect(ids(home.popular)).toContain(hit.id);
    expect(ids(home.popular)).not.toContain(hitOut.id);

    expect(ids(home.fresh)).not.toContain(hit.id); // already in «Популярное»
    expect(ids(home.fresh)).not.toContain(hitOut.id);
    expect(ids(home.fresh)).not.toContain(usaGone.id);
    expect(ids(home.fresh).indexOf(usa.id)).toBeLessThan(ids(home.fresh).indexOf(plainNew.id)); // newest first
    expect(ids(home.fresh)).toEqual(expect.arrayContaining([usa.id, plainNew.id]));
    expect(home.fresh.find((p) => p.id === usa.id)!.cross_border).toBe(true);
    for (const p of home.popular) expect(ids(home.fresh)).not.toContain(p.id);
  });

  it('«Проверенные бренды»: a brand with only «из США» products is shown; without the supplier it is not', async () => {
    const showcase = async () => ids((await http().get('/api/catalog/brands/showcase').expect(200)).body);
    expect(await showcase()).toContain(brand.id);
    await prisma.products.update({ where: { id: usa.id }, data: { on_zero_supplier_id: null } });
    expect(await showcase()).not.toContain(brand.id);
  });
});
