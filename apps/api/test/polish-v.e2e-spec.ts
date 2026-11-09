import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const MARKETER_TG = 222_222_224;
const WAREHOUSE_TG = 222_222_223;

/** 6а-В (D-62): the manual promo label of a product and the Halal / Vegan switches in the admin product card. */
describe('6а-В: promo label and Halal / Vegan (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let marketer: string;
  let warehouse: string;
  let p: { id: string };
  const http = () => request(app.getHttpServer());
  const patch = (token: string, body: object) => http().patch(`/api/staff/products/${p.id}`).set(bearer(token)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    marketer = await loginStaff(app, MARKETER_TG);
    warehouse = await loginStaff(app, WAREHOUSE_TG);
    p = await createTestProduct(prisma, { price: 100_000, stock: 3 });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('admin sets «Хит»: the shop shows it on the card and in the list; «выкл» removes it; a wrong value is refused', async () => {
    expect((await patch(admin, { promo_label: 'hit' }).expect(200)).body.promo_label).toBe('hit');
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.promo_label).toBe('hit');
    const list = (await http().get('/api/catalog/products?sort=new').expect(200)).body.items as { id: string; promo_label: string | null }[];
    expect(list.find((i) => i.id === p.id)?.promo_label).toBe('hit');
    await patch(admin, { promo_label: 'sale' }).expect(400);
    expect((await patch(admin, { promo_label: null }).expect(200)).body.promo_label).toBeNull();
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.promo_label).toBeNull();
  });

  it('the marketer may set the promo label (marketing), the warehouse may not', async () => {
    expect((await patch(marketer, { promo_label: 'black_friday' }).expect(200)).body.promo_label).toBe('black_friday');
    await patch(warehouse, { promo_label: 'new' }).expect(403);
    // the marketer still cannot change Halal / VEGE
    expect((await patch(marketer, { halal_vege: 'vege' }).expect(403)).body.code).toBe('CONTENT_ONLY');
  });

  it('Halal and VEGE off on a «VEGE» product → «Нет»: the shop shows no VEGE', async () => {
    await patch(admin, { halal_vege: 'vege', shell_ru: 'рыбий желатин' }).expect(200);
    await patch(admin, { halal_vege: 'none' }).expect(200);
    expect((await http().get(`/api/catalog/products/${p.id}`).expect(200)).body.halal_vege).toBe('none');
  });
});
