import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../lib/api';
import { money, ruDate } from '../lib/format';
import { Badge, ErrorBox, Field, Loading, toInt } from './ui';

/** The same lists as PLATFORMS / DOSE_UNITS / DOSE_PER in apps/api (iherb/one-to-one.ts, iherb-fields.ts). */
export const PLATFORM_LABELS: Record<string, string> = {
  uzum: 'Uzum Market',
  yandex_market: 'Яндекс Маркет',
  pharmacy: 'Аптека',
  social: 'Instagram / Telegram',
  other: 'Другое',
};
const UNITS: [string, string][] = [
  ['', '—'],
  ['mg', 'мг'],
  ['mcg', 'мкг'],
  ['iu', 'МЕ'],
  ['g', 'г'],
  ['ml', 'мл'],
  ['cfu_bn', 'млрд КОЕ'],
];
const PER: [string, string][] = [
  ['', '—'],
  ['capsule', 'на 1 капсулу'],
  ['tablet', 'на 1 таблетку'],
  ['softgel', 'на 1 мягкую капсулу'],
  ['serving', 'на 1 порцию'],
  ['drop', 'на 1 каплю'],
];

interface MatchValues {
  brand: string | null;
  match_form: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  dose_per: string | null;
  pack_count: number | null;
}

interface CompetitorRow extends MatchValues {
  orders_count: number | null;
  id: string;
  platform: string;
  seller: string | null;
  title: string | null;
  url: string | null;
  price_uzs: number;
  observed_on: string;
  source: string;
  match_status: 'match' | 'mismatch' | 'incomplete';
  mismatch_reasons: string[];
}

interface CompetitorList {
  product: MatchValues & { id: string };
  items: CompetitorRow[];
}

const STATUS: Record<CompetitorRow['match_status'], [string, 'ok' | 'warn' | 'neutral']> = {
  match: ['1-в-1', 'ok'],
  mismatch: ['не тот товар', 'warn'],
  incomplete: ['не сравнить', 'neutral'],
};

const today = () => {
  const d = new Date(Date.now() + 5 * 3600_000); // Tashkent
  return d.toISOString().slice(0, 10);
};

/**
 * Генплан, этап 5, ветка iherb-4-competitors (D-57, узел 4): competitor prices of one product with the strict «1-в-1»
 * match. Admin only. A price is compared only when brand + chemical form + dose + pack count are the same; the match
 * is re-checked against the product every time (fixing our card can turn «не тот товар» into «1-в-1»).
 */
export function Competitors({ productId }: { productId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['competitors', productId], queryFn: () => api<CompetitorList>(`/staff/competitors?product_id=${productId}`) });
  const [adding, setAdding] = useState(false);
  const hide = useMutation({
    mutationFn: (id: string) => api(`/staff/competitors/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['competitors', productId] });
      void qc.invalidateQueries({ queryKey: ['iherb'] });
    },
  });

  return (
    <section className="card">
      <div className="section-head">
        <h2>Цены конкурентов</h2>
        {!adding && (
          <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
            Добавить цену
          </button>
        )}
      </div>
      <p className="muted small">
        Цена сравнивается с нашей, только если совпадают все четыре: бренд, химическая форма, доза и количество в банке. Остальные записи
        сохраняются с пометкой и в графики и «минимум рынка» не идут.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {adding && <AddForm productId={productId} ours={q.data.product} onDone={() => setAdding(false)} />}
          {!q.data.items.length ? (
            !adding && <p className="muted">Цен конкурентов пока нет.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Где</th>
                    <th className="num">Цена</th>
                    <th>Дата</th>
                    <th>Сверка</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div>
                          {PLATFORM_LABELS[c.platform] ?? c.platform}
                          {c.seller && <span className="muted"> · {c.seller}</span>}
                          {c.source === 'ai' && <span className="muted small"> · от AI</span>}
                        </div>
                        {c.orders_count != null && <div className="muted small">заказов: {c.orders_count.toLocaleString('ru-RU')}</div>}
                        {(c.title || c.url) && (
                          <div className="muted small">
                            {c.url ? (
                              <a href={c.url} target="_blank" rel="noreferrer noopener">
                                {c.title || 'ссылка'}
                              </a>
                            ) : (
                              c.title
                            )}
                          </div>
                        )}
                      </td>
                      <td className="num">{money(c.price_uzs)}</td>
                      <td>{ruDate(c.observed_on)}</td>
                      <td>
                        <Badge tone={STATUS[c.match_status][1]}>{STATUS[c.match_status][0]}</Badge>
                        {c.mismatch_reasons.map((r) => (
                          <div key={r} className="muted small">
                            {r}
                          </div>
                        ))}
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={hide.isPending}
                          onClick={() => {
                            if (window.confirm('Убрать эту цену? Она пропадёт из списка и графиков, но останется в журнале.')) hide.mutate(c.id);
                          }}
                        >
                          Убрать
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hide.isError && <p className="text-bad">{errorText(hide.error)}</p>}
        </>
      )}
    </section>
  );
}

function AddForm({ productId, ours, onDone }: { productId: string; ours: MatchValues; onDone: () => void }) {
  const qc = useQueryClient();
  // what the competitor sells starts as our product: change only what differs on the competitor's page
  const [f, setF] = useState<Record<string, string>>({
    platform: 'uzum',
    seller: '',
    title: '',
    url: '',
    price_uzs: '',
    observed_on: today(),
    brand: ours.brand ?? '',
    match_form: ours.match_form ?? '',
    dose_amount: ours.dose_amount == null ? '' : String(ours.dose_amount),
    dose_unit: ours.dose_unit ?? '',
    dose_per: ours.dose_per ?? '',
    pack_count: ours.pack_count == null ? '' : String(ours.pack_count),
    orders_count: '',
  });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const m = useMutation({
    mutationFn: () =>
      api<CompetitorRow>(`/staff/competitors/${productId}`, {
        method: 'POST',
        body: {
          platform: f.platform,
          seller: f.seller,
          title: f.title,
          url: f.url,
          price_uzs: toInt(f.price_uzs),
          observed_on: f.observed_on || undefined,
          brand: f.brand,
          match_form: f.match_form,
          dose_amount: f.dose_amount.trim() ? Number(f.dose_amount.replace(',', '.')) : null,
          dose_unit: f.dose_unit || null,
          dose_per: f.dose_per || null,
          pack_count: toInt(f.pack_count) ?? null,
          orders_count: toInt(f.orders_count) ?? null,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['competitors', productId] });
      void qc.invalidateQueries({ queryKey: ['iherb'] });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const text = (k: string, props: Record<string, unknown> = {}) => <input value={f[k]} onChange={(e) => set(k, e.target.value)} {...props} />;
  return (
    <form onSubmit={submit} className="competitor-form">
      <div className="form-grid">
        <Field label="Площадка">
          <select value={f.platform} onChange={(e) => set('platform', e.target.value)}>
            {Object.entries(PLATFORM_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Магазин или аптека">{text('seller', { maxLength: 120 })}</Field>
        <Field label="Цена, сум">{text('price_uzs', { inputMode: 'numeric', required: true })}</Field>
        <Field label="Когда видели">{text('observed_on', { type: 'date', max: today() })}</Field>
        <Field label="Ссылка">{text('url', { type: 'url', maxLength: 500 })}</Field>
        <Field label="Название у конкурента">{text('title', { maxLength: 300 })}</Field>
        <Field label="Заказов у конкурента">{text('orders_count', { inputMode: 'numeric', placeholder: 'например, 350 на Uzum' })}</Field>
      </div>
      <h3>Что продаёт конкурент</h3>
      <p className="muted small">Заполнено как у нашего товара — сверьте со страницей конкурента и исправьте, что отличается.</p>
      <div className="form-grid">
        <Field label="Бренд">{text('brand', { maxLength: 120 })}</Field>
        <Field label="Химическая форма">{text('match_form', { maxLength: 80 })}</Field>
        <Field label="Доза">{text('dose_amount', { inputMode: 'decimal' })}</Field>
        <Field label="Единица">
          <select value={f.dose_unit} onChange={(e) => set('dose_unit', e.target.value)}>
            {UNITS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="На что">
          <select value={f.dose_per} onChange={(e) => set('dose_per', e.target.value)}>
            {PER.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="В банке, шт.">{text('pack_count', { inputMode: 'numeric' })}</Field>
      </div>
      <div className="iherb-actions">
        <button type="submit" className="btn" disabled={m.isPending || !f.price_uzs.trim()}>
          {m.isPending ? 'Сохраняю…' : 'Сохранить цену'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Отмена
        </button>
      </div>
      {m.isError && <p className="text-bad">{errorText(m.error)}</p>}
    </form>
  );
}

export interface CostBarsData {
  /** D-39: the larger of the cost in the card and the dearest jar on hand; null — no stock cost */
  cost_uzs: number | null;
  /** the last iHerb price + delivery by weight; null — no iHerb snapshot yet */
  iherb_landed_uzs?: number | null;
  price_uzs: number;
  competitors: { platform: string; seller: string | null; price_uzs: number; observed_on: string }[];
}

/**
 * Bars: the stock cost and / or the iHerb landed cost (owner, 09.11: shown even with nothing in stock), our price, the
 * margin and the newest «1-в-1» price of every seller.
 */
export function CostBars({ d }: { d: CostBarsData }) {
  const bars: { key: string; label: string; value: number; cls: string; hint?: string }[] = [];
  if (d.cost_uzs != null) bars.push({ key: 'cost', label: 'Себестоимость склада', value: d.cost_uzs, cls: 'bar-cost' });
  if (d.iherb_landed_uzs != null) bars.push({ key: 'iherb', label: 'Закупка iHerb (с доставкой)', value: d.iherb_landed_uzs, cls: 'bar-iherb' });
  bars.push({ key: 'vitalo', label: 'VITALO', value: d.price_uzs, cls: 'bar-vitalo' });
  // the margin counts from the stock cost when there is one, otherwise from what buying on iHerb would cost now
  const base = d.cost_uzs ?? d.iherb_landed_uzs ?? null;
  if (base != null) bars.push({ key: 'margin', label: 'Маржа', value: Math.max(0, d.price_uzs - base), cls: 'bar-margin', hint: d.cost_uzs != null ? 'цена − себестоимость' : 'цена − закупка iHerb' });
  d.competitors.forEach((c, i) =>
    bars.push({ key: `c${i}`, label: c.seller ? `${c.seller} (${PLATFORM_LABELS[c.platform] ?? c.platform})` : (PLATFORM_LABELS[c.platform] ?? c.platform), value: c.price_uzs, cls: 'bar-market', hint: ruDate(c.observed_on) }),
  );
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="cost-bars" role="img" aria-label="Закупка, цена VITALO, маржа и цены конкурентов">
      {bars.map((b) => (
        <div key={b.key} className="cost-bar-row">
          <span className="cost-bar-label small">
            {b.label}
            {b.hint && <span className="muted"> · {b.hint}</span>}
          </span>
          <span className="cost-bar-track">
            <span className={`cost-bar ${b.cls}`} style={{ width: `${(b.value / max) * 100}%` }} />
          </span>
          <span className="cost-bar-value small">{money(b.value)}</span>
        </div>
      ))}
      {d.cost_uzs == null && d.iherb_landed_uzs == null && <p className="muted small">Закупка и маржа появятся после первой загрузки вишлиста iHerb или когда у товара будет себестоимость.</p>}
      {!d.competitors.length && <p className="muted small">Цен конкурентов «1-в-1» за этот период нет.</p>}
    </div>
  );
}
