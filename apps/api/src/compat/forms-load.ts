import type { Prisma, PrismaClient } from '@prisma/client';
import { NEW_SUBSTANCES, PRODUCT_LABELS, SYNONYM_CHANGES, type NewSubstance, type ProductLabelPlan, type SynonymChange } from './forms-plan';
import { normalizeText } from './knowledge';
import { buildFormLabel, FORM_LABEL_MAX, writeProductSubstances } from './substance-label';

/**
 * 14.11.2026 `npm run compat:forms`: forms of substances, synonyms and the labels «Форма вещества» from the owner's
 * decisions (forms-plan.ts). Check first (writes nothing), then --apply: one transaction with backup tables
 * forms_backup_<stamp>_*; --rollback restores the latest one. Nothing is deleted: a substance made here is switched
 * off by the rollback, never removed. Safe to run twice: existing substances and done products are skipped.
 */

export interface FormsInput {
  substances: NewSubstance[];
  synonyms: SynonymChange[];
  products: Record<string, ProductLabelPlan>;
}

export const DEFAULT_FORMS_INPUT: FormsInput = { substances: NEW_SUBSTANCES, synonyms: SYNONYM_CHANGES, products: PRODUCT_LABELS };

interface DictRow {
  id: string;
  code: string;
  name_ru: string;
  name_uz: string;
  synonyms: string[];
}

export interface FormsPlan {
  create: NewSubstance[];
  existing: string[];
  synonyms: { code: string; name: string; add: string[]; remove: string[] }[];
  products: { id: string; sku: string; name: string; before: string[]; after: { code: string; in_label: boolean }[]; labelBefore: string | null; labelRu: string | null; labelUz: string | null }[];
  unchanged: string[];
  missing: string[];
  errors: string[];
}

/** The substances of a product after the plan: replaced by forms, removed, the label ones first and in label order. */
export function targetSubstances(current: string[], p: ProductLabelPlan): { code: string; in_label: boolean }[] {
  const out: string[] = [];
  for (const c of current) {
    if (p.remove?.includes(c)) continue;
    const n = p.replace?.[c] ?? c;
    if (!out.includes(n)) out.push(n);
  }
  for (const c of p.label) if (!out.includes(c)) out.push(c);
  const rank = (c: string) => (p.label.includes(c) ? p.label.indexOf(c) : p.label.length + out.indexOf(c));
  return out.sort((a, b) => rank(a) - rank(b)).map((code) => ({ code, in_label: p.label.includes(code) }));
}

export async function buildFormsPlan(db: PrismaClient | Prisma.TransactionClient, input: FormsInput = DEFAULT_FORMS_INPUT): Promise<FormsPlan> {
  const dict: DictRow[] = await db.substances.findMany({ select: { id: true, code: true, name_ru: true, name_uz: true, synonyms: true } });
  const byCode = new Map(dict.map((d) => [d.code, d]));
  const plan: FormsPlan = { create: [], existing: [], synonyms: [], products: [], unchanged: [], missing: [], errors: [] };
  const names = new Map<string, { name_ru: string; name_uz: string }>(dict.map((d) => [d.code, d]));

  for (const s of input.substances) {
    if (byCode.has(s.code)) plan.existing.push(s.code);
    else {
      if (s.parent && !byCode.has(s.parent) && !input.substances.some((x) => x.code === s.parent)) plan.errors.push(`${s.code}: нет вещества-родителя ${s.parent}`);
      plan.create.push(s);
      names.set(s.code, s);
    }
  }
  for (const ch of input.synonyms) {
    const d = byCode.get(ch.code);
    if (!d) {
      plan.errors.push(`синонимы: нет вещества ${ch.code}`);
      continue;
    }
    const have = new Set(d.synonyms.map(normalizeText));
    const add = (ch.add ?? []).map(normalizeText).filter((s) => !have.has(s));
    const remove = (ch.remove ?? []).map(normalizeText).filter((s) => have.has(s));
    if (add.length || remove.length) plan.synonyms.push({ code: ch.code, name: d.name_ru, add, remove });
  }

  const skus = Object.keys(input.products);
  const rows = await db.products.findMany({
    where: { sku: { in: skus } },
    select: {
      id: true,
      sku: true,
      name_ru: true,
      short_name_ru: true,
      substance_form_ru: true,
      substances: { orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { in_label: true, substance: { select: { code: true } } } },
    },
  });
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  for (const sku of skus) {
    const p = bySku.get(sku);
    if (!p) {
      plan.missing.push(sku);
      continue;
    }
    const before = p.substances.map((s) => s.substance.code);
    const after = targetSubstances(before, input.products[sku]);
    const unknown = after.filter((a) => !names.has(a.code)).map((a) => a.code);
    if (unknown.length) {
      plan.errors.push(`${sku}: нет в справочнике ${unknown.join(', ')}`);
      continue;
    }
    const parts = after.filter((a) => a.in_label).map((a) => names.get(a.code)!);
    const ru = parts.map((x) => x.name_ru).join(' + ') || null;
    const uz = parts.map((x) => x.name_uz || x.name_ru).join(' + ') || null;
    if ((ru?.length ?? 0) > FORM_LABEL_MAX || (uz?.length ?? 0) > FORM_LABEL_MAX) plan.errors.push(`${sku}: надпись длиннее ${FORM_LABEL_MAX} знаков`);
    const same =
      JSON.stringify(after) === JSON.stringify(p.substances.map((s) => ({ code: s.substance.code, in_label: s.in_label }))) && (p.substance_form_ru ?? null) === ru;
    if (same) plan.unchanged.push(sku);
    else plan.products.push({ id: p.id, sku, name: p.short_name_ru || p.name_ru, before, after, labelBefore: p.substance_form_ru, labelRu: ru, labelUz: uz });
  }
  return plan;
}

export function formatFormsPlan(plan: FormsPlan): string {
  const esc = (s: string | null | undefined) => String(s ?? '').replace(/\|/g, '/');
  const out: string[] = [];
  out.push(`## Справочник: новых записей ${plan.create.length} (уже есть: ${plan.existing.length})\n`);
  if (plan.create.length) {
    out.push('| Код | Вид | Форма какого вещества | RU | UZ |\n| --- | --- | --- | --- | --- |');
    for (const s of plan.create) out.push(`| ${s.code} | ${s.kind === 'form' ? 'форма' : 'вещество'} | ${s.parent ?? ''} | ${esc(s.name_ru)} | ${esc(s.name_uz)} |`);
  }
  out.push(`\n## Другие написания: веществ ${plan.synonyms.length}\n`);
  for (const s of plan.synonyms) out.push(`- ${s.name}: ${s.add.length ? `+ ${s.add.join(', ')}` : ''}${s.add.length && s.remove.length ? '; ' : ''}${s.remove.length ? `− ${s.remove.join(', ')}` : ''}`);
  out.push(`\n## Товары: меняется ${plan.products.length}, уже как надо ${plan.unchanged.length}, нет в базе ${plan.missing.length}\n`);
  if (plan.products.length) {
    out.push('| SKU | Товар | Надпись была | Надпись станет (RU) | Вещества (★ в надписи) |\n| --- | --- | --- | --- | --- |');
    for (const p of plan.products)
      out.push(`| ${p.sku} | ${esc(p.name)} | ${esc(p.labelBefore) || '—'} | ${esc(p.labelRu) || '— не показывается —'} | ${p.after.map((a) => (a.in_label ? '★' : '') + a.code).join(', ')} |`);
  }
  if (plan.missing.length) out.push(`\nНет в базе (пропущены): ${plan.missing.join(', ')}`);
  if (plan.errors.length) out.push('\n**Ошибки — загрузка не выполнится:**\n\n' + plan.errors.map((e) => `- ${e}`).join('\n'));
  return out.join('\n');
}

// ---------- apply / rollback ----------

const PREFIX = 'forms_backup_';

export async function applyFormsPlan(db: PrismaClient, plan: FormsPlan): Promise<{ backup: string; created: number; synonyms: number; products: number }> {
  if (plan.errors.length) throw new Error(`В плане ошибки, ничего не сделано:\n${plan.errors.join('\n')}`);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const t = (name: string) => `"${PREFIX}${stamp}_${name}"`;
  const ids = plan.products.map((p) => p.id);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('substances')} AS SELECT "id", "synonyms", "enabled" FROM "substances"`);
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('products')} AS SELECT "id", "substance_form_ru", "substance_form_uz" FROM "products" WHERE "id" = ANY($1::uuid[])`, ids);
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('product_substances')} AS SELECT * FROM "product_substances" WHERE "product_id" = ANY($1::uuid[])`, ids);
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('created')} ("code" text)`);

      // new substances: parents first (a parent may be created in the same run)
      const idOf = new Map((await tx.substances.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]));
      const pending = [...plan.create];
      while (pending.length) {
        const i = pending.findIndex((s) => !s.parent || idOf.has(s.parent));
        if (i < 0) throw new Error(`Не найден родитель для ${pending.map((s) => s.code).join(', ')}`);
        const s = pending.splice(i, 1)[0];
        const made = await tx.substances.create({
          data: { code: s.code, kind: s.kind, name_ru: s.name_ru, name_uz: s.name_uz, synonyms: [...new Set(s.synonyms.map(normalizeText))], parent_id: s.parent ? idOf.get(s.parent)! : null, sort_order: 500 },
        });
        idOf.set(s.code, made.id);
        await tx.$executeRawUnsafe(`INSERT INTO ${t('created')} ("code") VALUES ($1)`, s.code);
      }
      for (const ch of plan.synonyms) {
        const d = await tx.substances.findUniqueOrThrow({ where: { code: ch.code }, select: { synonyms: true } });
        const next = [...new Set([...d.synonyms.filter((x) => !ch.remove.includes(normalizeText(x))), ...ch.add])];
        await tx.substances.update({ where: { code: ch.code }, data: { synonyms: next } });
      }
      for (const p of plan.products) {
        await writeProductSubstances(
          tx,
          p.id,
          p.after.map((a) => ({ id: idOf.get(a.code)!, in_label: a.in_label })),
          { clearLabel: true },
        );
      }
      return { backup: `${PREFIX}${stamp}_*`, created: plan.create.length, synonyms: plan.synonyms.length, products: plan.products.length };
    },
    { timeout: 120_000 },
  );
}

/** Restores the labels, the substances of the touched products and the synonyms; switches off the substances it made. */
export async function rollbackFormsPlan(db: PrismaClient): Promise<{ backup: string; products: number; switchedOff: number }> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ~ '^${PREFIX}[0-9]{14}_products$'`,
      );
      const stamp = rows.map((r) => r.table_name.slice(PREFIX.length, PREFIX.length + 14)).sort().pop();
      if (!stamp) throw new Error('Резервных таблиц forms_backup_* нет: загрузка не выполнялась или уже откатана.');
      const t = (name: string) => `"${PREFIX}${stamp}_${name}"`;
      const products = await tx.$executeRawUnsafe(
        `UPDATE "products" p SET "substance_form_ru" = k."substance_form_ru", "substance_form_uz" = k."substance_form_uz" FROM ${t('products')} k WHERE k."id" = p."id"`,
      );
      await tx.$executeRawUnsafe(`DELETE FROM "product_substances" WHERE "product_id" IN (SELECT "id" FROM ${t('products')})`);
      await tx.$executeRawUnsafe(`INSERT INTO "product_substances" SELECT * FROM ${t('product_substances')}`);
      await tx.$executeRawUnsafe(`UPDATE "substances" s SET "synonyms" = k."synonyms" FROM ${t('substances')} k WHERE k."id" = s."id"`);
      const switchedOff = await tx.$executeRawUnsafe(`UPDATE "substances" SET "enabled" = false WHERE "code" IN (SELECT "code" FROM ${t('created')})`);
      // kept (renamed), never dropped: the next rollback takes the backup before this one
      for (const name of ['substances', 'products', 'product_substances', 'created']) await tx.$executeRawUnsafe(`ALTER TABLE ${t(name)} RENAME TO "forms_rb_${stamp}_${name}"`);
      return { backup: `${PREFIX}${stamp}_*`, products, switchedOff };
    },
    { timeout: 120_000 },
  );
}
