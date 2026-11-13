import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { Badge, ErrorBox, Field, Modal } from './ui';

/** The same limit as on the server (substance-label.ts FORM_LABEL_MAX). */
export const FORM_LABEL_MAX = 60;

export interface PickedSubstance {
  id: string;
  kind: string;
  name_ru: string;
  name_uz: string;
  parent_name: string | null;
  enabled?: boolean;
  in_label: boolean;
}

interface DictRow {
  id: string;
  code: string;
  kind: 'substance' | 'form' | 'drug_group';
  name_ru: string;
  name_uz: string;
  synonyms: string[];
  parent: { id: string; name_ru: string } | null;
  enabled: boolean;
}

interface Suggestion {
  id: string;
  strong: boolean;
  kind: string;
  name_ru: string;
  name_uz: string;
  parent_name: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** «Форма вещества» under the product name: the marked substances in their order (the server builds the same). */
export function labelOf(list: PickedSubstance[], lang: 'ru' | 'uz'): string {
  return list
    .filter((s) => s.in_label)
    .map((s) => (lang === 'uz' ? s.name_uz || s.name_ru : s.name_ru))
    .join(' + ');
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * «Состав» of the product card: substances and forms chosen from the dictionary of VITALO AI (search by name and
 * synonyms, RU / UZ / English); the label «Форма вещества» is built from those marked «в надпись». While nothing is
 * chosen, it shows what the dictionary finds in the name and the composition — one click to add.
 */
export function SubstancePicker({
  value,
  onChange,
  disabled,
  texts,
  canAddToDictionary,
  manualLabel,
}: {
  /** an old hand-written label, shown while nothing is marked and the list is untouched */
  manualLabel?: string;
  value: PickedSubstance[];
  onChange: (next: PickedSubstance[]) => void;
  disabled?: boolean;
  /** names, label composition, composition — what the suggestions are looked for in */
  texts: Record<string, string>;
  canAddToDictionary: boolean;
}) {
  const dict = useQuery({ queryKey: ['compat', 'substances'], queryFn: () => api<DictRow[]>('/staff/compat/substances') });
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const chosen = new Set(value.map((s) => s.id));

  const debouncedTexts = useDebounced(texts, 600);
  const hasText = Object.values(debouncedTexts).some((t) => t.trim());
  const suggest = useQuery({
    queryKey: ['compat', 'suggest', debouncedTexts],
    queryFn: () => api<Suggestion[]>('/staff/compat/suggest', { method: 'POST', body: debouncedTexts }),
    enabled: !disabled && hasText,
    staleTime: 60_000,
  });
  const suggestions = (suggest.data ?? []).filter((s) => !chosen.has(s.id));

  const found = useMemo(() => {
    const q = norm(search);
    if (q.length < 2) return [];
    return (dict.data ?? [])
      .filter((d) => d.enabled && d.kind !== 'drug_group' && !chosen.has(d.id))
      .filter((d) => [d.name_ru, d.name_uz, ...d.synonyms].some((s) => norm(s).includes(q)))
      .sort((a, b) => Number(norm(b.name_ru).startsWith(q)) - Number(norm(a.name_ru).startsWith(q)) || a.name_ru.localeCompare(b.name_ru, 'ru'))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, dict.data, value]);

  /** A new one goes «в надпись» while the label still fits in 60 characters. */
  const add = (items: Omit<PickedSubstance, 'in_label'>[]) => {
    let next = [...value];
    for (const item of items) {
      if (next.some((s) => s.id === item.id)) continue;
      const tryIt = [...next, { ...item, in_label: true }];
      const fits = labelOf(tryIt, 'ru').length <= FORM_LABEL_MAX && labelOf(tryIt, 'uz').length <= FORM_LABEL_MAX;
      next = [...next, { ...item, in_label: fits }];
    }
    onChange(next);
    setSearch('');
  };
  const fromDict = (d: DictRow) => ({ id: d.id, kind: d.kind, name_ru: d.name_ru, name_uz: d.name_uz, parent_name: d.parent?.name_ru ?? null });
  const move = (i: number) => {
    const next = [...value];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  };

  const ru = labelOf(value, 'ru');
  const uz = labelOf(value, 'uz');
  const tooLong = ru.length > FORM_LABEL_MAX || uz.length > FORM_LABEL_MAX;
  const strong = suggestions.filter((s) => s.strong);

  return (
    <div className="substance-picker">
      {value.length > 0 && (
        <ol className="substance-list">
          {value.map((s, i) => (
            <li key={s.id}>
              <span className="substance-name">
                {s.name_ru}
                {s.parent_name && <span className="muted small"> · форма: {s.parent_name}</span>}
                {s.enabled === false && <Badge tone="warn">выключено в справочнике</Badge>}
              </span>
              <label className="check small">
                <input
                  type="checkbox"
                  checked={s.in_label}
                  disabled={disabled}
                  onChange={(e) => onChange(value.map((x) => (x.id === s.id ? { ...x, in_label: e.target.checked } : x)))}
                />
                в надпись
              </label>
              {!disabled && (
                <span className="substance-ops">
                  {i > 0 && (
                    <button type="button" className="btn btn-sm btn-ghost" aria-label={`Выше: ${s.name_ru}`} onClick={() => move(i)}>
                      ↑
                    </button>
                  )}
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Убрать: ${s.name_ru}`} onClick={() => onChange(value.filter((x) => x.id !== s.id))}>
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className={`substance-label-preview${tooLong ? ' is-bad' : ''}`}>
        <span className="muted small">Надпись под названием в магазине:</span>{' '}
        {ru ? (
          <>
            <strong>{ru}</strong>
            <span className="muted small"> · UZ: {uz}</span>
            {tooLong && <div className="text-bad small">Длиннее {FORM_LABEL_MAX} знаков — снимите «в надпись» у второстепенных веществ.</div>}
          </>
        ) : manualLabel ? (
          <span>
            «{manualLabel}» <Badge tone="warn">написано вручную</Badge>
          </span>
        ) : (
          <span className="muted small">не показывается (ничего не отмечено «в надпись»)</span>
        )}
      </div>

      {!disabled && suggestions.length > 0 && (
        <div className="substance-suggest">
          <span className="small">
            <strong>Нашлось в названии и составе:</strong>
          </span>
          <div className="picker-chips">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chip${s.strong ? '' : ' chip-weak'}`}
                title={s.strong ? 'Найдено в названии, составе для этикетки или форме' : 'Найдено только в полном составе — проверьте, не вспомогательное ли это вещество'}
                onClick={() => add([s])}
              >
                + {s.name_ru}
                {!s.strong && <span className="muted small"> (только в полном составе)</span>}
              </button>
            ))}
          </div>
          {strong.length > 1 && (
            <button type="button" className="btn btn-sm" onClick={() => add(strong)}>
              Добавить найденные в названии ({strong.length})
            </button>
          )}
        </div>
      )}

      {!disabled && (
        <div className="substance-search">
          <input
            type="search"
            value={search}
            placeholder="Найти вещество или форму: магний, цитрат, collagen…"
            aria-label="Найти вещество в справочнике"
            onChange={(e) => setSearch(e.target.value)}
          />
          {found.length > 0 && (
            <ul className="substance-found" role="listbox">
              {found.map((d) => (
                <li key={d.id}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => add([fromDict(d)])}>
                    {d.name_ru}
                    {d.parent && <span className="muted small"> · форма: {d.parent.name_ru}</span>}
                    {d.kind === 'substance' && <span className="muted small"> · вещество</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {norm(search).length >= 2 && found.length === 0 && dict.isSuccess && (
            <p className="small muted">
              В справочнике нет «{search.trim()}».{' '}
              {canAddToDictionary ? (
                <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                  Добавить в справочник
                </button>
              ) : (
                'Попросите администратора добавить его в «База знаний AI → Вещества».'
              )}
            </p>
          )}
        </div>
      )}
      <ErrorBox error={dict.error} />
      {adding && (
        <AddSubstance
          initial={search.trim()}
          dict={dict.data ?? []}
          onClose={() => setAdding(false)}
          onAdded={(d) => {
            setAdding(false);
            add([fromDict(d)]);
          }}
        />
      )}
    </div>
  );
}

/** «Добавить в справочник» right from the card: a form points at its substance, so its rules and goals apply at once. */
function AddSubstance({ initial, dict, onClose, onAdded }: { initial: string; dict: DictRow[]; onClose: () => void; onAdded: (d: DictRow) => void }) {
  const client = useQueryClient();
  const [v, setV] = useState({ name_ru: initial, name_uz: '', kind: 'form' as 'form' | 'substance', parent_id: '', synonyms: '' });
  const parents = dict.filter((d) => d.kind === 'substance' && d.enabled).sort((a, b) => a.name_ru.localeCompare(b.name_ru, 'ru'));
  const m = useMutation({
    mutationFn: () =>
      api<DictRow[]>('/staff/compat/substances', {
        method: 'POST',
        body: {
          kind: v.kind,
          name_ru: v.name_ru.trim(),
          name_uz: v.name_uz.trim(),
          parent_id: v.kind === 'form' ? v.parent_id || null : null,
          synonyms: v.synonyms.split(',').map((s) => s.trim()).filter(Boolean),
        },
      }),
    onSuccess: (list) => {
      client.setQueryData(['compat', 'substances'], list);
      const made = list.find((d) => d.name_ru === v.name_ru.trim() && !dict.some((x) => x.id === d.id));
      if (made) onAdded(made);
      else onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // the card form around must not be submitted too (React events pass through portals)
    m.mutate();
  };
  // a portal: the picker lives inside the product form, and a form may not be inside a form
  return createPortal(
    <Modal title="Новое в справочнике веществ" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="segmented">
          <button type="button" className={v.kind === 'form' ? 'is-on' : ''} onClick={() => setV({ ...v, kind: 'form' })}>
            Форма вещества
          </button>
          <button type="button" className={v.kind === 'substance' ? 'is-on' : ''} onClick={() => setV({ ...v, kind: 'substance', parent_id: '' })}>
            Новое вещество
          </button>
        </div>
        <Field label="Название (RU)" hint="Как в надписи: «Магний цитрат»">
          <input value={v.name_ru} required minLength={2} maxLength={120} onChange={(e) => setV({ ...v, name_ru: e.target.value })} />
        </Field>
        <Field label="Название (UZ)" hint="«Magniy sitrat»">
          <input value={v.name_uz} required minLength={2} maxLength={120} onChange={(e) => setV({ ...v, name_uz: e.target.value })} />
        </Field>
        {v.kind === 'form' && (
          <Field label="Форма какого вещества" hint="Правила и цели этого вещества сразу будут действовать и для формы">
            <select value={v.parent_id} required onChange={(e) => setV({ ...v, parent_id: e.target.value })}>
              <option value="">— выберите —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name_ru}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Другие написания" hint="Через запятую: цитрат магния, magnesium citrate">
          <input value={v.synonyms} onChange={(e) => setV({ ...v, synonyms: e.target.value })} />
        </Field>
        {v.kind === 'substance' && (
          <p className="small muted">У нового вещества пока нет правил и целей — VITALO AI скажет «данных немного». Добавьте их в «База знаний AI».</p>
        )}
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending}>
            {m.isPending ? 'Сохранение…' : 'Добавить'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
