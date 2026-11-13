import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

/** «Действующие вещества» of the card: the label «Форма вещества» from the dictionary and suggestions from the texts. */
describe('Substances of the product card and the label (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let manager: string;
  const http = () => request(app.getHttpServer());
  let mg: string;
  let b6: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    const subs = (await http().get('/api/staff/compat/substances').set(bearer(admin)).expect(200)).body as { id: string; name_ru: string }[];
    mg = subs.find((s) => s.name_ru === 'Магний')!.id;
    b6 = subs.find((s) => s.name_ru === 'Витамин B6')!.id;
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('the label is built from the substances marked «в надпись», in order, RU and UZ; a sent hand-written one is ignored', async () => {
    const product = await createTestProduct(prisma, { price: 50_000, stock: 1 });
    await prisma.products.update({ where: { id: product.id }, data: { substance_form_ru: 'цитрат магния', substance_form_uz: 'sitrat' } });
    const patch = (body: Record<string, unknown>) => http().patch(`/api/staff/products/${product.id}`).set(bearer(admin)).send(body);

    let p = (await patch({ substance_form_ru: 'вручную', substances: [{ id: mg, in_label: true }, { id: b6, in_label: true }] }).expect(200)).body;
    expect(p.substance_form_ru).toBe('Магний + Витамин B6');
    expect(p.substance_form_uz).toMatch(/ \+ /);
    expect(p.substances.map((s: { id: string; in_label: boolean }) => [s.id, s.in_label])).toEqual([[mg, true], [b6, true]]);

    // «Товары и вещества» changes the order: the marks stay, the label follows
    await http().put(`/api/staff/compat/products/${product.id}/substances`).set(bearer(admin)).send({ substance_ids: [b6, mg] }).expect(200);
    expect((await prisma.products.findUniqueOrThrow({ where: { id: product.id } })).substance_form_ru).toBe('Витамин B6 + Магний');

    // nothing marked in the card — no label; untouched substances keep it as it is
    p = (await patch({ substances: [{ id: mg, in_label: false }] }).expect(200)).body;
    expect(p.substance_form_ru).toBeNull();
    expect(p.substances).toHaveLength(1);
    p = (await patch({ name_ru: product.name_ru }).expect(200)).body;
    expect(p.substances).toHaveLength(1);
  });

  it('an old hand-written label stays when «Товары и вещества» links substances without marks', async () => {
    const product = await createTestProduct(prisma, { price: 50_000, stock: 1 });
    await prisma.products.update({ where: { id: product.id }, data: { substance_form_ru: 'Цитрат + B6' } });
    const list = (await http().put(`/api/staff/compat/products/${product.id}/substances`).set(bearer(admin)).send({ substance_ids: [mg] }).expect(200)).body;
    expect(list.find((x: { id: string }) => x.id === product.id)).toMatchObject({ form_label: 'Цитрат + B6', label_source: 'manual' });
  });

  it('suggestions: found in the name — strong; drug groups never; the editor asks before saving', async () => {
    const found = (await http().post('/api/staff/compat/suggest').set(bearer(manager)).send({ name_ru: 'Магний + Витамин B6, 60 таблеток' }).expect(200)).body as { id: string; strong: boolean }[];
    expect(found).toEqual(expect.arrayContaining([{ id: mg, strong: true, kind: 'substance', name_ru: 'Магний', name_uz: expect.any(String), parent_name: null }]));
    expect(found.some((s) => s.id === b6 && s.strong)).toBe(true);
  });

  it('«Принять подсказки» links the strong suggestions to products without substances; a manager cannot', async () => {
    const product = await createTestProduct(prisma, { price: 50_000, stock: 1, name: `Магний тест ${Date.now()}` });
    const list = (await http().get('/api/staff/compat/products').set(bearer(admin)).expect(200)).body;
    expect(list.find((x: { id: string }) => x.id === product.id).suggested).toEqual(expect.arrayContaining([expect.objectContaining({ id: mg, strong: true })]));
    await http().post('/api/staff/compat/products/accept-suggestions').set(bearer(manager)).send({ product_ids: [product.id] }).expect(403);
    const r = (await http().post('/api/staff/compat/products/accept-suggestions').set(bearer(admin)).send({ product_ids: [product.id] }).expect(200)).body;
    expect(r.accepted).toBe(1);
    expect(r.products.find((x: { id: string }) => x.id === product.id).substances.map((s: { id: string }) => s.id)).toEqual([mg]);
  });
});
