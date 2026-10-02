import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers';

describe('Search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const search = (q: string, extra = '') =>
    request(app.getHttpServer()).get(`/api/catalog/search?q=${encodeURIComponent(q)}${extra}`);
  const firstSku = async (q: string) => (await search(q).expect(200)).body.items[0]?.sku;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('vitalo_norm() in the database', () => {
    it.each([
      ['Коллаген', 'kolagen'],
      ['collagen', 'kolagen'],
      ['kolagen', 'kolagen'],
      ['КОЛЛАГЕН', 'kolagen'],
      ['Цинк', 'zink'],
      ['zinc', 'zink'],
      ['tsink', 'zink'],
      ['Витамин С', 'vitamin c'], // Cyrillic "С"
      ['vitamin C', 'vitamin c'],
      ['Витамин В12', 'vitamin b12'], // Cyrillic "В"
      ['Омега-3', 'omega 3'],
      ['Магний', 'magni'],
      ['magniy', 'magni'],
      ["Bo'g'imlar", 'bogimlar'],
      ['Bo‘g‘imlar', 'bogimlar'],
    ])('%s -> %s', async (input, expected) => {
      const [{ n }] = await prisma.$queryRaw<{ n: string }[]>`SELECT vitalo_norm(${input}::text) AS n`;
      expect(n).toBe(expected);
    });
  });

  describe('GET /catalog/search', () => {
    it.each([
      ['kolagen', 'VTL-COLLAGEN'], // transliteration + typo, the example from the spec
      ['коллаген', 'VTL-COLLAGEN'],
      ['колаген', 'VTL-COLLAGEN'],
      ['collagen', 'VTL-COLLAGEN'],
      ['колаген морской', 'VTL-COLLAGEN'],
      ['omega', 'VTL-OMEGA3'],
      ['омега 3', 'VTL-OMEGA3'],
      ['omga 3', 'VTL-OMEGA3'], // typo
      ['zinc', 'VTL-ZINC-25'],
      ['tsink', 'VTL-ZINC-25'],
      ['rux', 'VTL-ZINC-25'], // Uzbek name
      ['magniy', 'VTL-MG-B6'],
      ['магни', 'VTL-MG-B6'],
      ['melatonin', 'VTL-MELATONIN'],
      ['мелатонинн', 'VTL-MELATONIN'], // typo
      ['vitamin c', 'VTL-C-1000'], // must not confuse with vitamin K2
      ['витамин с', 'VTL-C-1000'],
      ['витамин d3', 'VTL-D3-2000'],
      ['рыбий жир', 'VTL-OMEGA3'], // search keywords
      ['биотин', 'VTL-BIOTIN'],
    ])('"%s" -> %s first', async (q, sku) => {
      expect(await firstSku(q)).toBe(sku);
    });

    it('brand search returns only that brand', async () => {
      const { body } = await search('sunvita').expect(200);
      expect(body.total).toBe(4);
      expect(body.items.every((i: { brand: string }) => i.brand === 'SunVita')).toBe(true);
    });

    it('nonsense query -> empty result', async () => {
      const { body } = await search('qwzrtx').expect(200);
      expect(body).toMatchObject({ items: [], total: 0, page: 1, page_size: 24 });
    });

    it('does not return hidden or archived products', async () => {
      await prisma.products.create({
        data: { sku: 'TEST-HIDDEN-COLLAGEN', name_ru: 'Коллаген скрытый', brand: 'Hidden', manufacturer: 'X', price_uzs: 1n, status: 'hidden' },
      });
      const { body } = await search('коллаген').expect(200);
      expect(body.items.map((i: { sku: string }) => i.sku)).not.toContain('TEST-HIDDEN-COLLAGEN');
    });

    it('empty or too long query -> 400', async () => {
      await search('   ').expect(400);
      await search('x'.repeat(101)).expect(400);
    });

    it('a single character returns nothing instead of the whole catalog', async () => {
      expect((await search('a').expect(200)).body.total).toBe(0);
    });
  });
});
