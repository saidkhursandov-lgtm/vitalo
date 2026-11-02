/**
 * 3.8: starting knowledge of VITALO AI → database (npm run compat:knowledge). Reads the sheet «Правила совместимости»
 * of docs/content/VITALO_catalog.xlsx, adds the rules VITALO proposes and the starting substances of the products.
 * Everything it adds is a **draft** (rules) or a first fill (a product that has no substances yet); nothing existing is
 * changed or deleted, a second run adds nothing new.
 */
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import {
  PROPOSED_PRODUCT_SUBSTANCES,
  PROPOSED_RULES,
  RULE_KIND_LABELS,
  SHEET_RULE_KIND,
  SHEET_WHEN,
  WHEN_LABELS,
  matchSubstances,
  normalizeText,
  substanceOfCell,
  type DictEntry,
  type RuleDraft,
} from './knowledge';

export interface SheetData {
  /** row number in the sheet → the cells of «Правила совместимости» */
  rules: { row: number; cells: (string | number | null)[] }[];
  /** SKU → «Действующие вещества для проверки совместимости» of the sheet «Товары» */
  productSubstances: Record<string, string>;
}

const cellText = (v: ExcelJS.CellValue): string | number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return (v.result as string | number | null) ?? null;
  return String(v);
};

export async function readKnowledgeSheets(file: string): Promise<SheetData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out: SheetData = { rules: [], productSubstances: {} };
  const rules = wb.getWorksheet('Правила совместимости');
  if (!rules) throw new Error(`В файле ${file} нет листа «Правила совместимости»`);
  rules.eachRow((r, i) => {
    if (i < 3) return; // two header rows
    const cells = Array.from({ length: 9 }, (_, k) => cellText(r.getCell(k + 1).value));
    if (cells[0] && cells[1]) out.rules.push({ row: i, cells });
  });
  const goods = wb.getWorksheet('Товары');
  if (goods) {
    const head = goods.getRow(2);
    let skuCol = 0;
    let subCol = 0;
    head.eachCell((c, k) => {
      const t = String(cellText(c.value) ?? '');
      if (t.startsWith('Артикул')) skuCol = k;
      if (t.startsWith('Действующие вещества')) subCol = k;
    });
    if (skuCol && subCol) {
      goods.eachRow((r, i) => {
        const sku = i > 2 ? String(cellText(r.getCell(skuCol).value) ?? '').trim() : '';
        const sub = String(cellText(r.getCell(subCol).value) ?? '').trim();
        if (sku && sub) out.productSubstances[sku] = sub;
      });
    }
  }
  return out;
}

type DbSubstance = DictEntry & { id: string };

export interface KnowledgePlan {
  rules: (RuleDraft & { origin: 'xlsx' | 'vitalo'; row: number | null })[];
  skippedRules: { row: number | null; a: string; b: string; why: string }[];
  products: { id: string; sku: string; name: string; codes: string[]; sheet: string | null; sheetCodes: string[] }[];
  productsKept: { sku: string; name: string; codes: string[] }[];
  dict: DbSubstance[];
}

const num = (v: string | number | null) => (v == null || v === '' ? null : Number(v));

export async function buildKnowledgePlan(prisma: PrismaService, sheet: SheetData): Promise<KnowledgePlan> {
  const subs = await prisma.substances.findMany({ orderBy: { sort_order: 'asc' } });
  const dict: DbSubstance[] = subs.map((s) => ({ id: s.id, code: s.code, synonyms: s.synonyms, name_ru: s.name_ru, name_uz: s.name_uz }));
  const idOf = new Map(dict.map((d) => [d.code, d.id]));
  const existing = await prisma.compat_rules.findMany({ select: { substance_a_id: true, substance_b_id: true } });
  const taken = new Set(existing.flatMap((r) => [`${r.substance_a_id}|${r.substance_b_id}`, `${r.substance_b_id}|${r.substance_a_id}`]));
  const plan: KnowledgePlan = { rules: [], skippedRules: [], products: [], productsKept: [], dict };

  const take = (draft: RuleDraft, origin: 'xlsx' | 'vitalo', row: number | null) => {
    const a = idOf.get(draft.a);
    const b = idOf.get(draft.b);
    if (!a || !b) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'вещества нет в справочнике' });
    if (a === b) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'A и B — одно вещество' });
    if (taken.has(`${a}|${b}`)) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'правило для этой пары уже есть' });
    taken.add(`${a}|${b}`).add(`${b}|${a}`);
    plan.rules.push({ ...draft, origin, row });
  };

  for (const { row, cells } of sheet.rules) {
    const [ca, cb, kind, interval, whenA, whenB, ru, uz, source] = cells.map((c) => (c == null ? null : c));
    const label = `${ca} + ${cb}`;
    if (/\(пример\)/i.test(String(ca)) || /\(пример\)/i.test(String(cb))) {
      plan.skippedRules.push({ row, a: String(ca), b: String(cb), why: 'строка-пример' });
      continue;
    }
    const a = substanceOfCell(String(ca), dict);
    const b = substanceOfCell(String(cb), dict);
    const k = SHEET_RULE_KIND[normalizeText(String(kind ?? ''))];
    const wa = whenA ? SHEET_WHEN[normalizeText(String(whenA))] : null;
    const wb = whenB ? SHEET_WHEN[normalizeText(String(whenB))] : null;
    const why =
      ('error' in a && `A: ${a.error}`) ||
      ('error' in b && `B: ${b.error}`) ||
      (!k && `тип «${kind}» не из списка`) ||
      (whenA && !wa && `«когда A» = «${whenA}» не из списка`) ||
      (whenB && !wb && `«когда B» = «${whenB}» не из списка`) ||
      (!ru || !uz ? 'нет объяснения RU или UZ' : null);
    if (why || 'error' in a || 'error' in b || !k) {
      plan.skippedRules.push({ row, a: String(ca), b: String(cb), why: why || label });
      continue;
    }
    take(
      { a: a.code, b: b.code, kind: k, interval_hours: num(interval), when_a: wa ?? null, when_b: wb ?? null, text_ru: String(ru).trim(), text_uz: String(uz).trim(), source: source ? String(source).trim() : null },
      'xlsx',
      row,
    );
  }
  for (const p of PROPOSED_RULES) take(p, 'vitalo', null);

  const products = await prisma.products.findMany({
    where: { status: { not: 'archived' } },
    select: { id: true, sku: true, name_ru: true, short_name_ru: true, substances: { select: { substance: { select: { code: true } } } } },
    orderBy: { sku: 'asc' },
  });
  for (const p of products) {
    const name = p.short_name_ru || p.name_ru;
    if (p.substances.length) {
      plan.productsKept.push({ sku: p.sku, name, codes: p.substances.map((s) => s.substance.code) });
      continue;
    }
    const sheetText = sheet.productSubstances[p.sku] ?? null;
    plan.products.push({ id: p.id, sku: p.sku, name, codes: (PROPOSED_PRODUCT_SUBSTANCES[p.sku] ?? []).filter((c) => idOf.has(c)), sheet: sheetText, sheetCodes: sheetText ? matchSubstances(sheetText, dict) : [] });
  }
  return plan;
}

export function formatKnowledgePlan(plan: KnowledgePlan): string {
  const nameOf = new Map(plan.dict.map((d) => [d.code, d.name_ru]));
  const n = (c: string) => nameOf.get(c) ?? c;
  const w = (v: keyof typeof WHEN_LABELS | null) => (v ? WHEN_LABELS[v].ru : '—');
  const lines: string[] = [];
  lines.push(`## Правила — будут добавлены черновиками (${plan.rules.length})`, '');
  lines.push('| # | Откуда | A | B | Тип | Интервал, ч | Когда A | Когда B | Объяснение RU |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  plan.rules.forEach((r, i) =>
    lines.push(`| ${i + 1} | ${r.origin === 'xlsx' ? `таблица, стр. ${r.row}` : 'предложение VITALO'} | ${n(r.a)} | ${n(r.b)} | ${RULE_KIND_LABELS[r.kind].ru} | ${r.interval_hours ?? '—'} | ${w(r.when_a)} | ${w(r.when_b)} | ${r.text_ru} |`),
  );
  if (plan.skippedRules.length) {
    lines.push('', `## Строки правил, которые не добавляются (${plan.skippedRules.length})`, '');
    for (const s of plan.skippedRules) lines.push(`- ${s.row ? `стр. ${s.row}` : 'предложение'}: ${s.a} + ${s.b} — ${s.why}`);
  }
  lines.push('', `## Товары → вещества — первое заполнение (${plan.products.length})`, '');
  lines.push('| Артикул | Товар | Вещества | В таблице «Действующие вещества» |', '| --- | --- | --- | --- |');
  for (const p of plan.products) {
    const sheet = p.sheet ? `${p.sheet}${p.sheetCodes.length ? ` → ${p.sheetCodes.map(n).join(', ')}` : ' → не распознано'}` : '—';
    lines.push(`| ${p.sku} | ${p.name} | ${p.codes.length ? p.codes.map(n).join(', ') : '**нет — заполнить в админке**'} | ${sheet} |`);
  }
  if (plan.productsKept.length) {
    lines.push('', `Уже заполнены в админке, не меняются: ${plan.productsKept.map((p) => p.sku).join(', ')}.`);
  }
  return lines.join('\n');
}

export async function applyKnowledgePlan(prisma: PrismaService, plan: KnowledgePlan) {
  const idOf = new Map(plan.dict.map((d) => [d.code, d.id]));
  return prisma.$transaction(async (tx) => {
    let rules = 0;
    for (const r of plan.rules) {
      const a = idOf.get(r.a)!;
      const b = idOf.get(r.b)!;
      const clash = await tx.compat_rules.findFirst({ where: { OR: [{ substance_a_id: a, substance_b_id: b }, { substance_a_id: b, substance_b_id: a }] } });
      if (clash) continue;
      await tx.compat_rules.create({
        data: { substance_a_id: a, substance_b_id: b, kind: r.kind, interval_hours: r.interval_hours, when_a: r.when_a, when_b: r.when_b, text_ru: r.text_ru, text_uz: r.text_uz, source: r.source, origin: r.origin, status: 'draft' },
      });
      rules++;
    }
    let products = 0;
    for (const p of plan.products) {
      if (!p.codes.length) continue;
      if (await tx.product_substances.count({ where: { product_id: p.id } })) continue;
      await tx.product_substances.createMany({ data: p.codes.map((c) => ({ product_id: p.id, substance_id: idOf.get(c)! })), skipDuplicates: true });
      products++;
    }
    return { rules, products };
  });
}
