import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createTestApp, loginCustomer, seededAddresses } from './helpers';

interface Address { id: string; is_primary: boolean; address_text: string; label: string | null; city: { name_ru: string } }

describe('Addresses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
  });
  afterAll(() => app.close());

  const api = (token: string) => ({
    list: () => http().get('/api/addresses').set(bearer(token)),
    create: (body: object) => http().post('/api/addresses').set(bearer(token)).send(body),
    update: (id: string, body: object) => http().patch(`/api/addresses/${id}`).set(bearer(token)).send(body),
    primary: (id: string) => http().post(`/api/addresses/${id}/primary`).set(bearer(token)),
    remove: (id: string) => http().delete(`/api/addresses/${id}`).set(bearer(token)),
  });
  const home = () => ({ ...addr.tashkent, address_text: 'ул. Амира Темура, 1', label: 'Дом' });
  const primaries = (list: Address[]) => list.filter((a) => a.is_primary).map((a) => a.id);

  it('requires login', async () => {
    await http().get('/api/addresses').expect(401);
  });

  it('the first address becomes primary automatically, the next one does not', async () => {
    const a = api(await loginCustomer(app, 760_000_001));
    const first = (await a.create(home()).expect(201)).body;
    const second = (await a.create({ ...addr.samarkand, address_text: 'Регистан, 5' }).expect(201)).body;

    expect(first).toMatchObject({ is_primary: true, label: 'Дом', city: { name_ru: 'Юнусабадский район' } });
    expect(second.is_primary).toBe(false);
    const list: Address[] = (await a.list().expect(200)).body;
    expect(list.map((x) => x.id)).toEqual([first.id, second.id]); // primary first
  });

  it('only one primary: creating with is_primary or switching moves the flag', async () => {
    const a = api(await loginCustomer(app, 760_000_002));
    const first = (await a.create(home()).expect(201)).body;
    const second = (await a.create({ ...home(), address_text: 'Работа', is_primary: true }).expect(201)).body;
    expect(primaries((await a.list()).body)).toEqual([second.id]);

    const list = (await a.primary(first.id).expect(200)).body;
    expect(primaries(list)).toEqual([first.id]);
  });

  it('parallel "make primary" calls still leave exactly one primary', async () => {
    const a = api(await loginCustomer(app, 760_000_003));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await a.create({ ...home(), address_text: `Адрес ${i}` }).expect(201)).body.id);

    await Promise.all(ids.map((id) => a.primary(id)));
    expect(primaries((await a.list()).body)).toHaveLength(1);
  });

  it('edit changes fields; region/city are validated together', async () => {
    const a = api(await loginCustomer(app, 760_000_004));
    const created = (await a.create(home()).expect(201)).body;

    const { body } = await a.update(created.id, { address_text: 'ул. Новая, 2', label: 'Офис', ...addr.kattakurgan }).expect(200);
    expect(body).toMatchObject({ address_text: 'ул. Новая, 2', label: 'Офис', city: { name_ru: 'Каттакурган' }, is_primary: true });

    const bad = await a.update(created.id, { city_id: addr.tashkent.city_id }).expect(400); // Tashkent city in Samarkand region
    expect(bad.body.code).toBe('INVALID_ADDRESS');
    await a.update(created.id, { is_primary: false }).expect(200); // ignored: primary changes only via /primary
    expect((await a.list()).body[0].is_primary).toBe(true);
  });

  it('deleting the primary promotes the newest remaining address', async () => {
    const a = api(await loginCustomer(app, 760_000_005));
    const first = (await a.create(home()).expect(201)).body;
    await a.create({ ...home(), address_text: 'Второй' }).expect(201);
    const third = (await a.create({ ...home(), address_text: 'Третий' }).expect(201)).body;

    const list: Address[] = (await a.remove(first.id).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(primaries(list)).toEqual([third.id]);
    expect(await prisma.addresses.count({ where: { id: first.id, deleted_at: { not: null } } })).toBe(1); // soft delete
  });

  it('validation: city must belong to the region, text required, max 10 addresses', async () => {
    const a = api(await loginCustomer(app, 760_000_006));
    expect((await a.create({ ...home(), city_id: addr.samarkand.city_id }).expect(400)).body.code).toBe('INVALID_ADDRESS');
    await a.create({ ...home(), address_text: '   ' }).expect(400);

    for (let i = 0; i < 10; i++) await a.create({ ...home(), address_text: `Адрес ${i}` }).expect(201);
    expect((await a.create(home()).expect(422)).body.code).toBe('TOO_MANY_ADDRESSES');
  });

  it("other users' addresses cannot be read or changed", async () => {
    const mine = (await api(await loginCustomer(app, 760_000_007)).create(home()).expect(201)).body;
    const other = api(await loginCustomer(app, 760_000_008));
    expect((await other.list()).body).toEqual([]);
    await other.update(mine.id, { address_text: 'взлом' }).expect(404);
    await other.primary(mine.id).expect(404);
    await other.remove(mine.id).expect(404);
  });
});

describe('Profile & catalog additions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  it('PATCH /auth/me changes the language; other values are rejected', async () => {
    const token = await loginCustomer(app, 760_000_100);
    const { body } = await http().patch('/api/auth/me').set(bearer(token)).send({ language: 'uz' }).expect(200);
    expect(body.language).toBe('uz');
    await http().patch('/api/auth/me').set(bearer(token)).send({ language: 'en' }).expect(400);
  });

  it('filters products by form and lists forms', async () => {
    const forms = (await http().get('/api/catalog/forms').expect(200)).body;
    expect(forms).toContainEqual({ form: 'Капсулы', count: 5 });

    const { body } = await http().get(`/api/catalog/products?form=${encodeURIComponent('Порошок')}`).expect(200);
    expect(body.items.map((p: { sku: string }) => p.sku)).toEqual(['VTL-COLLAGEN']);
  });

  it('product card exposes available_qty for the qty stepper', async () => {
    const c = await prisma.products.findUniqueOrThrow({ where: { sku: 'VTL-C-1000' } });
    const { body } = await http().get(`/api/catalog/products/${c.id}`).expect(200);
    expect(body.available_qty).toBe(35); // 40 actual - 5 reserved in seed
  });
});
