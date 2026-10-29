import { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyImport, formatPlan, planImport, SHEET_NAME } from '../src/import/product-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminInventoryService } from '../src/staff/admin-inventory';
import { AdminProductsService } from '../src/staff/admin-products';
import { archiveTestProducts, createTestApp, TEST_BRAND } from './helpers';

const HEADER = [
  'sku *', 'Название (RU) *', 'Название (UZ)', 'Бренд *', 'Производитель *', 'Страна', 'Форма / дозировка', 'Цена, сум *',
  'Старая цена, сум', 'Себестоимость, сум', 'Остаток, шт *', 'Мин. остаток', 'Категории по потребности', 'Категории по типу',
  'Краткое описание (RU)', 'Краткое описание (UZ)', 'Состав (RU)', 'Дозировка / пищевая ценность (RU)', 'Способ применения (RU)',
  'Противопоказания (RU)', 'Поисковые слова', 'Фото (имена файлов)', 'Вес, г',
];
type Row = Partial<Record<(typeof HEADER)[number], string | number>>;

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const DIRECTIONS = 'По 1 капсуле в день.\nВо время еды.\nКурс: 1 месяц.';

const row = (over: Row = {}): Row => ({
  'sku *': 'E2E-IMP-1',
  'Название (RU) *': 'Импорт: коллаген',
  'Название (UZ)': 'Import: kollagen',
  'Бренд *': TEST_BRAND,
  'Производитель *': 'ООО «Тест»',
  'Страна': 'Узбекистан',
  'Форма / дозировка': 'Порошок',
  'Цена, сум *': 150000,
  'Себестоимость, сум': 90000,
  'Остаток, шт *': 10,
  'Мин. остаток': 2,
  'Категории по потребности': 'Красота; Энергия и мозг; Несуществующая',
  'Категории по типу': 'коллаген',
  'Краткое описание (RU)': 'Коротко.',
  'Состав (RU)': 'Коллаген, витамин C',
  'Способ применения (RU)': DIRECTIONS,
  'Противопоказания (RU)': 'Беременность',
  'Поисковые слова': 'collagen, kollagen',
  'Фото (имена файлов)': 'e2e-imp-1-main.png; E2E-IMP-1-SECOND.PNG; missing.jpg',
  'Вес, г': 250,
  ...over,
});

describe('Excel product import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let deps: { prisma: PrismaService; products: AdminProductsService; inventory: AdminInventoryService };
  const dir = join(tmpdir(), `vitalo-import-${process.pid}`);
  const photosDir = join(dir, 'photos');
  const file = join(dir, 'products.xlsx');

  async function writeSheet(rows: Row[], example = true) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET_NAME);
    ws.addRow(HEADER);
    if (example) {
      const ex = ws.addRow(HEADER.map((h) => (h === 'sku *' ? 'VTL-EXAMPLE' : h.startsWith('Цена') ? 1000 : 'пример')));
      ex.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    }
    for (const r of rows) ws.addRow(HEADER.map((h) => r[h] ?? null));
    await wb.xlsx.writeFile(file);
  }
  const plan = () => planImport(prisma, { file, photosDir });
  const product = () =>
    prisma.products.findUniqueOrThrow({
      where: { sku: 'E2E-IMP-1' },
      include: { categories: { include: { category: true } }, media: { orderBy: { sort_order: 'asc' } }, inventory: true },
    });
  const movements = async () => {
    const p = await prisma.products.findUnique({ where: { sku: 'E2E-IMP-1' } });
    return p ? prisma.inventory_movements.findMany({ where: { product_id: p.id }, orderBy: { created_at: 'asc' } }) : [];
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    deps = { prisma, products: app.get(AdminProductsService), inventory: app.get(AdminInventoryService) };
    await mkdir(photosDir, { recursive: true });
    await writeFile(join(photosDir, 'E2E-IMP-1-MAIN.png'), PNG); // different case on purpose
    await writeFile(join(photosDir, 'e2e-imp-1-second.png'), PNG);
    await writeFile(join(photosDir, 'not-an-image.png'), 'hello');
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await rm(dir, { recursive: true, force: true });
    await app.close();
  });

  it('dry run: shows the plan with warnings and writes nothing', async () => {
    await writeSheet([row(), row({ 'sku *': 'E2E-IMP-2', 'Фото (имена файлов)': 'not-an-image.png', 'Остаток, шт *': '' })]);
    const before = await Promise.all([prisma.products.count(), prisma.inventory_movements.count(), prisma.product_media.count()]);

    const p = await plan();

    expect(p.errors).toEqual([]);
    expect(p.skipped).toEqual([expect.objectContaining({ row: 2, sku: 'VTL-EXAMPLE' })]); // yellow example row
    expect(p.rows.map((r) => [r.sku, r.action])).toEqual([['E2E-IMP-1', 'create'], ['E2E-IMP-2', 'create']]);
    expect(p.rows[0].categoryNames.sort()).toEqual(['Красота', 'Энергия и мозг', 'Коллаген'].sort());
    const warnings = p.warnings.map((w) => w.message).join('\n');
    expect(warnings).toContain('категория «Несуществующая»');
    expect(warnings).toContain('фото «missing.jpg» не найдено');
    expect(warnings).toContain('«not-an-image.png» не JPEG/PNG/WebP');
    expect(warnings).toContain('остаток не указан');
    expect(formatPlan(p)).toContain('остаток: 0 → 10 (приход +10 шт)');

    const after = await Promise.all([prisma.products.count(), prisma.inventory_movements.count(), prisma.product_media.count()]);
    expect(after).toEqual(before);
    expect(await prisma.categories.count({ where: { name_ru: 'Несуществующая' } })).toBe(0);
  });

  it('apply: creates the product, links categories, books stock as a receipt, stores photos (first is main)', async () => {
    await writeSheet([row()]);
    const result = await applyImport(await plan(), deps);
    expect(result.created).toEqual(['E2E-IMP-1']);

    const p = await product();
    expect(p).toMatchObject({ status: 'active', name_uz: 'Import: kollagen', price_uzs: 150000n, old_price_uzs: null, cost_uzs: 90000n, min_stock: 2, shipping_weight_g: 250 });
    expect(p.directions_ru).toBe(DIRECTIONS); // line breaks kept
    expect(p.categories.map((c) => c.category.slug).sort()).toEqual(['beauty', 'collagen', 'energy']);

    const warehouse = await prisma.warehouses.findFirstOrThrow({ where: { address: { contains: 'Ташкент' } } });
    expect(p.inventory).toEqual([expect.objectContaining({ warehouse_id: warehouse.id, actual_qty: 10, reserved_qty: 0 })]);
    const moves = await movements();
    expect(moves).toEqual([expect.objectContaining({ movement_type: 'receipt', qty: 10, created_by: null })]);
    expect(await prisma.inventory_batches.findFirst({ where: { product_id: p.id } })).toMatchObject({ qty: 10, cost_uzs: 90000n });

    expect(p.media.map((m) => [m.title, m.is_main])).toEqual([['e2e-imp-1-main.png', true], ['E2E-IMP-1-SECOND.PNG', false]]);
    const file0 = join(process.env.UPLOAD_DIR!, p.media[0].url.replace(/^\/uploads\//, ''));
    expect(existsSync(file0)).toBe(true);
    expect(await prisma.audit_logs.count({ where: { entity_id: p.id, staff_user_id: null, action: 'product.created' } })).toBe(1);
  });

  it('running the same file again changes nothing (no duplicates, no extra stock)', async () => {
    const p2 = await plan();
    expect(p2.rows.map((r) => r.action)).toEqual(['unchanged']);
    await applyImport(p2, deps);

    const p = await product();
    expect(await prisma.products.count({ where: { sku: 'E2E-IMP-1' } })).toBe(1);
    expect(p.media).toHaveLength(2);
    expect(p.inventory[0].actual_qty).toBe(10);
    expect(await movements()).toHaveLength(1);
  });

  it('empty cells keep the stored values; an empty stock cell never touches the stock', async () => {
    await writeSheet([row({ 'Цена, сум *': 140000, 'Остаток, шт *': '', 'Состав (RU)': '', 'Категории по потребности': '', 'Фото (имена файлов)': '' })]);
    const p1 = await plan();
    expect(p1.rows[0].changes).toEqual(['price_uzs']);
    await applyImport(p1, deps);

    const p = await product();
    expect(p.price_uzs).toBe(140000n);
    expect(p.composition_ru).toBe('Коллаген, витамин C');
    expect(p.categories.map((c) => c.category.slug).sort()).toEqual(['beauty', 'collagen', 'energy']);
    expect(p.inventory[0].actual_qty).toBe(10);
    expect(await movements()).toHaveLength(1);
  });

  it('a different stock number books only the difference (receipt up, stock count down)', async () => {
    await writeSheet([row({ 'Остаток, шт *': 15 })]);
    await applyImport(await plan(), deps);
    await writeSheet([row({ 'Остаток, шт *': 12 })]);
    await applyImport(await plan(), deps);

    expect((await product()).inventory[0].actual_qty).toBe(12);
    expect((await movements()).map((m) => [m.movement_type, m.qty])).toEqual([['receipt', 10], ['receipt', 5], ['adjustment', -3]]);
  });

  it('errors (empty required fields, bad numbers, duplicate SKU) block the whole import', async () => {
    await writeSheet([
      row({ 'sku *': 'E2E-IMP-3', 'Цена, сум *': '' }),
      row({ 'sku *': 'E2E-IMP-4', 'Цена, сум *': '12,5' }),
      row({ 'sku *': 'E2E-IMP-4' }),
    ]);
    const p = await plan();
    expect(p.errors.map((e) => e.message)).toEqual([
      'пустое обязательное поле «цена, сум»',
      '«цена, сум»: нужно целое число без букв, сейчас «12,5»',
      'SKU повторяется (уже был в строке 4)',
    ]);
    await expect(applyImport(p, deps)).rejects.toThrow('ошибки');
    expect(await prisma.products.count({ where: { sku: { in: ['E2E-IMP-3', 'E2E-IMP-4'] } } })).toBe(0);
  });
});
