import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;

/** Аудит админки 10.11, п. 1.5: отметка «тестовый» у товара, бренда, закупки и клиента. */
describe('Test flags (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  const flag = (r: Role, entity: string, id: string, is_test: boolean) =>
    http().patch(`/api/staff/test-flags/${entity}/${id}`).set(bearer(tokens[r])).send({ is_test });

  it('admin only; written to the audit log; the product is hidden with hide_test=true and still found without it', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    for (const r of ['manager', 'warehouse', 'marketer'] as Role[]) await flag(r, 'product', p.id, true).expect(403);
    await flag('admin', 'order', p.id, true).expect(400);
    await flag('admin', 'product', p.id, true).expect(200, { entity: 'product', id: p.id, is_test: true });
    await flag('admin', 'product', p.id, true).expect(200); // the same value again: no second audit record
    const audit = await prisma.audit_logs.findMany({ where: { action: 'test_flag.set', entity_id: p.id } });
    expect(audit).toHaveLength(1);

    const list = async (query: string) => (await http().get(`/api/staff/products?q=${p.sku}${query}`).set(bearer(tokens.admin)).expect(200)).body.items;
    expect(await list('&hide_test=true')).toHaveLength(0);
    expect((await list(''))[0]).toMatchObject({ id: p.id, is_test: true });
    expect((await http().get(`/api/staff/products/${p.id}`).set(bearer(tokens.admin)).expect(200)).body.is_test).toBe(true);
    await flag('admin', 'product', p.id, false).expect(200);
  });

  it('brand, purchase, customer: flag and hide', async () => {
    const brand = await prisma.brands.findFirstOrThrow();
    const user = await prisma.users.findFirstOrThrow();
    const purchase = await prisma.purchases.findFirst();
    try {
      await flag('admin', 'brand', brand.id, true).expect(200);
      const brands = (await http().get('/api/staff/brands?hide_test=true').set(bearer(tokens.admin)).expect(200)).body.items;
      expect(brands.map((b: { id: string }) => b.id)).not.toContain(brand.id);

      await flag('admin', 'customer', user.id, true).expect(200);
      expect((await http().get(`/api/staff/customers/${user.id}`).set(bearer(tokens.admin)).expect(200)).body.is_test).toBe(true);
      const customers = (await http().get(`/api/staff/customers?q=${user.telegram_user_id}&hide_test=true`).set(bearer(tokens.admin)).expect(200)).body.items;
      expect(customers).toHaveLength(0);

      if (purchase) {
        await flag('admin', 'purchase', purchase.id, true).expect(200);
        const all = (await http().get('/api/staff/purchases?hide_test=true').set(bearer(tokens.admin)).expect(200)).body.items;
        expect(all.map((x: { id: string }) => x.id)).not.toContain(purchase.id);
      }
    } finally {
      await prisma.brands.update({ where: { id: brand.id }, data: { is_test: false } });
      await prisma.users.update({ where: { id: user.id }, data: { is_test: false } });
      if (purchase) await prisma.purchases.update({ where: { id: purchase.id }, data: { is_test: false } });
    }
  });

  it('unknown id → 404', async () => {
    await flag('admin', 'brand', '00000000-0000-4000-8000-000000000000', true).expect(404);
  });
});
