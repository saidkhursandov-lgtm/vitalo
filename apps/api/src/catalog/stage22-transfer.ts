/**
 * Stage 2.2: moving products from the old category trees (with «Кожа», «Витамин D» … inside) to the flat
 * three-layer catalog. Old categories are never deleted: they are hidden and point to the one that replaced them.
 *
 *   plan     — reads only: which category becomes which, and every product's new needs and its one type;
 *   apply    — one transaction: backup tables first, then names / order / hiding, then the links;
 *   rollback — puts categories and links back exactly as they were in the backup.
 *
 * Run through scripts/catalog-stage22.ts (npm run catalog:stage22). Decided with the owner on 30.10.2026.
 */
import { Prisma, PrismaClient, TreeType } from '@prisma/client';

export interface TargetCategory {
  slug: string;
  ru: string;
  uz: string;
}

/** Layer 1, «По потребности»: a product may be in several. Order = order on the screen. */
export const NEED_TARGETS: TargetCategory[] = [
  { slug: 'sleep', ru: 'Сон и стресс', uz: 'Uyqu va stress' },
  { slug: 'immunity', ru: 'Иммунитет', uz: 'Immunitet' },
  { slug: 'joints', ru: 'Суставы и кости', uz: 'Bo‘g‘imlar va suyaklar' },
  { slug: 'energy', ru: 'Энергия и мозг', uz: 'Energiya va miya' },
  { slug: 'beauty', ru: 'Красота', uz: 'Go‘zallik' },
  { slug: 'women', ru: 'Женское здоровье', uz: 'Ayollar salomatligi' },
  { slug: 'men', ru: 'Мужское здоровье', uz: 'Erkaklar salomatligi' },
  { slug: 'sport', ru: 'Спорт и восстановление', uz: 'Sport va tiklanish' },
];

/** Layer 2, «По типу»: exactly one per product. */
export const TYPE_TARGETS: TargetCategory[] = [
  { slug: 'vitamins', ru: 'Витамины', uz: 'Vitaminlar' },
  { slug: 'minerals', ru: 'Минералы', uz: 'Minerallar' },
  { slug: 'omega', ru: 'Омега-3', uz: 'Omega-3' },
  { slug: 'collagen', ru: 'Коллаген', uz: 'Kollagen' },
  { slug: 'creatine-amino', ru: 'Креатин и аминокислоты', uz: 'Kreatin va aminolar' },
  { slug: 'protein', ru: 'Протеин и гейнеры', uz: 'Protein va geynerlar' },
  { slug: 'other', ru: 'Другие добавки', uz: 'Boshqa qo‘shimchalar' },
];

export const TARGETS: Record<TreeType, TargetCategory[]> = { need: NEED_TARGETS, product_type: TYPE_TARGETS };

/**
 * Old category -> new one. A subcategory of a new category goes to its parent without being listed here.
 * null: hidden, its products keep only their other needs («Сердце и сосуды» — owner's decision 30.10.2026).
 */
export const MERGE: Record<string, string | null> = {
  memory: 'energy',
  'beauty-skin': 'beauty',
  'beauty-hair': 'beauty',
  heart: null,
  probiotics: 'other',
};

/**
 * The product's one type, by the first substance named in its title: «Коллаген … с витамином C» is collagen,
 * «Комплекс витаминов … Магний, Омега-3» is vitamins, «Магний B6» is minerals.
 */
const TYPE_WORDS: [slug: string, re: RegExp][] = [
  ['creatine-amino', /креатин|creatine|аминокислот|amino|bcaa|глютамин|glutamine|аргинин|arginine|карнитин|carnitine|таурин|taurine/],
  ['protein', /протеин|protein|гейнер|gainer/],
  ['collagen', /коллаген|collagen/],
  ['omega', /омега|omega|рыбий жир|fish oil/],
  ['minerals', /магни[йя]|magnesium|цинк|zinc|йод|iodine|кальци[йя]|calcium|селен|selenium|кали[йя] |potassium|хром|chromium/],
  ['vitamins', /витамин|vitamin|биотин|biotin|фолиев|folic/],
];
/** No substance in the title: by the old types, the most specific first. */
const TYPE_PRIORITY = ['collagen', 'omega', 'creatine-amino', 'protein', 'minerals', 'vitamins', 'other'];

export function pickType(name: string, oldTypes: string[]): string | null {
  const text = name.toLowerCase();
  let best: { slug: string; at: number } | null = null;
  for (const [slug, re] of TYPE_WORDS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { slug, at: m.index };
  }
  if (best) return best.slug;
  return TYPE_PRIORITY.find((s) => oldTypes.includes(s)) ?? null;
}

export interface CategoryRow {
  id: string;
  slug: string;
  tree_type: TreeType;
  parent_id: string | null;
  name_ru: string;
  name_uz: string;
  status: 'active' | 'archived';
  sort_order: number;
}

/** Where an old category goes: itself (a new one), its replacement, or nowhere. */
export function resolveTarget(cat: Pick<CategoryRow, 'slug' | 'parent_id' | 'tree_type'>, bySlugOrId: Map<string, CategoryRow>): string | null {
  const targets = TARGETS[cat.tree_type].map((t) => t.slug);
  if (targets.includes(cat.slug)) return cat.slug;
  if (cat.slug in MERGE) return MERGE[cat.slug];
  let parent = cat.parent_id ? bySlugOrId.get(cat.parent_id) : undefined;
  while (parent) {
    if (targets.includes(parent.slug)) return parent.slug;
    parent = parent.parent_id ? bySlugOrId.get(parent.parent_id) : undefined;
  }
  return cat.tree_type === 'product_type' ? 'other' : null;
}

export interface CategoryMove {
  slug: string;
  tree_type: TreeType;
  name_ru: string;
  products: number;
  target: string | null;
  /** keep = it is a new category; hide = hidden and points to target */
  action: 'keep' | 'rename' | 'hide';
  new_name_ru?: string;
}

export interface ProductMove {
  id: string;
  sku: string;
  name_ru: string;
  brand: string;
  status: string;
  old_needs: string[];
  old_types: string[];
  new_needs: string[];
  new_type: string | null;
  /** how the type was chosen: by the name, by the old categories, or set by hand (--set-type) */
  type_source: 'name' | 'old' | 'manual' | 'none';
}

export interface TransferPlan {
  categories: CategoryMove[];
  products: ProductMove[];
  missingTargets: string[];
  alreadyApplied: boolean;
}

export const BACKUP_LINKS = 'stage22_backup_product_categories';
export const BACKUP_CATEGORIES = 'stage22_backup_categories';

async function backupExists(db: PrismaClient | Prisma.TransactionClient): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN (${BACKUP_LINKS}, ${BACKUP_CATEGORIES})`;
  return Number(rows[0].n) > 0;
}

export interface PlanProductRow {
  id: string;
  sku: string;
  name_ru: string;
  brand: string;
  status: string;
  categories: { category_id: string }[];
}

export async function planTransfer(db: PrismaClient, overrides: Record<string, string> = {}): Promise<TransferPlan> {
  const cats = (await db.categories.findMany({ orderBy: [{ tree_type: 'asc' }, { sort_order: 'asc' }] })) as CategoryRow[];
  const products = await db.products.findMany({
    orderBy: [{ status: 'asc' }, { brand: 'asc' }, { sku: 'asc' }],
    select: { id: true, sku: true, name_ru: true, brand: true, status: true, categories: { select: { category_id: true } } },
  });
  return { ...buildPlan(cats, products, overrides), alreadyApplied: await backupExists(db) };
}

/** The plan from plain rows: also used to show the owner the table of a database read with SELECT only (the server). */
export function buildPlan(cats: CategoryRow[], products: PlanProductRow[], overrides: Record<string, string> = {}): Omit<TransferPlan, 'alreadyApplied'> {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const targetOf = new Map(cats.map((c) => [c.id, resolveTarget(c, byId)]));
  const counts = new Map<string, number>();
  for (const p of products) for (const l of p.categories) counts.set(l.category_id, (counts.get(l.category_id) ?? 0) + 1);

  const allTargets = [...NEED_TARGETS, ...TYPE_TARGETS];
  const categories: CategoryMove[] = cats
    .filter((c) => c.status === 'active' || allTargets.some((t) => t.slug === c.slug))
    .map((c) => {
      const target = targetOf.get(c.id) ?? null;
      const t = allTargets.find((x) => x.slug === c.slug);
      const action = !t ? 'hide' : t.ru !== c.name_ru || t.uz !== c.name_uz ? 'rename' : 'keep';
      return { slug: c.slug, tree_type: c.tree_type, name_ru: c.name_ru, products: counts.get(c.id) ?? 0, target, action, ...(action === 'rename' && { new_name_ru: t!.ru }) };
    });

  const order = (tree: TreeType) => (s: string) => TARGETS[tree].findIndex((t) => t.slug === s);
  const moves: ProductMove[] = products.map((p) => {
    const linked = p.categories.map((l) => byId.get(l.category_id)!).filter(Boolean);
    const oldNeeds = linked.filter((c) => c.tree_type === 'need');
    const oldTypes = linked.filter((c) => c.tree_type === 'product_type');
    const needs = [...new Set(oldNeeds.map((c) => targetOf.get(c.id)).filter((s): s is string => !!s))].sort((a, b) => order('need')(a) - order('need')(b));
    const typesResolved = [...new Set(oldTypes.map((c) => targetOf.get(c.id)).filter((s): s is string => !!s))];
    let type: string | null;
    let source: ProductMove['type_source'];
    if (overrides[p.sku]) {
      type = overrides[p.sku];
      source = 'manual';
    } else {
      const byName = pickType(p.name_ru, []);
      type = byName ?? pickType('', typesResolved);
      source = byName ? 'name' : type ? 'old' : 'none';
    }
    return {
      id: p.id,
      sku: p.sku,
      name_ru: p.name_ru,
      brand: p.brand,
      status: p.status,
      old_needs: oldNeeds.map((c) => c.slug).sort(),
      old_types: oldTypes.map((c) => c.slug).sort(),
      new_needs: needs,
      new_type: type,
      type_source: source,
    };
  });

  const missingTargets = allTargets.filter((t) => !cats.some((c) => c.slug === t.slug)).map((t) => t.slug);
  return { categories, products: moves, missingTargets };
}

const nameOfTarget = (slug: string | null) => (slug ? ([...NEED_TARGETS, ...TYPE_TARGETS].find((t) => t.slug === slug)?.ru ?? slug) : '—');
const STATUS: Record<string, string> = { active: 'в продаже', archived: 'в архиве', hidden: 'скрыт' };
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** Two markdown tables: categories, then every product (the owner checks them before --apply). */
export function formatPlan(plan: TransferPlan): string {
  const out: string[] = [];
  if (plan.alreadyApplied) out.push('**Перенос уже выполнен** (есть резервные таблицы stage22_backup_*). Повторно не применяется; откат: --rollback.\n');
  if (plan.missingTargets.length) out.push(`**Нет категорий:** ${plan.missingTargets.join(', ')} — сначала миграция 20261030200000.\n`);
  for (const tree of ['need', 'product_type'] as TreeType[]) {
    out.push(`### ${tree === 'need' ? '«По потребности»' : '«По типу»'}\n`);
    out.push('| Старая категория | Товаров | Станет | Что со старой |', '| --- | --- | --- | --- |');
    for (const c of plan.categories.filter((x) => x.tree_type === tree)) {
      const what = c.action === 'keep' ? 'остаётся' : c.action === 'rename' ? `новое название «${c.new_name_ru}»` : 'скрыть';
      out.push(`| ${c.name_ru} (\`${c.slug}\`) | ${c.products} | ${c.action === 'hide' ? nameOfTarget(c.target) : c.action === 'rename' ? c.new_name_ru : c.name_ru} | ${what} |`);
    }
    out.push('');
  }
  out.push(`### Товары (${plan.products.length})\n`);
  out.push('| SKU | Товар | Бренд | Статус | Было: потребности | Было: типы | Станет: потребности | Станет: тип |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of plan.products) {
    const needs = p.new_needs.map(nameOfTarget).join(', ') || '— (нет потребности)';
    const type = p.new_type ? nameOfTarget(p.new_type) + (p.type_source === 'old' ? ' (по старой категории)' : p.type_source === 'manual' ? ' (задано вручную)' : '') : '**нет типа**';
    out.push(`| ${p.sku} | ${cell(p.name_ru.slice(0, 60))}${p.name_ru.length > 60 ? '…' : ''} | ${cell(p.brand)} | ${STATUS[p.status] ?? p.status} | ${p.old_needs.join(', ') || '—'} | ${p.old_types.join(', ') || '—'} | ${needs} | ${type} |`);
  }
  const noType = plan.products.filter((p) => !p.new_type).length;
  const noNeed = plan.products.filter((p) => !p.new_needs.length).length;
  out.push('', `Итого: товаров ${plan.products.length}; без типа — ${noType}; без потребности — ${noNeed}.`);
  return out.join('\n');
}

export interface TransferResult {
  linksAdded: number;
  typeLinksRemoved: number;
  categoriesHidden: number;
  categoriesRenamed: number;
}

/** Everything in one transaction; the backup tables are created first and make a second apply impossible. */
export async function applyTransfer(db: PrismaClient, plan: TransferPlan): Promise<TransferResult> {
  if (plan.missingTargets.length) throw new Error(`Нет категорий ${plan.missingTargets.join(', ')}: сначала миграция 20261030200000.`);
  return db.$transaction(
    async (tx) => {
      if (await backupExists(tx)) throw new Error('Перенос уже выполнен (есть таблицы stage22_backup_*). Откат: --rollback.');
      await tx.$executeRawUnsafe(`CREATE TABLE "${BACKUP_LINKS}" AS SELECT * FROM "product_categories"`);
      await tx.$executeRawUnsafe(`CREATE TABLE "${BACKUP_CATEGORIES}" AS SELECT "id", "name_ru", "name_uz", "status", "sort_order", "parent_id", "merged_into_id" FROM "categories"`);

      const cats = await tx.categories.findMany();
      const idOf = new Map(cats.map((c) => [c.slug, c.id]));
      const result: TransferResult = { linksAdded: 0, typeLinksRemoved: 0, categoriesHidden: 0, categoriesRenamed: 0 };

      for (const tree of ['need', 'product_type'] as TreeType[]) {
        for (const [i, t] of TARGETS[tree].entries()) {
          const before = cats.find((c) => c.slug === t.slug)!;
          if (before.name_ru !== t.ru || before.name_uz !== t.uz) result.categoriesRenamed++;
          await tx.categories.update({ where: { id: before.id }, data: { name_ru: t.ru, name_uz: t.uz, sort_order: (i + 1) * 10, status: 'active', parent_id: null, merged_into_id: null } });
        }
      }
      for (const c of plan.categories.filter((x) => x.action === 'hide')) {
        await tx.categories.update({ where: { slug: c.slug }, data: { status: 'archived', merged_into_id: c.target ? idOf.get(c.target) : null } });
        result.categoriesHidden++;
      }

      const typeIds = new Set(cats.filter((c) => c.tree_type === 'product_type').map((c) => c.id));
      for (const p of plan.products) {
        const wanted = [...p.new_needs, ...(p.new_type ? [p.new_type] : [])].map((s) => idOf.get(s)!);
        const added = await tx.product_categories.createMany({ data: wanted.map((category_id) => ({ product_id: p.id, category_id })), skipDuplicates: true });
        result.linksAdded += added.count;
        if (p.new_type) {
          const keep = idOf.get(p.new_type)!;
          const removed = await tx.product_categories.deleteMany({ where: { product_id: p.id, category_id: { in: [...typeIds].filter((id) => id !== keep) } } });
          result.typeLinksRemoved += removed.count;
        }
      }
      await tx.audit_logs.create({ data: { action: 'catalog.stage22_applied', entity_type: 'categories', after_json: result as unknown as Prisma.InputJsonValue } });
      return result;
    },
    { timeout: 120_000 },
  );
}

/** Categories and links exactly as in the backup; the backup tables are kept under a new name for history. */
export async function rollbackTransfer(db: PrismaClient): Promise<{ links: number; categories: number }> {
  return db.$transaction(
    async (tx) => {
      if (!(await backupExists(tx))) throw new Error('Резервных таблиц stage22_backup_* нет: перенос не выполнялся или уже откатан.');
      await tx.$executeRawUnsafe(`DELETE FROM "product_categories"`);
      const links = await tx.$executeRawUnsafe(
        `INSERT INTO "product_categories" ("product_id", "category_id") SELECT "product_id", "category_id" FROM "${BACKUP_LINKS}" ON CONFLICT DO NOTHING`,
      );
      const categories = await tx.$executeRawUnsafe(
        `UPDATE "categories" c SET "name_ru" = b."name_ru", "name_uz" = b."name_uz", "status" = b."status", "sort_order" = b."sort_order", "parent_id" = b."parent_id", "merged_into_id" = b."merged_into_id" FROM "${BACKUP_CATEGORIES}" b WHERE b."id" = c."id"`,
      );
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      await tx.$executeRawUnsafe(`ALTER TABLE "${BACKUP_LINKS}" RENAME TO "${BACKUP_LINKS}_rolled_back_${stamp}"`);
      await tx.$executeRawUnsafe(`ALTER TABLE "${BACKUP_CATEGORIES}" RENAME TO "${BACKUP_CATEGORIES}_rolled_back_${stamp}"`);
      await tx.audit_logs.create({ data: { action: 'catalog.stage22_rolled_back', entity_type: 'categories', after_json: { links, categories } } });
      return { links, categories };
    },
    { timeout: 120_000 },
  );
}
