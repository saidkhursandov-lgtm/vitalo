import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';

interface Size {
  width_mm: number;
  height_mm: number;
}

/** Physical ID label paper, mm (XP-365B prints up to 76 mm wide). Default 58×40; the layout scales to the size. */
export function LabelSizeSettings() {
  const q = useQuery({ queryKey: ['settings', 'label-size'], queryFn: () => api<Size>('/staff/settings/label-size') });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  return <LabelSizeForm size={q.data} />;
}

function LabelSizeForm({ size }: { size: Size }) {
  const client = useQueryClient();
  const [w, setW] = useState(String(size.width_mm));
  const [h, setH] = useState(String(size.height_mm));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api<Size>('/staff/settings/label-size', { method: 'PUT', body: { width_mm: Number(w), height_mm: Number(h) } }),
    onSuccess: (s) => {
      client.setQueryData(['settings', 'label-size'], s);
      void client.invalidateQueries({ queryKey: ['label-size'] });
      setSaved(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setSaved(false);
  };
  return (
    <section className="card narrow">
      <h2>Размер этикетки Physical ID</h2>
      <p className="muted">
        Бумага в принтере XP-365B. По умолчанию 58×40 мм. Этот же размер нужно выбрать в драйвере принтера и в окне печати Chrome
        (docs/PRINT_SETUP.md).
      </p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Ширина, мм" hint="30–76 мм">
            <input type="number" min={30} max={76} step={1} value={w} onChange={edit(setW)} required />
          </Field>
          <Field label="Высота, мм" hint="20–120 мм">
            <input type="number" min={20} max={120} step={1} value={h} onChange={edit(setH)} required />
          </Field>
        </div>
        <ErrorBox error={save.error} />
        {saved && <div className="alert alert-ok">Сохранено</div>}
        <button className="btn" disabled={save.isPending || (String(size.width_mm) === w && String(size.height_mm) === h)}>
          Сохранить
        </button>{' '}
        <a className="btn btn-ghost" href={`/print/test?w=${size.width_mm}&h=${size.height_mm}`} target="_blank" rel="noopener noreferrer">
          Тестовая печать
        </a>
      </form>
    </section>
  );
}
