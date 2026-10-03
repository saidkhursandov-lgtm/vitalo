import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers';

interface Item { id: string; sku: string; brand: string; price_uzs: number; in_stock: boolean; image_url: string | null }
interface Node { slug: string; product_count: number; children: Node[] }

describe('Catalog (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const get = (url: string) => request(app.getHttpServer()).get(`/api/catalog${url}`);
  const skus = (items: Item[]) => items.map((i) => i.sku);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('GET /categories', () => {
    it('returns two separate trees with nested children (admin: include_empty=true)', async () => {
      const { body } = await get('/categories?include_empty=true').expect(200);
      const need: Node[] = body.need;
      const types: Node[] = body.product_type;

      expect(need.map((n) => n.slug)).toEqual([
        'immunity', 'beauty', 'joints', 'energy', 'sleep', 'heart', 'memory', 'women', 'men', 'sport',
      ]);
      expect(need.find((n) => n.slug === 'beauty')!.children.map((n) => n.slug)).toEqual(['beauty-skin', 'beauty-hair']);
      expect(types.find((n) => n.slug === 'vitamins')!.children.map((n) => n.slug)).toEqual(
        ['vitamin-d', 'vitamin-c', 'vitamin-b', 'vitamin-k'],
      );
      expect(types.map((n) => n.slug)).not.toContain('immunity');
    });

    it('customers do not see categories without products; the admin list keeps them', async () => {
      const all = (await get('/categories?include_empty=true').expect(200)).body;
      const shown = (await get('/categories').expect(200)).body;
      const slugs = (nodes: Node[]): string[] => nodes.flatMap((n) => [n.slug, ...slugs(n.children)]);
      const nonEmpty = (nodes: Node[]): string[] => nodes.filter((n) => n.product_count > 0).flatMap((n) => [n.slug, ...nonEmpty(n.children)]);
      expect(slugs(shown.need)).toEqual(nonEmpty(all.need));
      expect(slugs(shown.product_type)).toEqual(nonEmpty(all.product_type));
      expect(slugs(shown.need)).not.toContain('women');
      expect(slugs(all.need)).toContain('women');
    });

    it('shows how many visible products each category has (subcategories included)', async () => {
      const { body } = await get('/categories?include_empty=true').expect(200);
      const vitamins: Node = body.product_type.find((n: Node) => n.slug === 'vitamins');
      const listed = (await get('/products?category=vitamins').expect(200)).body.total;
      expect(vitamins.product_count).toBe(listed);
      expect(vitamins.product_count).toBeGreaterThanOrEqual(Math.max(...vitamins.children.map((c) => c.product_count)));
      expect(body.need.find((n: Node) => n.slug === 'women').product_count).toBe(0);
    });
  });

  describe('GET /products/count', () => {
    it('counts with the same filters as the list', async () => {
      for (const qs of ['', '?brand=SunVita', '?in_stock=true', '?category=vitamins&price_max=80000', '?form=capsules']) {
        const list = (await get(`/products${qs}`).expect(200)).body.total;
        expect((await get(`/products/count${qs}`).expect(200)).body).toEqual({ total: list });
      }
    });

    it('rejects invalid filters -> 400', async () => {
      await get('/products/count?price_min=-1').expect(400);
    });
  });

  describe('GET /texts', () => {
    it('returns the product disclaimer in both languages', async () => {
      const { body } = await get('/texts').expect(200);
      expect(body.product_disclaimer).toEqual({ ru: 'БАД. НЕ ЯВЛЯЕТСЯ ЛЕКАРСТВЕННЫМ СРЕДСТВОМ.', uz: expect.any(String) });
    });
  });

  describe('GET /products', () => {
    it('defaults: page 1, page_size 24, sorted by popularity', async () => {
      const { body } = await get('/products').expect(200);
      expect(body).toMatchObject({ page: 1, page_size: 24, total: 10, total_pages: 1 });
      expect(body.items).toHaveLength(10);
      expect(body.items[0].sku).toBe('VTL-OMEGA3'); // highest popularity_30d
      expect(body.items[0]).toMatchObject({ price_uzs: 145000, in_stock: true });
      expect(body.items[0].image_url).toMatch(/^https:\/\//);
    });

    it('page beyond the end is empty, total still correct', async () => {
      const { body } = await get('/products?page=2').expect(200);
      expect(body).toMatchObject({ page: 2, total: 10, items: [] });
    });

    it('filters by one or several brands', async () => {
      const one = (await get('/products?brand=SunVita').expect(200)).body;
      expect(one.total).toBe(4);
      expect(one.items.every((i: Item) => i.brand === 'SunVita')).toBe(true);

      const two = (await get('/products?brand=SunVita,BeautyLab').expect(200)).body;
      expect(two.total).toBe(6);
    });

    it('filters by price range (inclusive)', async () => {
      const { body } = await get('/products?price_min=65000&price_max=89000').expect(200);
      expect(skus(body.items).sort()).toEqual(['VTL-BIOTIN', 'VTL-C-1000', 'VTL-D3-2000', 'VTL-MG-B6']);
    });

    it('category filter includes subcategories', async () => {
      const { body } = await get('/products?category=vitamins').expect(200);
      expect(skus(body.items).sort()).toEqual(['VTL-BIOTIN', 'VTL-C-1000', 'VTL-D3-2000', 'VTL-K2-MK7']);
    });

    it('filters combine (category + brand + price)', async () => {
      const { body } = await get('/products?category=immunity&brand=SunVita&price_max=70000').expect(200);
      expect(skus(body.items)).toEqual(['VTL-C-1000']);
    });

    it('unknown category -> 404', async () => {
      await get('/products?category=no-such-thing').expect(404);
    });

    it('sorts by price both ways, out-of-stock products last', async () => {
      const asc: Item[] = (await get('/products?sort=price_asc').expect(200)).body.items;
      const desc: Item[] = (await get('/products?sort=price_desc').expect(200)).body.items;
      const inStockPrices = asc.filter((i) => i.in_stock).map((i) => i.price_uzs);

      expect(inStockPrices).toEqual([...inStockPrices].sort((a, b) => a - b));
      expect(desc.filter((i) => i.in_stock).map((i) => i.price_uzs)).toEqual([...inStockPrices].reverse());
      // Zinc is the cheapest product, but it is out of stock -> last even in price_asc
      expect(asc.at(-1)!.sku).toBe('VTL-ZINC-25');
      expect(desc.at(-1)!.sku).toBe('VTL-ZINC-25');
    });

    it('sorts by newest first, out-of-stock products last', async () => {
      const items: Item[] = (await get('/products?sort=new').expect(200)).body.items;
      const newest = await prisma.products.findMany({ where: { status: 'active' }, orderBy: { created_at: 'desc' } });
      const inStock = new Set(items.filter((i) => i.in_stock).map((i) => i.sku));
      const expected = [...newest.filter((p) => inStock.has(p.sku)), ...newest.filter((p) => !inStock.has(p.sku))];
      expect(skus(items)).toEqual(expected.map((p) => p.sku));
    });

    it('out-of-stock products go last in the default sort too', async () => {
      const items: Item[] = (await get('/products').expect(200)).body.items;
      const firstOut = items.findIndex((i) => !i.in_stock);
      expect(firstOut).toBeGreaterThan(-1);
      expect(items.slice(firstOut).every((i) => !i.in_stock)).toBe(true);
    });

    it('in_stock=true hides out-of-stock products', async () => {
      const { body } = await get('/products?in_stock=true').expect(200);
      expect(body.total).toBe(9);
      expect(skus(body.items)).not.toContain('VTL-ZINC-25');
    });

    it('rejects invalid query params -> 400', async () => {
      await get('/products?sort=cheapest').expect(400);
      await get('/products?page=0').expect(400);
      await get('/products?price_min=-5').expect(400);
    });

    it('marks out-of-stock and reserved-out products as not in stock', async () => {
      const items: Item[] = (await get('/products').expect(200)).body.items;
      expect(items.find((i) => i.sku === 'VTL-ZINC-25')!.in_stock).toBe(false);
      expect(items.find((i) => i.sku === 'VTL-C-1000')!.in_stock).toBe(true);
    });
  });

  describe('GET /brands', () => {
    it('lists active brands with product counts', async () => {
      const { body } = await get('/brands').expect(200);
      expect(body).toContainEqual({ brand: 'SunVita', count: 4 });
      expect(body.map((b: { brand: string }) => b.brand)).toEqual([...body.map((b: { brand: string }) => b.brand)].sort());
    });
  });

  describe('GET /products/:id', () => {
    it('returns the full card with media, categories and related products', async () => {
      const d3 = await prisma.products.findUniqueOrThrow({ where: { sku: 'VTL-D3-2000' } });
      const { body } = await get(`/products/${d3.id}`).expect(200);

      expect(body).toMatchObject({ sku: 'VTL-D3-2000', brand: 'SunVita', price_uzs: 89000, form: 'Капсулы', in_stock: true });
      expect(body.short_description_ru).toBeTruthy();
      expect(body.media).toHaveLength(1);
      expect(body.categories.map((c: { slug: string }) => c.slug).sort()).toEqual(['immunity', 'joints', 'vitamin-d']);
      expect(skus(body.similar)).toEqual(['VTL-K2-MK7']);
    });

    it('hidden products are not available', async () => {
      const hidden = await prisma.products.create({
        data: { sku: 'TEST-HIDDEN', name_ru: 'Скрытый товар', brand: 'Hidden', manufacturer: 'X', price_uzs: 1000n, status: 'hidden' },
      });
      await get(`/products/${hidden.id}`).expect(404);
      expect((await get('/products?brand=Hidden').expect(200)).body.total).toBe(0);
    });

    it('unknown id -> 404, malformed id -> 400', async () => {
      await get('/products/00000000-0000-4000-8000-000000000000').expect(404);
      await get('/products/abc').expect(400);
    });
  });

  // Runs last: adds 30 products, archives them afterwards so other suites see the plain seed.
  describe('pagination (24 per page)', () => {
    beforeAll(async () => {
      await prisma.products.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({
          sku: `PAG-${String(i).padStart(2, '0')}`,
          name_ru: `Тестовый товар ${i}`,
          brand: 'PagTest',
          manufacturer: 'Test',
          price_uzs: BigInt(10_000 + i),
        })),
      });
    });
    afterAll(() => prisma.products.updateMany({ where: { brand: 'PagTest' }, data: { status: 'archived' } }));

    it('splits 30 products into 24 + 6 without overlap', async () => {
      const p1 = (await get('/products?brand=PagTest&sort=price_asc').expect(200)).body;
      const p2 = (await get('/products?brand=PagTest&sort=price_asc&page=2').expect(200)).body;

      expect(p1).toMatchObject({ total: 30, total_pages: 2 });
      expect(p1.items).toHaveLength(24);
      expect(p2.items).toHaveLength(6);
      const all = [...skus(p1.items), ...skus(p2.items)];
      expect(new Set(all).size).toBe(30);
      expect(all[0]).toBe('PAG-00');
    });
  });
});
