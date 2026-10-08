import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawnSync } from 'child_process';
import ExcelJS from 'exceljs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyCatalogImport, CatalogFlags, NO_FLAGS, planCatalogImport } from '../src/import/catalog-import';
import { planOpeningStock } from '../src/import/opening-stock';
import { TABLETS_AND_CAPSULES } from '../src/import/yandex-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';
import { LocalFileStorage } from '../src/storage/file-storage';
import { archiveTestProducts, createTestApp, createTestProduct, TEST_BRAND } from './helpers';

const RUN = `${process.pid}${Date.now() % 100000}`;
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The header row of the real VITALO_каталог_единая_таблица.xlsx (sheet «Товары»), plus the ignored note column. */
const HEAD = [
  'SKU *', 'Статус в магазине (Виден / Скрыт)', 'Название (RU) *', 'Название (UZ)', 'Бренд *', 'Производитель *', 'Страна', 'Форма / дозировка',
  'Цена VITALO, сум *', 'Старая цена VITALO, сум', 'Категории по потребности (через ;)', 'Категории по типу (через ;)', 'Описание (RU)', 'Описание (UZ)',
  'Состав (RU)', 'Состав (UZ)', 'Пищевая ценность и дозировка (RU)', 'Пищевая ценность и дозировка (UZ)', 'Способ применения (RU)', 'Способ применения (UZ)',
  'Противопоказания и предупреждения (RU)', 'Противопоказания и предупреждения (UZ)', 'Поисковые слова (через запятую)', 'Фото: имена файлов (через ;, главное первым)',
  'Документы: имена файлов (через ;)', 'Вес в упаковке, г', 'Цена на Яндексе, сум', 'Комиссия Яндекса, %', 'Платёжный сбор Яндекса, %', 'Логистика Яндекса, сум (фикс.)',
  'Себестоимость, сум (только admin)', 'Мин. остаток, шт', 'Короткий состав для этикетки (RU)', 'Короткий состав для этикетки (UZ)', 'Прежний SKU (если менялся)',
  'Примечание (не загружается)',
];
type Row = Partial<Record<(typeof HEAD)[number], unknown>>;

describe('import:catalog — the single catalog table (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: LocalFileStorage;
  const dir = mkdtempSync(join(tmpdir(), 'vitalo-catalog-'));
  const photosDir = join(dir, 'photos');
  const NEW = `E2E-CATN-${RUN}`;
  const BARE = `E2E-CATB-${RUN}`;
  const RENAMED = `E2E-OZN-${RUN}`;
  const MANUFACTURER = `ООО «Тест ${RUN}»`;
  let old: { id: string; sku: string };
  let existing: { id: string; sku: string };

  async function sheet(name: string, rows: Row[], opening?: unknown[][]) {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Инструкция').addRow(['Единая таблица каталога VITALO']);
    const ws = wb.addWorksheet('Товары');
    ws.addRow(HEAD);
    for (const r of rows) ws.addRow(HEAD.map((h) => r[h] ?? null));
    if (opening) {
      const o = wb.addWorksheet('Начальные остатки (банки)');
      o.addRow(['SKU *', 'Срок годности (ДД.ММ.ГГГГ) *', 'Количество банок *', 'Комментарий']);
      for (const r of opening) o.addRow(r);
    }
    wb.addWorksheet('Справочник').addRow(['Категории по потребности']);
    const file = join(dir, name);
    await wb.xlsx.writeFile(file);
    return file;
  }

  const newRow = (over: Row = {}): Row => ({
    'SKU *': NEW,
    'Статус в магазине (Виден / Скрыт)': 'Виден',
    'Название (RU) *': `Коллаген каталог ${RUN}`,
    'Название (UZ)': 'Kollagen katalog',
    'Бренд *': TEST_BRAND,
    'Производитель *': `ООО "Тест ${RUN}"`, // other quotes than in the dictionary
    'Страна': ' Россия ',
    'Форма / дозировка': 'Таблетки; Капсулы',
    'Цена VITALO, сум *': '180 000',
    'Старая цена VITALO, сум': 315000,
    'Категории по потребности (через ;)': 'Красота → Кожа; Иммунитет; Несуществующая',
    'Категории по типу (через ;)': 'Витамины',
    'Описание (RU)': 'Строка 1\\nСтрока 2',
    'Описание (UZ)': 'Qator 1',
    'Состав (RU)': 'Коллаген, витамин C',
    'Пищевая ценность и дозировка (RU)': '1 порция — 5 г',
    'Способ применения (RU)': 'По 1 ложке в день',
    'Противопоказания и предупреждения (RU)': 'Беременность',
    'Поисковые слова (через запятую)': 'коллаген, успокоительное, профилактика',
    'Фото: имена файлов (через ;, главное первым)': 'e2e-cat-1.png; missing.png; E2E-CAT-2.PNG',
    'Документы: имена файлов (через ;)': 'certificate.pdf',
    'Вес в упаковке, г': 210,
    'Цена на Яндексе, сум': 110000,
    'Комиссия Яндекса, %': '18,5',
    'Платёжный сбор Яндекса, %': 0.5,
    'Логистика Яндекса, сум (фикс.)': 5000,
    'Себестоимость, сум (только admin)': 79725,
    'Мин. остаток, шт': 3,
    'Короткий состав для этикетки (RU)': 'Коллаген, витамин C',
    'Короткий состав для этикетки (UZ)': 'Kollagen, C vitamini',
    'Примечание (не загружается)': 'не загружать',
    ...over,
  });
  const renamedRow = (over: Row = {}): Row => ({
    'SKU *': RENAMED,
    'Статус в магазине (Виден / Скрыт)': 'Скрыт',
    'Название (RU) *': `Переименованный ${RUN}`,
    'Бренд *': TEST_BRAND,
    'Производитель *': 'Test',
    'Цена VITALO, сум *': 120000,
    'Описание (RU)': 'Новое описание',
    'Состав (RU)': 'Новый состав',
    'Себестоимость, сум (только admin)': 70000,
    'Прежний SKU (если менялся)': '',
    ...over,
  });
  const bareRow = (over: Row = {}): Row => ({
    'SKU *': BARE,
    'Статус в магазине (Виден / Скрыт)': 'Виден',
    'Название (RU) *': `Без фото ${RUN}`,
    'Бренд *': TEST_BRAND,
    'Производитель *': 'Test',
    'Цена VITALO, сум *': 50000,
    ...over,
  });
  const rows = () => [newRow(), renamedRow({ 'Прежний SKU (если менялся)': old.sku }), bareRow()];
  const plan = (file: string, flags: CatalogFlags = NO_FLAGS) => planCatalogImport(prisma, { file, photosDir, flags });
  const counts = async () => ({
    products: await prisma.products.count(),
    audit: await prisma.audit_logs.count(),
    media: await prisma.product_media.count(),
    manufacturers: await prisma.manufacturers.count(),
    forms: await prisma.forms.count(),
  });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    storage = new LocalFileStorage(app.get(ConfigService));
    mkdirSync(photosDir, { recursive: true });
    writeFileSync(join(photosDir, 'E2E-CAT-1.png'), PNG); // other case on purpose
    writeFileSync(join(photosDir, 'e2e-cat-2.png'), PNG);
    old = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `Старый TPRD ${RUN}` });
    await prisma.products.update({ where: { id: old.id }, data: { short_description_ru: 'Старое описание', status: 'active' } });
    existing = await createTestProduct(prisma, { price: 1, stock: 0 });
    await prisma.manufacturers.create({ data: { name_ru: MANUFACTURER } });
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('dry run writes nothing; the report shows the rename, the differences, warnings and the lawyer list', async () => {
    const file = await sheet('ok.xlsx', rows());
    const before = await counts();
    const p = await plan(file);
    expect(await counts()).toEqual(before);
    expect(p.errors).toEqual([]);

    const n = p.rows.find((r) => r.sku === NEW)!;
    expect(n).toMatchObject({ action: 'create', renameFrom: null, firstIsMain: true });
    expect(n.data).toMatchObject({
      status: 'active',
      price_uzs: 180_000,
      old_price_uzs: 315_000,
      cost_uzs: 79_725,
      country: 'Россия',
      form: TABLETS_AND_CAPSULES,
      manufacturer: MANUFACTURER, // «» and "" are the same value: the dictionary spelling wins
      short_description_ru: 'Строка 1\nСтрока 2',
      yandex_commission_percent: 18.5,
      label_composition_uz: 'Kollagen, C vitamini',
    });
    expect(n.categoryNames).toEqual(['Красота → Кожа', 'Иммунитет', 'Витамины']);
    expect(n.photos.map((x) => [x.name, !!x.path])).toEqual([['e2e-cat-1.png', true], ['missing.png', false], ['E2E-CAT-2.PNG', true]]);
    expect(p.newValues.manufacturers ?? []).not.toContain(`ООО "Тест ${RUN}"`);

    const r = p.rows.find((x) => x.sku === RENAMED)!;
    expect(r).toMatchObject({ action: 'update', renameFrom: old.sku, productId: old.id });
    expect(r.changes).toContain(`переименовать ${old.sku} → ${RENAMED}`);
    expect(r.diffs.map((d) => [d.label, d.flag])).toEqual(
      expect.arrayContaining([['название RU', '--update-text'], ['описание RU', '--update-text'], ['цена VITALO', '--apply-prices'], ['себестоимость', '--apply-cost'], ['статус', '--apply-status']]),
    );
    expect(r.data).toMatchObject({ composition_ru: 'Новый состав' }); // empty field: filled by default
    expect(r.data).not.toHaveProperty('cost_uzs'); // never without --apply-cost

    const text = p.warnings.map((w) => `${w.sku}: ${w.message}`).join('\n');
    expect(text).toContain(`${NEW}: категория «Несуществующая» (по потребности) не найдена — пропущена`);
    expect(text).toContain(`${NEW}: «Документы» (certificate.pdf) не загружаются`);
    expect(text).toContain(`${NEW}: фото «missing.png» не найдено`);
    expect(text).toContain(`${BARE}: нет фото — товар будет виден с серой плиткой; статус не меняется`);
    expect(text).toContain(`форма «Таблетки; Капсулы» → «${TABLETS_AND_CAPSULES}»`);
    expect(p.legal.filter((l) => l.sku === NEW).map((l) => l.word).sort()).toEqual(['профилактик', 'успокоительн']);
    expect(p.notInTable.map((x) => x.sku)).toEqual(expect.arrayContaining(['VTL-OMEGA3', existing.sku]));
    expect(p.notInTable.map((x) => x.sku)).not.toContain(old.sku);
  });

  it('--confirm: creates (status from the table, photos, categories, dictionaries), renames the SKU (same id, audit), fills only empty fields', async () => {
    const file = await sheet('ok.xlsx', rows());
    const res = await applyCatalogImport(prisma, new AuditService(prisma), storage, await plan(file));
    expect(res.created.sort()).toEqual([BARE, NEW].sort());
    expect(res.renamed).toEqual([`${old.sku} → ${RENAMED}`]);
    expect(res.photos).toBe(2);

    const n = await prisma.products.findUniqueOrThrow({ where: { sku: NEW }, include: { media: { orderBy: { sort_order: 'asc' } }, categories: { include: { category: true } } } });
    expect(n).toMatchObject({ status: 'active', price_uzs: 180_000n, cost_uzs: 79_725n, min_stock: 3, shipping_weight_g: 210, form: TABLETS_AND_CAPSULES, manufacturer: MANUFACTURER, yandex_price_sync_needed: false });
    expect(Number(n.yandex_commission_percent)).toBe(18.5);
    expect(n.manufacturer_id).toBe((await prisma.manufacturers.findFirstOrThrow({ where: { name_ru: MANUFACTURER } })).id);
    expect(n.form_id).not.toBeNull();
    expect(n.categories.map((c) => c.category.name_ru).sort()).toEqual(['Витамины', 'Иммунитет', 'Кожа']);
    expect(n.media.map((m) => [m.title, m.is_main])).toEqual([['e2e-cat-1.png', true], ['E2E-CAT-2.PNG', false]]);
    expect(n.media[0].url).toMatch(/\.webp$/);
    expect(n.media[0].thumb_url_jpeg).toMatch(/-400\.jpg$/);
    expect((await prisma.products.findUniqueOrThrow({ where: { sku: BARE } })).status).toBe('active'); // no photo: still visible

    const r = await prisma.products.findUniqueOrThrow({ where: { id: old.id } });
    expect(r).toMatchObject({ sku: RENAMED, composition_ru: 'Новый состав', short_description_ru: 'Старое описание', price_uzs: 100_000n, cost_uzs: null, status: 'active' });
    expect(r.name_ru).toBe(`Старый TPRD ${RUN}`);
    expect(await prisma.products.findUnique({ where: { sku: old.sku } })).toBeNull();
    const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: old.id, action: 'product.sku_renamed' } });
    expect(audit.before_json).toEqual({ sku: old.sku });
    expect(audit.after_json).toMatchObject({ sku: RENAMED, source: 'import:catalog' });
  });

  it('running the same file again changes nothing (also the photos)', async () => {
    const file = await sheet('ok.xlsx', rows());
    const p = await plan(file);
    expect(p.rows.map((r) => [r.sku, r.action])).toEqual([[NEW, 'unchanged'], [RENAMED, 'unchanged'], [BARE, 'unchanged']]);
    const before = await counts();
    const res = await applyCatalogImport(prisma, new AuditService(prisma), storage, p);
    expect(res).toMatchObject({ created: [], updated: [], renamed: [], photos: 0 });
    expect(await counts()).toEqual(before);
  });

  it('flags overwrite: --update-text, --apply-prices, --apply-status, --apply-cost', async () => {
    const file = await sheet('ok.xlsx', rows());
    const only = async (flags: Partial<CatalogFlags>) => (await plan(file, { ...NO_FLAGS, ...flags })).rows.find((r) => r.sku === RENAMED)!.data;
    expect(await only({ applyCost: true })).toEqual({ cost_uzs: 70_000 });
    expect(await only({ applyPrices: true })).toEqual({ price_uzs: 120_000 });
    expect(await only({ applyStatus: true })).toEqual({ status: 'hidden' });
    expect(await only({ updateText: true })).toEqual({ name_ru: `Переименованный ${RUN}`, short_description_ru: 'Новое описание' });

    const all = { updateText: true, applyPrices: true, applyStatus: true, applyCost: true };
    await applyCatalogImport(prisma, new AuditService(prisma), storage, await plan(file, all));
    expect(await prisma.products.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      cost_uzs: 70_000n,
      price_uzs: 120_000n,
      status: 'hidden',
      short_description_ru: 'Новое описание',
      name_ru: `Переименованный ${RUN}`,
    });
    expect((await plan(file, all)).rows.every((r) => r.action === 'unchanged')).toBe(true);
  });

  it('errors stop everything: duplicate SKU, both SKUs in the database, bad values, required fields', async () => {
    const both = await createTestProduct(prisma, { price: 1, stock: 0 });
    const file = await sheet('bad.xlsx', [
      newRow({ 'SKU *': `E2E-CATX-${RUN}` }),
      newRow({ 'SKU *': `e2e-catx-${RUN}` }), // the same SKU in another case
      renamedRow({ 'SKU *': existing.sku, 'Прежний SKU (если менялся)': both.sku }),
      bareRow({ 'SKU *': `E2E-CATY-${RUN}`, 'Комиссия Яндекса, %': 150, 'Статус в магазине (Виден / Скрыт)': 'Видно' }),
      bareRow({ 'SKU *': `E2E-CATZ-${RUN}`, 'Название (RU) *': null, 'Цена VITALO, сум *': '12,5' }),
    ]);
    const before = await counts();
    const p = await plan(file);
    const text = p.errors.map((e) => e.message).join('\n');
    expect(text).toContain('SKU повторяется в таблице');
    expect(text).toContain(`в базе есть и ${existing.sku}, и прежний ${both.sku}`);
    expect(text).toContain('«комиссия яндекса, %»: нужен процент от 0 до 100');
    expect(text).toContain('нужно «Виден» или «Скрыт»');
    expect(text).toContain('пустое обязательное поле «название (ru)»');
    expect(text).toContain('«цена vitalo, сум»: нужно целое число');
    await expect(applyCatalogImport(prisma, new AuditService(prisma), storage, p)).rejects.toThrow(/ничего не записано/);
    expect(await counts()).toEqual(before);
  });

  it('opening stock: renamed SKUs are found by the old SKU, 0 jars / no date are skipped, missing costs are listed with totals', async () => {
    const pending = await createTestProduct(prisma, { price: 1, stock: 4 }); // still has the old SKU in the database
    const noCost = await createTestProduct(prisma, { price: 1, stock: 0 });
    await prisma.products.update({ where: { id: pending.id }, data: { cost_uzs: 9_000n } });
    const NEXT = `E2E-OZN2-${RUN}`;
    const file = await sheet('opening.xlsx', [bareRow({ 'SKU *': NEXT, 'Прежний SKU (если менялся)': pending.sku })], [
      [NEXT, '31.12.2028', 3],
      [NEXT, '30.06.2029', 2],
      [NEXT, null, 0], // nothing left: skipped, no error
      [noCost.sku, '31.12.2028', 0], // zero jars: skipped
      [noCost.sku, '', 5], // no date: skipped with a warning
      [existing.sku, '31.12.2028', 1], // no cost
    ]);
    const before = await counts();
    const p = await planOpeningStock(prisma, file);
    expect(await counts()).toEqual(before);
    expect(p.skippedRows).toBe(3);
    const row = p.rows.find((r) => r.productId === pending.id)!;
    expect(row).toMatchObject({ sku: NEXT, sheetQty: 5, actual: 4, difference: 1, cost: 9_000, action: 'create' });
    expect(p.warnings.map((w) => w.message).join('\n')).toContain(`найден по прежнему SKU ${pending.sku}`);
    expect(p.warnings.map((w) => w.message).join('\n')).toContain('5 банок без срока годности — строка пропущена');
    expect(p.missingCost).toEqual([existing.sku]);
    expect(p.errors.map((e) => e.sku)).toEqual([existing.sku]);
    const { formatOpeningPlan } = await import('../src/import/opening-stock');
    const report = formatOpeningPlan(p);
    expect(report).toContain('Итого по листу: товаров 2, групп сроков 3, всего банок 6');
    expect(report).toContain(`Нет себестоимости у товаров с банками (1): ${existing.sku}`);
  });

  it('the script refuses a database without _dev / _test', () => {
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ts-node', 'scripts/import-catalog.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/vitalo' }, // nothing listens on port 1
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('без отдельного разрешения');
  }, 90_000);
});
