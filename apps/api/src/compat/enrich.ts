/**
 * VITALO AI, ветка 1 «карточка как одно окно»: the model reads the texts of a product card and drafts its substances
 * (forms from the dictionary), the dose per serving, who it is for and its health goals. Only a draft: a person accepts
 * it in the card or in «Товары и вещества». No database or network access here: the service and the tests use these.
 */
import { DOSE_UNITS, type DoseUnit } from '../iherb/iherb-fields';
import { AUDIENCES, PRODUCT_GOALS, PRODUCT_GOAL_LABELS, type Audience, type ProductGoal } from './ai-goal';
import { matchSubstances, normalizeText } from './knowledge';
import { buildFormLabelSafe } from './substance-label';

/** Nutrition facts and fillers, not active substances: never «предложить в справочник». */
const NUTRITION = /^(углеводы|сахара?|жиры|белки?|калории|энергетическая ценность|пищевые волокна|(не)?растворимые волокна|натрий|хлориды|мальтодекстрины?|фруктоза|стевия|оливковое масло|какао-порошок)(\s|\(|$)/;

/** Product texts the draft is made from (and that start a new draft when they change). */
export const ENRICH_TEXTS = [
  'name_ru',
  'name_uz',
  'short_name_ru',
  'brand',
  'form',
  'short_description_ru',
  'composition_ru',
  'label_composition_ru',
  'directions_ru',
  'match_form',
] as const;
export type EnrichTexts = Partial<Record<(typeof ENRICH_TEXTS)[number], string | null>> & { servings_per_day?: number | null; pack_count?: number | null };

export interface EnrichDictEntry {
  id: string;
  code: string;
  kind: string;
  name_ru: string;
  name_uz: string;
  synonyms: string[];
  parent_id: string | null;
  enabled: boolean;
}

export const ENRICH_SYSTEM = `Ты — фармацевт-аналитик каталога магазина БАДов VITALO. По текстам карточки товара определи:
1. Действующие вещества — ТОЛЬКО коды из справочника в данных. Химическую форму (например, «Магний цитрат», «Магний
   бисглицинат», «Омега-3 rTG», «P-5-P», «Убихинол») выбирай ТОЛЬКО если её название или синоним прямо написан в тексте
   карточки. Если форма не названа — выбирай общее вещество (например, «Омега-3», а не «Омега-3 rTG»). Не угадывай форму
   по бренду или цене.
   Вспомогательные вещества (желатин, целлюлоза, стеарат магния, диоксид кремния, вода, глицерин, ароматизаторы,
   красители, подсластители, оболочка капсулы) не включай. Пищевую ценность (углеводы, сахара, жиры, белки, калории,
   волокна) не включай никуда, даже в unknown. ЭПК и ДГК (EPA, DHA) — это Омега-3.
2. Дозу каждого вещества — ровно как написано в составе этикетки (на 1 таблетку, капсулу или порцию из состава): число и
   единица (mg, mcg, iu — МЕ, g, ml, cfu_bn — миллиарды КОЕ). НЕ пересчитывай дозу по способу применения или описанию
   (½ таблетки, 2 капсулы в день) — противоречия опиши в note. Если дозы нет в составе — null. Не выдумывай и не
   переводи МЕ в мкг и обратно.
3. in_label: true для 1–3 главных веществ, по которым покупатель выбирает товар (их название покажется под товаром).
4. Вещество, которого нет в справочнике, — в unknown: название по-русски и доза текстом, если она есть.
5. audience: «child» — товар явно детский (дети, kids, children, детская форма или доза); «adult» — явно для взрослых;
   «any» — универсальный или неясно.
6. goals: 1–3 цели из списка, только если действующие вещества товара известны поддержкой этой цели по данным
   исследований. Не придумывай цель по рекламным словам.
7. note — одно короткое предложение по-русски для сотрудника: что в тексте неясно или противоречиво; иначе пустая строка.
Отвечай строго по схеме JSON.`;

export const ENRICH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['substances', 'unknown', 'audience', 'goals', 'note'],
  properties: {
    substances: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'dose_amount', 'dose_unit', 'in_label'],
        properties: {
          code: { type: 'string' },
          dose_amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          // the Claude API wants the enum inside its own type (an enum next to ['string', 'null'] is refused)
          dose_unit: { anyOf: [{ type: 'string', enum: [...DOSE_UNITS] }, { type: 'null' }] },
          in_label: { type: 'boolean' },
        },
      },
    },
    unknown: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'dose'], properties: { name: { type: 'string' }, dose: { type: ['string', 'null'] } } },
    },
    audience: { type: 'string', enum: [...AUDIENCES] },
    goals: { type: 'array', items: { type: 'string', enum: [...PRODUCT_GOALS] } },
    note: { type: 'string' },
  },
} as const;

/** The longest piece of a text sent to the model (a full composition can be very long). */
const TEXT_PIECE_MAX = 4000;
const SUBSTANCES_MAX = 30;
const UNKNOWN_MAX = 10;
const GOALS_MAX = 3;

const clip = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_PIECE_MAX);

/** What the model reads: the card texts, then the dictionary (codes, names, forms, a few synonyms). */
export function enrichDataBlock(texts: EnrichTexts, dict: EnrichDictEntry[]): string {
  const byId = new Map(dict.map((d) => [d.id, d]));
  const field = (label: string, v: string | null | undefined) => (clip(v) ? `${label}: ${clip(v)}` : null);
  const card = [
    field('Название', texts.name_ru),
    field('Название (UZ)', texts.name_uz),
    field('Короткое название', texts.short_name_ru),
    field('Бренд', texts.brand),
    field('Форма выпуска', texts.form),
    field('Форма вещества (для сравнения с конкурентами)', texts.match_form),
    field('Состав для этикетки', texts.label_composition_ru),
    field('Полный состав', texts.composition_ru),
    field('Описание', texts.short_description_ru),
    field('Способ применения', texts.directions_ru),
    texts.servings_per_day ? `Порций в день: ${texts.servings_per_day}` : null,
    texts.pack_count ? `Порций в банке: ${texts.pack_count}` : null,
  ].filter(Boolean);
  const dictLines = dict
    .filter((d) => d.enabled && d.kind !== 'drug_group')
    .map((d) => {
      const parent = d.parent_id ? byId.get(d.parent_id) : null;
      const syn = d.synonyms.slice(0, 6).join(', ');
      return `- ${d.code} | ${d.name_ru}${d.kind === 'form' && parent ? ` | форма вещества ${parent.code}` : ''}${syn ? ` | ${syn}` : ''}`;
    });
  const goals = PRODUCT_GOALS.map((g) => `${g} — ${PRODUCT_GOAL_LABELS[g].ru}`).join('; ');
  return [`<карточка>`, ...card, `</карточка>`, '', `Цели: ${goals}`, '', `<справочник>`, ...dictLines, `</справочник>`].join('\n');
}

export interface EnrichSubstance {
  id: string;
  code: string;
  kind: string;
  name_ru: string;
  name_uz: string;
  parent_name: string | null;
  dose_amount: number | null;
  dose_unit: DoseUnit | null;
  in_label: boolean;
}

/** The stored draft (product_enrichments.payload). */
export interface EnrichPayload {
  substances: EnrichSubstance[];
  unknown: { name: string; dose: string | null }[];
  audience: Audience;
  goals: ProductGoal[];
  note: string;
}

/**
 * The model's answer → a clean draft. Unknown or switched-off codes and drug groups are dropped; a parent next to its
 * own form is dropped (the form says more); a dose needs a positive number and a known unit; «в надпись» is kept only
 * while the label fits in 60 characters.
 */
export function checkEnrichAnswer(json: unknown, dict: EnrichDictEntry[]): { ok: true; payload: EnrichPayload } | { ok: false; error: string } {
  if (!json || typeof json !== 'object') return { ok: false, error: 'not_object' };
  const a = json as Record<string, unknown>;
  if (!Array.isArray(a.substances) || !Array.isArray(a.unknown) || !Array.isArray(a.goals)) return { ok: false, error: 'shape' };
  const byCode = new Map(dict.filter((d) => d.enabled && d.kind !== 'drug_group').map((d) => [d.code, d]));
  const byId = new Map(dict.map((d) => [d.id, d]));

  const seen = new Set<string>();
  const picked: EnrichSubstance[] = [];
  for (const raw of a.substances as Record<string, unknown>[]) {
    const d = typeof raw?.code === 'string' ? byCode.get(raw.code.trim()) : undefined;
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    const amount = typeof raw.dose_amount === 'number' && Number.isFinite(raw.dose_amount) && raw.dose_amount > 0 && raw.dose_amount < 1_000_000 ? Math.round(raw.dose_amount * 1000) / 1000 : null;
    const unit = typeof raw.dose_unit === 'string' && (DOSE_UNITS as readonly string[]).includes(raw.dose_unit) ? (raw.dose_unit as DoseUnit) : null;
    picked.push({
      id: d.id,
      code: d.code,
      kind: d.kind,
      name_ru: d.name_ru,
      name_uz: d.name_uz,
      parent_name: d.parent_id ? (byId.get(d.parent_id)?.name_ru ?? null) : null,
      dose_amount: amount != null && unit ? amount : null,
      dose_unit: amount != null && unit ? unit : null,
      in_label: raw.in_label === true,
    });
  }
  // a parent next to its own form: keep the form only
  const parentsOfForms = new Set(picked.map((s) => byId.get(s.id)?.parent_id).filter((x): x is string => !!x));
  const substances = picked.filter((s) => !parentsOfForms.has(s.id)).slice(0, SUBSTANCES_MAX);
  // «в надпись» while it fits
  const marked: EnrichSubstance[] = [];
  for (const s of substances) {
    if (!s.in_label) continue;
    if (buildFormLabelSafe([...marked, s])) marked.push(s);
    else s.in_label = false;
  }

  // the dictionary entries already in the draft, with their parents («ДГК (DHA)» is Омега-3 when Омега-3 rTG is picked)
  const inDraft = new Set(substances.flatMap((s) => [s.code, byId.get(byId.get(s.id)?.parent_id ?? '')?.code].filter((x): x is string => !!x)));
  const unknown = (a.unknown as Record<string, unknown>[])
    .filter((u) => typeof u?.name === 'string' && u.name.trim().length >= 2)
    .filter((u) => !NUTRITION.test(normalizeText(u.name as string)))
    .filter((u) => !matchSubstances(u.name as string, [...byCode.values()]).some((c) => inDraft.has(c)))
    .map((u) => ({ name: (u.name as string).trim().slice(0, 120), dose: typeof u.dose === 'string' && u.dose.trim() ? u.dose.trim().slice(0, 60) : null }))
    .slice(0, UNKNOWN_MAX);
  const audience = (AUDIENCES as readonly string[]).includes(a.audience as string) ? (a.audience as Audience) : 'any';
  const goals = [...new Set((a.goals as unknown[]).filter((g): g is ProductGoal => (PRODUCT_GOALS as readonly string[]).includes(g as string)))].slice(0, GOALS_MAX);
  const note = typeof a.note === 'string' ? a.note.trim().slice(0, 300) : '';
  if (!substances.length && !unknown.length) return { ok: false, error: 'empty' };
  return { ok: true, payload: { substances, unknown, audience, goals, note } };
}

export interface CurrentSubstance {
  id: string;
  in_label: boolean;
  dose_amount: number | null;
  dose_unit: string | null;
}

/**
 * «Принять» merges a draft into what the product has now, without losing a person's work: the draft's order first, then
 * the product's own substances the draft does not have (unless the draft has their form); a dose typed by hand stays;
 * the «в надпись» marks of a product that already has a label from the dictionary stay as they are. The same rules are
 * in the admin (ProductEdit «Принять»).
 */
export function mergeEnrichment(
  current: CurrentSubstance[],
  draft: EnrichPayload,
  parentOf: Map<string, string | null>,
  names: Map<string, { name_ru: string; name_uz: string }>,
): { id: string; in_label: boolean; dose_amount: number | null; dose_unit: string | null }[] {
  const cur = new Map(current.map((c) => [c.id, c]));
  const hasLabel = current.some((c) => c.in_label);
  const draftIds = new Set(draft.substances.map((s) => s.id));
  const draftParents = new Set(draft.substances.map((s) => parentOf.get(s.id)).filter((x): x is string => !!x));
  const fromDraft = draft.substances.map((s) => {
    const c = cur.get(s.id);
    // the product's «магний» in the label becomes the draft's «магний цитрат» in the label
    const parent = parentOf.get(s.id);
    const parentMarked = !!parent && !!cur.get(parent)?.in_label;
    const keepDose = c && c.dose_amount != null && c.dose_unit;
    return {
      id: s.id,
      in_label: hasLabel ? !!c?.in_label || parentMarked : s.in_label,
      dose_amount: keepDose ? c.dose_amount : s.dose_amount,
      dose_unit: keepDose ? c.dose_unit : s.dose_unit,
    };
  });
  const kept = current.filter((c) => !draftIds.has(c.id) && !draftParents.has(c.id)).map((c) => ({ ...c }));
  const list = [...fromDraft, ...kept];
  // the label must still fit: later marks are dropped first
  const marked: { name_ru: string; name_uz: string }[] = [];
  for (const s of list) {
    if (!s.in_label) continue;
    const n = names.get(s.id);
    if (n && buildFormLabelSafe([...marked, n])) marked.push(n);
    else s.in_label = false;
  }
  return list;
}
