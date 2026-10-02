import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginCustomer } from './helpers';

describe('Favorites (e2e)', () => {
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

  const api = (token: string) => ({
    list: () => http().get('/api/favorites').set(bearer(token)),
    ids: () => http().get('/api/favorites/ids').set(bearer(token)),
    add: (id: string) => http().put(`/api/favorites/${id}`).set(bearer(token)),
    remove: (id: string) => http().delete(`/api/favorites/${id}`).set(bearer(token)),
  });

  it('requires login', async () => {
    await http().get('/api/favorites').expect(401);
  });

  it('add, list (newest first), ids, remove', async () => {
    const fav = api(await loginCustomer(app, 750_000_001));
    const a = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    const b = await createTestProduct(prisma, { price: 20_000, stock: 0 });

    await fav.add(a.id).expect(204);
    await fav.add(b.id).expect(204);

    const { body } = await fav.list().expect(200);
    expect(body.map((p: { id: string }) => p.id)).toEqual([b.id, a.id]);
    expect(body[0]).toMatchObject({ id: b.id, price_uzs: 20_000, in_stock: false });
    expect((await fav.ids().expect(200)).body.sort()).toEqual([a.id, b.id].sort());

    await fav.remove(a.id).expect(204);
    expect((await fav.list().expect(200)).body.map((p: { id: string }) => p.id)).toEqual([b.id]);
  });

  it('adding twice and removing twice are harmless', async () => {
    const fav = api(await loginCustomer(app, 750_000_002));
    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    await fav.add(p.id).expect(204);
    await fav.add(p.id).expect(204);
    expect((await fav.list().expect(200)).body).toHaveLength(1);
    await fav.remove(p.id).expect(204);
    await fav.remove(p.id).expect(204);
    expect((await fav.list().expect(200)).body).toHaveLength(0);
  });

  it('unknown or archived product -> 404; archived favorites disappear from the list', async () => {
    const fav = api(await loginCustomer(app, 750_000_003));
    await fav.add('00000000-0000-4000-8000-000000000000').expect(404);

    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    await fav.add(p.id).expect(204);
    await prisma.products.update({ where: { id: p.id }, data: { status: 'archived' } });
    expect((await fav.list().expect(200)).body).toEqual([]);
    expect((await fav.ids().expect(200)).body).toEqual([]);
    await fav.add(p.id).expect(404);
  });

  it('favorites are private', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    await api(await loginCustomer(app, 750_000_004)).add(p.id).expect(204);
    expect((await api(await loginCustomer(app, 750_000_005)).list().expect(200)).body).toEqual([]);
  });
});
