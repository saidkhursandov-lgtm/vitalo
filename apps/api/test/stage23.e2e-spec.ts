import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

/** Stage 2.3: product card fields — saved in the admin panel, shown in the Mini App without the staff-only ones. */
describe('Stage 2.3 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('admin saves the card fields; the card and the list show them, the Halal source, memo and staff note stay in the admin', async () => {
    const p = await createTestProduct(prisma, { price: 125_000, stock: 5 });
    const fields = {
      substance_form_ru: ' Цитрат + B6 ',
      substance_form_uz: 'Sitrat + B6',
      pack_count: 200,
      servings_per_day: 4,
      std_bioavailability: true,
      std_tested: true,
      std_original: false,
      halal_vege: 'vege',
      shell_ru: 'без капсулы',
      halal_vege_source: 'состав на этикетке',
      market_advantage_percent: 15,
      doctor_verdict_ru: 'Цитрат магния хорошо усваивается.',
      doctor_verdict_uz: 'Magniy sitrat yaxshi oʻzlashtiriladi.',
      intake_memo_ru: 'По 2 таблетки утром и вечером.',
      admin_note: 'сверить при следующей поставке',
    };
    const saved = (await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send(fields).expect(200)).body;
    expect(saved).toMatchObject({ ...fields, substance_form_ru: 'Цитрат + B6' });

    const card = (await http().get(`/api/catalog/products/${p.id}`).expect(200)).body;
    expect(card).toMatchObject({
      substance_form_ru: 'Цитрат + B6',
      course_days: 50,
      pack_count: 200,
      std_bioavailability: true,
      std_original: false,
      halal_vege: 'vege',
      shell_ru: 'без капсулы',
      market_advantage_percent: 15,
      doctor_verdict_uz: 'Magniy sitrat yaxshi oʻzlashtiriladi.',
    });
    for (const hidden of ['halal_vege_source', 'intake_memo_ru', 'intake_memo_uz', 'admin_note', 'servings_per_day']) expect(card).not.toHaveProperty(hidden);

    const list = (await http().get(`/api/catalog/products?q=${encodeURIComponent(p.sku)}`).expect(200)).body;
    const item = list.items.find((x: { id: string }) => x.id === p.id);
    expect(item).toMatchObject({ substance_form_ru: 'Цитрат + B6', course_days: 50 });
    expect(item).not.toHaveProperty('doctor_verdict_ru');

    // under 7 days or not filled: no «Хватит на…»; empty texts clear the field
    await http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send({ pack_count: 12, servings_per_day: 2, doctor_verdict_ru: '' }).expect(200);
    const short = (await http().get(`/api/catalog/products/${p.id}`).expect(200)).body;
    expect(short.course_days).toBeNull();
    expect(short.doctor_verdict_ru).toBeNull();
  });

  it('wrong values are refused: Маркет over 50%, an unknown Halal value, a too long verdict', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    const patch = (body: object) => http().patch(`/api/staff/products/${p.id}`).set(bearer(admin)).send(body);
    await patch({ market_advantage_percent: 51 }).expect(400);
    await patch({ halal_vege: 'maybe' }).expect(400);
    await patch({ doctor_verdict_ru: 'x'.repeat(1501) }).expect(400);
    await patch({ servings_per_day: 0 }).expect(400);
    await patch({ halal_vege: null, market_advantage_percent: null }).expect(200);
  });
});
