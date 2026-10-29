import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { applyTransfer, planTransfer, rollbackTransfer } from '../src/catalog/stage22-transfer';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff, setStock } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;

/** Stage 2.2: one-level catalog, moving the old categories, the brand showcase and Админка → Бренды. */
describe('Stage 2.2: catalog in 3 layers and brands (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const http = () => request(app.getHttpServer());
  const run = Date.now().toString(36);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    // products moved to the test brands are not «E2E» any more: archive them too, so other suites count the same
    await prisma.products.updateMany({ where: { brand: { startsWith: 'E2E ' } }, data: { status: 'archived' } });
    await prisma.brands.updateMany({ where: { name_ru: { startsWith: 'E2E ' } }, data: { status: 'archived' } });
    await app.close();
  });

  it('a fresh shop has 8 needs and 7 types, one level, in the agreed order', async () => {
    const all = (await http().get('/api/catalog/categories?include_empty=true').expect(200)).body;
    expect(all.need.map((c: { slug: string }) => c.slug)).toEqual(['sleep', 'immunity', 'joints', 'energy', 'beauty', 'women', 'men', 'sport']);
    expect(all.product_type.map((c: { slug: string }) => c.slug)).toEqual(['vitamins', 'minerals', 'omega', 'collagen', 'creatine-amino', 'protein', 'other']);
    expect(all.need.find((c: { slug: string }) => c.slug === 'energy').name_uz).toBe('Energiya va miya');
    expect([...all.need, ...all.product_type].every((c: { children: unknown[] }) => c.children.length === 0)).toBe(true);
  });

  describe('moving old categories (npm run catalog:stage22)', () => {
    const made: string[] = [];
    let collagen: { id: string };
    let heartOnly: { id: string };

    beforeAll(async () => {
      const beauty = await prisma.categories.findUniqueOrThrow({ where: { slug: 'beauty' } });
      const vitamins = await prisma.categories.findUniqueOrThrow({ where: { slug: 'vitamins' } });
      // The old trees as they are on vitalo_dev and the server: «Кожа» inside «Красота», «Витамин D» inside «Витамины» …
      const old = [
        { slug: 'memory', tree_type: 'need' as const, parent_id: null, name_ru: 'Память и концентрация' },
        { slug: 'heart', tree_type: 'need' as const, parent_id: null, name_ru: 'Сердце и сосуды' },
        { slug: 'beauty-skin', tree_type: 'need' as const, parent_id: beauty.id, name_ru: 'Кожа' },
        { slug: 'vitamin-d', tree_type: 'product_type' as const, parent_id: vitamins.id, name_ru: 'Витамин D' },
      ];
      for (const c of old) {
        const row = await prisma.categories.upsert({ where: { slug: c.slug }, create: { ...c, name_uz: c.name_ru }, update: { status: 'active', merged_into_id: null } });
        made.push(row.id);
      }
      await prisma.categories.update({ where: { slug: 'energy' }, data: { name_ru: 'Энергия', name_uz: 'Energiya' } });
      const id = async (slug: string) => (await prisma.categories.findUniqueOrThrow({ where: { slug } })).id;
      collagen = await createTestProduct(prisma, { price: 100_000, stock: 5, name: 'Коллаген морской с витамином C' });
      heartOnly = await createTestProduct(prisma, { price: 100_000, stock: 5, name: 'Омега-3 1000 мг' });
      await prisma.product_categories.createMany({
        data: [
          { product_id: collagen.id, category_id: await id('collagen') },
          { product_id: collagen.id, category_id: await id('vitamin-d') },
          { product_id: collagen.id, category_id: await id('beauty-skin') },
          { product_id: collagen.id, category_id: await id('memory') },
          { product_id: heartOnly.id, category_id: await id('heart') },
          { product_id: heartOnly.id, category_id: await id('omega') },
        ],
      });
    });
    afterAll(async () => {
      await prisma.product_categories.deleteMany({ where: { category_id: { in: made } } });
      await prisma.categories.updateMany({ where: { id: { in: made } }, data: { status: 'archived' } });
      await prisma.categories.update({ where: { slug: 'energy' }, data: { name_ru: 'Энергия и мозг', name_uz: 'Energiya va miya', status: 'active' } });
    });

    const linksOf = async (productId: string) =>
      (await prisma.product_categories.findMany({ where: { product_id: productId }, include: { category: true } })).map((l) => l.category.slug).sort();

    it('dry run writes nothing and shows every product', async () => {
      const plan = await planTransfer(prisma);
      expect(plan.alreadyApplied).toBe(false);
      const p = plan.products.find((x) => x.id === collagen.id)!;
      expect(p).toMatchObject({ new_needs: ['energy', 'beauty'], new_type: 'collagen', type_source: 'name' });
      expect(plan.products.find((x) => x.id === heartOnly.id)).toMatchObject({ new_needs: [], new_type: 'omega' });
      expect(plan.categories.find((c) => c.slug === 'energy')).toMatchObject({ action: 'rename', new_name_ru: 'Энергия и мозг' });
      expect(plan.categories.find((c) => c.slug === 'heart')).toMatchObject({ action: 'hide', target: null });
      expect(await linksOf(collagen.id)).toEqual(['beauty-skin', 'collagen', 'memory', 'vitamin-d']);
    });

    it('apply: backup first, old ones hidden and pointing to the new ones, one type, old addresses still work; rollback puts all back', async () => {
      const r = await applyTransfer(prisma, await planTransfer(prisma));
      expect(r.categoriesHidden).toBeGreaterThanOrEqual(4);
      // Old links stay (hidden categories), the new ones are added; the extra type link is gone.
      expect(await linksOf(collagen.id)).toEqual(['beauty', 'beauty-skin', 'collagen', 'energy', 'memory']);
      const memory = await prisma.categories.findUniqueOrThrow({ where: { slug: 'memory' }, include: { merged_into: true } });
      expect(memory).toMatchObject({ status: 'archived' });
      expect(memory.merged_into?.slug).toBe('energy');
      expect((await prisma.categories.findUniqueOrThrow({ where: { slug: 'energy' } })).name_ru).toBe('Энергия и мозг');

      // A banner or an old link to «Память» opens «Энергия и мозг»; «Сердце» has no replacement.
      const viaOld = (await http().get('/api/catalog/products?category=memory').expect(200)).body;
      expect(viaOld.items.map((p: { id: string }) => p.id)).toContain(collagen.id);
      await http().get('/api/catalog/products?category=heart').expect(404);
      const tree = (await http().get('/api/catalog/categories').expect(200)).body;
      expect(tree.need.map((c: { slug: string }) => c.slug)).not.toContain('memory');

      await expect(applyTransfer(prisma, await planTransfer(prisma))).rejects.toThrow(/уже выполнен/);

      await rollbackTransfer(prisma);
      expect(await linksOf(collagen.id)).toEqual(['beauty-skin', 'collagen', 'memory', 'vitamin-d']);
      expect(await prisma.categories.findUniqueOrThrow({ where: { slug: 'memory' } })).toMatchObject({ status: 'active', merged_into_id: null });
      expect((await prisma.categories.findUniqueOrThrow({ where: { slug: 'energy' } })).name_ru).toBe('Энергия');
      expect((await planTransfer(prisma)).alreadyApplied).toBe(false);
    });
  });

  it('a product has several needs but only one type (admin product card)', async () => {
    const p = await createTestProduct(prisma, { price: 50_000, stock: 1 });
    const ids = Object.fromEntries((await prisma.categories.findMany({ where: { status: 'active' } })).map((c) => [c.slug, c.id]));
    const bad = await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ category_ids: [ids.sleep, ids.vitamins, ids.minerals] }).expect(400);
    expect(bad.body.code).toBe('ONE_PRODUCT_TYPE');
    await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ category_ids: [ids.sleep, ids.energy, ids.minerals] }).expect(200);
  });

  describe('brands', () => {
    let shown: { id: string; slug: string };
    let soldOut: { id: string };
    let product: { id: string };

    beforeAll(async () => {
      // New brands get their address at once (the dictionary in Настройки or the import).
      shown = (await http().post('/api/staff/dictionaries/brands').set(bearer(admin)).send({ name_ru: `E2E Now Foods ${run}` }).expect(201)).body;
      soldOut = (await http().post('/api/staff/dictionaries/brands').set(bearer(admin)).send({ name_ru: `E2E Empty ${run}` }).expect(201)).body;
      const b = await prisma.brands.findUniqueOrThrow({ where: { id: shown.id } });
      expect(b.slug).toBe(`e2e-now-foods-${run}`);
      shown = { id: b.id, slug: b.slug! };
      product = await createTestProduct(prisma, { price: 120_000, stock: 3 });
      await prisma.products.update({ where: { id: product.id }, data: { brand_id: shown.id, brand: b.name_ru } });
      const empty = await createTestProduct(prisma, { price: 120_000, stock: 0 });
      await prisma.products.update({ where: { id: empty.id }, data: { brand_id: soldOut.id, brand: `E2E Empty ${run}` } });
    });

    const showcase = async () => (await http().get('/api/catalog/brands/showcase').expect(200)).body as { id: string; slug: string; logo_url: string | null }[];

    it('the showcase has only brands with products in stock, switched on', async () => {
      expect((await showcase()).map((b) => b.id)).toContain(shown.id);
      expect((await showcase()).map((b) => b.id)).not.toContain(soldOut.id);
      await setStock(prisma, product.id, 0);
      expect((await showcase()).map((b) => b.id)).not.toContain(shown.id);
      await setStock(prisma, product.id, 3);
      await http().patch(`/api/staff/brands/${shown.id}`).set(bearer(admin)).send({ show_in_showcase: false }).expect(200);
      expect((await showcase()).map((b) => b.id)).not.toContain(shown.id);
      await http().patch(`/api/staff/brands/${shown.id}`).set(bearer(admin)).send({ show_in_showcase: true }).expect(200);
    });

    it('brand page by address (and by name for old banners); «Почему … в VITALO», country RU/UZ; product card links to it', async () => {
      await http()
        .patch(`/api/staff/brands/${shown.id}`)
        .set(bearer(admin))
        .send({ country_ru: 'США', country_uz: 'AQSH', why_vitalo_ru: 'Проверенный производитель.', why_vitalo_uz: 'Ishonchli ishlab chiqaruvchi.' })
        .expect(200);
      const page = (await http().get(`/api/catalog/brands/${shown.slug}`).expect(200)).body;
      expect(page).toMatchObject({ slug: shown.slug, country_uz: 'AQSH', why_vitalo_ru: 'Проверенный производитель.', product_count: 1 });
      expect((await http().get(`/api/catalog/brands/${encodeURIComponent(`E2E Now Foods ${run}`)}`).expect(200)).body.id).toBe(shown.id);
      await http().get('/api/catalog/brands/no-such-brand').expect(404);
      expect((await http().get(`/api/catalog/products/${product.id}`).expect(200)).body.brand_slug).toBe(shown.slug);
    });

    it('admin: address rules, logo upload (square WebP 400×400), access only for admins', async () => {
      expect((await http().patch(`/api/staff/brands/${shown.id}`).set(bearer(admin)).send({ slug: 'Not Latin!' }).expect(400)).body).toBeTruthy();
      const taken = await http().patch(`/api/staff/brands/${soldOut.id}`).set(bearer(admin)).send({ slug: shown.slug }).expect(409);
      expect(taken.body.code).toBe('BRAND_SLUG_TAKEN');

      const wide = await sharp({ create: { width: 800, height: 400, channels: 4, background: '#002d62' } }).png().toBuffer();
      const up = (await http().post(`/api/staff/brands/${shown.id}/logo`).set(bearer(admin)).attach('file', wide, 'logo.png').expect(201)).body;
      expect(up.logo_square).toBe(false);
      expect(up.logo_url).toMatch(/\.webp$/);
      const list = (await http().get('/api/staff/brands').set(bearer(admin)).expect(200)).body;
      expect(list.logo).toEqual({ width: 400, height: 400 });
      expect(list.items.find((b: { id: string }) => b.id === shown.id)).toMatchObject({ shown_in_showcase: true, products_in_stock: 1 });
      expect((await showcase()).find((b) => b.id === shown.id)?.logo_url).toBe(up.logo_url);
      await http().delete(`/api/staff/brands/${shown.id}/logo`).set(bearer(admin)).expect(200);

      const manager = await loginStaff(app, MANAGER_TG);
      await http().get('/api/staff/brands').set(bearer(manager)).expect(403);
    });
  });
});
