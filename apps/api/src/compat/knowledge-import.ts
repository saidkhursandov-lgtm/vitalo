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
  PROPOSED_SUBSTANCES,
  PROPOSED_RULES,
  RULE_KIND_LABELS,
  SHEET_RULE_EDITS,
  SHEET_RULE_KIND,
  SHEET_WHEN,
  WHEN_LABELS,
  matchSubstances,
  normalizeText,
  pairKey,
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

type DbSubstance = DictEntry & { id: string | null };

type PlannedRule = RuleDraft & { origin: 'xlsx' | 'vitalo'; row: number | null };

export interface KnowledgePlan {
  /** substances of PROPOSED_SUBSTANCES that the dictionary does not have yet */
  substances: (typeof PROPOSED_SUBSTANCES)[number][];
  rules: PlannedRule[];
  /** draft rules whose text, interval or time differ from the source (applied only with `--update-drafts`) */
  ruleUpdates: (PlannedRule & { id: string })[];
  skippedRules: { row: number | null; a: string; b: string; why: string }[];
  products: { id: string; sku: string; name: string; codes: string[]; sheet: string | null; sheetCodes: string[] }[];
  /** filled products lacking some proposed substances (added only with `--update-drafts`; nothing is removed) */
  productAdds: { id: string; sku: string; name: string; codes: string[] }[];
  productsKept: { sku: string; name: string; codes: string[] }[];
  dict: DbSubstance[];
}

const num = (v: string | number | null) => (v == null || v === '' ? null : Number(v));

const RULE_FIELDS = ['kind', 'interval_hours', 'when_a', 'when_b', 'text_ru', 'text_uz', 'source'] as const;

export async function buildKnowledgePlan(prisma: PrismaService, sheet: SheetData): Promise<KnowledgePlan> {
  const subs = await prisma.substances.findMany({ orderBy: { sort_order: 'asc' } });
  const dict: DbSubstance[] = subs.map((s) => ({ id: s.id, code: s.code, synonyms: s.synonyms, name_ru: s.name_ru, name_uz: s.name_uz }));
  const newSubstances = PROPOSED_SUBSTANCES.filter((p) => !dict.some((d) => d.code === p.code));
  dict.push(...newSubstances.map((s) => ({ id: null, code: s.code, synonyms: s.synonyms, name_ru: s.name_ru, name_uz: s.name_uz })));
  const known = new Set(dict.map((d) => d.code));
  const codeOf = new Map(subs.map((s) => [s.id, s.code]));
  const existing = await prisma.compat_rules.findMany();
  const ruleOf = new Map(existing.map((r) => [pairKey(codeOf.get(r.substance_a_id) ?? r.substance_a_id, codeOf.get(r.substance_b_id) ?? r.substance_b_id), r]));
  const taken = new Set<string>();
  const plan: KnowledgePlan = { substances: newSubstances, rules: [], ruleUpdates: [], skippedRules: [], products: [], productAdds: [], productsKept: [], dict };

  const take = (draft: RuleDraft, origin: 'xlsx' | 'vitalo', row: number | null) => {
    if (!known.has(draft.a) || !known.has(draft.b)) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'вещества нет в справочнике' });
    if (draft.a === draft.b) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'A и B — одно вещество' });
    const key = pairKey(draft.a, draft.b);
    const rule: PlannedRule = { ...draft, ...SHEET_RULE_EDITS[key], origin, row };
    if (taken.has(key)) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'пара уже встречалась выше' });
    taken.add(key);
    const old = ruleOf.get(key);
    if (!old) return plan.rules.push(rule);
    if (old.status !== 'draft' || old.origin !== origin) return plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'правило одобрено, выключено или заведено в админке — меняется только там' });
    // the stored rule keeps the A → B order of its first import: compare the fields in that order
    const same = codeOf.get(old.substance_a_id) === rule.a ? rule : { ...rule, a: rule.b, b: rule.a, when_a: rule.when_b, when_b: rule.when_a };
    if (RULE_FIELDS.some((f) => (old[f] ?? null) !== (same[f] ?? null))) plan.ruleUpdates.push({ ...same, id: old.id });
    else plan.skippedRules.push({ row, a: draft.a, b: draft.b, why: 'правило для этой пары уже есть' });
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
    const proposed = (PROPOSED_PRODUCT_SUBSTANCES[p.sku] ?? []).filter((c) => known.has(c));
    if (p.substances.length) {
      const has = p.substances.map((s) => s.substance.code);
      plan.productsKept.push({ sku: p.sku, name, codes: has });
      const missing = proposed.filter((c) => !has.includes(c));
      if (missing.length) plan.productAdds.push({ id: p.id, sku: p.sku, name, codes: missing });
      continue;
    }
    const sheetText = sheet.productSubstances[p.sku] ?? null;
    plan.products.push({ id: p.id, sku: p.sku, name, codes: proposed, sheet: sheetText, sheetCodes: sheetText ? matchSubstances(sheetText, dict) : [] });
  }
  return plan;
}

export function formatKnowledgePlan(plan: KnowledgePlan): string {
  const nameOf = new Map(plan.dict.map((d) => [d.code, d.name_ru]));
  const n = (c: string) => nameOf.get(c) ?? c;
  const w = (v: keyof typeof WHEN_LABELS | null) => (v ? WHEN_LABELS[v].ru : '—');
  const head = ['| # | Откуда | A | B | Тип | Интервал, ч | Когда A | Когда B | Объяснение RU |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const ruleRow = (r: PlannedRule, i: number) =>
    `| ${i + 1} | ${r.origin === 'xlsx' ? `таблица, стр. ${r.row}` : 'предложение VITALO'} | ${n(r.a)} | ${n(r.b)} | ${RULE_KIND_LABELS[r.kind].ru} | ${r.interval_hours ?? '—'} | ${w(r.when_a)} | ${w(r.when_b)} | ${r.text_ru} |`;
  const lines: string[] = [];
  if (plan.substances.length) {
    lines.push(`## Вещества — будут добавлены в справочник (${plan.substances.length})`, '');
    for (const s of plan.substances) lines.push(`- ${s.name_ru} / ${s.name_uz}: ${s.synonyms.join(', ')}`);
    lines.push('');
  }
  lines.push(`## Правила — будут добавлены черновиками (${plan.rules.length})`, '', ...head);
  plan.rules.forEach((r, i) => lines.push(ruleRow(r, i)));
  if (plan.ruleUpdates.length) {
    lines.push('', `## Черновики правил с новым текстом — обновятся только с --update-drafts (${plan.ruleUpdates.length})`, '', ...head);
    plan.ruleUpdates.forEach((r, i) => lines.push(ruleRow(r, i)));
  }
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
  if (plan.productAdds.length) {
    lines.push('', `## Товарам не хватает веществ по полному составу — добавятся только с --update-drafts (${plan.productAdds.length})`, '');
    for (const p of plan.productAdds) lines.push(`- ${p.sku} ${p.name}: + ${p.codes.map(n).join(', ')}`);
  }
  if (plan.productsKept.length) {
    lines.push('', `Уже заполнены, ничего не убирается: ${plan.productsKept.map((p) => p.sku).join(', ')}.`);
  }
  return lines.join('\n');
}

export async function applyKnowledgePlan(prisma: PrismaService, plan: KnowledgePlan, opts: { updateDrafts?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    let substances = 0;
    for (const s of plan.substances) {
      if (await tx.substances.findUnique({ where: { code: s.code } })) continue;
      await tx.substances.create({ data: { code: s.code, kind: s.kind, name_ru: s.name_ru, name_uz: s.name_uz, synonyms: s.synonyms, sort_order: s.sort_order } });
      substances++;
    }
    const idOf = new Map((await tx.substances.findMany({ select: { id: true, code: true } })).map((d) => [d.code, d.id]));
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
    let updated = 0;
    let added = 0;
    if (opts.updateDrafts) {
      for (const r of plan.ruleUpdates) {
        // only while it is still a draft: an approved rule belongs to the admin
        const res = await tx.compat_rules.updateMany({
          where: { id: r.id, status: 'draft' },
          data: { kind: r.kind, interval_hours: r.interval_hours, when_a: r.when_a, when_b: r.when_b, text_ru: r.text_ru, text_uz: r.text_uz, source: r.source },
        });
        updated += res.count;
      }
      for (const p of plan.productAdds) {
        const res = await tx.product_substances.createMany({ data: p.codes.map((c) => ({ product_id: p.id, substance_id: idOf.get(c)! })), skipDuplicates: true });
        added += res.count;
      }
    }
    return { substances, rules, products, updated, added };
  });
}
