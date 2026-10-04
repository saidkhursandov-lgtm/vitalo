import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';

type Text = { ru: string; uz: string };
interface HomeContent {
  banner: { enabled: boolean; title: Text; subtitle: Text; button: Text };
  trust: { key: 'original' | 'delivery' | 'documents' | 'payments'; enabled: boolean; title: Text; text: Text }[];
  steps: { enabled: boolean; items: Text[] };
}
interface BonusTeaser {
  enabled: boolean;
  text: Text;
}

const TILE_HINT: Record<HomeContent['trust'][number]['key'], string> = {
  original: 'Плитка «Оригинальная продукция»',
  delivery: 'Плитка про доставку. {delivery} заменится сроками из тарифов («г. Ташкент — 2–5 рабочих дней, регионы — 5–10…»)',
  documents: 'Плитка «Документы на каждый товар»',
  payments: 'Плитка про платежи. {from} и {to} заменятся часами проверки платежей',
};

function TextPair({ label, value, onChange, hint }: { label: string; value: Text; onChange: (v: Text) => void; hint?: string }) {
  return (
    <div className="form-grid">
      <Field label={`${label} (RU)`} hint={hint}>
        <input value={value.ru} maxLength={200} onChange={(e) => onChange({ ...value, ru: e.target.value })} required />
      </Field>
      <Field label={`${label} (UZ)`}>
        <input value={value.uz} maxLength={200} onChange={(e) => onChange({ ...value, uz: e.target.value })} required />
      </Field>
    </div>
  );
}

/** Home page of the shop: banner, four trust tiles, «Как заказать» (B1). Each block can be switched off. */
export function HomeSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'home'], queryFn: () => api<HomeContent>('/staff/settings/home') });
  const [f, setF] = useState<HomeContent | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<HomeContent>('/staff/settings/home', { method: 'PUT', body: f }),
    onSuccess: (c) => {
      client.setQueryData(['settings', 'home'], c);
      setSaved(true);
    },
  });
  if (q.isPending || !f) return <Loading />;
  const set = (next: HomeContent) => {
    setF(next);
    setSaved(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit}>
      <section className="card narrow">
        <h2>Баннер</h2>
        <label className="check">
          <input type="checkbox" checked={f.banner.enabled} onChange={(e) => set({ ...f, banner: { ...f.banner, enabled: e.target.checked } })} />
          Показывать баннер
        </label>
        <TextPair label="Заголовок" value={f.banner.title} onChange={(title) => set({ ...f, banner: { ...f.banner, title } })} />
        <TextPair label="Подзаголовок" value={f.banner.subtitle} onChange={(subtitle) => set({ ...f, banner: { ...f.banner, subtitle } })} />
        <TextPair label="Кнопка" value={f.banner.button} onChange={(button) => set({ ...f, banner: { ...f.banner, button } })} hint="Открывает каталог" />
      </section>

      <section className="card narrow">
        <h2>Плитки доверия</h2>
        {f.trust.map((tile, i) => {
          const put = (patch: Partial<typeof tile>) => set({ ...f, trust: f.trust.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          return (
            <div key={tile.key} className="edit-entry">
              <label className="check">
                <input type="checkbox" checked={tile.enabled} onChange={(e) => put({ enabled: e.target.checked })} />
                <strong>{TILE_HINT[tile.key]}</strong>
              </label>
              <TextPair label="Заголовок" value={tile.title} onChange={(title) => put({ title })} />
              <TextPair label="Текст" value={tile.text} onChange={(text) => put({ text })} />
            </div>
          );
        })}
      </section>

      <section className="card narrow">
        <h2>Как заказать</h2>
        <label className="check">
          <input type="checkbox" checked={f.steps.enabled} onChange={(e) => set({ ...f, steps: { ...f.steps, enabled: e.target.checked } })} />
          Показывать блок «Как заказать»
        </label>
        {f.steps.items.map((s, i) => (
          <TextPair key={i} label={`Шаг ${i + 1}`} value={s} onChange={(v) => set({ ...f, steps: { ...f.steps, items: f.steps.items.map((x, j) => (j === i ? v : x)) } })} />
        ))}
      </section>

      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено — покупатели увидят изменения при следующем открытии магазина</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить главную
      </button>
    </form>
  );
}

/** «VITALO Bonus — скоро» in the profile (B4): on/off and the caption. */
export function BonusTeaserForm() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'bonus'], queryFn: () => api<BonusTeaser>('/staff/settings/bonus-teaser') });
  const [f, setF] = useState<BonusTeaser | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<BonusTeaser>('/staff/settings/bonus-teaser', { method: 'PUT', body: f }),
    onSuccess: (c) => {
      client.setQueryData(['settings', 'bonus'], c);
      setSaved(true);
    },
  });
  if (q.isPending || !f) return <Loading />;
  return (
    <form
      className="card narrow"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2>Карточка «VITALO Bonus — скоро»</h2>
      <p className="muted">Только витрина в профиле Mini App и строка в боте: без баланса, цифр и начислений.</p>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => (setF({ ...f, enabled: e.target.checked }), setSaved(false))} />
        Показывать карточку
      </label>
      <Field label="Подпись (RU)">
        <textarea rows={2} value={f.text.ru} onChange={(e) => (setF({ ...f, text: { ...f.text, ru: e.target.value } }), setSaved(false))} required />
      </Field>
      <Field label="Подпись (UZ)">
        <textarea rows={2} value={f.text.uz} onChange={(e) => (setF({ ...f, text: { ...f.text, uz: e.target.value } }), setSaved(false))} required />
      </Field>
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить
      </button>
    </form>
  );
}
