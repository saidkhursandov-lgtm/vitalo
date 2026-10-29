import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createTestApp, createTestProduct, archiveTestProducts, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const DOCTOR = '00000000-0000-4000-8000-00000000b001';
const DELIVERY = '00000000-0000-4000-8000-00000000b002';

/** Stage 2.1: home banners (Настройки → Главная → Баннеры). */
describe('Home banners (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let png: Buffer;
  const http = () => request(app.getHttpServer());
  const base = '/api/staff/settings/banners';
  const shop = async (lang: 'ru' | 'uz') => (await http().get(`/api/catalog/banners?lang=${lang}`).expect(200)).body as { id: string; kind: string; image_url: string | null; link: unknown }[];
  const upload = (id: string, lang: 'ru' | 'uz', file = png) => http().post(`${base}/${id}/image/${lang}`).set(bearer(admin)).attach('file', file, 'banner.png');

  const reset = async () => {
    await prisma.home_banners.deleteMany({ where: { kind: 'image' } });
    await prisma.home_banners.update({ where: { id: DOCTOR }, data: { enabled: true, sort_order: 1, starts_at: null, ends_at: null, link_type: null, link_value: null } });
    await prisma.home_banners.update({ where: { id: DELIVERY }, data: { enabled: true, sort_order: 2, starts_at: null, ends_at: null, link_type: null, link_value: null } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    png = await sharp({ create: { width: 1500, height: 500, channels: 3, background: '#002d62' } }).png().toBuffer();
    await reset();
  });
  afterEach(reset);
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('the two banners the shop had are in the list and shown by default, in order', async () => {
    const list = (await http().get(base).set(bearer(admin)).expect(200)).body;
    expect(list.max).toBe(5);
    expect(list.recommended).toEqual({ width: 1200, height: 400 });
    expect(list.items.map((b: { kind: string }) => b.kind)).toEqual(['doctor', 'delivery']);
    expect((await shop('ru')).map((b) => b.kind)).toEqual(['doctor', 'delivery']);
  });

  it('at most 5 banners', async () => {
    for (let i = 0; i < 3; i++) await http().post(base).set(bearer(admin)).expect(201);
    const extra = await http().post(base).set(bearer(admin)).expect(409);
    expect(extra.body).toMatchObject({ code: 'BANNERS_LIMIT' });
    expect(await prisma.home_banners.count()).toBe(5);
  });

  it('on / off: a new picture banner is off until it has a picture; all off = no banners at all', async () => {
    const b = (await http().post(base).set(bearer(admin)).expect(201)).body;
    expect(b).toMatchObject({ kind: 'image', enabled: false });
    expect((await http().patch(`${base}/${b.id}`).set(bearer(admin)).send({ enabled: true }).expect(400)).body.code).toBe('BANNER_IMAGE_REQUIRED');
    await upload(b.id, 'ru').expect(201);
    await http().patch(`${base}/${b.id}`).set(bearer(admin)).send({ enabled: true }).expect(200);
    expect((await shop('ru')).map((x) => x.kind)).toEqual(['doctor', 'delivery', 'image']);

    for (const id of [DOCTOR, DELIVERY, b.id]) await http().patch(`${base}/${id}`).set(bearer(admin)).send({ enabled: false }).expect(200);
    expect(await shop('ru')).toEqual([]);
  });

  it('order: arrows / drag send the full list; a partial list is refused', async () => {
    const b = (await http().post(base).set(bearer(admin)).expect(201)).body;
    await upload(b.id, 'uz').expect(201);
    await http().patch(`${base}/${b.id}`).set(bearer(admin)).send({ enabled: true }).expect(200);
    const after = (await http().put(`${base}/order`).set(bearer(admin)).send({ ids: [b.id, DELIVERY, DOCTOR] }).expect(200)).body;
    expect(after.map((x: { id: string }) => x.id)).toEqual([b.id, DELIVERY, DOCTOR]);
    expect((await shop('ru')).map((x) => x.kind)).toEqual(['image', 'delivery', 'doctor']);
    expect((await http().put(`${base}/order`).set(bearer(admin)).send({ ids: [DOCTOR, DELIVERY] }).expect(400)).body.code).toBe('BANNER_ORDER_INVALID');
  });

  it('picture by language: own picture, otherwise the other one; stored as WebP 1200×400', async () => {
    const b = (await http().post(base).set(bearer(admin)).expect(201)).body;
    const ru = (await upload(b.id, 'ru').expect(201)).body;
    await http().patch(`${base}/${b.id}`).set(bearer(admin)).send({ enabled: true }).expect(200);
    expect(ru.image_ru_url).toMatch(/\.webp$/);
    expect(ru.image_ru_jpeg).toMatch(/\.jpg$/);
    const meta = await sharp((await http().get(ru.image_ru_url).expect(200)).body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1200, 400]);

    // only RU uploaded: both languages show it
    expect((await shop('uz')).find((x) => x.id === b.id)?.image_url).toBe(ru.image_ru_url);
    const uz = (await upload(b.id, 'uz').expect(201)).body;
    expect((await shop('uz')).find((x) => x.id === b.id)?.image_url).toBe(uz.image_uz_url);
    expect((await shop('ru')).find((x) => x.id === b.id)?.image_url).toBe(ru.image_ru_url);

    // removing both pictures switches the banner off
    await http().delete(`${base}/${b.id}/image/ru`).set(bearer(admin)).expect(200);
    const last = (await http().delete(`${base}/${b.id}/image/uz`).set(bearer(admin)).expect(200)).body;
    expect(last.enabled).toBe(false);
    await upload(b.id, 'ru', Buffer.from('not an image')).expect(400);
  });

  it('dates, link check; the built-in banners can only be switched off', async () => {
    const day = 86_400_000;
    await http().patch(`${base}/${DOCTOR}`).set(bearer(admin)).send({ starts_at: new Date(Date.now() + day).toISOString() }).expect(200);
    expect((await shop('ru')).map((x) => x.kind)).toEqual(['delivery']);
    await http().patch(`${base}/${DOCTOR}`).set(bearer(admin)).send({ starts_at: null, ends_at: new Date(Date.now() - day).toISOString() }).expect(200);
    expect((await shop('ru')).map((x) => x.kind)).toEqual(['delivery']);
    expect((await http().patch(`${base}/${DOCTOR}`).set(bearer(admin)).send({ starts_at: new Date(Date.now() + 2 * day).toISOString(), ends_at: new Date(Date.now() + day).toISOString() }).expect(400)).body.code).toBe('BANNER_DATES');

    const p = await createTestProduct(prisma, { price: 10_000, stock: 1 });
    await http().patch(`${base}/${DELIVERY}`).set(bearer(admin)).send({ link_type: 'product', link_value: p.id }).expect(200);
    expect((await shop('ru')).find((x) => x.id === DELIVERY)?.link).toEqual({ type: 'product', value: p.id });
    expect((await http().patch(`${base}/${DELIVERY}`).set(bearer(admin)).send({ link_type: 'category', link_value: 'no-such-category' }).expect(400)).body.code).toBe('BANNER_LINK_INVALID');
    await http().patch(`${base}/${DELIVERY}`).set(bearer(admin)).send({ link_type: null }).expect(200);

    expect((await http().delete(`${base}/${DOCTOR}`).set(bearer(admin)).expect(400)).body.code).toBe('BANNER_BUILT_IN');
    await http().post(`${base}/${DOCTOR}/image/ru`).set(bearer(admin)).attach('file', png, 'b.png').expect(400);
  });

  it('a picture banner can be deleted; only staff with settings rights manage banners', async () => {
    const b = (await http().post(base).set(bearer(admin)).expect(201)).body;
    await upload(b.id, 'ru').expect(201);
    const left = (await http().delete(`${base}/${b.id}`).set(bearer(admin)).expect(200)).body;
    expect(left.map((x: { kind: string }) => x.kind)).toEqual(['doctor', 'delivery']);
    await http().get(base).expect(401);
  });
});
