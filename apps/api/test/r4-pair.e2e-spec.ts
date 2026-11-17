import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PairService } from '../src/catalog/pair.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

/** 4.1 «Идеальная пара» in the product card: picked by the approved synergy rule; by hand; switched off. */
describe('4.1 «Идеальная пара» (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const run = `${process.pid}_${Date.now()}`;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    const sub = async (k: string, parent?: string) =>
      (await prisma.substances.create({ data: { code: `pair_${k}_${run}`, kind: parent ? 'form' : 'substance', parent_id: parent ?? null, name_ru: `${k} ${run}`, name_uz: `${k} ${run}`, synonyms: [] } })).id;
    ids.a = await sub('a');
    ids.aForm = await sub('a_form', ids.a);
    ids.b = await sub('b');
    await prisma.compat_rules.create({
      data: { substance_a_id: ids.a, substance_b_id: ids.b, kind: 'synergy', text_ru: 'Вместе лучше', text_uz: 'Birga yaxshi', status: 'approved' },
    });
    const product = async (name: string, subs: string[], stock: number, extra: Record<string, unknown> = {}) => {
      const p = await createTestProduct(prisma, { price: 100_000, stock, name });
      await prisma.products.update({ where: { id: p.id }, data: extra });
      await prisma.product_substances.createMany({ data: subs.map((s, i) => ({ product_id: p.id, substance_id: s, position: i, in_label: true })) });
      return p.id;
    };
    ids.main = await product(`Главный ${run}`, [ids.aForm], 0); // a form of A, out of stock itself
    ids.pairB = await product(`Пара B ${run}`, [ids.b], 5, { popularity_30d: 3 });
    ids.pairBcheap = await product(`Пара B дешевле ${run}`, [ids.b], 0); // out of stock: never a pair
    ids.both = await product(`A + B ${run}`, [ids.a, ids.b], 5);
    ids.manual = await product(`Ручная ${run}`, [], 5);
    app.get(PairService).reset();
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  const card = async (id: string) => (await request(app.getHttpServer()).get(`/api/catalog/products/${id}`).expect(200)).body;

  it('a form counts as its substance: the pair is the product in stock with the other substance, with «почему вместе»', async () => {
    const c = await card(ids.main);
    expect(c.pair).toMatchObject({ product: { id: ids.pairB }, why_ru: 'Вместе лучше', why_uz: 'Birga yaxshi' });
  });

  it('both substances in one jar: no pair', async () => {
    expect((await card(ids.both)).pair).toBeNull();
  });

  it('the admin chooses the pair by hand, then switches the block off; a product cannot be its own pair', async () => {
    const patch = (body: object) => request(app.getHttpServer()).patch(`/api/staff/products/${ids.main}`).set(bearer(admin)).send(body);
    await patch({ pair_product_id: ids.main }).expect(400);
    await patch({ pair_product_id: ids.manual }).expect(200);
    expect((await card(ids.main)).pair).toMatchObject({ product: { id: ids.manual }, why_ru: null });
    await patch({ pair_off: true }).expect(200);
    expect((await card(ids.main)).pair).toBeNull();
    await patch({ pair_off: false, pair_product_id: null }).expect(200);
    expect((await card(ids.main)).pair.product.id).toBe(ids.pairB);
  });
});
