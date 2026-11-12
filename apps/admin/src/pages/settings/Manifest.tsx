import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';

type Text = { ru: string; uz: string };
interface Manifest {
  enabled: boolean;
  title: Text;
  subtitle: Text;
  lead: Text;
  cards: { title: Text; bad: Text; good: Text }[];
}

function Pair({ label, value, onChange, rows, optional }: { label: string; value: Text; onChange: (v: Text) => void; rows?: number; optional?: boolean }) {
  const input = (lang: 'ru' | 'uz') =>
    rows ? (
      <textarea rows={rows} maxLength={300} value={value[lang]} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} required={!optional} />
    ) : (
      <input maxLength={200} value={value[lang]} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} required={!optional} />
    );
  return (
    <div className="form-grid">
      <Field label={`${label} (RU)`}>{input('ru')}</Field>
      <Field label={`${label} (UZ)`}>{input('uz')}</Field>
    </div>
  );
}

/**
 * 2.4: «Как VITALO отбирает добавки» — the entry on Home (under «Популярное») and its sheet; every text RU/UZ.
 * 2.4 patch: one sentence above three cards «Не берём / Стандарт VITALO»; «Не берём» may stay empty.
 */
export function ManifestSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'manifest'], queryFn: () => api<Manifest>('/staff/settings/manifest') });
  const [f, setF] = useState<Manifest | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Manifest>('/staff/settings/manifest', { method: 'PUT', body: f }),
    onSuccess: (m) => {
      client.setQueryData(['settings', 'manifest'], m);
      setSaved(true);
    },
  });
  if (q.isPending || !f) return <Loading />;
  const set = (next: Manifest) => {
    setF(next);
    setSaved(false);
  };
  return (
    <form
      className="card narrow"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2>Манифест «Как VITALO отбирает добавки»</h2>
      <p className="muted">
        Строка на главной под «Популярным» открывает окно: одна фраза и три карточки «Не берём» (красный крестик) и «Стандарт
        VITALO» (зелёная галочка), внизу кнопка «Спросить специалиста». То же окно открывается из кнопки «AI-подбор». Без
        процентов усвоения и без слова Halal.
      </p>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set({ ...f, enabled: e.target.checked })} />
        Показывать блок на главной
      </label>
      <Pair label="Заголовок" value={f.title} onChange={(title) => set({ ...f, title })} />
      <Pair label="Подзаголовок (одна строка на главной)" value={f.subtitle} onChange={(subtitle) => set({ ...f, subtitle })} />
      <Pair label="Фраза над карточками" rows={2} value={f.lead} onChange={(lead) => set({ ...f, lead })} />
      {f.cards.map((c, i) => {
        const put = (patch: Partial<typeof c>) => set({ ...f, cards: f.cards.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div key={i} className="edit-entry">
            <strong>Карточка {i + 1}</strong>
            <Pair label="Заголовок" value={c.title} onChange={(title) => put({ title })} />
            <Pair label="Не берём — можно оставить пустым" rows={2} optional value={c.bad} onChange={(bad) => put({ bad })} />
            <Pair label="Стандарт VITALO" rows={3} value={c.good} onChange={(good) => put({ good })} />
          </div>
        );
      })}
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено — покупатели увидят изменения при следующем открытии магазина</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить манифест
      </button>
    </form>
  );
}
