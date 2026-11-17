import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge, ErrorBox, Field, Help, Loading, Modal, PageHead, toInt } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { money } from '../lib/format';
import { ProductPicker } from './Purchases';

export interface BundleCheck {
  list_total_uzs: number;
  sale_total_uzs: number;
  cost_total_uzs: number | null;
  margin_pct: number | null;
  too_low: boolean;
  hidden_because: { product_id: string; sku: string; reason: 'inactive' | 'out_of_stock' }[];
  no_cost: string[];
}
interface BundleRow {
  id: string;
  slug: string;
  title_ru: string;
  title_uz: string | null;
  goal: string | null;
  discount_pct: number;
  is_active: boolean;
  sort_order: number;
  items: { product_id: string; qty: number }[];
  check: BundleCheck;
}
interface Item {
  product_id: string;
  qty: number;
  sku: string;
  name_ru: string;
}
interface BundleFull extends Omit<BundleRow, 'items'> {
  doctor_text_ru: string | null;
  doctor_text_uz: string | null;
  items: (Item & { status: string })[];
}

/** VITALO AI goals (the set shows on the home page under its goal later); empty — no goal. */
export const GOALS: [string, string][] = [
  ['', 'Без цели'],
  ['immunity', 'Иммунитет'],
  ['energy', 'Энергия'],
  ['sleep', 'Сон'],
  ['stress', 'Стресс'],
  ['joints', 'Суставы'],
  ['sport', 'Спорт'],
  ['skin_hair', 'Кожа и волосы'],
  ['heart', 'Сердце'],
  ['cognitive', 'Память и внимание'],
];
const MIN_MARGIN = 30;

/** «Маржа 44,4%» / «нет себестоимости». */
export function marginText(c: BundleCheck): string {
  return c.margin_pct == null ? 'нет себестоимости' : `${String(c.margin_pct).replace('.', ',')}%`;
}

/** Why the set is hidden in the Mini App now (a jar archived or out of stock), or null. */
export function hiddenText(c: BundleCheck): string | null {
  if (!c.hidden_because.length) return null;
  return `Скрыт в Mini App: ${c.hidden_because.map((h) => `${h.sku || 'товар'} — ${h.reason === 'inactive' ? 'скрыт или в архиве' : 'нет в наличии'}`).join(', ')}`;
}

/** Админка → Сеты (4.3, D-75): 2–3 товара, текст врача, скидка 0–10%, маржа после скидки не ниже 30%. Только админ. */
export function Bundles() {
  const q = useQuery({ queryKey: ['bundles'], queryFn: () => api<BundleRow[]>('/staff/bundles') });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <>
      <PageHead title="Сеты от врача">
        <button className="btn" onClick={() => setEditing('new')}>
          Новый сет
        </button>
      </PageHead>
      <Help id="bundles">
        Сет — 2–3 товара с текстом врача и своей скидкой (0–10%). Скидка действует в корзине, пока в ней лежат все товары
        сета. Маржа считается по себестоимости после скидки: ниже {MIN_MARGIN}% сет не сохранится. Если товара сета нет в
        наличии, сет сам скрывается в Mini App.
      </Help>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="muted">Сетов пока нет.</p>
      ) : (
        <div className="card flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Название</th>
                <th className="num">Товаров</th>
                <th className="num">Скидка</th>
                <th className="num">Цена сета</th>
                <th className="num">Маржа</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((b) => (
                <tr key={b.id} className={b.is_active ? '' : 'muted'}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setEditing(b.id)}>
                      {b.title_ru}
                    </button>
                    {b.title_uz && <div className="muted small">{b.title_uz}</div>}
                  </td>
                  <td className="num">{b.items.length}</td>
                  <td className="num">{b.discount_pct}%</td>
                  <td className="num nowrap">
                    {money(b.check.sale_total_uzs)}
                    <div className="muted small">без скидки {money(b.check.list_total_uzs)}</div>
                  </td>
                  <td className="num">{b.check.too_low ? <Badge tone="bad">{marginText(b.check)}</Badge> : marginText(b.check)}</td>
                  <td>
                    <Badge tone={!b.is_active ? 'neutral' : b.check.hidden_because.length ? 'warn' : 'ok'}>{!b.is_active ? 'Выключен' : b.check.hidden_because.length ? 'Скрыт' : 'Показан'}</Badge>
                    {b.is_active && hiddenText(b.check) && <div className="muted small">{hiddenText(b.check)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <BundleEditor key={editing} id={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function BundleEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const loaded = useQuery({ queryKey: ['bundles', id], enabled: !!id, queryFn: () => api<BundleFull>(`/staff/bundles/${id}`) });
  if (id && loaded.isPending) return <Modal title="Сет" onClose={onClose}><Loading /></Modal>;
  if (id && loaded.isError) return <Modal title="Сет" onClose={onClose}><ErrorBox error={loaded.error} /></Modal>;
  return <BundleForm bundle={loaded.data ?? null} onClose={onClose} />;
}

export function BundleForm({ bundle, onClose }: { bundle: BundleFull | null; onClose: () => void }) {
  const client = useQueryClient();
  const [f, setF] = useState({
    title_ru: bundle?.title_ru ?? '',
    title_uz: bundle?.title_uz ?? '',
    goal: bundle?.goal ?? '',
    doctor_text_ru: bundle?.doctor_text_ru ?? '',
    doctor_text_uz: bundle?.doctor_text_uz ?? '',
    discount_pct: String(bundle?.discount_pct ?? 7),
    sort_order: String(bundle?.sort_order ?? 0),
  });
  const [items, setItems] = useState<Item[]>(bundle?.items.map(({ product_id, qty, sku, name_ru }) => ({ product_id, qty, sku, name_ru })) ?? []);
  const set = <K extends keyof typeof f>(k: K, v: string) => setF({ ...f, [k]: v });
  const pct = toInt(f.discount_pct) ?? 0;
  const body = () => ({
    title_ru: f.title_ru,
    title_uz: f.title_uz,
    goal: f.goal,
    doctor_text_ru: f.doctor_text_ru,
    doctor_text_uz: f.doctor_text_uz,
    discount_pct: pct,
    sort_order: toInt(f.sort_order) ?? 0,
    items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
  });

  // the price and the margin while typing (the same check the save does)
  const [check, setCheck] = useState<BundleCheck | null>(bundle?.check ?? null);
  const key = JSON.stringify([pct, items.map((i) => [i.product_id, i.qty])]);
  useEffect(() => {
    if (items.length < 2 || pct < 0 || pct > 10) {
      setCheck(null);
      return;
    }
    let stop = false;
    const t = setTimeout(() => {
      api<BundleCheck>('/staff/bundles/check', { method: 'POST', body: { ...body(), title_ru: f.title_ru || 'Проверка' } })
        .then((r) => !stop && setCheck(r))
        .catch(() => !stop && setCheck(null));
    }, 300);
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = () => void client.invalidateQueries({ queryKey: ['bundles'] });
  const save = useMutation({
    mutationFn: () => api(bundle ? `/staff/bundles/${bundle.id}` : '/staff/bundles', { method: bundle ? 'PUT' : 'POST', body: body() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const toggle = useMutation({
    mutationFn: () => api(`/staff/bundles/${bundle!.id}/status`, { method: 'POST', body: { active: !bundle!.is_active } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const countOk = items.length >= 2 && items.length <= 3;
  const pctOk = pct >= 0 && pct <= 10;
  const blocked = !f.title_ru.trim() || !countOk || !pctOk || !check || check.too_low;
  const saveError = save.error instanceof ApiError && (save.error.body.code === 'BUNDLE_MARGIN_LOW' || save.error.body.code === 'BUNDLE_NO_COST') ? null : save.error;

  return (
    <Modal title={bundle ? `Сет «${bundle.title_ru}»` : 'Новый сет'} onClose={onClose} wide>
      <div className="grid-2">
        <Field label="Название (RU)">
          <input value={f.title_ru} maxLength={80} onChange={(e) => set('title_ru', e.target.value)} placeholder="Крепкий иммунитет зимой" />
        </Field>
        <Field label="Название (UZ)">
          <input value={f.title_uz} maxLength={80} onChange={(e) => set('title_uz', e.target.value)} placeholder="Qishda kuchli immunitet" />
        </Field>
        <Field label="Цель">
          <select value={f.goal} onChange={(e) => set('goal', e.target.value)}>
            {GOALS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Скидка, %" hint="0–10%">
            <input inputMode="numeric" value={f.discount_pct} onChange={(e) => set('discount_pct', e.target.value)} aria-invalid={!pctOk} />
          </Field>
          <Field label="Порядок" hint="меньше — выше на главной">
            <input inputMode="numeric" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="Текст врача (RU)" hint="почему эти товары вместе и как принимать">
        <textarea rows={3} maxLength={1500} value={f.doctor_text_ru} onChange={(e) => set('doctor_text_ru', e.target.value)} />
      </Field>
      <Field label="Текст врача (UZ)">
        <textarea rows={3} maxLength={1500} value={f.doctor_text_uz} onChange={(e) => set('doctor_text_uz', e.target.value)} />
      </Field>

      <h3>Товары сета (2–3)</h3>
      {items.map((i) => (
        <div key={i.product_id} className="bundle-item">
          <span className="bundle-grow">
            <b>{i.sku}</b> {i.name_ru}
          </span>
          <label className="bundle-qty small">
            банок
            <input className="bundle-qty-input" inputMode="numeric" value={i.qty} onChange={(e) => setItems(items.map((x) => (x.product_id === i.product_id ? { ...x, qty: Math.min(5, Math.max(1, toInt(e.target.value) ?? 1)) } : x)))} />
          </label>
          <button type="button" className="btn ghost small" onClick={() => setItems(items.filter((x) => x.product_id !== i.product_id))}>
            Убрать
          </button>
        </div>
      ))}
      {items.length < 3 && <ProductPicker exclude={items.map((i) => i.product_id)} onPick={(p) => setItems([...items, { product_id: p.id, qty: 1, sku: p.sku, name_ru: p.name_ru }])} />}

      <div className="card pad bundle-summary" aria-live="polite">
        {!countOk ? (
          <p className="muted">Добавьте 2–3 товара — покажем цену и маржу.</p>
        ) : !check ? (
          <Loading />
        ) : (
          <>
            <div className="bundle-line">
              <span>Без скидки</span>
              <span>{money(check.list_total_uzs)}</span>
            </div>
            <div className="bundle-line">
              <span>Со скидкой {pct}%</span>
              <b>{money(check.sale_total_uzs)}</b>
            </div>
            <div className="bundle-line">
              <span>Себестоимость</span>
              <span>{check.cost_total_uzs == null ? '—' : money(check.cost_total_uzs)}</span>
            </div>
            <div className="bundle-line">
              <span>Маржа после скидки</span>
              {check.too_low ? <Badge tone="bad">{marginText(check)}</Badge> : <Badge tone="ok">{marginText(check)}</Badge>}
            </div>
            {check.margin_pct != null && check.too_low && <p className="bundle-error">Маржа ниже {MIN_MARGIN}% — уменьшите скидку или выберите другие товары. Сохранить нельзя.</p>}
            {check.no_cost.length > 0 && <p className="bundle-error">Нет себестоимости: {check.no_cost.join(', ')}. Без неё маржу не посчитать — сохранить нельзя.</p>}
            {hiddenText(check) && <p className="muted small">{hiddenText(check)}</p>}
          </>
        )}
      </div>

      {saveError && <p className="bundle-error">{errorText(saveError)}</p>}
      <div className="bundle-actions">
        {bundle && (
          <button type="button" className="btn ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {bundle.is_active ? 'Выключить' : 'Включить'}
          </button>
        )}
        <button type="button" className="btn" disabled={blocked || save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}

