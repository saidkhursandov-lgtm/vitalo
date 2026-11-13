import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { matchSubstances, normalizeText } from './knowledge';

/** The same limit as substance_form_ru / _uz in the product card (admin-products.ts). */
export const FORM_LABEL_MAX = 60;

export interface LabelPart {
  name_ru: string;
  name_uz: string;
}

/**
 * «Форма вещества» under the product name, built from the dictionary (not typed by hand): the chosen substances / forms
 * in their order, «Магний цитрат + Витамин B6 (P-5-P)». Nothing chosen — no label (null).
 */
export function buildFormLabel(parts: LabelPart[]): { ru: string | null; uz: string | null } {
  if (!parts.length) return { ru: null, uz: null };
  const ru = parts.map((p) => p.name_ru.trim()).join(' + ');
  const uz = parts.map((p) => (p.name_uz || p.name_ru).trim()).join(' + ');
  const long = [ru, uz].find((s) => s.length > FORM_LABEL_MAX);
  if (long) {
    throw new BadRequestException({
      code: 'FORM_LABEL_TOO_LONG',
      message: `Надпись «${long}» длиннее ${FORM_LABEL_MAX} знаков: отметьте для надписи меньше веществ (главные 1–3)`,
    });
  }
  return { ru, uz };
}

export interface ProductSubstanceInput {
  id: string;
  in_label?: boolean;
}

/**
 * Sets the substances of a product in the given order and rebuilds the label from those marked «в надпись».
 * `clearLabel`: with none marked the label is cleared (the card editor); otherwise a hand-written label stays (the
 * «Товары и вещества» tab, which does not know about the label of old products).
 */
export async function writeProductSubstances(
  tx: Prisma.TransactionClient,
  productId: string,
  items: ProductSubstanceInput[],
  opts: { clearLabel: boolean },
): Promise<{ before: string[]; after: string[]; label: { ru: string | null; uz: string | null } | null }> {
  const seen = new Set<string>();
  const list = items.filter((i) => !seen.has(i.id) && seen.add(i.id));
  const ids = list.map((i) => i.id);
  const known = await tx.substances.findMany({ where: { id: { in: ids } }, select: { id: true, name_ru: true, name_uz: true } });
  if (known.length !== ids.length) throw new BadRequestException({ code: 'BAD_SUBSTANCE', message: 'Unknown substance' });
  const before = (await tx.product_substances.findMany({ where: { product_id: productId }, select: { substance_id: true } })).map((r) => r.substance_id);
  await tx.product_substances.deleteMany({ where: { product_id: productId, substance_id: { notIn: ids } } });
  for (const [position, i] of list.entries()) {
    await tx.product_substances.upsert({
      where: { product_id_substance_id: { product_id: productId, substance_id: i.id } },
      create: { product_id: productId, substance_id: i.id, position, in_label: !!i.in_label },
      update: { position, ...(i.in_label !== undefined && { in_label: i.in_label }) },
    });
  }
  const label = await refreshFormLabel(tx, productId, opts);
  return { before, after: ids, label };
}

/** Rebuilds «Форма вещества» from the marked substances; returns the new label or null when it was left as it was. */
export async function refreshFormLabel(tx: Prisma.TransactionClient, productId: string, opts: { clearLabel: boolean }) {
  const marked = await tx.product_substances.findMany({
    where: { product_id: productId, in_label: true },
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
    select: { substance: { select: { name_ru: true, name_uz: true } } },
  });
  if (!marked.length && !opts.clearLabel) return null;
  const label = buildFormLabel(marked.map((m) => m.substance));
  await tx.products.update({ where: { id: productId }, data: { substance_form_ru: label.ru, substance_form_uz: label.uz } });
  return label;
}

// ---------------- suggestions: substances found in the texts of a product ----------------

export interface SuggestDictEntry {
  id: string;
  code: string;
  kind: string;
  name_ru: string;
  name_uz: string;
  synonyms: string[];
  parent_id: string | null;
  enabled: boolean;
}

/** Texts of a product the suggestions are looked for in: strong — names, label, form; weak — the full composition. */
export interface ProductTexts {
  name_ru?: string | null;
  name_uz?: string | null;
  short_name_ru?: string | null;
  short_name_uz?: string | null;
  substance_form_ru?: string | null;
  substance_form_uz?: string | null;
  match_form?: string | null;
  label_composition_ru?: string | null;
  label_composition_uz?: string | null;
  search_keywords?: string | null;
  composition_ru?: string | null;
  composition_uz?: string | null;
}

const STRONG: (keyof ProductTexts)[] = ['name_ru', 'name_uz', 'short_name_ru', 'short_name_uz', 'substance_form_ru', 'substance_form_uz', 'match_form', 'label_composition_ru', 'label_composition_uz', 'search_keywords'];
const WEAK: (keyof ProductTexts)[] = ['composition_ru', 'composition_uz'];

/**
 * Substances of the dictionary named in the product's texts — a suggestion for «Состав», never written by itself (a
 * person accepts it). `strong`: found in the name, the label composition or the form; otherwise only in the full
 * composition, where excipients live too («магния стеарат»). Drug groups are never suggested; a substance is dropped
 * when one of its forms is found (Магний цитрат, not also Магний).
 */
export function suggestSubstances(texts: ProductTexts, dict: SuggestDictEntry[]): { id: string; strong: boolean }[] {
  const usable = dict.filter((d) => d.enabled && d.kind !== 'drug_group');
  const byCode = new Map(usable.map((d) => [d.code, d]));
  const join = (keys: (keyof ProductTexts)[]) => keys.map((k) => texts[k] ?? '').filter(Boolean).join(' | ');
  // in the order they stand in the text («Коллаген, гиалуроновая кислота» → Коллаген first), not by synonym length
  const inTextOrder = (text: string) => {
    const hay = normalizeText(text);
    const at = (d: SuggestDictEntry) => Math.min(...[d.name_ru, d.name_uz, ...d.synonyms].map((s) => hay.indexOf(normalizeText(s))).filter((i) => i >= 0));
    return matchSubstances(text, usable)
      .map((c) => byCode.get(c)!)
      .sort((a, b) => at(a) - at(b))
      .map((d) => d.id);
  };
  const strong = inTextOrder(join(STRONG));
  const weak = inTextOrder(join(WEAK)).filter((id) => !strong.includes(id));
  const all = [...strong.map((id) => ({ id, strong: true })), ...weak.map((id) => ({ id, strong: false }))];
  const parents = new Set(all.map((x) => usable.find((d) => d.id === x.id)?.parent_id).filter(Boolean));
  return all.filter((x) => !parents.has(x.id));
}
