import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import request from 'supertest';
import { findPlaceholders } from '../src/legal/legal.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;
const MIGRATION = join(__dirname, '..', 'prisma', 'migrations', '20261004100000_launch_regions_delivery_legal', 'migration.sql');

/** Splits a SQL file into statements (keeps ; inside quotes and $tag$ … $tag$ blocks). */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      cur += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const tag = sql.slice(i).match(/^\$[a-z_]*\$/);
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      cur += sql.slice(i, end + tag[0].length);
      i = end + tag[0].length;
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

describe('Launch block A (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const http = () => request(app.getHttpServer());
  const asAdmin = (method: 'get' | 'post' | 'patch' | 'put', path: string, body?: object) => http()[method](`/api${path}`).set(bearer(admin)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginStaff(app, ADMIN_TG);
    addr = await seededAddresses(prisma);
  });
  afterAll(async () => {
    // Leave no active documents behind: other suites create orders without the consent screen.
    await prisma.legal_documents.updateMany({ where: { status: 'active' }, data: { status: 'archived' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ A1 legal documents
  describe('A1: offer and privacy policy', () => {
    it('placeholders: "[ ]" and escaped "\\[…\\]" are found, links are not', () => {
      expect(findPlaceholders('Продавец: \\[полное наименование, ИНН\\]. Телефон [ ]. См. [сайт](https://x.uz)')).toEqual(['[полное наименование, ИНН]', '[ ]']);
      expect(findPlaceholders('Готовый текст')).toEqual([]);
    });

    it('admin publishes a version -> customers must accept it before ordering; marketing consent is optional and off by default', async () => {
      const p = await createTestProduct(prisma, { price: 10_000, stock: 5 });
      const token = await loginCustomer(app, 970_000_001);
      // No active documents yet: nothing to accept
      expect((await http().get('/api/legal/status').set(bearer(token)).expect(200)).body.accepted).toBe(true);

      for (const code of ['offer', 'privacy']) {
        const list = (await asAdmin('post', '/staff/legal', { code, version: 't1', text_ru: `**${code}** RU\n\n- пункт [ ]`, text_uz: `${code} UZ` }).expect(201)).body;
        const draft = list.find((d: { code: string; version: string }) => d.code === code && d.version === 't1');
        expect(draft).toMatchObject({ status: 'draft', placeholders: ['[ ]'] });
        await asAdmin('post', `/staff/legal/${draft.id}/publish`).expect(200);
        // published text is frozen
        expect((await asAdmin('patch', `/staff/legal/${draft.id}`, { text_ru: 'x' }).expect(409)).body.code).toBe('LEGAL_NOT_DRAFT');
      }

      const docs = (await http().get('/api/legal/documents').expect(200)).body;
      expect(docs.map((d: { code: string; version: string }) => `${d.code}:${d.version}`)).toEqual(['offer:t1', 'privacy:t1']);
      expect((await http().get('/api/legal/status').set(bearer(token)).expect(200)).body.accepted).toBe(false);

      const body = { source: 'buy_now', buy_now: { product_id: p.id, qty: 1 }, recipient_name: 'Тест', recipient_phone: '+998901112233', ...addr.tashkent, address_text: 'ул. 1', payment_method: 'card_transfer' };
      const blocked = await http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body).expect(403);
      expect(blocked.body.code).toBe('LEGAL_NOT_ACCEPTED');

      const accepted = (await http().post('/api/legal/accept').set(bearer(token)).send({}).expect(200)).body;
      expect(accepted.accepted).toBe(true);
      const user = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: 970_000_001n } });
      expect(user.marketing_opt_in).toBe(false);
      expect(await prisma.legal_acceptances.count({ where: { user_id: user.id, source: 'mini_app' } })).toBe(2);
      // accepting twice records nothing new
      await http().post('/api/legal/accept').set(bearer(token)).send({ marketing_opt_in: true }).expect(200);
      expect(await prisma.legal_acceptances.count({ where: { user_id: user.id } })).toBe(2);
      expect((await prisma.users.findUniqueOrThrow({ where: { id: user.id } })).marketing_opt_in).toBe(true);

      await http().post('/api/orders').set(bearer(token)).set('Idempotency-Key', randomUUID()).send(body).expect(201);

      // A new version of the offer -> the consent screen again; the old one is archived
      const v2 = (await asAdmin('post', '/staff/legal', { code: 'offer', version: 't2', text_ru: 'Новая оферта', text_uz: 'Yangi oferta' }).expect(201)).body.find((d: { version: string }) => d.version === 't2');
      await asAdmin('post', `/staff/legal/${v2.id}/publish`).expect(200);
      expect((await http().get('/api/legal/status').set(bearer(token)).expect(200)).body).toMatchObject({ accepted: false, documents: [{ code: 'offer', version: 't2', accepted: false }, { code: 'privacy', accepted: true }] });
      expect(await prisma.legal_documents.findFirst({ where: { code: 'offer', version: 't1' } })).toMatchObject({ status: 'archived' });
    });

    it('only admins manage documents', async () => {
      const manager = await loginStaff(app, DEV_MANAGER_TG);
      await http().get('/api/staff/legal').set(bearer(manager)).expect(403);
      await http().post('/api/legal/accept').send({}).expect(401);
    });
  });

  // ------------------------------------------------------------------ A2 regions, A3 terms, A4/A5 contacts
  describe('A2-A5: regions, tariffs, contacts', () => {
    it('the migration adds all 14 regions, Tashkent districts and test tariffs; running it again adds nothing', async () => {
      const statements = splitSql(readFileSync(MIGRATION, 'utf8'));
      const before = await prisma.delivery_tariffs.findMany({ where: { is_test: false } });
      await prisma
        .$transaction(async (tx) => {
          // documents published by other tests would (correctly) stop the migration from adding the test version
          await tx.legal_documents.updateMany({ where: { status: 'active' }, data: { status: 'archived' } });
          for (let run = 0; run < 2; run++) for (const s of statements) await tx.$executeRawUnsafe(s);
          const regions = await tx.regions.findMany({ include: { cities: true, tariffs: { where: { city_id: null, status: 'active' } } } });
          expect(regions).toHaveLength(14);
          expect(regions.find((r) => r.name_ru === 'г. Ташкент')!.cities.filter((c) => c.name_ru.endsWith('район'))).toHaveLength(12);
          for (const r of regions) expect(r.tariffs).toHaveLength(1); // every region can deliver
          const test = regions.filter((r) => r.tariffs[0].is_test);
          expect(test.length).toBe(11); // seed has tariffs for 3 regions
          for (const r of test) expect(r.tariffs[0]).toMatchObject({ tariff_uzs: 35000n, free_shipping_threshold_uzs: 500000n, min_days: 5, max_days: 10 });
          // existing tariffs are unchanged
          for (const t of before) expect(await tx.delivery_tariffs.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ tariff_uzs: t.tariff_uzs, status: t.status });
          const legal = await tx.legal_documents.findMany({ where: { version: '0.1-test' } });
          expect(legal.map((d) => d.code).sort()).toEqual(['offer', 'privacy']);
          expect(legal[0].text_ru).not.toContain('Прочитайте сначала');
          throw new Error('rollback');
        })
        .catch((e: Error) => {
          if (e.message !== 'rollback') throw e;
        });
      expect(await prisma.regions.count()).toBe(3); // rolled back
    });

    it('admin: delivery terms and the test mark on tariffs, validation', async () => {
      const tariffs = (await asAdmin('get', '/staff/settings/tariffs').expect(200)).body;
      const tashkent = tariffs.find((t: { region: { name_ru: string }; city: unknown }) => t.region.name_ru === 'г. Ташкент' && !t.city);
      expect(tashkent).toMatchObject({ min_days: 2, max_days: 5, is_test: false });
      expect((await asAdmin('patch', `/staff/settings/tariffs/${tashkent.id}`, { min_days: 6, max_days: 3 }).expect(409)).body.code).toBe('INVALID_DAYS');
      await asAdmin('patch', `/staff/settings/tariffs/${tashkent.id}`, { min_days: 1, max_days: 3, note_ru: 'Курьер позвонит', note_uz: 'Kuryer qo‘ng‘iroq qiladi', is_test: true }).expect(200);
      try {
        expect((await http().get(`/api/delivery/eta?region_id=${addr.tashkent.region_id}&city_id=${addr.tashkent.city_id}`).expect(200)).body).toEqual({ min_days: 1, max_days: 3, note_ru: 'Курьер позвонит', note_uz: 'Kuryer qo‘ng‘iroq qiladi' });
        expect((await asAdmin('get', '/staff/settings/tariffs').expect(200)).body.find((t: { id: string }) => t.id === tashkent.id).is_test).toBe(true);
      } finally {
        await asAdmin('patch', `/staff/settings/tariffs/${tashkent.id}`, { min_days: 2, max_days: 5, note_ru: '', note_uz: '', is_test: false }).expect(200);
      }
    });

    it('admin: add, rename and switch off a city; customers see only active cities', async () => {
      const region = (await asAdmin('get', '/staff/settings/regions').expect(200)).body.find((r: { name_ru: string }) => r.name_ru === 'г. Ташкент');
      const list = (await asAdmin('post', '/staff/settings/cities', { region_id: region.id, name_ru: 'Тестовый район', name_uz: 'Test tumani' }).expect(201)).body;
      const city = list.find((r: { id: string }) => r.id === region.id).cities.find((c: { name_ru: string }) => c.name_ru === 'Тестовый район');
      expect((await asAdmin('post', '/staff/settings/cities', { region_id: region.id, name_ru: 'тестовый район', name_uz: 'x' }).expect(409)).body.code).toBe('CITY_EXISTS');
      await asAdmin('patch', `/staff/settings/cities/${city.id}`, { name_uz: 'Sinov tumani', status: 'archived' }).expect(200);
      const shop = (await http().get('/api/delivery/regions').expect(200)).body.find((r: { id: string }) => r.id === region.id);
      expect(shop.cities.map((c: { id: string }) => c.id)).not.toContain(city.id);
      expect(await prisma.audit_logs.count({ where: { entity_id: city.id, action: { startsWith: 'city.' } } })).toBe(2);
    });

    it('admin: support contact, payment hours and the «рабочих дней» label (validated, used by the shop)', async () => {
      const before = (await asAdmin('get', '/staff/settings/contacts').expect(200)).body;
      expect(before).toMatchObject({ support_contact: '@VITALO_support', payment_check_from: '08:00', payment_check_to: '22:00' });
      await asAdmin('put', '/staff/settings/contacts', { ...before, support_contact: 'not a handle!' }).expect(400);
      await asAdmin('put', '/staff/settings/contacts', { ...before, payment_check_from: '25:00' }).expect(400);
      try {
        await asAdmin('put', '/staff/settings/contacts', { ...before, support_contact: 't.me/vitalo_help', payment_check_from: '09:00' }).expect(200);
        expect((await http().get('/api/catalog/texts').expect(200)).body).toMatchObject({ support_url: 'https://t.me/vitalo_help', payment_check_hours: { from: '09:00', to: '22:00' } });
      } finally {
        await asAdmin('put', '/staff/settings/contacts', before).expect(200);
      }
    });
  });
});
