import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';

type Text = { ru: string; uz: string };
interface Manifest {
  enabled: boolean;
  title: Text;
  subtitle: Text;
  intro: Text;
  points: { title: Text; text: Text }[];
  outro: Text;
}

function Pair({ label, value, onChange, rows }: { label: string; value: Text; onChange: (v: Text) => void; rows?: number }) {
  const input = (lang: 'ru' | 'uz') =>
    rows ? (
      <textarea rows={rows} maxLength={1000} value={value[lang]} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} required />
    ) : (
      <input maxLength={200} value={value[lang]} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} required />
    );
  return (
    <div className="form-grid">
      <Field label={`${label} (RU)`}>{input('ru')}</Field>
      <Field label={`${label} (UZ)`}>{input('uz')}</Field>
    </div>
  );
}

/** 2.4: «Как VITALO отбирает добавки» — the entry on Home (under «Популярное») and its sheet; every text RU/UZ. */
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
        Строка на главной под «Популярным» открывает окно с текстом и кнопкой «Спросить специалиста». То же окно открывается
        из центральной кнопки «Подбор».
      </p>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set({ ...f, enabled: e.target.checked })} />
        Показывать блок на главной
      </label>
      <Pair label="Заголовок" value={f.title} onChange={(title) => set({ ...f, title })} />
      <Pair label="Подзаголовок (одна строка на главной)" value={f.subtitle} onChange={(subtitle) => set({ ...f, subtitle })} />
      <Pair label="Вступление" rows={4} value={f.intro} onChange={(intro) => set({ ...f, intro })} />
      {f.points.map((p, i) => {
        const put = (patch: Partial<typeof p>) => set({ ...f, points: f.points.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div key={i} className="edit-entry">
            <strong>Пункт {i + 1}</strong>
            <Pair label="Заголовок" value={p.title} onChange={(title) => put({ title })} />
            <Pair label="Текст" rows={4} value={p.text} onChange={(text) => put({ text })} />
          </div>
        );
      })}
      <Pair label="Заключение" rows={3} value={f.outro} onChange={(outro) => set({ ...f, outro })} />
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено — покупатели увидят изменения при следующем открытии магазина</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить манифест
      </button>
    </form>
  );
}
