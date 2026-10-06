import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'child_process';
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { applyBackfill, planBackfill } from '../src/import/dictionary-backfill';
import { applyYandexImport, planYandexImport, TABLETS_AND_CAPSULES } from '../src/import/yandex-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;
const RUN = `${process.pid}${Date.now() % 100000}`; // unique names per run (the test database keeps old rows)
const FINANCE = ['cost_uzs', 'yandex_commission_percent', 'yandex_payment_fee_percent', 'yandex_logistics_uzs'];

describe('Stage 1: dictionaries and Yandex Market data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (r: Role) => ({
    get: (p: string) => http().get(`/api${p}`).set(bearer(tokens[r])),
    post: (p: string, body: object = {}) => http().post(`/api${p}`).set(bearer(tokens[r])).send(body),
    patch: (p: string, body: object) => http().patch(`/api${p}`).set(bearer(tokens[r])).send(body),
  });
  const productBody = (over: object = {}) => ({ sku: `E2E-S1-${RUN}-${Math.round(Math.random() * 1e6)}`, name_ru: 'Тест этапа 1', brand: 'x', manufacturer: 'x', price_uzs: 50_000, ...over });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    // Other suites count the active catalog: the products made here leave it.
    await prisma.products.updateMany({ where: { OR: [{ sku: { startsWith: 'E2E-S1-' } }, { sku: { startsWith: 'E2E-BF-' } }] }, data: { status: 'archived' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  // ------------------------------------------------------------------ 1.1 dictionaries
  describe('1.1: dictionaries', () => {
    it('admin adds a value (spaces cleaned); the same name in another case / spacing / ё is a duplicate', async () => {
      const res = await as('admin').post('/staff/dictionaries/brands', { name_ru: `  Ёжик   ${RUN} ` }).expect(201);
      expect(res.body).toMatchObject({ name_ru: `Ёжик ${RUN}`, status: 'active', products: 0 });
      for (const name of [`ёжик ${RUN}`, `ЕЖИК  ${RUN}`, ` Ежик ${RUN}`]) {
        const dup = await as('admin').post('/staff/dictionaries/brands', { name_ru: name }).expect(409);
        expect(dup.body).toMatchObject({ code: 'DICTIONARY_DUPLICATE', existing: { id: res.body.id } });
      }
      await as('manager').post('/staff/dictionaries/brands', { name_ru: `M ${RUN}` }).expect(403);
      await as('marketer').get('/staff/dictionaries/brands').expect(200); // the product card shows the choices
      await as('admin').get('/staff/dictionaries/colors').expect(400);
      await as('admin').post('/staff/dictionaries/forms', { name_ru: '' }).expect(400);
    });

    it('a chosen value is copied into the text column; renaming it renames the products too (audited), the shop filters by the new text', async () => {
      const brand = (await as('admin').post('/staff/dictionaries/brands', { name_ru: `Старый бренд ${RUN}` }).expect(201)).body;
      const form = (await as('admin').post('/staff/dictionaries/forms', { name_ru: `Пастилки ${RUN}` }).expect(201)).body;
      const p = (await as('admin').post('/staff/products', productBody({ brand: 'что угодно', brand_id: brand.id, form_id: form.id })).expect(201)).body;
      expect(p).toMatchObject({ brand: `Старый бренд ${RUN}`, brand_id: brand.id, form: `Пастилки ${RUN}`, form_id: form.id });

      const renamed = await as('admin').patch(`/staff/dictionaries/brands/${brand.id}`, { name_ru: `Новый бренд ${RUN}` }).expect(200);
      expect(renamed.body).toMatchObject({ name_ru: `Новый бренд ${RUN}`, products_updated: 1 });
      expect((await prisma.products.findUniqueOrThrow({ where: { id: p.id } })).brand).toBe(`Новый бренд ${RUN}`);
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { action: 'dictionary.renamed', entity_id: brand.id } });
      expect(audit.before_json).toMatchObject({ name_ru: `Старый бренд ${RUN}` });
      expect(audit.after_json).toMatchObject({ name_ru: `Новый бренд ${RUN}`, products_updated: 1 });

      const shop = (await http().get(`/api/catalog/products?brand=${encodeURIComponent(`Новый бренд ${RUN}`)}`).expect(200)).body;
      expect(shop.items.map((i: { id: string }) => i.id)).toContain(p.id);
    });

    it('archived: not offered, stays on its products, cannot be chosen anew, never deleted', async () => {
      const country = (await as('admin').post('/staff/dictionaries/countries', { name_ru: `Страна ${RUN}` }).expect(201)).body;
      const p = (await as('admin').post('/staff/products', productBody({ country_id: country.id })).expect(201)).body;
      await as('admin').patch(`/staff/dictionaries/countries/${country.id}`, { status: 'archived' }).expect(200);

      const active = (await as('admin').get('/staff/dictionaries/countries').expect(200)).body;
      expect(active.map((v: { id: string }) => v.id)).not.toContain(country.id);
      const all = (await as('admin').get('/staff/dictionaries/countries?include_archived=true').expect(200)).body;
      expect(all.find((v: { id: string }) => v.id === country.id)).toMatchObject({ status: 'archived', products: 1 });

      await as('admin').patch(`/staff/products/${p.id}`, { country_id: country.id, name_ru: 'Переименован' }).expect(200); // keeps it
      const other = await as('admin').post('/staff/products', productBody({ country_id: country.id })).expect(409);
      expect(other.body.code).toBe('DICTIONARY_ARCHIVED');
      await http().delete(`/api/staff/dictionaries/countries/${country.id}`).set(bearer(tokens.admin)).expect(404); // no such endpoint
      await expect(prisma.countries.delete({ where: { id: country.id } })).rejects.toThrow(/cannot be deleted/);
    });

    it('a text changed without a dictionary choice drops the link only when it names something else', async () => {
      const m = (await as('admin').post('/staff/dictionaries/manufacturers', { name_ru: `Завод ${RUN}` }).expect(201)).body;
      const p = (await as('admin').post('/staff/products', productBody({ manufacturer_id: m.id })).expect(201)).body;
      expect((await as('admin').patch(`/staff/products/${p.id}`, { manufacturer: `завод  ${RUN}` }).expect(200)).body.manufacturer_id).toBe(m.id);
      expect((await as('admin').patch(`/staff/products/${p.id}`, { manufacturer: 'Совсем другой завод' }).expect(200)).body.manufacturer_id).toBeNull();
    });
  });

  // ------------------------------------------------------------------ 1.4 Yandex fields
  describe('1.4: Yandex fields and who sees them', () => {
    let productId: string;

    it('a new or changed Yandex price needs the answer «already changed on Yandex Market?»', async () => {
      const body = productBody({ yandex_price_uzs: 60_000, yandex_commission_percent: 18.5, yandex_payment_fee_percent: 0.5, yandex_logistics_uzs: 6_000 });
      const missing = await as('admin').post('/staff/products', body).expect(400);
      expect(missing.body.code).toBe('YANDEX_SYNC_ANSWER_REQUIRED');
      const p = (await as('admin').post('/staff/products', { ...body, yandex_price_already_changed: true }).expect(201)).body;
      expect(p).toMatchObject({ yandex_price_uzs: 60_000, yandex_price_sync_needed: false, yandex_commission_percent: 18.5, yandex_payment_fee_percent: 0.5, yandex_logistics_uzs: 6_000 });
      productId = p.id;

      await as('admin').patch(`/staff/products/${productId}`, { yandex_price_uzs: 65_000 }).expect(400);
      const changed = (await as('admin').patch(`/staff/products/${productId}`, { yandex_price_uzs: 65_000, yandex_price_already_changed: false }).expect(200)).body;
      expect(changed).toMatchObject({ yandex_price_uzs: 65_000, yandex_price_sync_needed: true });
      expect(changed.yandex_price_sync_changed_at).toBeTruthy();
      await as('admin').patch(`/staff/products/${productId}`, { yandex_price_uzs: 65_000, name_ru: 'Тот же Яндекс' }).expect(200); // same price: no question
      await as('admin').patch(`/staff/products/${productId}`, { price_uzs: 51_000 }).expect(200); // the VITALO price never asks

      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: productId, action: 'product.updated' }, orderBy: { created_at: 'asc' } });
      expect(audit.before_json).toMatchObject({ yandex_price_uzs: 60_000 });
      expect(audit.after_json).toMatchObject({ yandex_price_uzs: 65_000, yandex_price_sync_needed: true });

      for (const bad of [{ yandex_commission_percent: 101 }, { yandex_commission_percent: 18.555 }, { yandex_payment_fee_percent: -1 }, { yandex_logistics_uzs: 1.5 }]) {
        await as('admin').patch(`/staff/products/${productId}`, bad).expect(400);
      }
    });

    it('commission, payment fee and logistics: only admin; the Yandex price: admin, manager, marketer — not warehouse', async () => {
      const card = async (r: Role) => (await as(r).get(`/staff/products/${productId}`).expect(200)).body;
      const admin = await card('admin');
      for (const k of [...FINANCE, 'yandex_price_uzs']) expect(admin).toHaveProperty(k);
      for (const r of ['manager', 'marketer'] as Role[]) {
        const b = await card(r);
        expect(b.yandex_price_uzs).toBe(65_000);
        expect(b.yandex_price_sync_needed).toBe(true);
        for (const k of FINANCE) expect(b).not.toHaveProperty(k);
      }
      const w = await card('warehouse');
      for (const k of [...FINANCE, 'yandex_price_uzs', 'yandex_price_sync_needed', 'yandex_price_sync_changed_at']) expect(w).not.toHaveProperty(k);

      const list = async (r: Role) => (await as(r).get(`/staff/products?q=${encodeURIComponent('Тот же Яндекс')}`).expect(200)).body.items[0];
      expect((await list('manager')).yandex_price_uzs).toBe(65_000);
      expect(await list('warehouse')).not.toHaveProperty('yandex_price_uzs');
    });

    it('«требует синхронизации»: filter in the list, marked as synchronized by admin or manager only', async () => {
      const ids = (await as('manager').get('/staff/products?yandex_sync_needed=true').expect(200)).body.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(productId);
      await as('warehouse').post(`/staff/products/${productId}/yandex-price-synced`).expect(403);
      await as('marketer').post(`/staff/products/${productId}/yandex-price-synced`).expect(403);
      expect((await as('manager').post(`/staff/products/${productId}/yandex-price-synced`).expect(200)).body.yandex_price_sync_needed).toBe(false);
      expect(await prisma.audit_logs.count({ where: { entity_id: productId, action: 'product.yandex_price_synced' } })).toBe(1);
      expect((await as('manager').get('/staff/products?yandex_sync_needed=true').expect(200)).body.items.map((i: { id: string }) => i.id)).not.toContain(productId);
    });

    it('finance fields cannot be written without costs.view', async () => {
      // products.edit is admin-only today; the finance check stands on its own anyway
      const res = await as('manager').patch(`/staff/products/${productId}`, { yandex_commission_percent: 10 }).expect(403);
      expect(['FORBIDDEN_FOR_ROLE', 'COST_FORBIDDEN']).toContain(res.body.code);
    });
  });

  // ------------------------------------------------------------------ 1.2 backfill
  describe('1.2: backfill of dictionary links', () => {
    it('groups spellings, reports similar names and «, Россия»; writes only *_id; running again changes nothing', async () => {
      const make = (sku: string, data: Record<string, string | null>) =>
        prisma.products.create({ data: { sku: `E2E-BF-${RUN}-${sku}`, name_ru: 'Backfill', brand: 'x', manufacturer: 'x', price_uzs: 1000n, ...data } });
      const a = await make('A', { brand: `Эвалар${RUN}`, manufacturer: `Завод${RUN}, Россия`, country: null, form: 'Капсулы' });
      const b = await make('B', { brand: `Эвалар${RUN}`, manufacturer: `Завод${RUN}`, country: 'Россия', form: 'капсулы' });
      const c = await make('C', { brand: `эвалар${RUN}  `, manufacturer: `Завод${RUN}`, country: 'Россия', form: null });
      await make('D', { brand: `Солгар${RUN}`, manufacturer: 'Solgar Inc', country: 'США', form: null });
      await make('E', { brand: `Солгарр${RUN}`, manufacturer: 'Solgar Inc', country: 'США', form: null });
      const before = await prisma.brands.count();

      const plan = await planBackfill(prisma);
      expect(await prisma.brands.count()).toBe(before); // the plan writes nothing
      const evalar = plan.kinds.brands.groups.find((g) => g.key === `эвалар${RUN}`)!;
      expect(evalar.name).toBe(`Эвалар${RUN}`); // the most frequent spelling
      expect(evalar.variants).toEqual([
        { text: `Эвалар${RUN}`, count: 2 },
        { text: `эвалар${RUN}`, count: 1 },
      ]);
      expect(plan.kinds.brands.similar).toContainEqual([`Солгар${RUN}`, `Солгарр${RUN}`]);
      expect(plan.splits).toContainEqual(expect.objectContaining({ sku: a.sku, manufacturer: `Завод${RUN}`, country: 'Россия', country_link: 'link' }));

      const result = await applyBackfill(prisma, new AuditService(prisma), plan);
      expect(result.created.brands).toEqual(expect.arrayContaining([`Эвалар${RUN}`, `Солгар${RUN}`, `Солгарр${RUN}`])); // similar names stay separate
      const rows = await prisma.products.findMany({ where: { id: { in: [a.id, b.id, c.id] } }, include: { brand_entry: true, manufacturer_entry: true, country_entry: true } });
      for (const r of rows) {
        expect(r.brand_entry?.name_ru).toBe(`Эвалар${RUN}`);
        expect(r.manufacturer_entry?.name_ru).toBe(`Завод${RUN}`);
        expect(r.country_entry?.name_ru).toBe('Россия');
      }
      expect(rows.find((r) => r.id === a.id)).toMatchObject({ manufacturer: `Завод${RUN}, Россия`, country: null }); // texts untouched
      expect(rows.find((r) => r.id === c.id)!.brand).toBe(`эвалар${RUN}  `);

      const again = await applyBackfill(prisma, new AuditService(prisma), await planBackfill(prisma));
      expect(Object.values(again.created).flat()).toEqual([]);
      expect(Object.values(again.linked).reduce((s, n) => s + n, 0)).toBe(0);
    });

    it('the script refuses a database without _dev / _test, even with --allow-production when nobody can confirm', () => {
      const run = (args: string[]) =>
        spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ts-node', 'scripts/backfill-dictionaries.ts', ...args], {
          cwd: join(__dirname, '..'),
          env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/vitalo' }, // nothing listens on port 1
          encoding: 'utf8',
          shell: process.platform === 'win32',
        });
      const plain = run([]);
      expect(plain.status).not.toBe(0);
      expect(`${plain.stdout}${plain.stderr}`).toContain('без отдельного разрешения');
      const forced = run(['--allow-production']);
      expect(forced.status).not.toBe(0);
      expect(`${forced.stdout}${forced.stderr}`).toContain('нужно подтверждение в окне терминала');
    }, 90_000);
  });

  // ------------------------------------------------------------------ 1.5 Yandex table import
  describe('1.5: import of the Yandex Market table', () => {
    const HEAD = [
      'Наш текущий SKU *', 'SKU Яндекса *', 'Название товара (для сверки)', 'Бренд *', 'Название на узбекском', 'Цена VITALO, сум',
      'Старая цена VITALO (для акции)', 'Цена на Яндексе, сум *', 'Описание рус', 'Описание узб', 'Производитель', 'Страна производителя', 'Форма',
      'Состав', 'Пищевая ценность и дозировка', 'Способ применения', 'Противопоказания и предупреждения', 'Комиссия Яндекса, % *',
      'Поручение на перевод платежа (яндекс), %', 'Логистика Яндекса, сум (фикс.) *', 'Примечание',
    ];
    const dir = mkdtempSync(join(tmpdir(), 'vitalo-yandex-'));
    async function sheet(name: string, rows: unknown[][]) {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('Проверка').addRow(['ignored']);
      const ws = wb.addWorksheet('Яндекс Маркет');
      ws.addRow(HEAD);
      for (const r of rows) ws.addRow(r);
      wb.addWorksheet('Объединено').addRow(HEAD);
      const file = join(dir, name);
      await wb.xlsx.writeFile(file);
      return file;
    }
    const audit = () => new AuditService(prisma);
    const newSku = `E2E-YA-NEW-${RUN}`;

    it('dry run writes nothing; apply fills Yandex fields and empty texts only, creates a hidden product; again = unchanged', async () => {
      const existing = await createTestProduct(prisma, { price: 10_000, stock: 3 });
      await prisma.products.update({ where: { id: existing.id }, data: { short_description_ru: 'Старое описание', manufacturer: 'Test' } });
      const file = await sheet('ok.xlsx', [
        [existing.sku, `YA-${existing.sku}`, 'Сверка', existing.brand, null, 99_999, 30_000, 12_000, 'Новое описание', 'Yangi tavsif', 'Test', 'Россия', 'Таблетки; Капсулы', null, null, null, 'Не для детей', '18,5', '0.5', 5000, null],
        [newSku, newSku, `Новый товар ${RUN}`, `Бренд-${RUN}`, 'Yangi', 220_000, 930_000, '220 000', 'Строка 1\\nСтрока 2', null, `Бренд-${RUN}`, 'Россия', 'Капсулы', null, null, null, null, 18.5, 0.5, 6000, 'примечание'],
      ]);

      const plan = await planYandexImport(prisma, file);
      expect(plan.errors).toEqual([]);
      expect(await prisma.products.findUnique({ where: { sku: newSku } })).toBeNull(); // dry run
      const messages = plan.warnings.map((w) => w.message).join('\n');
      expect(messages).toContain(`SKU Яндекса «YA-${existing.sku}» отличается от нашего`);
      expect(messages).toContain(`форма «Таблетки; Капсулы» → «${TABLETS_AND_CAPSULES}»`);
      expect(messages).toContain('уточнить по упаковке');
      const row = plan.rows.find((r) => r.sku === existing.sku)!;
      expect(row.notes.join('\n')).toContain('цена VITALO: в базе 10000, в таблице 99999 — НЕ применяю');
      expect(row.notes.join('\n')).toContain('short_description_ru: в базе уже «Старое описание»');

      const result = await applyYandexImport(prisma, audit(), plan);
      expect(result).toMatchObject({ created: [newSku], updated: [existing.sku] });

      const e = await prisma.products.findUniqueOrThrow({ where: { id: existing.id }, include: { country_entry: true, form_entry: true } });
      expect(Number(e.price_uzs)).toBe(10_000); // the VITALO price is not applied
      expect(e.short_description_ru).toBe('Старое описание'); // not overwritten
      expect(e).toMatchObject({ short_description_uz: 'Yangi tavsif', warnings_ru: 'Не для детей', country: 'Россия', form: TABLETS_AND_CAPSULES, yandex_price_sync_needed: false });
      expect(Number(e.old_price_uzs)).toBe(30_000);
      expect([Number(e.yandex_price_uzs), Number(e.yandex_commission_percent), Number(e.yandex_payment_fee_percent), Number(e.yandex_logistics_uzs)]).toEqual([12_000, 18.5, 0.5, 5000]);
      expect(e.country_entry?.name_ru).toBe('Россия');
      expect(e.form_entry?.name_ru).toBe(TABLETS_AND_CAPSULES);

      const n = await prisma.products.findUniqueOrThrow({ where: { sku: newSku }, include: { categories: true, inventory: true, media: true, brand_entry: true, manufacturer_entry: true } });
      expect(n).toMatchObject({ status: 'hidden', min_stock: 0, name_ru: `Новый товар ${RUN}`, name_uz: 'Yangi', short_description_ru: 'Строка 1\nСтрока 2' });
      expect([n.categories.length, n.inventory.length, n.media.length]).toEqual([0, 0, 0]);
      expect(Number(n.price_uzs)).toBe(220_000);
      expect(Number(n.yandex_price_uzs)).toBe(220_000);
      expect(n.brand_entry?.name_ru).toBe(`Бренд-${RUN}`);
      expect(n.manufacturer_entry?.name_ru).toBe(`Бренд-${RUN}`);
      await http().get(`/api/catalog/products/${n.id}`).expect(404); // hidden: not in the Mini App

      const again = await planYandexImport(prisma, file);
      expect(again.errors).toEqual([]);
      expect(again.rows.map((r) => r.action)).toEqual(['unchanged', 'unchanged']);
      expect((await applyYandexImport(prisma, audit(), again)).unchanged).toHaveLength(2);
    });

    it('errors anywhere in the table: nothing is written at all', async () => {
      const okSku = `E2E-YA-OK-${RUN}`;
      const file = await sheet('bad.xlsx', [
        [okSku, okSku, 'Хороший', `Бренд-${RUN}`, null, 1000, null, 1000, null, null, 'Завод', null, 'Капсулы', null, null, null, null, 10, 0.5, 100, null],
        [`E2E-YA-BAD1-${RUN}`, `E2E-YA-BAD1-${RUN}`, 'Плохой', `Бренд-${RUN}`, null, 1000, null, 1000, null, null, 'Завод', null, null, null, null, null, null, 150, 0.5, 'abc', null],
        [`E2E-YA-BAD2-${RUN}`, `E2E-YA-BAD2-${RUN}`, 'Без бренда', null, null, 1000, null, 1000, null, null, 'Завод', null, 'Таблетки; Порошок', null, null, null, null, 10, 0.5, 100, null],
      ]);
      const plan = await planYandexImport(prisma, file);
      const text = plan.errors.map((e) => e.message).join('\n');
      expect(text).toContain('процент от 0 до 100');
      expect(text).toContain('сумма целым числом');
      expect(text).toContain('пустое обязательное поле «бренд»');
      expect(text).toContain('несколько значений');
      await expect(applyYandexImport(prisma, audit(), plan)).rejects.toThrow(/ничего не записано/);
      expect(await prisma.products.findUnique({ where: { sku: okSku } })).toBeNull();
    });
  });
});
