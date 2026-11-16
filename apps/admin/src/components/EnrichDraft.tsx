import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { FORM_LABEL_MAX, labelOf, type PickedSubstance } from './SubstancePicker';
import { Badge, ErrorBox } from './ui';

/** The same lists as apps/api ai-goal.ts (PRODUCT_GOALS, AUDIENCES) and iherb-fields.ts DOSE_UNITS. */
export const GOAL_LABELS: Record<string, string> = {
  sleep: 'Сон',
  stress: 'Стресс',
  energy: 'Энергия',
  joints: 'Суставы',
  immunity: 'Иммунитет',
  sport: 'Спорт',
  skin_hair: 'Кожа и волосы',
  heart: 'Сердце и сосуды',
  cognitive: 'Память и внимание',
};
export const AUDIENCE_LABELS: Record<string, string> = { adult: 'Взрослым', child: 'Детям', any: 'Всем' };
export const DOSE_UNIT_LABELS: Record<string, string> = { mg: 'мг', mcg: 'мкг', iu: 'МЕ', g: 'г', ml: 'мл', cfu_bn: 'млрд КОЕ' };

export const doseText = (amount: number | null | undefined, unit: string | null | undefined) =>
  amount != null && unit ? `${String(amount).replace('.', ',')} ${DOSE_UNIT_LABELS[unit] ?? unit}` : '';

export interface DraftSubstance {
  id: string;
  code: string;
  kind: string;
  name_ru: string;
  name_uz: string;
  parent_name: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  in_label: boolean;
}
export interface Enrichment {
  id: string;
  trigger: 'manual' | 'batch' | 'auto';
  created_at: string;
  payload: {
    substances: DraftSubstance[];
    unknown: { name: string; dose: string | null }[];
    audience: string;
    goals: string[];
    note: string;
  };
}

interface DictRow {
  id: string;
  parent: { id: string } | null;
  enabled: boolean;
}

/**
 * «Принять» — the same rules as apps/api enrich.ts mergeEnrichment: the draft's order first, then the product's own
 * substances the draft does not have (unless the draft has their form); a dose typed by hand stays; the «в надпись»
 * marks of a product with a label from the dictionary stay (a marked «магний» passes the mark to «магний цитрат»).
 */
export function mergeDraft(current: PickedSubstance[], draft: Enrichment['payload'], parentOf: Map<string, string | null>): PickedSubstance[] {
  const cur = new Map(current.map((c) => [c.id, c]));
  const hasLabel = current.some((c) => c.in_label);
  // the draft's «Омега-3» while the card has «Омега-3 rTG»: the card's form stays, the draft brings the dose
  const ids0 = new Set(draft.substances.map((s) => s.id));
  const substances = draft.substances.map((s) => {
    const form = current.find((c) => parentOf.get(c.id) === s.id && !ids0.has(c.id));
    return form ? { ...s, id: form.id, kind: form.kind, name_ru: form.name_ru, name_uz: form.name_uz, parent_name: form.parent_name } : s;
  });
  const draftIds = new Set(substances.map((s) => s.id));
  const draftParents = new Set(substances.map((s) => parentOf.get(s.id)).filter((x): x is string => !!x));
  const fromDraft: PickedSubstance[] = substances.map((s) => {
    const c = cur.get(s.id);
    const parent = parentOf.get(s.id);
    const parentMarked = !!parent && !!cur.get(parent)?.in_label;
    const keepDose = c && c.dose_amount != null && c.dose_unit;
    return {
      id: s.id,
      kind: s.kind,
      name_ru: s.name_ru,
      name_uz: s.name_uz,
      parent_name: s.parent_name,
      in_label: hasLabel ? !!c?.in_label || parentMarked : s.in_label,
      dose_amount: keepDose ? c.dose_amount : s.dose_amount,
      dose_unit: keepDose ? c.dose_unit : s.dose_unit,
    };
  });
  const kept = current.filter((c) => !draftIds.has(c.id) && !draftParents.has(c.id));
  const list = [...fromDraft, ...kept.map((c) => ({ ...c }))];
  const marked: PickedSubstance[] = [];
  for (const s of list) {
    if (!s.in_label) continue;
    const tryIt = [...marked, s];
    if (labelOf(tryIt, 'ru').length <= FORM_LABEL_MAX && labelOf(tryIt, 'uz').length <= FORM_LABEL_MAX) marked.push(s);
    else s.in_label = false;
  }
  return list;
}

/**
 * VITALO AI in the product card: «Заполнить с помощью AI» drafts the substances (forms), doses, who it is for and the
 * goals from the card texts. Nothing changes until «Принять»; then the card is saved as usual.
 */
export function EnrichDraft({
  productId,
  draft,
  onDraft,
  current,
  audience,
  goals,
  disabled,
  canRun,
  onAccept,
}: {
  productId: string | null;
  draft: Enrichment | null;
  onDraft: (d: Enrichment | null) => void;
  current: PickedSubstance[];
  audience: string | null;
  goals: string[];
  disabled?: boolean;
  canRun: boolean;
  onAccept: (next: { substances: PickedSubstance[]; audience: string | null; goals: string[]; draftId: string }) => void;
}) {
  const dict = useQuery({ queryKey: ['compat', 'substances'], queryFn: () => api<DictRow[]>('/staff/compat/substances') });
  const run = useMutation({
    mutationFn: () => api<Enrichment>(`/staff/compat/products/${productId}/enrich`, { method: 'POST' }),
    onSuccess: (d) => onDraft(d),
  });
  const reject = useMutation({
    mutationFn: (id: string) => api(`/staff/compat/enrichments/reject`, { method: 'POST', body: { ids: [id] } }),
    onSuccess: () => onDraft(null),
  });

  const accept = () => {
    if (!draft) return;
    const parentOf = new Map((dict.data ?? []).map((d) => [d.id, d.parent?.id ?? null]));
    onAccept({
      substances: mergeDraft(current, draft.payload, parentOf),
      audience: audience ?? draft.payload.audience,
      goals: [...new Set([...goals, ...draft.payload.goals])],
      draftId: draft.id,
    });
  };

  const curIds = new Set(current.map((c) => c.id));
  const p = draft?.payload;
  return (
    <div className="enrich-draft">
      <div className="enrich-head">
        <strong>Черновик VITALO AI</strong>
        {canRun && !disabled && (
          <button type="button" className="btn btn-sm" disabled={!productId || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'AI читает карточку…' : draft ? 'Заполнить заново' : 'Заполнить с помощью AI'}
          </button>
        )}
      </div>
      {!productId && <p className="muted small">Сохраните товар — AI заполнит вещества, дозы и цели по названию и составу.</p>}
      <ErrorBox error={run.error ?? reject.error} />
      {p && (
        <>
          <p className="muted small">
            AI прочитал название и состав карточки. Проверьте и нажмите «Принять» — изменения попадут в карточку, потом «Сохранить».
            {draft!.trigger === 'auto' && ' (сделано само после изменения состава)'}
          </p>
          <ul className="enrich-list">
            {p.substances.map((s) => (
              <li key={s.id}>
                {s.name_ru}
                {s.parent_name && <span className="muted small"> · форма: {s.parent_name}</span>}
                {doseText(s.dose_amount, s.dose_unit) && <span className="small"> · {doseText(s.dose_amount, s.dose_unit)} на порцию</span>}
                {s.in_label && <span className="muted small"> · в надпись</span>}
                {!curIds.has(s.id) && <Badge tone="info">новое</Badge>}
              </li>
            ))}
          </ul>
          {p.unknown.length > 0 && (
            <div className="alert alert-warn small">
              Нет в справочнике: {p.unknown.map((u) => `${u.name}${u.dose ? ` (${u.dose})` : ''}`).join(', ')}. Добавьте их в справочник через поиск ниже, если это
              действующие вещества.
            </div>
          )}
          <p className="small">
            Кому: <strong>{AUDIENCE_LABELS[p.audience] ?? p.audience}</strong>
            {p.goals.length > 0 && (
              <>
                {' · '}Цели: <strong>{p.goals.map((g) => GOAL_LABELS[g] ?? g).join(', ')}</strong>
              </>
            )}
          </p>
          {p.note && <p className="small muted">Заметка AI: {p.note}</p>}
          {!disabled && (
            <div className="enrich-actions">
              <button type="button" className="btn btn-sm" disabled={dict.isLoading} onClick={accept}>
                Принять
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={reject.isPending} onClick={() => reject.mutate(draft!.id)}>
                Отклонить
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
