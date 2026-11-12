import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt, Help } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { useSession } from '../lib/auth';
import { money } from '../lib/format';

export type Skin = 'none' | 'black_friday' | 'eleven_eleven' | 'sale';
type State = 'running' | 'scheduled' | 'ended' | 'disabled';
type Problem = 'bad_value' | 'no_discount' | 'too_big' | 'below_margin' | 'unknown_product' | 'not_active';

export interface Campaign {
  id: string;
  slug: string;
  title_ru: string;
  title_uz: string | null;
  skin: Skin;
  start_at: string;
  end_at: string | null;
  open_ended: boolean;
  active: boolean;
  notify_start: boolean;
  start_notified_at: string | null;
  state: State;
  products_count?: number;
  orders?: number;
  discount_total_uzs?: number;
}
interface Item {
  product_id: string;
  discount_pct: number | null;
  campaign_price_uzs: number | null;
}
export interface ItemCheck {
  product_id: string;
  sku: string;
  name: string;
  list_price_uzs: number;
  price_uzs: number;
  discount_pct: number;
  floor_uzs: number;
  max_pct: number;
  cost_known: boolean;
  problem: Problem | null;
  conflict: { id: string; title: string } | null;
}
interface CheckResult {
  guard: { min_markup_pct: number; max_discount_pct: number };
  items: ItemCheck[];
  ok: boolean;
  blocking: number;
}
interface PickerData {
  products: { id: string; sku: string; name: string; price_uzs: number; brand: string; brand_id: string | null; category_ids: string[]; in_stock: boolean }[];
  brands: { id: string; name_ru: string }[];
  categories: { id: string; name_ru: string; tree_type: string }[];
}

/** Skin names: the admin select and the badge (UZ in the shop: «Chegirma» for «Акция»). */
export const SKIN: Record<Skin, string> = { none: 'Без плашки', black_friday: 'Black Friday', eleven_eleven: '11.11', sale: 'Акция' };
export const STATE: Record<State, [string, 'ok' | 'info' | 'neutral' | 'warn']> = {
  running: ['Идёт', 'ok'],
  scheduled: ['Запланирована', 'info'],
  ended: ['Закончилась', 'neutral'],
  disabled: ['Выключена', 'neutral'],
};

/** What blocks the save, in plain words. */
export function problemText(c: ItemCheck, guardMaxPct: number): string | null {
  if (c.conflict) return `Уже в акции «${c.conflict.title}» в эти даты — один товар может быть только в одной акции`;
  switch (c.problem) {
    case 'bad_value':
      return 'Укажите скидку в % или акционную цену';
    case 'no_discount':
      return 'Акционная цена не ниже обычной';
    case 'too_big':
      return c.max_pct === 35 ? 'Скидка больше 35%' : 'Без даты окончания скидка — не больше 25%';
    case 'below_margin':
      return c.cost_known
        ? `Ниже границы маржи: не дешевле ${money(c.floor_uzs)}`
        : `Нет закупочной цены: скидка не больше ${guardMaxPct}% (не дешевле ${money(c.floor_uzs)})`;
    case 'unknown_product':
      return 'Товар не найден';
    case 'not_active':
      return 'Товар скрыт — в акции не продаётся';
    default:
      return null;
  }
}

/** Dates and times are Tashkent (UTC+5): the input shows local time, the API gets ISO. */
const TZ_MS = 5 * 3600_000;
export const toLocal = (iso: string) => new Date(new Date(iso).getTime() + TZ_MS).toISOString().slice(0, 16);
export const fromLocal = (v: string) => `${v}:00+05:00`;
export function periodLabel(c: Pick<Campaign, 'start_at' | 'end_at'>): string {
  const f = (iso: string) => toLocal(iso).replace(/^(\d{4})-(\d\d)-(\d\d)T/, '$3.$2.$1 ');
  return `${f(c.start_at)} — ${c.end_at ? f(c.end_at) : 'без даты окончания'}`;
}

/** Админка → Акции (3.7). Managers only look; admin and marketer create, change and switch on/off. Never deleted. */
export function Campaigns() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['campaigns'], queryFn: () => api<Campaign[]>('/staff/campaigns') });
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const manage = can('promo.manage');
  return (
    <>
      <PageHead title="Акции">
        {manage && (
          <button className="btn" onClick={() => setEditing('new')}>
            Новая акция
          </button>
        )}
      </PageHead>
      <Help id="campaigns">
        Акция включается и выключается сама по датам (время Ташкента); после окончания цены возвращаются. Скидка до 35% —
        только с датой окончания, без неё — до 25%. Цена не ниже границы маржи. Один товар — только в одной акции в одно
        время. Промокод не действует на товары со скидкой акции больше 15%.
      </Help>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="muted">Акций пока нет.</p>
      ) : (
        <div className="card flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Плашка</th>
                <th>Даты</th>
                <th>Статус</th>
                <th className="num">Товаров</th>
                <th className="num">Заказы / скидки</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id} className={c.state === 'disabled' || c.state === 'ended' ? 'muted' : ''}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setEditing(c)}>
                      {c.title_ru}
                    </button>
                    {c.title_uz && <div className="muted small">{c.title_uz}</div>}
                  </td>
                  <td>
                    <SkinBadge skin={c.skin} pct={null} />
                  </td>
                  <td className="small nowrap">{periodLabel(c)}</td>
                  <td>
                    <Badge tone={STATE[c.state][1]}>{STATE[c.state][0]}</Badge>
                    {c.notify_start && <div className="muted small">{c.start_notified_at ? 'о старте сообщили' : 'сообщим о старте'}</div>}
                  </td>
                  <td className="num">{c.products_count ?? 0}</td>
                  <td className="num nowrap">
                    {c.orders ?? 0}
                    <div className="muted small">{c.discount_total_uzs ? `−${money(c.discount_total_uzs)}` : '—'}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">«Заказы / скидки» — заказы с ценой акции (кроме отменённых и тестовых) и сумма скидок по акции в них.</p>
      {editing && <CampaignEditor key={editing === 'new' ? 'new' : editing.id} id={editing === 'new' ? null : editing.id} manage={manage} onClose={() => setEditing(null)} />}
    </>
  );
}

/** «−30% Black Friday» on the photo (the same look as in the Mini App). «Без плашки» — no badge. */
export function SkinBadge({ skin, pct }: { skin: Skin; pct: number | null }) {
  if (skin === 'none') return <span className="muted small">{SKIN.none}</span>;
  return (
    <span className={`skin-badge skin-${skin}`}>
      {pct != null && <b>−{pct}%</b>} {SKIN[skin]}
    </span>
  );
}

/** «Как будет выглядеть карточка»: one product in the grid, in the chosen skin. */
export function CardPreview({ skin, title, item }: { skin: Skin; title: string; item: ItemCheck | null }) {
  const list = item?.list_price_uzs ?? 125_000;
  const price = item && !item.problem ? item.price_uzs : Math.round(list * 0.8);
  const pct = item && !item.problem ? item.discount_pct : 20;
  return (
    <div className={`camp-preview skin-card-${skin}`} aria-label="Предпросмотр карточки">
      <div className="camp-preview-photo">
        {skin !== 'none' && (
          <span className={`skin-badge skin-${skin}`}>
            <b>−{pct}%</b> {SKIN[skin]}
          </span>
        )}
      </div>
      <div className="camp-preview-body">
        <div className="muted small">{title || 'Название акции'}</div>
        <div className="camp-preview-name">{item ? `${item.sku} ${item.name}` : 'Магний B6 Цитрат, 200 таб.'}</div>
        <div className="camp-preview-old">{money(list)}</div>
        <div className={`camp-preview-price skin-price-${skin}`}>{money(price)}</div>
      </div>
    </div>
  );
}

function CampaignEditor({ id, manage, onClose }: { id: string | null; manage: boolean; onClose: () => void }) {
  const loaded = useQuery({ queryKey: ['campaigns', id], enabled: !!id, queryFn: () => api<Campaign & { items: Item[]; checks: ItemCheck[] }>(`/staff/campaigns/${id}`) });
  if (id && loaded.isPending) return <Modal title="Акция" onClose={onClose}><Loading /></Modal>;
  if (id && loaded.isError) return <Modal title="Акция" onClose={onClose}><ErrorBox error={loaded.error} /></Modal>;
  return <CampaignForm campaign={loaded.data ?? null} manage={manage} onClose={onClose} />;
}

function CampaignForm({ campaign, manage, onClose }: { campaign: (Campaign & { items: Item[] }) | null; manage: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const now = toLocal(new Date().toISOString());
  const [f, setF] = useState({
    title_ru: campaign?.title_ru ?? '',
    title_uz: campaign?.title_uz ?? '',
    skin: campaign?.skin ?? ('sale' as Skin),
    start: campaign ? toLocal(campaign.start_at) : now,
    end: campaign?.end_at ? toLocal(campaign.end_at) : '',
    open_ended: campaign?.open_ended ?? false,
    active: campaign?.active ?? true,
    notify_start: campaign?.notify_start ?? false,
  });
  const [items, setItems] = useState<Item[]>(campaign?.items ?? []);
  const [defaultPct, setDefaultPct] = useState('20');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const picker = useQuery({ queryKey: ['campaigns', 'products'], queryFn: () => api<PickerData>('/staff/campaigns/products') });

  const body = () => ({
    title_ru: f.title_ru,
    title_uz: f.title_uz,
    skin: f.skin,
    start_at: f.start ? fromLocal(f.start) : new Date().toISOString(),
    end_at: f.open_ended || !f.end ? null : fromLocal(f.end),
    open_ended: f.open_ended,
    active: f.active,
    notify_start: f.notify_start,
    items,
  });

  // the rules while typing: the same check the save does (debounced)
  const [check, setCheck] = useState<CheckResult | null>(null);
  const key = JSON.stringify([f.start, f.end, f.open_ended, f.active, items]);
  useEffect(() => {
    if (!items.length || (!f.open_ended && !f.end)) {
      setCheck(null);
      return;
    }
    let stop = false;
    const t = setTimeout(() => {
      api<CheckResult>(campaign ? `/staff/campaigns/${campaign.id}/check` : '/staff/campaigns/check', { method: 'POST', body: { ...body(), title_ru: f.title_ru || 'Проверка' } })
        .then((r) => !stop && setCheck(r))
        .catch(() => !stop && setCheck(null));
    }, 350);
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const byId = useMemo(() => new Map((check?.items ?? []).map((c) => [c.product_id, c])), [check]);

  const products = picker.data?.products ?? [];
  const addMany = (ids: string[]) => {
    const pct = toInt(defaultPct) ?? 20;
    const fresh = ids.filter((pid) => !items.some((i) => i.product_id === pid));
    setItems([...items, ...fresh.map((product_id) => ({ product_id, discount_pct: pct, campaign_price_uzs: null }))]);
  };
  const flip = (pid: string) => (items.some((i) => i.product_id === pid) ? setItems(items.filter((i) => i.product_id !== pid)) : addMany([pid]));
  const update = (pid: string, patch: Partial<Item>) => setItems(items.map((i) => (i.product_id === pid ? { ...i, ...patch } : i)));

  const refresh = () => void client.invalidateQueries({ queryKey: ['campaigns'] });
  const save = useMutation({
    mutationFn: () => api(campaign ? `/staff/campaigns/${campaign.id}` : '/staff/campaigns', { method: campaign ? 'PUT' : 'POST', body: body() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.body.items)) setCheck({ guard: check?.guard ?? { min_markup_pct: 10, max_discount_pct: 20 }, items: e.body.items as ItemCheck[], ok: false, blocking: 1 });
    },
  });
  const toggle = useMutation({
    mutationFn: () => api(`/staff/campaigns/${campaign!.id}/status`, { method: 'POST', body: { active: !campaign!.active } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const found = products.filter((p) => !search || `${p.sku} ${p.name} ${p.brand}`.toLowerCase().includes(search.toLowerCase()));
  const guardMax = check?.guard.max_discount_pct ?? 20;
  const blocking = check ? check.items.filter((c) => (c.problem && c.problem !== 'not_active') || c.conflict).length : 0;
  const first = check?.items.find((c) => !c.problem && !c.conflict) ?? check?.items[0] ?? null;

  return (
    <Modal title={campaign ? `Акция «${campaign.title_ru}»` : 'Новая акция'} onClose={onClose} wide>
      <div className="camp-form">
        <div>
          <div className="grid-2">
            <Field label="Название (RU)">
              <input value={f.title_ru} maxLength={60} onChange={(e) => set('title_ru', e.target.value)} placeholder="Распродажа 11.11" />
            </Field>
            <Field label="Название (UZ)">
              <input value={f.title_uz} maxLength={60} onChange={(e) => set('title_uz', e.target.value)} placeholder="11.11 chegirmalari" />
            </Field>
            <Field label="Плашка (скин)">
              <select value={f.skin} onChange={(e) => set('skin', e.target.value as Skin)}>
                {(Object.keys(SKIN) as Skin[]).map((s) => (
                  <option key={s} value={s}>
                    {SKIN[s]}
                  </option>
                ))}
              </select>
            </Field>
            <div />
            <Field label="Начало (время Ташкента)">
              <input type="datetime-local" value={f.start} onChange={(e) => set('start', e.target.value)} />
            </Field>
            <Field label="Окончание (время Ташкента)" hint={f.open_ended ? 'Без даты окончания — скидка не больше 25% и без обратного отсчёта' : undefined}>
              <input type="datetime-local" value={f.end} disabled={f.open_ended} onChange={(e) => set('end', e.target.value)} />
            </Field>
          </div>
          <div className="check-col">
            <label className="check">
              <input type="checkbox" checked={f.open_ended} onChange={(e) => set('open_ended', e.target.checked)} />
              Без даты окончания
            </label>
            <label className="check">
              <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
              Включена
            </label>
            <label className="check">
              <input type="checkbox" checked={f.notify_start} disabled={!!campaign?.start_notified_at} onChange={(e) => set('notify_start', e.target.checked)} />
              Сообщить о старте акции {campaign?.start_notified_at ? '(уже сообщили)' : '(всем — в уведомления, в бот — тем, кто получает акции; не с 22:00 до 08:00)'}
            </label>
          </div>
        </div>
        <div>
          <div className="muted small">Предпросмотр в сетке</div>
          <CardPreview skin={f.skin} title={f.title_ru} item={first} />
        </div>
      </div>

      <fieldset className="picker">
        <legend>Товары ({items.length})</legend>
        <div className="row-gap camp-quick">
          <label className="small">
            Скидка для добавляемых, %{' '}
            <input className="input-xs" inputMode="numeric" value={defaultPct} onChange={(e) => setDefaultPct(e.target.value)} />
          </label>
          <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Бренд">
            <option value="">Бренд…</option>
            {picker.data?.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name_ru}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!brand} onClick={() => addMany(products.filter((p) => p.brand_id === brand).map((p) => p.id))}>
            Добавить бренд
          </button>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Категория">
            <option value="">Категория…</option>
            {picker.data?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_ru}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!category} onClick={() => addMany(products.filter((p) => p.category_ids.includes(category)).map((p) => p.id))}>
            Добавить категорию
          </button>
        </div>
        <input type="search" placeholder="Поиск: артикул, название или бренд" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="picker-list">
          {picker.isPending ? (
            <Loading />
          ) : (
            found.map((p) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={items.some((i) => i.product_id === p.id)} onChange={() => flip(p.id)} />
                {p.sku} · {p.name} · {money(p.price_uzs)}
                {!p.in_stock && <span className="muted small"> · нет в наличии</span>}
              </label>
            ))
          )}
        </div>
      </fieldset>

      {items.length > 0 && (
        <div className="table-scroll">
          <table className="table camp-items">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Обычная</th>
                <th>Скидка</th>
                <th className="num">В акции</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const p = products.find((x) => x.id === i.product_id);
                const c = byId.get(i.product_id);
                const why = c ? problemText(c, guardMax) : null;
                const byPrice = i.campaign_price_uzs != null;
                return (
                  <tr key={i.product_id} className={why && c?.problem !== 'not_active' ? 'row-bad' : ''}>
                    <td>
                      {p ? `${p.sku} ${p.name}` : (c?.name ?? i.product_id.slice(0, 8))}
                      {why && <div className={`small ${c?.problem === 'not_active' ? 'muted' : 'text-bad'}`}>{why}</div>}
                    </td>
                    <td className="num nowrap">{money(p?.price_uzs ?? c?.list_price_uzs)}</td>
                    <td className="nowrap">
                      <select
                        aria-label="Тип скидки"
                        value={byPrice ? 'price' : 'pct'}
                        onChange={(e) =>
                          update(i.product_id, e.target.value === 'price' ? { discount_pct: null, campaign_price_uzs: c?.price_uzs ?? p?.price_uzs ?? 0 } : { discount_pct: c?.discount_pct || 10, campaign_price_uzs: null })
                        }
                      >
                        <option value="pct">%</option>
                        <option value="price">Цена, сум</option>
                      </select>{' '}
                      <input
                        className={byPrice ? 'input-sm' : 'input-xs'}
                        inputMode="numeric"
                        aria-label={byPrice ? 'Акционная цена' : 'Скидка, %'}
                        value={String((byPrice ? i.campaign_price_uzs : i.discount_pct) ?? '')}
                        onChange={(e) => update(i.product_id, byPrice ? { campaign_price_uzs: toInt(e.target.value) ?? null } : { discount_pct: toInt(e.target.value) ?? null })}
                      />
                    </td>
                    <td className="num nowrap">
                      {c && !c.problem ? (
                        <>
                          {money(c.price_uzs)}
                          <div className="muted small">−{c.discount_pct}%</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" title="Убрать" onClick={() => setItems(items.filter((x) => x.product_id !== i.product_id))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {blocking > 0 && <p className="alert alert-error">Нельзя сохранить: исправьте товары, отмеченные красным ({blocking}).</p>}
      {save.isError && !(save.error instanceof ApiError && save.error.body.items) && <p className="alert alert-error">{errorText(save.error)}</p>}
      {toggle.isError && <p className="alert alert-error">{errorText(toggle.error)}</p>}
      <div className="modal-actions">
        {campaign && manage && (
          <button type="button" className="btn btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {campaign.active ? 'Выключить' : 'Включить'}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {manage ? 'Отмена' : 'Закрыть'}
        </button>
        {manage && (
          <button type="button" className="btn" disabled={save.isPending || blocking > 0 || !f.title_ru.trim() || !items.length || (!f.open_ended && !f.end)} onClick={() => save.mutate()}>
            Сохранить
          </button>
        )}
      </div>
    </Modal>
  );
}
