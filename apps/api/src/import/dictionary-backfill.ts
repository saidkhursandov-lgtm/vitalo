/**
 * Stage 1.2: fills products.*_id (brand / manufacturer / country / form) from the text columns.
 *
 * - Read-only plan first; nothing is written until `applyBackfill` (the CLI needs --confirm).
 * - One dictionary value per spelling group: trim + collapsed spaces + case + ё/е. The most frequent spelling
 *   becomes the name (an existing dictionary value keeps its own name). Every merge of spellings is reported.
 * - Nothing is merged silently beyond that: similar but different names are only listed as «возможные дубли».
 * - «ООО X, Россия»: when the tail is a known country, the manufacturer value is «ООО X» and the country is
 *   linked if the product has no other country; shown in the report.
 * - Only *_id are written, and only where they are empty; the text columns are never changed.
 */
import { Prisma } from '@prisma/client';
import {
  cleanName,
  closeEnough,
  DICTIONARY_COLUMNS,
  DICTIONARY_KINDS,
  DictionaryKind,
  looseKey,
  matchKey,
} from '../dictionaries/dictionary-names';
import { PrismaService } from '../prisma/prisma.service';
import { DictionaryRow, dictionaryTable, ensureDictionaryValue } from '../staff/admin-dictionaries';
import { AuditService } from '../staff/audit.service';

interface ProductTexts {
  id: string;
  sku: string;
  brand: string;
  manufacturer: string;
  country: string | null;
  form: string | null;
  brand_id: string | null;
  manufacturer_id: string | null;
  country_id: string | null;
  form_id: string | null;
}

export interface ValueGroup {
  key: string;
  name: string; // the dictionary name it will have
  existing: { id: string; name_ru: string; status: string } | null;
  variants: { text: string; count: number }[];
  productIds: string[]; // products to link (their *_id is empty now)
  skus: string[];
}

export interface KindPlan {
  groups: ValueGroup[];
  alreadyLinked: number;
  similar: [string, string][];
}

export interface ManufacturerSplit {
  sku: string;
  text: string;
  manufacturer: string;
  country: string;
  country_link: 'link' | 'already' | 'conflict';
  product_country: string | null;
}

export interface BackfillPlan {
  kinds: Record<DictionaryKind, KindPlan>;
  splits: ManufacturerSplit[];
}

export interface BackfillResult {
  created: Record<DictionaryKind, string[]>;
  linked: Record<DictionaryKind, number>;
}

const PRODUCT_SELECT = {
  id: true,
  sku: true,
  brand: true,
  manufacturer: true,
  country: true,
  form: true,
  brand_id: true,
  manufacturer_id: true,
  country_id: true,
  form_id: true,
} as const;

export async function planBackfill(prisma: PrismaService): Promise<BackfillPlan> {
  const products: ProductTexts[] = await prisma.products.findMany({ select: PRODUCT_SELECT, orderBy: { sku: 'asc' } });
  const existing = {} as Record<DictionaryKind, DictionaryRow[]>;
  for (const k of DICTIONARY_KINDS) existing[k] = await dictionaryTable(prisma, k).findMany();

  // Countries known anywhere: the dictionary and the products' own country text.
  const countryNames = new Map<string, string>();
  for (const c of existing.countries) countryNames.set(matchKey(c.name_ru), c.name_ru);
  for (const p of products) if (p.country?.trim()) countryNames.set(matchKey(p.country), cleanName(p.country));

  const splits: ManufacturerSplit[] = [];
  /** text value per kind and product (after the «, Россия» split) */
  const values: Record<DictionaryKind, { product: ProductTexts; text: string }[]> = { brands: [], manufacturers: [], countries: [], forms: [] };

  for (const p of products) {
    for (const kind of DICTIONARY_KINDS) {
      const cols = DICTIONARY_COLUMNS[kind];
      let text = (p[cols.text] ?? '').trim();
      if (!text) continue;
      if (kind === 'manufacturers') {
        const m = cleanName(text).match(/^(.*\S)\s*,\s*([^,]+)$/);
        const country = m && countryNames.get(matchKey(m[2]));
        if (m && country) {
          const productCountry = p.country?.trim() ? cleanName(p.country) : null;
          const link = !productCountry ? 'link' : matchKey(productCountry) === matchKey(country) ? 'already' : 'conflict';
          splits.push({ sku: p.sku, text: cleanName(text), manufacturer: m[1], country, country_link: link, product_country: productCountry });
          text = m[1];
          if (link === 'link' && !p.country_id) values.countries.push({ product: p, text: country });
        }
      }
      values[kind].push({ product: p, text });
    }
  }

  const kinds = {} as Record<DictionaryKind, KindPlan>;
  for (const kind of DICTIONARY_KINDS) {
    const cols = DICTIONARY_COLUMNS[kind];
    const byKey = new Map<string, { spellings: Map<string, number>; products: ProductTexts[] }>();
    let alreadyLinked = 0;
    for (const { product, text } of values[kind]) {
      const key = matchKey(text);
      const g = byKey.get(key) ?? { spellings: new Map<string, number>(), products: [] as ProductTexts[] };
      const spelling = cleanName(text);
      g.spellings.set(spelling, (g.spellings.get(spelling) ?? 0) + 1);
      if (product[cols.id]) alreadyLinked++;
      else if (!g.products.includes(product)) g.products.push(product);
      byKey.set(key, g);
    }
    const groups: ValueGroup[] = [...byKey.entries()]
      .map(([key, g]) => {
        const variants = [...g.spellings.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
        const found = existing[kind].find((r) => matchKey(r.name_ru) === key) ?? null;
        return {
          key,
          name: found?.name_ru ?? variants[0].text,
          existing: found && { id: found.id, name_ru: found.name_ru, status: found.status },
          variants,
          productIds: g.products.map((p) => p.id),
          skus: g.products.map((p) => p.sku),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // Similar but different names (all values of this kind, existing ones included): only reported.
    const names = [...new Set([...groups.map((g) => g.name), ...existing[kind].map((r) => r.name_ru)])];
    const similar: [string, string][] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [looseKey(names[i]), looseKey(names[j])];
        if (matchKey(names[i]) === matchKey(names[j])) continue;
        if (a && a === b) similar.push([names[i], names[j]]);
        else if (a.length >= 5 && b.length >= 5 && closeEnough(a, b, 2)) similar.push([names[i], names[j]]);
      }
    }
    kinds[kind] = { groups, alreadyLinked, similar };
  }
  return { kinds, splits };
}

/** Writes in one transaction: missing dictionary values, then *_id of the products that have none yet. */
export async function applyBackfill(prisma: PrismaService, audit: AuditService, plan: BackfillPlan): Promise<BackfillResult> {
  const result: BackfillResult = {
    created: { brands: [], manufacturers: [], countries: [], forms: [] },
    linked: { brands: 0, manufacturers: 0, countries: 0, forms: 0 },
  };
  await prisma.$transaction(
    async (tx) => {
      for (const kind of DICTIONARY_KINDS) {
        const idCol = DICTIONARY_COLUMNS[kind].id;
        for (const g of plan.kinds[kind].groups) {
          if (!g.productIds.length) continue; // every product of this spelling is linked already
          const { row, created } = await ensureDictionaryValue(tx, audit, kind, g.name, null);
          if (created) result.created[kind].push(row.name_ru);
          // Only empty links: a value chosen by hand in the admin panel is never replaced.
          const res = await tx.products.updateMany({ where: { id: { in: g.productIds }, [idCol]: null } as Prisma.productsWhereInput, data: { [idCol]: row.id } });
          result.linked[kind] += res.count;
        }
      }
      await audit.log({ staffId: null, action: 'dictionary.backfill', entityType: 'dictionaries', after: result }, tx);
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
  return result;
}

const LABEL: Record<DictionaryKind, string> = { brands: 'Бренды', manufacturers: 'Производители', countries: 'Страны', forms: 'Формы' };

export function formatBackfillPlan(plan: BackfillPlan): string {
  const out: string[] = [];
  for (const kind of DICTIONARY_KINDS) {
    const k = plan.kinds[kind];
    const toCreate = k.groups.filter((g) => !g.existing && g.productIds.length);
    const toLink = k.groups.reduce((n, g) => n + g.productIds.length, 0);
    out.push(`== ${LABEL[kind]}: значений ${k.groups.length} (новых ${toCreate.length}), привязать товаров ${toLink}, уже привязано ${k.alreadyLinked}`);
    for (const g of k.groups) {
      const state = g.existing ? (g.existing.status === 'archived' ? 'есть в справочнике (в архиве)' : 'есть в справочнике') : g.productIds.length ? 'СОЗДАТЬ' : 'все товары уже привязаны';
      out.push(`  «${g.name}» — ${state}; товаров к привязке: ${g.productIds.length}${g.skus.length ? ` (${g.skus.slice(0, 8).join(', ')}${g.skus.length > 8 ? ', …' : ''})` : ''}`);
      if (g.variants.length > 1) out.push(`      объединены написания: ${g.variants.map((v) => `«${v.text}» ×${v.count}`).join(', ')} → основное «${g.name}»`);
    }
    for (const [a, b] of k.similar) out.push(`  ? возможный дубль: «${a}» и «${b}» — НЕ объединено, проверьте вручную`);
    out.push('');
  }
  if (plan.splits.length) {
    out.push('== Производитель с названием страны в конце:');
    for (const s of plan.splits) {
      const c = s.country_link === 'link' ? `страна «${s.country}» будет привязана` : s.country_link === 'already' ? `страна у товара уже «${s.product_country}»` : `у товара другая страна «${s.product_country}» — страну НЕ привязываю`;
      out.push(`  ${s.sku}: «${s.text}» → производитель «${s.manufacturer}», ${c}`);
    }
    out.push('');
  }
  const n = DICTIONARY_KINDS.reduce((a, kind) => a + plan.kinds[kind].groups.reduce((m, g) => m + g.productIds.length, 0), 0);
  out.push(`Итого: привязок к записи ${n}. Текстовые поля товаров не меняются.`);
  return out.join('\n');
}

export function formatBackfillResult(r: BackfillResult): string {
  return DICTIONARY_KINDS.map(
    (k) => `${LABEL[k]}: создано ${r.created[k].length}${r.created[k].length ? ` (${r.created[k].join(', ')})` : ''}, привязано товаров ${r.linked[k]}`,
  ).join('\n');
}
