import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;

/** Аудит админки, п. 2.5: «проблемы» товара, сортировка и массовые «Скрыть / Показать / В архив» (D-64). */
describe('Products list: problems, sorting, bulk status (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const list = (query: string, r: Role = 'admin') => http().get(`/api/staff/products${query}`).set(bearer(tokens[r]));

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('problem filters find the product and the counters count it', async () => {
    const p = await createTestProduct(prisma, { price: 120_000, stock: 0 });
    await prisma.products.update({ where: { id: p.id }, data: { ikpu_code: null, name_uz: null, yandex_price_uzs: 110_000 } });
    const before = (await list(`?q=${p.sku}`).expect(200)).body.problems;
    for (const problem of ['no_photo', 'no_ikpu', 'no_uz', 'yandex_mismatch']) {
      const ids = (await list(`?q=${p.sku}&problem=${problem}`).expect(200)).body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual([p.id]);
    }
    // the same Yandex price: no longer a mismatch, the counter goes down by one
    await prisma.products.update({ where: { id: p.id }, data: { yandex_price_uzs: 120_000 } });
    expect((await list(`?q=${p.sku}&problem=yandex_mismatch`).expect(200)).body.items).toEqual([]);
    expect((await list(`?q=${p.sku}`).expect(200)).body.problems.yandex_mismatch).toBe(before.yandex_mismatch - 1);
    await list('?problem=everything').expect(400);
  });

  it('sorting by price and by stock', async () => {
    const tag = `SORT${Date.now().toString(36)}`;
    const a = await createTestProduct(prisma, { price: 30_000, stock: 1, name: `${tag} A` });
    const b = await createTestProduct(prisma, { price: 10_000, stock: 9, name: `${tag} B` });
    const c = await createTestProduct(prisma, { price: 20_000, stock: 5, name: `${tag} C` });
    const ids = async (sort: string) => (await list(`?q=${tag}&sort=${sort}`).expect(200)).body.items.map((i: { id: string }) => i.id);
    expect(await ids('price_asc')).toEqual([b.id, c.id, a.id]);
    expect(await ids('price_desc')).toEqual([a.id, c.id, b.id]);
    expect(await ids('stock_asc')).toEqual([a.id, c.id, b.id]);
    expect(await ids('stock_desc')).toEqual([b.id, c.id, a.id]);
    await list(`?sort=random`).expect(400);
  });

  it('bulk «Скрыть / Показать / В архив»: products.edit only, each change audited, no delete', async () => {
    const [p1, p2] = await Promise.all([1, 2].map(() => createTestProduct(prisma, { price: 5_000, stock: 0 })));
    const bulk = (r: Role, body: object) => http().post('/api/staff/products/bulk-status').set(bearer(tokens[r])).send(body);
    await bulk('marketer', { ids: [p1.id], status: 'hidden' }).expect(403);
    await bulk('admin', { ids: [p1.id], status: 'deleted' }).expect(400);
    await bulk('admin', { ids: [], status: 'hidden' }).expect(400);
    await bulk('admin', { ids: [p1.id, '00000000-0000-4000-8000-000000000000'], status: 'hidden' }).expect(404);

    expect((await bulk('admin', { ids: [p1.id, p2.id], status: 'hidden' }).expect(200)).body).toEqual({ changed: 2, unchanged: 0 });
    expect((await bulk('admin', { ids: [p1.id, p2.id], status: 'hidden' }).expect(200)).body).toEqual({ changed: 0, unchanged: 2 });
    await bulk('admin', { ids: [p1.id], status: 'archived' }).expect(200);
    const rows = await prisma.products.findMany({ where: { id: { in: [p1.id, p2.id] } }, select: { id: true, status: true } });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [p1.id]: 'archived', [p2.id]: 'hidden' });
    expect(await prisma.audit_logs.count({ where: { entity_id: p1.id, action: 'product.archived' } })).toBe(1);
  });
});
