/**
 * Product import from the Excel template (VITALO_товары.xlsx, sheet «Товары»).
 *
 * - A product is created or updated by SKU; running the same file again changes nothing.
 * - Empty cells never erase what is already in the database (stock included).
 * - «Остаток» is the wanted quantity in the Tashkent warehouse: only the difference is booked,
 *   as a warehouse receipt (or a stock-count adjustment when it goes down) — never a direct number change.
 * - Products, photos and stock go through the same services as the admin panel (validation, audit log,
 *   photo storage), with the system as the actor (staff = null).
 * - Dry run reads only; nothing is written until `apply` is called.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import ExcelJS from 'exceljs';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AdminInventoryService } from '../staff/admin-inventory';
import { AdminProductsService, detectImage, MAX_PHOTO_BYTES, ProductInput } from '../staff/admin-products';

export const SHEET_NAME = 'Товары';
const STOCK_COMMENT = 'Импорт из Excel';

/** Spreadsheet columns, matched by header text (case, spaces and the red "*" do not matter). */
const COLUMNS = {
  sku: 'sku',
  name_ru: 'название (ru)',
  name_uz: 'название (uz)',
  brand: 'бренд',
  manufacturer: 'производитель',
  country: 'страна',
  form: 'форма / дозировка',
  price: 'цена, сум',
  old_price: 'старая цена, сум',
  cost: 'себестоимость, сум',
  stock: 'остаток, шт',
  min_stock: 'мин. остаток',
  cat_need: 'категории по потребности',
  cat_type: 'категории по типу',
  short_ru: 'краткое описание (ru)',
  short_uz: 'краткое описание (uz)',
  composition_ru: 'состав (ru)',
  nutrition_ru: 'дозировка / пищевая ценность (ru)',
  directions_ru: 'способ применения (ru)',
  warnings_ru: 'противопоказания (ru)',
  keywords: 'поисковые слова',
  photos: 'фото (имена файлов)',
  weight: 'вес, г',
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED: Column[] = ['sku', 'name_ru', 'brand', 'manufacturer', 'price'];
/** Plain text columns -> product fields (kept exactly as written, line breaks included). */
const TEXT: [Column, keyof ProductInput][] = [
  ['name_uz', 'name_uz'],
  ['country', 'country'],
  ['form', 'form'],
  ['short_ru', 'short_description_ru'],
  ['short_uz', 'short_description_uz'],
  ['composition_ru', 'composition_ru'],
  ['nutrition_ru', 'nutrition_ru'],
  ['directions_ru', 'directions_ru'],
  ['warnings_ru', 'warnings_ru'],
  ['keywords', 'search_keywords'],
];
const RU_TEXT: Column[] = ['name_ru', 'short_ru', 'composition_ru', 'nutrition_ru', 'directions_ru', 'warnings_ru'];

export interface ImportOptions {
  file: string;
  photosDir: string;
}

export interface Issue {
  row: number; // spreadsheet row, 0 = the whole file
  sku?: string;
  message: string;
}

interface PhotoPlan {
  name: string; // as written in the table
  path: string | null; // found file
  buffer?: Buffer;
  attached: boolean; // already on the product (same file name)
}

export interface RowPlan {
  row: number;
  sku: string;
  action: 'create' | 'update' | 'unchanged';
  productId: string | null;
  name: string;
  data: ProductInput; // validated product fields (only non-empty cells)
  changes: string[]; // human-readable list for the report
  categoryIds: string[] | undefined; // undefined = keep the product's categories
  categoryNames: string[];
  weight: number | undefined;
  photos: PhotoPlan[];
  stockTarget: number | undefined; // undefined = do not touch
  stockNow: number;
  reserved: number;
  cost: number | undefined;
}

export interface ImportPlan {
  database: string;
  warehouse: { id: string; name: string } | null;
  rows: RowPlan[];
  errors: Issue[];
  warnings: Issue[];
  skipped: Issue[];
}

export interface ImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  stock: { sku: string; before: number; after: number }[];
  photosAdded: { sku: string; file: string; main: boolean }[];
  categories: { sku: string; names: string[] }[];
}

// ---------------------------------------------------------------- reading the sheet

const norm = (s: string) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Cell value as text: rich text, formulas and hyperlinks included; Windows line breaks become \n. */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\r\n?/g, '\n').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('').replace(/\r\n?/g, '\n').trim();
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return cellText(v.text as ExcelJS.CellValue);
  }
  return String(v).trim();
}

/** The template marks its example row with a yellow fill. */
function isYellow(row: ExcelJS.Row): boolean {
  const fill = row.getCell(1).fill;
  const argb = fill && fill.type === 'pattern' ? fill.fgColor?.argb : undefined;
  if (!argb || argb.length < 8) return false;
  const [r, g, b] = [2, 4, 6].map((i) => parseInt(argb.slice(i, i + 2), 16));
  return r > 200 && g > 180 && b < 170;
}

/** Whole sums / pieces. Spaces inside are allowed ("145 000"), fractions and letters are not. */
function parseInt0(text: string): number | null | 'bad' {
  if (!text) return null;
  const t = text.replace(/[\s ]/g, '');
  return /^\d+$/.test(t) ? Number(t) : 'bad';
}

const splitList = (text: string) =>
  text
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

// ---------------------------------------------------------------- planning (read only)

export async function planImport(prisma: PrismaService, opts: ImportOptions): Promise<ImportPlan> {
  const plan: ImportPlan = {
    database: new URL(process.env.DATABASE_URL ?? 'postgresql://x/unknown').pathname.slice(1),
    warehouse: null,
    rows: [],
    errors: [],
    warnings: [],
    skipped: [],
  };
  const error = (row: number, message: string, sku?: string) => plan.errors.push({ row, sku, message });
  const warn = (row: number, message: string, sku?: string) => plan.warnings.push({ row, sku, message });

  // Warehouse in Tashkent
  const warehouses = await prisma.warehouses.findMany({ where: { status: 'active' } });
  const tashkent = warehouses.filter((w) => /ташкент|toshkent|tashkent/i.test(`${w.name} ${w.address ?? ''}`));
  if (tashkent.length === 1) plan.warehouse = { id: tashkent[0].id, name: tashkent[0].name };
  else if (tashkent.length === 0) error(0, 'Не найден активный склад в Ташкенте — остатки некуда записать');
  else error(0, `Найдено несколько складов в Ташкенте (${tashkent.map((w) => w.name).join(', ')}) — непонятно, какой выбрать`);

  // Workbook
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(opts.file);
  } catch (e) {
    error(0, `Не удалось открыть файл ${opts.file}: ${(e as Error).message}`);
    return plan;
  }
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) {
    error(0, `В файле нет листа «${SHEET_NAME}»`);
    return plan;
  }
  const col: Partial<Record<Column, number>> = {};
  ws.getRow(1).eachCell((cell, i) => {
    const h = norm(cellText(cell.value));
    const key = (Object.keys(COLUMNS) as Column[]).find((k) => COLUMNS[k] === h);
    if (key) col[key] = i;
  });
  const missingCols = REQUIRED.filter((k) => !col[k]);
  if (missingCols.length) {
    error(0, `Нет обязательных колонок: ${missingCols.map((k) => COLUMNS[k]).join(', ')}`);
    return plan;
  }

  // Reference data
  const categories = await prisma.categories.findMany({ where: { status: 'active' } });
  let photoFiles: string[] = [];
  try {
    photoFiles = await readdir(opts.photosDir);
  } catch {
    warn(0, `Папка с фото не найдена: ${opts.photosDir}`);
  }
  const fileByLower = new Map(photoFiles.map((f) => [f.toLowerCase(), f]));
  const seenSku = new Map<string, number>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: Column) => (col[k] ? cellText(row.getCell(col[k]!).value) : '');
    if (!(Object.keys(col) as Column[]).some((k) => get(k))) continue; // empty row
    if (isYellow(row)) {
      plan.skipped.push({ row: r, sku: get('sku') || undefined, message: 'жёлтая строка-пример пропущена' });
      continue;
    }

    const sku = get('sku');
    const rowErrors = plan.errors.length;
    for (const k of REQUIRED) if (!get(k)) error(r, `пустое обязательное поле «${COLUMNS[k]}»`, sku || undefined);
    if (!sku) continue;
    if (seenSku.has(sku.toLowerCase())) {
      error(r, `SKU повторяется (уже был в строке ${seenSku.get(sku.toLowerCase())})`, sku);
      continue;
    }
    seenSku.set(sku.toLowerCase(), r);

    // Numbers
    const nums: Partial<Record<Column, number>> = {};
    for (const k of ['price', 'old_price', 'cost', 'stock', 'min_stock', 'weight'] as Column[]) {
      const v = parseInt0(get(k));
      if (v === 'bad') error(r, `«${COLUMNS[k]}»: нужно целое число без букв, сейчас «${get(k)}»`, sku);
      else if (v !== null) nums[k] = v;
    }

    const existing = await prisma.products.findUnique({
      where: { sku },
      include: { categories: { include: { category: true } }, media: true, inventory: true },
    });

    // Product fields: only filled cells (an empty cell never erases a value).
    const raw: Record<string, unknown> = { sku };
    if (get('name_ru')) raw.name_ru = get('name_ru');
    if (get('brand')) raw.brand = get('brand');
    if (get('manufacturer')) raw.manufacturer = get('manufacturer');
    if (nums.price !== undefined) raw.price_uzs = nums.price;
    if (nums.old_price !== undefined) raw.old_price_uzs = nums.old_price;
    if (nums.cost !== undefined) raw.cost_uzs = nums.cost;
    if (nums.min_stock !== undefined) raw.min_stock = nums.min_stock;
    for (const [c, field] of TEXT) if (get(c)) raw[field] = get(c);
    const data = plainToInstance(ProductInput, raw);
    const problems = await validate(data, { skipMissingProperties: false, forbidUnknownValues: false });
    for (const p of problems) {
      // Empty required cells are already reported above; here only wrong values.
      if (raw[p.property] !== undefined) error(r, `поле ${p.property}: ${Object.values(p.constraints ?? {}).join('; ')}`, sku);
    }

    // Sanity warnings
    if (nums.old_price !== undefined && nums.price !== undefined) {
      if (nums.old_price <= nums.price) warn(r, `старая цена ${nums.old_price} не больше цены ${nums.price} — скидка не покажется`, sku);
      else if (nums.old_price > nums.price * 2) warn(r, `скидка ${Math.round((1 - nums.price / nums.old_price) * 100)}% (старая цена ${nums.old_price}) — проверьте, что это не опечатка`, sku);
    }
    if (nums.cost !== undefined && nums.price !== undefined && nums.cost > nums.price) warn(r, `себестоимость ${nums.cost} больше цены ${nums.price}`, sku);
    for (const c of RU_TEXT) {
      const t = get(c);
      if (t.length > 20 && !/[а-яё]/i.test(t)) warn(r, `в колонке «${COLUMNS[c]}» нет русских букв — похоже, туда попал узбекский текст`, sku);
    }
    if (!existing && !get('name_uz')) warn(r, 'нет названия на узбекском — покажется русское', sku);

    // Categories (both trees, subcategories by their own name, «Красота → Кожа» also works)
    let categoryIds: string[] | undefined;
    const categoryNames: string[] = [];
    if (get('cat_need') || get('cat_type')) {
      const ids = new Set<string>();
      for (const [c, tree] of [['cat_need', 'need'], ['cat_type', 'product_type']] as const) {
        if (!get(c)) {
          // keep this tree as it is on the product
          for (const pc of existing?.categories ?? []) if (pc.category.tree_type === tree) ids.add(pc.category_id);
          continue;
        }
        for (const name of splitList(get(c))) {
          const leaf = norm(name.split(/→|->|>/).pop()!);
          const found = categories.filter((k) => k.tree_type === tree && (norm(k.name_ru) === leaf || norm(k.name_uz) === leaf));
          if (found.length === 1) {
            ids.add(found[0].id);
            categoryNames.push(found[0].name_ru);
          } else if (found.length === 0) warn(r, `категория «${name}» (${COLUMNS[c]}) не найдена — пропущена`, sku);
          else warn(r, `категория «${name}» найдена несколько раз — пропущена, уточните название`, sku);
        }
      }
      categoryIds = [...ids];
    }

    // Photos: case-insensitive file names, first one is the main photo
    const photos: PhotoPlan[] = [];
    for (const name of splitList(get('photos'))) {
      const file = fileByLower.get(name.toLowerCase());
      const attached = !!existing?.media.some((m) => m.title?.toLowerCase() === name.toLowerCase());
      if (!file) {
        warn(r, `фото «${name}» не найдено в папке photos`, sku);
        photos.push({ name, path: null, attached });
        continue;
      }
      const path = join(opts.photosDir, file);
      const size = (await stat(path)).size;
      if (size > MAX_PHOTO_BYTES) {
        warn(r, `фото «${name}» больше 5 МБ — пропущено (как и в админке)`, sku);
        photos.push({ name, path: null, attached });
        continue;
      }
      const buffer = await readFile(path);
      if (!detectImage(buffer)) {
        warn(r, `фото «${name}» не JPEG/PNG/WebP — пропущено`, sku);
        photos.push({ name, path: null, attached });
        continue;
      }
      photos.push({ name, path, buffer, attached });
    }
    if (!existing && !photos.some((p) => p.path)) warn(r, 'у товара не будет фото', sku);

    // Stock in the Tashkent warehouse
    const inv = existing?.inventory.find((i) => i.warehouse_id === plan.warehouse?.id);
    const stockNow = inv?.actual_qty ?? 0;
    const reserved = inv?.reserved_qty ?? 0;
    const stockTarget = nums.stock;
    if (stockTarget === undefined && !existing) warn(r, 'остаток не указан — товар будет без остатка (не в наличии)', sku);
    if (stockTarget !== undefined && stockTarget < reserved) error(r, `остаток ${stockTarget} меньше, чем уже зарезервировано заказами (${reserved})`, sku);

    // What changes
    const changes: string[] = [];
    if (existing) {
      for (const [k, v] of Object.entries(raw)) {
        const before = (existing as Record<string, unknown>)[k];
        const same = typeof before === 'bigint' ? before === BigInt(v as number) : before === v;
        if (!same) changes.push(k);
      }
      if (categoryIds && [...categoryIds].sort().join() !== existing.categories.map((c) => c.category_id).sort().join()) changes.push('категории');
      if (nums.weight !== undefined && existing.shipping_weight_g !== nums.weight) changes.push('вес');
    }
    const newPhotos = photos.filter((p) => p.path && !p.attached);
    if (newPhotos.length) changes.push(`фото +${newPhotos.length}`);
    if (stockTarget !== undefined && stockTarget !== stockNow) changes.push(`остаток ${stockNow} → ${stockTarget}`);

    if (plan.errors.length > rowErrors) continue;
    plan.rows.push({
      row: r,
      sku,
      action: !existing ? 'create' : changes.length ? 'update' : 'unchanged',
      productId: existing?.id ?? null,
      name: get('name_ru') || existing?.name_ru || sku,
      data,
      changes,
      categoryIds,
      categoryNames,
      weight: nums.weight,
      photos,
      stockTarget,
      stockNow,
      reserved,
      cost: nums.cost,
    });
  }
  if (!plan.rows.length && !plan.errors.length) warn(0, 'В таблице нет товаров для загрузки');
  return plan;
}

// ---------------------------------------------------------------- applying (writes)

export async function applyImport(
  plan: ImportPlan,
  deps: { prisma: PrismaService; products: AdminProductsService; inventory: AdminInventoryService },
): Promise<ImportResult> {
  if (plan.errors.length) throw new Error('В таблице есть ошибки — исправьте их и запустите проверку ещё раз');
  const { prisma, products, inventory } = deps;
  const result: ImportResult = { created: [], updated: [], unchanged: [], stock: [], photosAdded: [], categories: [] };

  for (const p of plan.rows) {
    if (p.action === 'unchanged') {
      result.unchanged.push(p.sku);
      continue;
    }
    // 1. Product fields and categories (admin service: validation + audit log)
    let id = p.productId;
    if (!id) {
      id = (await products.create(null, { ...p.data, category_ids: p.categoryIds })).id;
      result.created.push(p.sku);
    } else {
      await products.update(null, id, { ...p.data, ...(p.categoryIds && { category_ids: p.categoryIds }) });
      result.updated.push(p.sku);
    }
    if (p.weight !== undefined) await prisma.products.update({ where: { id }, data: { shipping_weight_g: p.weight } });
    if (p.categoryIds) result.categories.push({ sku: p.sku, names: p.categoryNames });

    // 2. Photos (same storage and rules as «Добавить фото» in the admin panel); the first listed is the main one
    for (const photo of p.photos) {
      if (!photo.path || !photo.buffer || photo.attached) continue;
      await products.addPhoto(null, id, { buffer: photo.buffer }, photo.name);
      result.photosAdded.push({ sku: p.sku, file: photo.name, main: false });
    }
    const first = p.photos.find((ph) => ph.path);
    if (first) {
      const media = await prisma.product_media.findMany({ where: { product_id: id, media_type: 'image' } });
      const main = media.find((m) => m.title?.toLowerCase() === first.name.toLowerCase());
      if (main && !main.is_main) await products.setMainPhoto(null, id, main.id);
      const added = result.photosAdded.find((a) => a.sku === p.sku && a.file === first.name);
      if (added) added.main = true;
    }

    // 3. Stock: only the difference, as a receipt (up) or a stock-count adjustment (down)
    if (p.stockTarget !== undefined && plan.warehouse) {
      const row = await prisma.inventory.findUnique({ where: { product_id_warehouse_id: { product_id: id, warehouse_id: plan.warehouse.id } } });
      const now = row?.actual_qty ?? 0;
      const target = { product_id: id, warehouse_id: plan.warehouse.id };
      if (p.stockTarget > now) {
        await inventory.receipt(null, { ...target, qty: p.stockTarget - now, cost_uzs: p.cost, comment: STOCK_COMMENT });
      } else if (p.stockTarget < now) {
        await inventory.adjustment(null, { ...target, actual_qty: p.stockTarget, reason: STOCK_COMMENT });
      }
      result.stock.push({ sku: p.sku, before: now, after: p.stockTarget });
    }
  }
  return result;
}

// ---------------------------------------------------------------- report

export function formatPlan(plan: ImportPlan): string {
  const out: string[] = [];
  out.push(`База данных: ${plan.database}`);
  out.push(`Склад для остатков: ${plan.warehouse?.name ?? '— не найден'}`);
  out.push('');
  const label = { create: 'СОЗДАТЬ', update: 'ОБНОВИТЬ', unchanged: 'без изменений' };
  for (const p of plan.rows) {
    out.push(`[строка ${p.row}] ${p.sku} — ${p.name}: ${label[p.action]}`);
    if (p.action === 'create') {
      out.push(`    цена ${p.data.price_uzs}${p.data.old_price_uzs != null ? `, старая ${p.data.old_price_uzs}` : ''}${p.cost != null ? `, себестоимость ${p.cost}` : ''}`);
    } else if (p.changes.length) out.push(`    изменится: ${p.changes.join(', ')}`);
    if (p.categoryIds) out.push(`    категории: ${p.categoryNames.join(', ') || '—'}`);
    const ph = p.photos.filter((x) => x.path);
    if (p.photos.length) out.push(`    фото: ${p.photos.map((x, i) => `${x.name}${i === 0 ? ' (главное)' : ''}${!x.path ? ' — НЕ НАЙДЕНО' : x.attached ? ' — уже есть' : ''}`).join('; ')}`);
    else if (!ph.length) out.push('    фото: нет');
    if (p.stockTarget !== undefined) {
      const d = p.stockTarget - p.stockNow;
      out.push(`    остаток: ${p.stockNow} → ${p.stockTarget}${d > 0 ? ` (приход +${d} шт)` : d < 0 ? ` (пересчёт ${d} шт)` : ' (без движения)'}`);
    } else out.push(`    остаток: ${p.stockNow} (колонка пустая — не меняется)`);
  }
  const list = (title: string, items: Issue[]) => {
    if (!items.length) return;
    out.push('', `${title} (${items.length}):`);
    for (const i of items) out.push(`  - ${i.row ? `строка ${i.row}` : 'файл'}${i.sku ? `, ${i.sku}` : ''}: ${i.message}`);
  };
  list('ОШИБКИ — загрузка невозможна, пока их не исправить', plan.errors);
  list('Предупреждения', plan.warnings);
  list('Пропущено', plan.skipped);
  const n = (a: RowPlan['action']) => plan.rows.filter((r) => r.action === a).length;
  out.push('', `Итого: создать ${n('create')}, обновить ${n('update')}, без изменений ${n('unchanged')}; ошибок ${plan.errors.length}, предупреждений ${plan.warnings.length}.`);
  return out.join('\n');
}

export function formatResult(r: ImportResult): string {
  const out = [`Создано товаров: ${r.created.length}${r.created.length ? ` (${r.created.join(', ')})` : ''}`];
  out.push(`Обновлено: ${r.updated.length}${r.updated.length ? ` (${r.updated.join(', ')})` : ''}`);
  out.push(`Без изменений: ${r.unchanged.length}`);
  for (const s of r.stock) out.push(`Остаток ${s.sku}: ${s.before} → ${s.after}`);
  for (const p of r.photosAdded) out.push(`Фото ${p.sku}: ${p.file}${p.main ? ' (главное)' : ''}`);
  for (const c of r.categories) out.push(`Категории ${c.sku}: ${c.names.join(', ') || '—'}`);
  return out.join('\n');
}
