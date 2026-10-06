import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/auth';
import { ErrorBox } from './ui';

export type DictionaryKind = 'brands' | 'manufacturers' | 'countries' | 'forms';
export const DICTIONARY_LABELS: Record<DictionaryKind, string> = { brands: 'Бренды', manufacturers: 'Производители', countries: 'Страны', forms: 'Формы' };

export interface DictionaryValue {
  id: string;
  name_ru: string;
  name_uz: string | null;
  status: 'active' | 'archived';
  products: number;
}

export const dictionaryKey = (kind: DictionaryKind) => ['dictionary', kind] as const;
export const useDictionary = (kind: DictionaryKind) =>
  useQuery({ queryKey: dictionaryKey(kind), queryFn: () => api<DictionaryValue[]>(`/staff/dictionaries/${kind}?include_archived=true`) });

const ADD = '__add__';
const TEXT = '__text__';

/**
 * Choice of a dictionary value for a product. Archived values are not offered, but a product keeps the one it has.
 * A text that is not linked to the dictionary yet (before the backfill) is shown as it is.
 * Admin (settings.dictionaries) can add a new value right here.
 */
export function DictionarySelect({
  kind,
  valueId,
  text,
  disabled,
  required,
  onChange,
}: {
  kind: DictionaryKind;
  valueId: string;
  text: string;
  disabled?: boolean;
  required?: boolean;
  onChange: (v: { id: string; name: string }) => void;
}) {
  const { can } = useSession();
  const client = useQueryClient();
  const q = useDictionary(kind);
  const add = useMutation({
    mutationFn: (name_ru: string) => api<DictionaryValue>(`/staff/dictionaries/${kind}`, { method: 'POST', body: { name_ru } }),
    onSuccess: (v) => {
      void client.invalidateQueries({ queryKey: dictionaryKey(kind) });
      onChange({ id: v.id, name: v.name_ru });
    },
    onError: (e) => {
      // Already there: just choose it (unless it is archived).
      const existing = e instanceof ApiError ? (e.body as { existing?: { id: string; name_ru: string; status: string } } | undefined)?.existing : undefined;
      if (existing && existing.status === 'active') {
        add.reset();
        onChange({ id: existing.id, name: existing.name_ru });
      }
    },
  });
  const values = q.data ?? [];
  const current = values.find((v) => v.id === valueId);
  const offered = values.filter((v) => v.status === 'active' || v.id === valueId);
  const selected = valueId || (text ? TEXT : '');

  return (
    <>
      <select
        value={selected}
        disabled={disabled || q.isPending}
        required={required}
        onChange={(e) => {
          const v = e.target.value;
          if (v === ADD) {
            const name = window.prompt(`Новое значение (${DICTIONARY_LABELS[kind].toLowerCase()})`)?.trim();
            if (name) add.mutate(name);
            return;
          }
          if (v === TEXT) return;
          const found = values.find((x) => x.id === v);
          onChange(found ? { id: found.id, name: found.name_ru } : { id: '', name: '' });
        }}
      >
        <option value="">{required ? '— выберите —' : '— не указано —'}</option>
        {!valueId && text && <option value={TEXT}>{text} (не из справочника)</option>}
        {offered.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name_ru}
            {v.status === 'archived' ? ' (в архиве)' : ''}
          </option>
        ))}
        {!disabled && can('settings.dictionaries') && <option value={ADD}>+ Добавить новое…</option>}
      </select>
      {current?.status === 'archived' && <span className="field-hint">Значение в архиве: у товара оно остаётся, но для новых товаров его не выбрать</span>}
      <ErrorBox error={add.error} />
    </>
  );
}
