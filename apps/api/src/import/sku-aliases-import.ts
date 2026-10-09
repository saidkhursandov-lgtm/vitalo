/**
 * Alternative SKUs from VITALO_SKU_для_Яндекса.xlsx, sheet «SKU для Яндекса»:
 *   A — our SKU (OZN-A001), D — «Прежний SKU у нас» (source internal), E — «Старый SKU в Яндексе» (source yandex).
 * Empty cells are skipped; a cell that does not look like a SKU (e.g. «НА ЯНДЕКС ЕЩЁ НЕ ВЫСТАВЛЕН…») is skipped with a
 * warning; an old SKU equal to the product's own SKU is not created; a conflict (the alias is already another
 * product's alias or SKU) is shown and never overwritten. The plan reads only; apply writes all or nothing.
 */
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { aliasConflict, isSkuLike, normSku, skuProblem, type AliasSource } from '../staff/sku-aliases';
import { AuditService } from '../staff/audit.service';
import { cellText } from './yandex-import';

export const ALIASES_SHEET = 'SKU для Яндекса';
const COLUMNS: { col: number; source: AliasSource; title: string }[] = [
  { col: 4, source: 'internal', title: 'Прежний SKU у нас' },
  { col: 5, source: 'yandex', title: 'Старый SKU в Яндексе' },
];

export interface AliasPlanRow {
  row: number;
  sku: string;
  product_id: string;
  alias: string;
  source: AliasSource;
}

export interface AliasesPlan {
  file: string;
  create: AliasPlanRow[];
  /** already there for this product: nothing to do */
  existing: { row: number; sku: string; alias: string }[];
  /** the old SKU equals the product SKU */
  same: { row: number; sku: string }[];
  /** not a SKU (text), with a warning */
  notSku: { row: number; sku: string; column: string; text: string; reason: string }[];
  /** our SKU in column A is not in the database: skipped with a warning */
  unknownProduct: { row: number; sku: string }[];
  /** belongs to another product (alias or SKU): shown, not overwritten */
  conflicts: { row: number; sku: string; alias: string; message: string }[];
  /** errors that stop the write: no file or no sheet */
  errors: { row: number; message: string }[];
}

export async function planSkuAliases(prisma: PrismaService, file: string): Promise<AliasesPlan> {
  const plan: AliasesPlan = { file, create: [], existing: [], same: [], notSku: [], unknownProduct: [], conflicts: [], errors: [] };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch (e) {
    plan.errors.push({ row: 0, message: `Не удалось открыть файл ${file}: ${(e as Error).message}` });
    return plan;
  }
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === ALIASES_SHEET.toLowerCase());
  if (!ws) {
    plan.errors.push({ row: 0, message: `В файле нет листа «${ALIASES_SHEET}»` });
    return plan;
  }
  const seenInFile = new Map<string, { row: number; sku: string }>();
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sku = cellText(row.getCell(1).value).trim();
    if (!sku || !isSkuLike(sku)) continue; // empty rows and text headers
    const product = await prisma.products.findUnique({ where: { sku }, select: { id: true, sku: true } });
    if (!product && r === 1) continue; // the header row («SKU», «Прежний SKU у нас», …) is not a product
    const cells = COLUMNS.map((c) => ({ ...c, text: cellText(row.getCell(c.col).value).trim() })).filter((c) => c.text);
    if (!product) {
      if (cells.length) plan.unknownProduct.push({ row: r, sku });
      continue;
    }
    for (const c of cells) {
      const problem = skuProblem(c.text);
      if (problem) {
        plan.notSku.push({ row: r, sku, column: c.title, text: c.text.slice(0, 80), reason: problem });
        continue;
      }
      if (normSku(c.text) === normSku(product.sku)) {
        plan.same.push({ row: r, sku });
        continue;
      }
      const dup = seenInFile.get(normSku(c.text));
      if (dup) {
        if (dup.sku !== sku) plan.conflicts.push({ row: r, sku, alias: c.text, message: `в файле этот код уже указан у ${dup.sku} (строка ${dup.row})` });
        continue;
      }
      seenInFile.set(normSku(c.text), { row: r, sku });
      const conflict = await aliasConflict(prisma, product.id, c.text);
      if (conflict?.code === 'ALIAS_EXISTS') plan.existing.push({ row: r, sku, alias: c.text });
      else if (conflict?.code === 'ALIAS_IS_OWN_SKU') plan.same.push({ row: r, sku });
      else if (conflict) plan.conflicts.push({ row: r, sku, alias: c.text, message: conflict.message });
      else plan.create.push({ row: r, sku, product_id: product.id, alias: c.text, source: c.source });
    }
  }
  return plan;
}

/** All or nothing; conflicts found meanwhile (another writer) stop the whole write. */
export async function applySkuAliases(prisma: PrismaService, audit: AuditService, plan: AliasesPlan): Promise<number> {
  if (plan.errors.length) throw new Error('В плане есть ошибки — ничего не записано');
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const a of plan.create) {
      const conflict = await aliasConflict(tx, a.product_id, a.alias);
      if (conflict) throw new Error(`Строка ${a.row}: ${conflict.message} — ничего не записано`);
      await tx.product_sku_aliases.create({ data: { product_id: a.product_id, alias: a.alias, alias_norm: normSku(a.alias), source: a.source } });
      await audit.log({ staffId: null, action: 'product.alias_added', entityType: 'product', entityId: a.product_id, after: { sku: a.sku, alias: a.alias, source: a.source, via: 'import:yandex-aliases' } }, tx);
    }
    return plan.create.length;
  });
}

export function formatAliasesPlan(plan: AliasesPlan): string {
  const out: string[] = [];
  const list = (title: string, lines: string[]) => {
    out.push(`${title}: ${lines.length}`);
    for (const l of lines) out.push(`  ${l}`);
  };
  list('Будет создано', plan.create.map((a) => `стр. ${a.row}: ${a.sku} ← ${a.alias} (${a.source === 'yandex' ? 'старый SKU в Яндексе' : 'прежний SKU у нас'})`));
  list('Уже есть', plan.existing.map((a) => `стр. ${a.row}: ${a.sku} ← ${a.alias}`));
  list('Пропущено: совпадает с SKU товара', plan.same.map((a) => `стр. ${a.row}: ${a.sku}`));
  list('Пропущено: не похоже на SKU (предупреждение)', plan.notSku.map((a) => `стр. ${a.row}: ${a.sku}, «${a.column}»: «${a.text}» — ${a.reason}`));
  list('Пропущено: товара с таким SKU нет в базе (предупреждение)', plan.unknownProduct.map((a) => `стр. ${a.row}: ${a.sku}`));
  list('Конфликты (не перезаписываются)', plan.conflicts.map((a) => `стр. ${a.row}: ${a.sku} ← ${a.alias}: ${a.message}`));
  if (plan.errors.length) list('ОШИБКИ', plan.errors.map((e) => (e.row ? `стр. ${e.row}: ${e.message}` : e.message)));
  return out.join('\n');
}
