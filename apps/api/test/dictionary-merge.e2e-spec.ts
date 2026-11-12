import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const MANAGER_TG = 222_222_222;

/** D-65 / аудит админки 4.6: «Объединить» duplicates — products move, the duplicate is archived (not deleted), audited. */
describe('Dictionary merge (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  const http = () => request(app.getHttpServer());
  const tag = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, MANAGER_TG);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('a brand duplicate: products, campaign targets and banners move; the duplicate stays in the archive', async () => {
    const keep = (await http().post('/api/staff/dictionaries/brands').set(bearer(admin)).send({ name_ru: `Merge Keep ${tag}` }).expect(201)).body;
    const dup = (await http().post('/api/staff/dictionaries/brands').set(bearer(admin)).send({ name_ru: `Merge Dup ${tag}` }).expect(201)).body;
    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    await prisma.products.update({ where: { id: p.id }, data: { brand_id: dup.id, brand: dup.name_ru } });
    const dupSlug = (await prisma.brands.findUniqueOrThrow({ where: { id: dup.id } })).slug!;
    const keepSlug = (await prisma.brands.findUniqueOrThrow({ where: { id: keep.id } })).slug!;
    const banner = await prisma.home_banners.create({ data: { kind: 'promo', enabled: false, link_type: 'brand', link_value: dupSlug } });

    await http().post(`/api/staff/dictionaries/brands/${dup.id}/merge`).set(bearer(manager)).send({ into_id: keep.id }).expect(403);
    await http().post(`/api/staff/dictionaries/brands/${dup.id}/merge`).set(bearer(admin)).send({ into_id: dup.id }).expect(400);

    const res = (await http().post(`/api/staff/dictionaries/brands/${dup.id}/merge`).set(bearer(admin)).send({ into_id: keep.id }).expect(200)).body;
    expect(res).toMatchObject({ products_moved: 1, banners_moved: 1, merged: { status: 'archived' } });
    expect(await prisma.products.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ brand_id: keep.id, brand: keep.name_ru });
    expect((await prisma.home_banners.findUniqueOrThrow({ where: { id: banner.id } })).link_value).toBe(keepSlug);
    expect(await prisma.brands.findUnique({ where: { id: dup.id } })).toMatchObject({ status: 'archived' }); // not deleted
    expect(await prisma.audit_logs.count({ where: { action: 'dictionary.merged', entity_id: dup.id } })).toBe(1);

    // nothing merges into an archived value
    await http().post(`/api/staff/dictionaries/brands/${keep.id}/merge`).set(bearer(admin)).send({ into_id: dup.id }).expect(409);
  });

  it('a manufacturer duplicate moves its products and their text column', async () => {
    const keep = (await http().post('/api/staff/dictionaries/manufacturers').set(bearer(admin)).send({ name_ru: `Maker Keep ${tag}` }).expect(201)).body;
    const dup = (await http().post('/api/staff/dictionaries/manufacturers').set(bearer(admin)).send({ name_ru: `Maker Dup ${tag}` }).expect(201)).body;
    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    await prisma.products.update({ where: { id: p.id }, data: { manufacturer_id: dup.id, manufacturer: dup.name_ru } });
    await http().post(`/api/staff/dictionaries/manufacturers/${dup.id}/merge`).set(bearer(admin)).send({ into_id: keep.id }).expect(200);
    expect(await prisma.products.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ manufacturer_id: keep.id, manufacturer: keep.name_ru });
    await http().post(`/api/staff/dictionaries/suppliers/${dup.id}/merge`).set(bearer(admin)).send({ into_id: keep.id }).expect(400);
  });
});
