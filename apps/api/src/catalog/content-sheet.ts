/**
 * Content sheet docs/content/VITALO_content.xlsx → the database (brands and products, 2.2).
 *
 *   read   — the «Бренды» and «Товары» sheets; example rows («(ПРИМЕР)») are skipped;
 *   plan   — products are matched by brand + name (the sheet's SKUs are made up), nothing is created;
 *   apply  — one transaction: backup tables content_backup_<stamp>_*, then brand texts / order / logo,
 *            product short names, needs exactly as in the sheet, one type;
 *   rollback — the latest backup back in place.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';

export const SHORT_NAME_MAX = 40;
export const WHY_MAX = 350;

export interface SheetBrand {
  row: number;
  dbName: string;
  country_ru: string | null;
  country_uz: string | null;
  why_ru: string | null;
  why_uz: string | null;
  showcase: boolean | null;
  order: number | null;
  logo: string | null;
}

export interface SheetProduct {
  row: number;
  sku: string;
  name: string;
  brand: string;
  short_ru: string | null;
  short_uz: string | null;
  needs: string[];
  type: string | null;
  /** 2.3: columns J–Z, as typed in the sheet (rules and checks — card-content.ts) */
  card?: SheetCard;
}

export interface SheetCard {
  substance_ru: string | null;
  substance_uz: string | null;
  pack: string | null;
  per_day: string | null;
  std_bio: string | null;
  std_tested: string | null;
  std_original: string | null;
  halal_vege: string | null;
  shell: string | null;
  source: string | null;
  market: string | null;
  verdict_ru: string | null;
  verdict_uz: string | null;
  memo_ru: string | null;
  memo_uz: string | null;
}

export interface ContentSheet {
  brands: SheetBrand[];
  products: SheetProduct[];
}

function cellText(v: ExcelJS.CellValue): string | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
    if ('text' in v) return String(v.text).trim() || null;
    if ('result' in v) return v.result == null ? null : String(v.result).trim() || null;
    if (v instanceof Date) return v.toISOString();
    return null;
  }
  return String(v).trim() || null;
}

const isExample = (s: string | null) => !!s && /\(ПРИМЕР\)/i.test(s);

function yesNo(s: string | null): boolean | null {
  if (!s) return null;
  if (/^да$/i.test(s)) return true;
  if (/^нет$/i.test(s)) return false;
  return null;
}

export async function readContentSheet(file: string): Promise<ContentSheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = (name: string) => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`В файле нет листа «${name}»`);
    return ws;
  };
  const brands: SheetBrand[] = [];
  sheet('Бренды').eachRow((row, n) => {
    if (n === 1) return;
    const c = (i: number) => cellText(row.getCell(i).value);
    const dbName = c(1);
    if (!dbName || isExample(dbName)) return;
    const order = Number(c(8));
    brands.push({
      row: n,
      dbName,
      country_ru: c(3),
      country_uz: c(4),
      why_ru: c(5),
      why_uz: c(6),
      showcase: yesNo(c(7)),
      order: Number.isFinite(order) && c(8) ? order : null,
      logo: c(9),
    });
  });
  const products: SheetProduct[] = [];
  sheet('Товары').eachRow((row, n) => {
    if (n === 1) return;
    const c = (i: number) => cellText(row.getCell(i).value);
    const sku = c(1);
    const name = c(2);
    if ((!sku && !name) || isExample(sku)) return;
    products.push({
      row: n,
      sku: sku ?? `строка ${n}`,
      name: name ?? '',
      brand: c(3) ?? '',
      short_ru: c(4),
      short_uz: c(5),
      needs: [c(6), c(7), c(8)].filter((x): x is string => !!x),
      type: c(9),
      card: {
        substance_ru: c(10),
        substance_uz: c(11),
        pack: c(13),
        per_day: c(14),
        std_bio: c(16),
        std_tested: c(17),
        std_original: c(18),
        halal_vege: c(19),
        shell: c(20),
        source: c(21),
        market: c(22),
        verdict_ru: c(23),
        verdict_uz: c(24),
        memo_ru: c(25),
        memo_uz: c(26),
      },
    });
  });
  return { brands, products };
}

// ---------- matching ----------

export const brandKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function nameTokens(s: string): Set<string> {
  const norm = s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/в(?=\d)/g, 'b') // «В6» typed in Cyrillic
    .replace(/витамин\s*д/g, 'витамин d')
    .replace(/[«»"(),.\/+–—-]/g, ' ');
  return new Set(norm.split(/\s+/).filter((w) => w.length > 1));
}

/** Share of the shorter name's words found in the other one (0..1). */
export function nameScore(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return common / Math.max(1, Math.min(ta.size, tb.size));
}

export const MATCH_MIN = 0.6;

export interface DbBrand {
  id: string;
  name_ru: string;
}
export interface DbProduct {
  id: string;
  sku: string;
  name_ru: string;
  status: string;
  brand_name: string | null;
  needs: string[]; // active need category ids
  types: string[]; // active product_type category ids
}
export interface DbCategory {
  id: string;
  name_ru: string;
  tree_type: 'need' | 'product_type';
}

export interface BrandUpdate {
  brand: DbBrand;
  sheet: SheetBrand;
}
export interface ProductUpdate {
  product: DbProduct;
  sheet: SheetProduct;
  score: number;
  addNeeds: string[];
  removeNeeds: string[];
  setType: string | null; // category id when the type changes
}
export interface ContentPlan {
  brands: BrandUpdate[];
  brandsMissing: SheetBrand[];
  products: ProductUpdate[];
  notFound: SheetProduct[];
  skipped: SheetProduct[];
  errors: { sku: string; row: number; text: string }[];
  warnings: string[];
}

export function buildContentPlan(
  sheet: ContentSheet,
  db: { brands: DbBrand[]; products: DbProduct[]; categories: DbCategory[] },
  opts: { skip?: string[]; map?: Record<string, string> } = {},
): ContentPlan {
  const plan: ContentPlan = { brands: [], brandsMissing: [], products: [], notFound: [], skipped: [], errors: [], warnings: [] };
  const brandByKey = new Map(db.brands.map((b) => [brandKey(b.name_ru), b]));
  for (const b of sheet.brands) {
    const found = brandByKey.get(brandKey(b.dbName));
    if (!found) {
      plan.brandsMissing.push(b);
      continue;
    }
    for (const [label, text] of [['RU', b.why_ru], ['UZ', b.why_uz]] as const)
      if (text && text.length > WHY_MAX) plan.warnings.push(`Бренд ${b.dbName}: «Почему» ${label} длиннее ${WHY_MAX} знаков (${text.length})`);
    plan.brands.push({ brand: found, sheet: b });
  }

  const catByName = (kind: DbCategory['tree_type'], name: string) =>
    db.categories.find((c) => c.tree_type === kind && c.name_ru.toLowerCase() === name.toLowerCase());
  const skip = new Set(opts.skip ?? []);
  const taken = new Map<string, string>();
  for (const p of sheet.products) {
    if (skip.has(p.sku)) {
      plan.skipped.push(p);
      continue;
    }
    let product: DbProduct | undefined;
    let score = 1;
    const mapped = opts.map?.[p.sku];
    if (mapped) {
      product = db.products.find((x) => x.sku === mapped);
      if (!product) {
        plan.errors.push({ sku: p.sku, row: p.row, text: `указан товар ${mapped}, его нет в базе` });
        continue;
      }
    } else {
      const ranked = db.products
        .filter((x) => x.brand_name && brandKey(x.brand_name) === brandKey(p.brand))
        .map((x) => ({ x, s: nameScore(p.name, x.name_ru) }))
        .sort((a, b) => b.s - a.s);
      if (!ranked.length || ranked[0].s < MATCH_MIN) {
        plan.notFound.push(p);
        continue;
      }
      if (ranked[1] && ranked[1].s === ranked[0].s) {
        plan.errors.push({ sku: p.sku, row: p.row, text: `неоднозначно: ${ranked[0].x.sku} и ${ranked[1].x.sku} — укажите --map ${p.sku}=АРТИКУЛ` });
        continue;
      }
      product = ranked[0].x;
      score = ranked[0].s;
    }
    if (taken.has(product.sku)) {
      plan.errors.push({ sku: p.sku, row: p.row, text: `товар ${product.sku} уже сопоставлен со строкой ${taken.get(product.sku)}` });
      continue;
    }

    const problems: string[] = [];
    if (!p.short_ru || !p.short_uz) problems.push('нет короткого названия RU или UZ');
    for (const [label, text] of [['RU', p.short_ru], ['UZ', p.short_uz]] as const)
      if (text && text.length > SHORT_NAME_MAX) problems.push(`короткое название ${label} длиннее ${SHORT_NAME_MAX} знаков (${text.length})`);
    if (!p.needs.length) problems.push('не указана потребность');
    const needIds: string[] = [];
    for (const n of p.needs) {
      const c = catByName('need', n);
      if (c) needIds.push(c.id);
      else problems.push(`нет потребности «${n}»`);
    }
    const type = p.type ? catByName('product_type', p.type) : undefined;
    if (!p.type) problems.push('не указан тип');
    else if (!type) problems.push(`нет типа «${p.type}»`);
    if (problems.length) {
      plan.errors.push({ sku: p.sku, row: p.row, text: problems.join('; ') });
      continue;
    }
    taken.set(product.sku, p.sku);
    const want = new Set(needIds);
    plan.products.push({
      product,
      sheet: p,
      score,
      addNeeds: [...want].filter((id) => !product.needs.includes(id)),
      removeNeeds: product.needs.filter((id) => !want.has(id)),
      setType: product.types.length === 1 && product.types[0] === type!.id ? null : type!.id,
    });
  }
  return plan;
}

export async function loadDbForContent(db: PrismaClient) {
  const [brands, categories, products] = await Promise.all([
    db.brands.findMany({ select: { id: true, name_ru: true } }),
    db.categories.findMany({ where: { status: 'active' }, select: { id: true, name_ru: true, tree_type: true } }),
    db.products.findMany({
      where: { status: { not: 'archived' } },
      select: { id: true, sku: true, name_ru: true, status: true, brand: true, brand_entry: { select: { name_ru: true } }, categories: { select: { category: { select: { id: true, tree_type: true, status: true } } } } },
    }),
  ]);
  return {
    brands,
    categories: categories as DbCategory[],
    products: products.map((p): DbProduct => {
      const active = p.categories.map((l) => l.category).filter((c) => c.status === 'active');
      return {
        id: p.id,
        sku: p.sku,
        name_ru: p.name_ru,
        status: p.status,
        brand_name: p.brand_entry?.name_ru ?? p.brand,
        needs: active.filter((c) => c.tree_type === 'need').map((c) => c.id),
        types: active.filter((c) => c.tree_type === 'product_type').map((c) => c.id),
      };
    }),
  };
}

export function formatContentPlan(plan: ContentPlan, categories: DbCategory[], logoNote: (b: SheetBrand) => string): string {
  const cat = (id: string) => categories.find((c) => c.id === id)?.name_ru ?? id;
  const esc = (s: string | null) => (s ?? '—').replace(/\|/g, '/').replace(/\n/g, ' ');
  const out: string[] = [];
  out.push(`### Бренды: обновится ${plan.brands.length}\n`);
  out.push('| Бренд | Страна RU / UZ | «Почему» RU / UZ, знаков | В витрине | Порядок | Логотип |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const { brand, sheet: b } of plan.brands)
    out.push(
      `| ${esc(brand.name_ru)} | ${esc(b.country_ru)} / ${esc(b.country_uz)} | ${b.why_ru?.length ?? 0} / ${b.why_uz?.length ?? 0} | ${b.showcase == null ? 'не меняется' : b.showcase ? 'да' : 'нет'} | ${b.order ?? '—'} | ${logoNote(b)} |`,
    );
  if (plan.brandsMissing.length)
    out.push(`\nНет в базе (не создаются): ${plan.brandsMissing.map((b) => b.dbName).join(', ')}`);

  out.push(`\n### Товары: обновится ${plan.products.length}\n`);
  out.push('| Строка | Артикул в файле | Товар в базе | Короткое название RU | Короткое название UZ | Потребности + | Потребности − | Тип |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const u of plan.products)
    out.push(
      `| ${u.sheet.row} | ${esc(u.sheet.sku)} | ${u.product.sku}${u.product.status === 'hidden' ? ' (скрыт)' : ''} | ${esc(u.sheet.short_ru)} | ${esc(u.sheet.short_uz)} | ${u.addNeeds.map(cat).join(', ') || '—'} | ${u.removeNeeds.map(cat).join(', ') || '—'} | ${u.setType ? '→ ' + cat(u.setType) : 'без изменений'} |`,
    );
  if (plan.skipped.length) out.push(`\nПропущены по указанию: ${plan.skipped.map((p) => `${p.sku} (строка ${p.row})`).join(', ')}`);
  if (plan.notFound.length) out.push(`\nНет в базе (не создаются): ${plan.notFound.map((p) => `${p.sku} «${p.name.slice(0, 60)}»`).join('; ')}`);
  if (plan.errors.length) out.push('\n**Ошибки (эти строки не загружаются):**\n\n' + plan.errors.map((e) => `- строка ${e.row}, ${e.sku}: ${e.text}`).join('\n'));
  if (plan.warnings.length) out.push('\nПредупреждения:\n\n' + plan.warnings.map((w) => `- ${w}`).join('\n'));
  return out.join('\n');
}

// ---------- apply / rollback ----------

const BACKUP_PREFIX = 'content_backup_';

async function backupStamps(db: PrismaClient | Prisma.TransactionClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ~ '^${BACKUP_PREFIX}[0-9]{14}_products$'`,
  );
  return rows.map((r) => r.table_name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 14)).sort();
}

export interface ContentResult {
  backup: string;
  brands: number;
  logos: number;
  products: number;
  needsAdded: number;
  needsRemoved: number;
  typesChanged: number;
}

/** logoUrls: brand id → already stored logo url (files are saved before the transaction). */
export async function applyContent(db: PrismaClient, plan: ContentPlan, logoUrls: Map<string, string>): Promise<ContentResult> {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const t = (name: string) => `"${BACKUP_PREFIX}${stamp}_${name}"`;
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('product_categories')} AS SELECT * FROM "product_categories"`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE ${t('brands')} AS SELECT "id", "country_ru", "country_uz", "why_vitalo_ru", "why_vitalo_uz", "show_in_showcase", "sort_order", "logo_url" FROM "brands"`,
      );
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('products')} AS SELECT "id", "short_name_ru", "short_name_uz" FROM "products"`);

      const r: ContentResult = { backup: `${BACKUP_PREFIX}${stamp}_*`, brands: 0, logos: 0, products: 0, needsAdded: 0, needsRemoved: 0, typesChanged: 0 };
      for (const { brand, sheet: b } of plan.brands) {
        const logo = logoUrls.get(brand.id);
        await tx.brands.update({
          where: { id: brand.id },
          data: {
            ...(b.country_ru ? { country_ru: b.country_ru } : {}),
            ...(b.country_uz ? { country_uz: b.country_uz } : {}),
            ...(b.why_ru ? { why_vitalo_ru: b.why_ru } : {}),
            ...(b.why_uz ? { why_vitalo_uz: b.why_uz } : {}),
            ...(b.showcase != null ? { show_in_showcase: b.showcase } : {}),
            ...(b.order != null ? { sort_order: b.order } : {}),
            ...(logo ? { logo_url: logo } : {}),
          },
        });
        r.brands++;
        if (logo) r.logos++;
      }
      for (const u of plan.products) {
        await tx.products.update({ where: { id: u.product.id }, data: { short_name_ru: u.sheet.short_ru, short_name_uz: u.sheet.short_uz } });
        if (u.removeNeeds.length)
          r.needsRemoved += (await tx.product_categories.deleteMany({ where: { product_id: u.product.id, category_id: { in: u.removeNeeds } } })).count;
        if (u.addNeeds.length)
          r.needsAdded += (
            await tx.product_categories.createMany({ data: u.addNeeds.map((category_id) => ({ product_id: u.product.id, category_id })), skipDuplicates: true })
          ).count;
        if (u.setType) {
          await tx.product_categories.deleteMany({ where: { product_id: u.product.id, category_id: { in: u.product.types } } });
          await tx.product_categories.createMany({ data: [{ product_id: u.product.id, category_id: u.setType }], skipDuplicates: true });
          r.typesChanged++;
        }
        r.products++;
      }
      await tx.audit_logs.create({ data: { action: 'catalog.content_loaded', entity_type: 'products', after_json: r as unknown as Prisma.InputJsonValue } });
      return r;
    },
    { timeout: 60_000 },
  );
}

/** The latest load undone: links, brand fields and short names exactly as in its backup. */
export async function rollbackContent(db: PrismaClient): Promise<{ backup: string; links: number; brands: number; products: number }> {
  return db.$transaction(
    async (tx) => {
      const stamp = (await backupStamps(tx)).pop();
      if (!stamp) throw new Error('Резервных таблиц content_backup_* нет: загрузка не выполнялась или уже откатана.');
      const t = (name: string) => `"${BACKUP_PREFIX}${stamp}_${name}"`;
      await tx.$executeRawUnsafe(`DELETE FROM "product_categories"`);
      const links = await tx.$executeRawUnsafe(`INSERT INTO "product_categories" SELECT * FROM ${t('product_categories')}`);
      const brands = await tx.$executeRawUnsafe(
        `UPDATE "brands" b SET "country_ru" = k."country_ru", "country_uz" = k."country_uz", "why_vitalo_ru" = k."why_vitalo_ru", "why_vitalo_uz" = k."why_vitalo_uz", "show_in_showcase" = k."show_in_showcase", "sort_order" = k."sort_order", "logo_url" = k."logo_url" FROM ${t('brands')} k WHERE k."id" = b."id"`,
      );
      const products = await tx.$executeRawUnsafe(
        `UPDATE "products" p SET "short_name_ru" = k."short_name_ru", "short_name_uz" = k."short_name_uz" FROM ${t('products')} k WHERE k."id" = p."id"`,
      );
      for (const name of ['product_categories', 'brands', 'products'])
        await tx.$executeRawUnsafe(`ALTER TABLE ${t(name)} RENAME TO "content_rb_${stamp}_${name}"`);
      await tx.audit_logs.create({ data: { action: 'catalog.content_rolled_back', entity_type: 'products', after_json: { backup: stamp, links, brands, products } } });
      return { backup: stamp, links, brands, products };
    },
    { timeout: 60_000 },
  );
}
