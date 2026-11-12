import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt, Help } from '../components/ui';
import { api, errorText, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { money, ruDate } from '../lib/format';

type PromoType = 'percent' | 'fixed' | 'free_delivery';
type Scope = 'order' | 'brand' | 'product';
type State = 'active' | 'scheduled' | 'expired' | 'exhausted' | 'disabled';

export interface PromoCode {
  id: string;
  code: string;
  type: PromoType;
  value: number;
  scope: Scope;
  product_ids: string[];
  brand_ids: string[];
  targets_label: string;
  min_order_uzs: number | null;
  first_order_only: boolean;
  global_limit: number | null;
  per_customer_limit: number;
  start_at: string;
  end_at: string;
  active: boolean;
  description_ru: string | null;
  description_uz: string | null;
  state: State;
  used: number;
  used_paid: number;
  discount_total_uzs: number;
  revenue_uzs: number;
}
interface Guard {
  min_markup_pct: number;
  max_discount_pct: number;
}
interface MarginItem {
  product_id: string;
  sku: string;
  name: string;
  wanted_uzs: number;
  allowed_uzs: number;
  reason: 'margin' | 'no_cost' | 'product_discount';
}
interface MarginCheck {
  guard: Guard;
  products_checked: number;
  items: MarginItem[];
}

export const STATE: Record<State, [string, 'ok' | 'info' | 'neutral' | 'warn']> = {
  active: ['Действует', 'ok'],
  scheduled: ['Запланирован', 'info'],
  expired: ['Закончился', 'neutral'],
  exhausted: ['Лимит исчерпан', 'warn'],
  disabled: ['Выключен', 'neutral'],
};

/** «−10%», «−20 000 сум», «Бесплатная доставка». */
export function typeLabel(p: Pick<PromoCode, 'type' | 'value'>): string {
  return p.type === 'percent' ? `−${p.value}%` : p.type === 'fixed' ? `−${money(p.value)}` : 'Бесплатная доставка';
}

/** One line of conditions for the table. */
export function conditionsLabel(p: PromoCode): string {
  const parts = [p.scope === 'order' ? 'Вся корзина' : `${p.scope === 'brand' ? 'Бренды' : 'Товары'}: ${p.targets_label || '—'}`];
  if (p.min_order_uzs) parts.push(`от ${money(p.min_order_uzs)}`);
  if (p.first_order_only) parts.push('только первый заказ');
  parts.push(`${p.per_customer_limit} на клиента`);
  return parts.join(' · ');
}

/** «01.11 — 30.11.2026»; the year twice only when it differs. */
export function datesLabel(p: Pick<PromoCode, 'start_at' | 'end_at'>): string {
  const [a, b] = [ruDate(toDay(p.start_at)), ruDate(toDay(p.end_at))];
  return a.slice(6) === b.slice(6) ? `${a.slice(0, 5)} — ${b}` : `${a} — ${b}`;
}

const REASON: Record<MarginItem['reason'], string> = {
  margin: 'скидку урежет защита маржи',
  no_cost: 'нет закупочной цены — скидка не больше лимита',
  product_discount: 'видимая скидка товара больше 15% — код не действует',
};

/** Dates are days in Tashkent (UTC+5): from the start of the first day to the end of the last one. */
const TZ_MS = 5 * 3600_000;
const toDay = (iso: string) => new Date(new Date(iso).getTime() + TZ_MS).toISOString().slice(0, 10);
const today = () => toDay(new Date().toISOString());

/** Админка → Промокоды (3.3). Managers only look; admin and marketer create, change and switch off. Never deleted. */
export function PromoCodes() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['promo-codes'], queryFn: () => api<PromoCode[]>('/staff/promo-codes') });
  const guard = useQuery({ queryKey: ['promo-codes', 'guard'], queryFn: () => api<Guard>('/staff/promo-codes/settings') });
  const [editing, setEditing] = useState<PromoCode | 'new' | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  const manage = can('promo.manage');

  return (
    <>
      <PageHead title="Промокоды">
        {manage && (
          <button className="btn" onClick={() => setEditing('new')}>
            Новый промокод
          </button>
        )}
      </PageHead>
      {/* аудит 4.4: the numbers, not «…» — an error loading them is said plainly */}
      <Help id="promo-codes">
        Один промокод на заказ. Код не действует на товары с видимой скидкой больше 15%. Защита маржи: цена строки после
        скидки не ниже закупки + {guard.data ? guard.data.min_markup_pct : guard.isError ? '?' : '…'}%, а без закупочной цены скидка не больше{' '}
        {guard.data ? guard.data.max_discount_pct : guard.isError ? '?' : '…'}%.{' '}
        {guard.isError && <span className="text-bad">Не удалось загрузить настройки защиты маржи. </span>}
        {can('settings.manage') && (
          <button className="btn btn-ghost btn-sm" onClick={() => setGuardOpen(true)}>
            Изменить защиту маржи
          </button>
        )}
      </Help>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="muted">Промокодов пока нет.</p>
      ) : (
        <div className="card flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Скидка</th>
                <th>Условия</th>
                <th>Даты</th>
                <th>Статус</th>
                <th className="num">Использован</th>
                <th className="num">Скидки / выручка</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.id} className={p.state === 'disabled' ? 'muted' : ''}>
                  <td>
                    {/* the code itself opens editing (keeps the table narrow enough for 1280 px) */}
                    {manage ? (
                      <button type="button" className="id-chip promo-code-btn" title="Изменить" onClick={() => setEditing(p)}>
                        {p.code}
                      </button>
                    ) : (
                      <span className="id-chip">{p.code}</span>
                    )}
                    {p.description_ru && <div className="muted small">{p.description_ru}</div>}
                  </td>
                  <td>{typeLabel(p)}</td>
                  <td className="small promo-cond">{conditionsLabel(p)}</td>
                  <td className="small nowrap">{datesLabel(p)}</td>
                  <td>
                    <Badge tone={STATE[p.state][1]}>{STATE[p.state][0]}</Badge>
                  </td>
                  <td className="num">
                    {p.used} / {p.global_limit ?? '∞'}
                    <div className="muted small">оплачено {p.used_paid}</div>
                  </td>
                  <td className="num nowrap">
                    {p.discount_total_uzs ? `−${money(p.discount_total_uzs)}` : '—'}
                    <div className="muted small">{money(p.revenue_uzs)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        «Использован» — заказы, которые держат код (ещё не оплачены или оплачены); отменённый заказ возвращает активацию.
        «Скидки / выручка»: сумма скидок и, ниже, сумма оплаченных заказов с кодом. Тестовые заказы не считаются.
      </p>
      {editing && <PromoEditor key={editing === 'new' ? 'new' : editing.id} promo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {guardOpen && guard.data && <GuardEditor guard={guard.data} onClose={() => setGuardOpen(false)} />}
    </>
  );
}

function PromoEditor({ promo, onClose }: { promo: PromoCode | null; onClose: () => void }) {
  const client = useQueryClient();
  const [f, setF] = useState({
    code: promo?.code ?? '',
    type: promo?.type ?? ('percent' as PromoType),
    value: promo ? String(promo.value) : '10',
    scope: promo?.scope ?? ('order' as Scope),
    product_ids: promo?.product_ids ?? [],
    brand_ids: promo?.brand_ids ?? [],
    min_order_uzs: promo?.min_order_uzs ? String(promo.min_order_uzs) : '',
    first_order_only: promo?.first_order_only ?? false,
    global_limit: promo?.global_limit ? String(promo.global_limit) : '',
    per_customer_limit: String(promo?.per_customer_limit ?? 1),
    start: promo ? toDay(promo.start_at) : today(),
    end: promo ? toDay(promo.end_at) : '',
    active: promo?.active ?? true,
    description_ru: promo?.description_ru ?? '',
    description_uz: promo?.description_uz ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setF({ ...f, [k]: v });
    setChecked(null);
  };
  // Margin warning: checked before saving; with warnings the button becomes «Сохранить всё равно».
  const [checked, setChecked] = useState<MarginCheck | null>(null);

  const body = () => ({
    code: f.code,
    type: f.type,
    value: f.type === 'free_delivery' ? 0 : (toInt(f.value) ?? 0),
    scope: f.scope,
    product_ids: f.scope === 'product' ? f.product_ids : [],
    brand_ids: f.scope === 'brand' ? f.brand_ids : [],
    min_order_uzs: toInt(f.min_order_uzs) ?? null,
    first_order_only: f.first_order_only,
    global_limit: toInt(f.global_limit) ?? null,
    per_customer_limit: toInt(f.per_customer_limit) ?? 1,
    start_at: `${f.start}T00:00:00+05:00`,
    end_at: `${f.end}T23:59:59+05:00`,
    active: f.active,
    description_ru: f.description_ru,
    description_uz: f.description_uz,
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['promo-codes'] });

  const generate = useMutation({ mutationFn: () => api<{ code: string }>('/staff/promo-codes/generate'), onSuccess: (r) => set('code', r.code) });
  const save = useMutation({
    mutationFn: async () => {
      if (!checked && f.type !== 'free_delivery') {
        const m = await api<MarginCheck>('/staff/promo-codes/margin-check', { method: 'POST', body: body() });
        if (m.items.length) {
          setChecked(m);
          return false;
        }
      }
      await api(promo ? `/staff/promo-codes/${promo.id}` : '/staff/promo-codes', { method: promo ? 'PUT' : 'POST', body: body() });
      return true;
    },
    onSuccess: (done) => {
      if (!done) return;
      refresh();
      onClose();
    },
  });
  const toggle = useMutation({
    mutationFn: () => api(`/staff/promo-codes/${promo!.id}/status`, { method: 'POST', body: { active: !promo!.active } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const used = (promo?.used ?? 0) > 0;
  return (
    <Modal title={promo ? `Промокод ${promo.code}` : 'Новый промокод'} onClose={onClose} wide>
      <div className="grid-2">
        <Field label="Код" hint={used ? 'Код уже использовали в заказах — текст менять нельзя' : 'Латиница и цифры, 3–32 знака. Регистр не важен'}>
          <div className="row-gap">
            <input value={f.code} disabled={used} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="VITALO10" />
            {!used && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
                Сгенерировать код
              </button>
            )}
          </div>
        </Field>
        <Field label="Тип скидки">
          <select value={f.type} onChange={(e) => set('type', e.target.value as PromoType)}>
            <option value="percent">Процент</option>
            <option value="fixed">Сумма, сум</option>
            <option value="free_delivery">Бесплатная доставка</option>
          </select>
        </Field>
        {f.type !== 'free_delivery' && (
          <Field label={f.type === 'percent' ? 'Скидка, %' : 'Скидка, сум'} hint="Скидка округляется вниз до 100 сум">
            <input inputMode="numeric" value={f.value} onChange={(e) => set('value', e.target.value)} />
          </Field>
        )}
        <Field label="На что действует">
          <select value={f.scope} onChange={(e) => set('scope', e.target.value as Scope)}>
            <option value="order">Вся корзина</option>
            <option value="brand">Бренды</option>
            <option value="product">Товары</option>
          </select>
        </Field>
      </div>
      {f.scope === 'brand' && <BrandPicker value={f.brand_ids} onChange={(v) => set('brand_ids', v)} />}
      {f.scope === 'product' && <ProductPicker value={f.product_ids} onChange={(v) => set('product_ids', v)} />}

      <div className="grid-2">
        <Field label="Минимальная сумма заказа, сум" hint="Сумма товаров до скидки. Пусто — без условия">
          <input inputMode="numeric" value={f.min_order_uzs} onChange={(e) => set('min_order_uzs', e.target.value)} />
        </Field>
        <Field label="Лимит активаций всего" hint="Пусто — без лимита">
          <input inputMode="numeric" value={f.global_limit} onChange={(e) => set('global_limit', e.target.value)} />
        </Field>
        <Field label="Лимит на одного клиента">
          <input inputMode="numeric" value={f.per_customer_limit} onChange={(e) => set('per_customer_limit', e.target.value)} />
        </Field>
        <div />
        <Field label="Действует с">
          <input type="date" value={f.start} onChange={(e) => set('start', e.target.value)} />
        </Field>
        <Field label="Действует по (включительно)">
          <input type="date" value={f.end} onChange={(e) => set('end', e.target.value)} />
        </Field>
        <Field label="Описание для клиента (RU)" hint="Показывается под применённым кодом">
          <input value={f.description_ru} maxLength={300} onChange={(e) => set('description_ru', e.target.value)} />
        </Field>
        <Field label="Описание для клиента (UZ)">
          <input value={f.description_uz} maxLength={300} onChange={(e) => set('description_uz', e.target.value)} />
        </Field>
      </div>
      <div className="check-col">
        <label className="check">
          <input type="checkbox" checked={f.first_order_only} onChange={(e) => set('first_order_only', e.target.checked)} />
          Только на первый заказ (у клиента нет заказов, кроме отменённых)
        </label>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
          Включён
        </label>
      </div>

      {checked && (
        <div className="alert alert-warn promo-margin">
          <strong>Защита маржи: скидка будет меньше на {checked.items.length} из {checked.products_checked} товаров</strong>
          <ul className="small">
            {checked.items.slice(0, 15).map((i) => (
              <li key={i.product_id}>
                {i.sku} {i.name}: {REASON[i.reason]}
                {i.reason !== 'product_discount' && ` (−${money(i.allowed_uzs)} вместо −${money(i.wanted_uzs)} за штуку)`}
              </li>
            ))}
            {checked.items.length > 15 && <li>и ещё {checked.items.length - 15}</li>}
          </ul>
        </div>
      )}
      {save.isError && <p className="alert alert-error">{errorText(save.error)}</p>}
      {toggle.isError && <p className="alert alert-error">{errorText(toggle.error)}</p>}
      <div className="modal-actions">
        {promo && (
          <button type="button" className="btn btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {promo.active ? 'Выключить' : 'Включить'}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn" disabled={save.isPending || !f.code || !f.start || !f.end} onClick={() => save.mutate()}>
          {checked ? 'Сохранить всё равно' : 'Сохранить'}
        </button>
      </div>
    </Modal>
  );
}

function BrandPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const q = useQuery({ queryKey: ['brands', 'admin'], queryFn: () => api<{ items: { id: string; name_ru: string; status: string }[] }>('/staff/brands') });
  const flip = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <fieldset className="picker">
      <legend>Бренды ({value.length})</legend>
      {q.isPending ? (
        <Loading />
      ) : (
        <div className="picker-list">
          {q.data?.items
            .filter((b) => b.status === 'active' || value.includes(b.id))
            .map((b) => (
              <label key={b.id} className="check">
                <input type="checkbox" checked={value.includes(b.id)} onChange={() => flip(b.id)} />
                {b.name_ru}
              </label>
            ))}
        </div>
      )}
    </fieldset>
  );
}

interface ProductOption {
  id: string;
  sku: string;
  name_ru: string;
}

function ProductPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [search, setSearch] = useState('');
  // Names of chosen products are kept here so the chips stay readable while the search changes.
  const [known, setKnown] = useState<Record<string, ProductOption>>({});
  const all = useQuery({
    queryKey: ['promo-products', search],
    queryFn: () => api<{ items: ProductOption[] }>(`/staff/products${qs({ q: search || undefined, status: 'active', page: 1 })}`),
  });
  const chosen = useQuery({
    queryKey: ['promo-products', 'chosen', value.filter((id) => !known[id]).join(',')],
    enabled: value.some((id) => !known[id]),
    queryFn: async () => {
      // Editing an existing code: names of the products it already has (the list is paged, so look them up by id).
      const found = await Promise.all(value.filter((id) => !known[id]).map((id) => api<ProductOption>(`/staff/products/${id}`).catch(() => null)));
      setKnown((k) => ({ ...k, ...Object.fromEntries(found.filter((p): p is ProductOption => !!p).map((p) => [p.id, p])) }));
      return true;
    },
  });
  const flip = (p: ProductOption) => {
    setKnown((k) => ({ ...k, [p.id]: p }));
    onChange(value.includes(p.id) ? value.filter((x) => x !== p.id) : [...value, p.id]);
  };
  return (
    <fieldset className="picker">
      <legend>Товары ({value.length})</legend>
      <div className="picker-chips">
        {value.map((id) => (
          <button key={id} type="button" className="id-chip" title="Убрать" onClick={() => onChange(value.filter((x) => x !== id))}>
            {known[id] ? `${known[id].sku} ${known[id].name_ru}` : chosen.isPending ? '…' : id.slice(0, 8)} ✕
          </button>
        ))}
      </div>
      <input type="search" placeholder="Поиск: артикул или название" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="picker-list">
        {all.data?.items.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={value.includes(p.id)} onChange={() => flip(p)} />
            {p.sku} · {p.name_ru}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function GuardEditor({ guard, onClose }: { guard: Guard; onClose: () => void }) {
  const client = useQueryClient();
  const [markup, setMarkup] = useState(String(guard.min_markup_pct));
  const [max, setMax] = useState(String(guard.max_discount_pct));
  const save = useMutation({
    mutationFn: () => api('/staff/promo-codes/settings', { method: 'PUT', body: { min_markup_pct: toInt(markup) ?? 0, max_discount_pct: toInt(max) ?? 0 } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['promo-codes', 'guard'] });
      onClose();
    },
  });
  return (
    <Modal title="Защита маржи" onClose={onClose}>
      <Field label="Минимальная наценка над закупкой, %" hint="Цена строки после скидки промокода не опустится ниже закупочной цены + этот процент">
        <input inputMode="numeric" value={markup} onChange={(e) => setMarkup(e.target.value)} />
      </Field>
      <Field label="Скидка без закупочной цены — не больше, %" hint="Для товаров, у которых закупочная цена не заполнена">
        <input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
      </Field>
      {save.isError && <p className="alert alert-error">{errorText(save.error)}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
