import { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BRAND_COLUMNS, CATEGORY_COLUMNS, PRODUCT_COLUMNS, RULE_COLUMNS, SUBSTANCE_COLUMNS, checkCatalog, loadCatalogDb, readCatalogFile } from '../src/import/catalog-master';
import { applyCatalogLoad, nextSkus, planCatalogLoad } from '../src/import/catalog-master-load';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';
import { createTestApp, createTestProduct } from './helpers';

const RUN = `${process.pid}${Date.now() % 100000}`;
type Row = Record<string, string | number | null>;

/** npm run catalog:load — the checked master table goes into the database in one transaction (07.11.2026). */
describe('catalog:load — the master table into the database (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const dir = mkdtempSync(join(tmpdir(), 'vitalo-catalog-load-'));
  const BRAND = `E2E Load ${RUN}`;
  const SUB_A = `Тестин ${RUN}`;
  const SUB_B = `Пробин ${RUN}`;
  const NEW_NAME = `Тестин ${RUN} новый товар, 60 капс.`;
  let need: { name_ru: string; name_uz: string; slug: string }[];
  let types: { name_ru: string; name_uz: string; slug: string }[];
  let old: { id: string; sku: string };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const cats = await prisma.categories.findMany({ where: { parent_id: null, status: 'active' }, orderBy: { sort_order: 'asc' } });
    need = cats.filter((c) => c.tree_type === 'need');
    types = cats.filter((c) => c.tree_type === 'product_type');
    old = await createTestProduct(prisma, { price: 100_000, stock: 3, name: `Старый товар ${RUN}` });
  });
  afterAll(async () => {
    await prisma.products.updateMany({ where: { brand: BRAND }, data: { status: 'archived' } });
    await app.close();
  });

  const product = (over: Row): Row => ({
    status: 'Скрыт',
    brand: BRAND,
    name_uz: 'Test mahsulot',
    short_ru: 'Тестин, 60 капс.',
    short_uz: 'Testin, 60 kaps.',
    need1: need[0].name_ru,
    type: types[0].name_ru,
    form: 'Капсулы',
    pack: 60,
    per_day: 2,
    price: 150_000,
    comp_ru: 'Тестин 100 мг',
    comp_uz: 'Testin 100 mg',
    verdict_ru: 'Длинный вердикт. '.repeat(80),
    verdict_uz: 'Uzun xulosa. '.repeat(80),
    substances: SUB_A,
    std_bio: 'Да',
    halal: 'VEGE',
    shell: 'Растительная (HPMC)',
    manufacturer: `ООО «Тест ${RUN}»`,
    country: 'США',
    ...over,
  });

  async function table(file: string, opts: { products: Row[]; rules?: Row[]; substances?: Row[]; brands?: Row[] }) {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('VITALO Curation Process').addRow(['справочный лист — не читается']);
    const sheet = (name: string, heads: string[], rows: Row[], keys: string[]) => {
      const ws = wb.addWorksheet(name);
      ws.getRow(2).values = heads;
      rows.forEach((r, i) => (ws.getRow(4 + i).values = keys.map((k) => r[k] ?? null)));
    };
    sheet('Товары', PRODUCT_COLUMNS.map((c) => c.head), opts.products, PRODUCT_COLUMNS.map((c) => c.key));
    sheet('Бренды', BRAND_COLUMNS.map((c) => c.head), opts.brands ?? [], BRAND_COLUMNS.map((c) => c.key));
    sheet('Вещества', SUBSTANCE_COLUMNS.map((c) => c.head), opts.substances ?? [], SUBSTANCE_COLUMNS.map((c) => c.key));
    sheet('Правила совместимости', RULE_COLUMNS.map((c) => c.head), opts.rules ?? [], RULE_COLUMNS.map((c) => c.key));
    const cats = wb.addWorksheet('Категории');
    for (const [head, from, list] of [
      [2, 3, need],
      [22, 23, types],
    ] as const) {
      cats.getRow(head).values = CATEGORY_COLUMNS.map((c) => c.head);
      list.forEach((c, i) => (cats.getRow(from + i).values = CATEGORY_COLUMNS.map((d) => ({ code: `C${head}${i}`, name_ru: c.name_ru, name_uz: c.name_uz, order: i + 1, show: 'Да', slug: c.slug })[d.key as 'code'] ?? null)));
    }
    await wb.xlsx.writeFile(join(dir, file));
    return readCatalogFile(join(dir, file));
  }

  const fullTable = (file: string) =>
    table(file, {
      brands: [{ name: BRAND, action: 'Новый', country_ru: 'США', country_uz: 'AQSh', why_ru: 'Почему бренд в VITALO. '.repeat(60), why_uz: 'Nega VITALO da. '.repeat(60), show: 'Да', order: 50 }],
      substances: [
        { action: 'Новое', name_ru: SUB_A, name_uz: `Testin ${RUN}`, kind: 'Вещество', synonyms: `testin${RUN}` },
        { action: 'Новое', name_ru: SUB_B, name_uz: `Probin ${RUN}`, kind: 'Вещество' },
      ],
      products: [
        product({ action: 'Новый', name_ru: NEW_NAME }),
        product({ sku: old.sku, action: 'Изменить', status: 'Активен', name_ru: `Старый товар ${RUN}`, substances: `${SUB_A}, ${SUB_B}`, need2: need[1].name_ru }),
      ],
      rules: [{ a: SUB_A, b: SUB_B, kind: 'Синергия', when_a: 'Утро', when_b: 'Утро', text_ru: 'Вместе лучше.', text_uz: 'Birga yaxshiroq.', action: 'Новое', approve: 'Да' }],
    });

  it('new SKUs continue OZN-A### and skip the taken ones', () => {
    expect(nextSkus(['OZN-A001', 'OZN-A023', 'VTL-ZINC-25', 'ozn-a025'], 3)).toEqual(['OZN-A026', 'OZN-A027', 'OZN-A028']);
    expect(nextSkus([], 1)).toEqual(['OZN-A001']);
  });

  it('the plan writes nothing; --confirm writes everything in one go; a second run of the same file adds no twins', async () => {
    const sheets = await fullTable('load.xlsx');
    const before = await prisma.products.count();
    const plan = await planCatalogLoad(prisma, sheets);
    expect(plan.check.errors).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.newSkus).toHaveLength(1);
    expect(plan.newSkus[0].sku).toMatch(/^OZN-A\d{3}$/);
    expect(await prisma.products.count()).toBe(before); // the plan is read only

    const result = await applyCatalogLoad(prisma, new AuditService(prisma), plan);
    expect(result).toMatchObject({ substances: { created: 2 }, brands: { created: 1 }, rules: { created: 1 }, products: { created: [plan.newSkus[0].sku], updated: [old.sku] } });

    const brand = await prisma.brands.findFirstOrThrow({ where: { name_ru: BRAND } });
    expect(brand.slug).toBeTruthy();
    expect(brand.why_vitalo_ru!.length).toBeGreaterThan(1000);
    const created = await prisma.products.findUniqueOrThrow({
      where: { sku: plan.newSkus[0].sku },
      include: { categories: { include: { category: true } }, substances: { include: { substance: true } } },
    });
    expect(created).toMatchObject({ status: 'hidden', brand: BRAND, brand_id: brand.id, pack_count: 60, servings_per_day: 2, halal_vege: 'vege', shell_ru: 'растительная (HPMC)', std_bioavailability: true, std_tested: false });
    expect(created.price_uzs).toBe(150_000n);
    expect(created.doctor_verdict_ru!.length).toBeGreaterThan(1000);
    expect(created.categories.map((c) => c.category.name_ru).sort()).toEqual([need[0].name_ru, types[0].name_ru].sort());
    expect(created.substances.map((s) => s.substance.name_ru)).toEqual([SUB_A]);

    const changed = await prisma.products.findUniqueOrThrow({ where: { id: old.id }, include: { categories: { include: { category: true } }, substances: { include: { substance: true } } } });
    expect(changed).toMatchObject({ status: 'active', brand: BRAND, brand_id: brand.id, short_name_ru: 'Тестин, 60 капс.' });
    expect(changed.categories.map((c) => c.category.name_ru).sort()).toEqual([need[0].name_ru, need[1].name_ru, types[0].name_ru].sort());
    expect(changed.substances.map((s) => s.substance.name_ru).sort()).toEqual([SUB_A, SUB_B].sort());

    const rule = await prisma.compat_rules.findFirstOrThrow({ where: { substance_a: { name_ru: SUB_A } } });
    expect(rule).toMatchObject({ kind: 'synergy', origin: 'xlsx', status: 'approved', when_a: 'morning' });
    expect(rule.approved_at).not.toBeNull();
    expect(await prisma.audit_logs.count({ where: { entity_id: { in: [created.id, old.id, brand.id, rule.id] }, after_json: { path: ['source'], equals: 'catalog:load' } } })).toBeGreaterThanOrEqual(4);

    // the table as the next export writes it (codes of the substances, the new SKU): nothing left to change
    const codes = await prisma.substances.findMany({ where: { name_ru: { in: [SUB_A, SUB_B] } } });
    const exported = await table('exported.xlsx', {
      brands: [{ name: BRAND, action: 'Без изменений', country_ru: 'США', country_uz: 'AQSh', why_ru: 'Почему бренд в VITALO. '.repeat(60), why_uz: 'Nega VITALO da. '.repeat(60), show: 'Да', order: 50 }],
      substances: codes.map((c) => ({ code: c.code, action: 'Без изменений', name_ru: c.name_ru, name_uz: c.name_uz, kind: 'Вещество', synonyms: c.synonyms.join(', ') })),
      products: [
        product({ sku: plan.newSkus[0].sku, action: 'Изменить', name_ru: NEW_NAME }),
        product({ sku: old.sku, action: 'Изменить', status: 'Активен', name_ru: `Старый товар ${RUN}`, substances: `${SUB_A}, ${SUB_B}`, need2: need[1].name_ru }),
      ],
      rules: [{ id: rule.id, a: SUB_A, b: SUB_B, kind: 'Синергия', when_a: 'Утро', when_b: 'Утро', text_ru: 'Вместе лучше.', text_uz: 'Birga yaxshiroq.', action: 'Изменить' }],
    });
    const again = checkCatalog(exported, await loadCatalogDb(prisma));
    expect(again.errors).toEqual([]);
    expect(again.changes).toEqual([]);

    // the same file once more: the new rows are refused, nothing is written twice
    const count = await prisma.products.count();
    const second = await planCatalogLoad(prisma, sheets);
    expect([...second.check.errors, ...second.errors].length).toBeGreaterThan(0);
    await expect(applyCatalogLoad(prisma, new AuditService(prisma), second)).rejects.toThrow('ничего не записано');
    expect(await prisma.products.count()).toBe(count);
  });

  it('a new product with the full name of an existing one is refused (the SKU has to be written in)', async () => {
    const sheets = await table('twin.xlsx', {
      brands: [{ name: BRAND, action: 'Без изменений', country_ru: 'США', country_uz: 'AQSh', why_ru: 'Почему бренд в VITALO. '.repeat(60), why_uz: 'Nega VITALO da. '.repeat(60), show: 'Да', order: 50 }],
      products: [product({ action: 'Новый', name_ru: `Старый товар ${RUN}`, substances: null })],
    });
    const plan = await planCatalogLoad(prisma, sheets);
    expect(plan.errors.map((e) => e.message).join('\n')).toContain(`уже есть (${old.sku})`);
  });

  it('an untranslated UZ text or a too long text stops the whole load', async () => {
    const sheets = await table('stop.xlsx', {
      brands: [{ name: BRAND, action: 'Без изменений', country_ru: 'США', country_uz: 'AQSh', why_ru: 'Почему бренд в VITALO. '.repeat(60), why_uz: 'Nega VITALO da. '.repeat(60), show: 'Да', order: 50 }],
      products: [
        product({ action: 'Новый', name_ru: `Без перевода ${RUN}`, comp_uz: null, substances: null }),
        product({ action: 'Новый', name_ru: `Длинная форма ${RUN}`, sform_ru: 'x'.repeat(61), sform_uz: 'y', substances: null }),
      ],
    });
    const plan = await planCatalogLoad(prisma, sheets);
    expect(plan.check.errors.map((e) => e.message).join('\n')).toContain('Форма вещества RU длиннее 60 знаков');
    const fixed = await table('stop2.xlsx', {
      brands: [{ name: BRAND, action: 'Без изменений', country_ru: 'США', country_uz: 'AQSh', why_ru: 'Почему бренд в VITALO. '.repeat(60), why_uz: 'Nega VITALO da. '.repeat(60), show: 'Да', order: 50 }],
      products: [product({ action: 'Новый', name_ru: `Без перевода ${RUN}`, comp_uz: null, substances: null })],
    });
    const plan2 = await planCatalogLoad(prisma, fixed);
    expect(plan2.errors.map((e) => e.message).join('\n')).toContain('сначала переводы');
  });
});
