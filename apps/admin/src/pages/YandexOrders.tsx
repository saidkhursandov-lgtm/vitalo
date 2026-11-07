import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { REASONS, ReasonPicker } from '../components/Reason';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Pagination } from '../components/ui';
import { api, ApiError, newKey, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { AUDIT_ACTION, dateTime, money, ruDate, UNIT_STATUS, YANDEX_STATUS } from '../lib/format';
import { ProductPicker } from './Purchases';
import { OrderFinance, TestBadge } from '../components/OrderFinance';
import { ChannelTabs } from '../components/ChannelTabs';

/**
 * Stage 2C «Заказы Яндекса»: warehouse and admin work with the orders, the manager only views them (no buttons). Units are reserved by FEFO when the order is created; at
 * assembly every Physical ID is typed or scanned; the buttons follow the status. Commission, unit costs and
 * profit come from the server only for the admin, so the screens show them only when they are there.
 */

interface ListRow {
  id: string;
  external_number: string;
  order_date: string;
  customer_name: string | null;
  status: string;
  qty: number;
  picked: number;
  skus: string[];
  total_uzs: number;
  is_test?: boolean;
  ship_by?: ShipByValue | null;
}

interface OrderUnit {
  assignment_id: string;
  unit_id: string;
  physical_id: string;
  expiry_date: string;
  status: string;
  picked: boolean;
  fefo_override: string | null;
  actual_cost_uzs?: number;
}

interface Order {
  id: string;
  external_number: string;
  order_date: string;
  customer_name: string | null;
  status: string;
  note: string | null;
  cancel_reason: string | null;
  created_by_name: string | null;
  created_at: string;
  total_uzs: number;
  lines: { id: string; product: { id: string; sku: string; name_ru: string }; qty: number; unit_price_uzs: number; units: OrderUnit[]; picked: number }[];
  released: { physical_id: string; status: string; released_at: string; reason: string | null; return_decision: string | null }[];
  history: { action: string; at: string; staff_name: string | null; details: Record<string, unknown> | null }[];
  source?: 'manual' | 'yandex_api';
  ship_by?: ShipByValue | null;
  stock_shortage?: boolean;
  yandex?: { status: string; substatus: string | null; campaign_id: number | null; updated_at: string | null } | null;
  is_test?: boolean;
  /** Stage 3: only for the admin (comes with the money block) */
  own_delivery_cost_uzs?: number;
  commission_percent?: number;
  money?: { revenue_uzs: number; commission_uzs: number; cost_uzs: number; profit_uzs: number } | null;
  message?: string;
}

interface ShipByValue {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
}

/** «Отгрузить до» from Yandex. While the order is not handed over yet: red when the day has passed, yellow on the day. */
export function ShipBy({ value, status, today: now = today() }: { value: ShipByValue | null | undefined; status: string; today?: string }) {
  if (!value) return <span className="muted">—</span>;
  const text = `${ruDate(value.date)}${value.time ? ` ${value.time}` : ''}`;
  const open = status === 'NEW' || status === 'ASSEMBLED';
  if (open && value.date < now) return <Badge tone="bad">{text} — просрочено</Badge>;
  if (open && value.date === now) return <Badge tone="warn">{text} — сегодня</Badge>;
  return <>{text}</>;
}

const StatusBadge = ({ status }: { status: string }) => {
  const [label, tone] = YANDEX_STATUS[status] ?? [status, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
};

const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10); // Tashkent

// ====================================================================== list

export function YandexOrders() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const f = { status: params.get('status') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '', q: params.get('q') ?? '', hide_test: params.get('hide_test') ?? '' };
  const [text, setText] = useState(f.q);
  const list = useQuery({
    queryKey: ['yandex-orders', f, page],
    queryFn: () => api<{ items: ListRow[]; total: number; total_pages: number }>(`/staff/yandex-orders${qs({ ...f, page })}`),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHead title="Заказы Яндекса">
        <ChannelTabs current="yandex" />
        {can('yandex.orders') && (
          <Link className="btn" to="/yandex-orders/new">
            Новый заказ
          </Link>
        )}
      </PageHead>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', text.trim());
        }}
      >
        <input placeholder="Номер заказа Яндекса — Enter" value={text} onChange={(e) => setText(e.target.value)} />
        <select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Статус">
          <option value="">Все статусы</option>
          {Object.entries(YANDEX_STATUS).map(([v, [l]]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <label className="muted small">
          с <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="Дата с" />
        </label>
        <label className="muted small">
          по <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="Дата по" />
        </label>
        <label className="check">
          <input type="checkbox" checked={f.hide_test === 'true'} onChange={(e) => set('hide_test', e.target.checked ? 'true' : '')} />
          Скрыть тестовые
        </label>
      </form>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <p className="muted">Заказов нет. Новый заказ: кнопка «Новый заказ» — банки зарезервируются сразу.</p>
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>№ Яндекса</th>
                <th>Дата</th>
                <th>Статус</th>
                <th>Отгрузить до</th>
                <th>Товары</th>
                <th className="num">Банок</th>
                <th className="num">Собрано</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/yandex-orders/${o.id}`}>{o.external_number}</Link> <TestBadge show={o.is_test} />
                    {o.customer_name && <div className="muted small">{o.customer_name}</div>}
                  </td>
                  <td>{ruDate(o.order_date)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>
                    <ShipBy value={o.ship_by} status={o.status} />
                  </td>
                  <td className="small">{o.skus.join(', ')}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num">{o.status === 'NEW' ? `${o.picked} из ${o.qty}` : '—'}</td>
                  <td className="num">{money(o.total_uzs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Заказов: {list.data.total}</span>
            <Pagination page={page} totalPages={list.data.total_pages} onPage={(p) => set('page', String(p))} />
          </div>
        </section>
      )}
    </>
  );
}

// ====================================================================== new

interface DraftLine {
  product: { id: string; sku: string; name_ru: string };
  qty: string;
  price: string;
}

export function YandexOrderNew() {
  const { can } = useSession();
  const moneyAllowed = can('yandex.orders.money');
  const navigate = useNavigate();
  const [key] = useState(newKey); // one key per form: a double click never creates two orders
  const [form, setForm] = useState({ external_number: '', order_date: today(), customer_name: '', note: '', commission: '18.5' });
  const [lines, setLines] = useState<DraftLine[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api<Order>('/staff/yandex-orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: {
          external_number: form.external_number.trim(),
          order_date: form.order_date,
          customer_name: form.customer_name.trim() || null,
          note: form.note.trim() || null,
          ...(moneyAllowed && form.commission.trim() && { commission_percent: Number(form.commission.replace(',', '.')) }),
          lines: lines.map((l) => ({ product_id: l.product.id, qty: Number(l.qty), unit_price_uzs: Number(l.price.replace(/\s/g, '')) })),
        },
      }),
    onSuccess: (o) => navigate(`/yandex-orders/${o.id}`, { replace: true }),
  });
  const edit = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  /** A picked product comes with the Yandex price of its card (S2C-12), editable before saving. */
  const addLine = async (p: DraftLine['product']) => {
    setLines((cur) => [...cur, { product: p, qty: '1', price: '' }]);
    try {
      const [hint] = await api<{ product_id: string; yandex_price_uzs: number | null }[]>(`/staff/yandex-orders/price-hints${qs({ product_ids: p.id })}`);
      if (hint?.yandex_price_uzs !== null && hint?.yandex_price_uzs !== undefined) {
        const price = String(hint.yandex_price_uzs);
        setLines((cur) => cur.map((l) => (l.product.id === p.id && l.price === '' ? { ...l, price } : l)));
      }
    } catch {
      /* no hint: the price is typed by hand */
    }
  };
  const valid = form.external_number.trim() && form.order_date && lines.length > 0 && lines.every((l) => Number(l.qty) >= 1 && l.price.trim() !== '' && Number(l.price.replace(/\s/g, '')) >= 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit}>
      <PageHead title="Новый заказ Яндекса">
        <Link className="btn btn-ghost" to="/yandex-orders">
          Назад
        </Link>
      </PageHead>
      <section className="card narrow">
        <div className="form-grid">
          <Field label="Номер заказа Яндекса">
            <input value={form.external_number} onChange={(e) => setForm({ ...form, external_number: e.target.value })} maxLength={64} required autoFocus />
          </Field>
          <Field label="Дата заказа">
            <input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} required />
          </Field>
          <Field label="Покупатель (необязательно)">
            <input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} maxLength={200} />
          </Field>
          {moneyAllowed && (
            <Field label="Комиссия Яндекса, %" hint="По умолчанию 18.5">
              <input inputMode="decimal" value={form.commission} onChange={(e) => setForm({ ...form, commission: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Примечание (необязательно)">
          <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={1000} />
        </Field>
      </section>
      <section className="card narrow">
        <h2>Позиции</h2>
        <p className="muted small">Банки резервируются сразу при сохранении: самые ранние сроки годности первыми (FEFO).</p>
        {lines.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Кол-во</th>
                <th className="num">Цена за шт., сум</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.product.id}>
                  <td>
                    <strong>{l.product.sku}</strong>
                    <div className="muted small">{l.product.name_ru}</div>
                  </td>
                  <td className="num">
                    <input type="number" min={1} max={50} value={l.qty} onChange={(e) => edit(i, { qty: e.target.value })} style={{ width: 70 }} aria-label="Количество" />
                  </td>
                  <td className="num">
                    <input inputMode="numeric" value={l.price} onChange={(e) => edit(i, { price: e.target.value })} style={{ width: 120 }} aria-label="Цена за штуку" placeholder="0" />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))}>
                      Убрать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ProductPicker exclude={lines.map((l) => l.product.id)} onPick={(p) => void addLine(p)} />
        <p className="muted small">Цена подставляется из карточки товара (цена Яндекса); её можно изменить.</p>
      </section>
      <ErrorBox error={create.error} />
      <button className="btn btn-lg" disabled={!valid || create.isPending}>
        Создать и зарезервировать банки
      </button>
    </form>
  );
}

// ====================================================================== card

type Action = 'assemble' | 'hand-over' | 'deliver' | 'cancel' | 'reserve';

/** Yandex order statuses (shown only). */
const YANDEX_STATUS_RU: Record<string, string> = {
  PLACING: 'Оформляется',
  RESERVED: 'Зарезервирован',
  UNPAID: 'Не оплачен',
  PENDING: 'Ожидает',
  PROCESSING: 'В обработке',
  DELIVERY: 'Передан в доставку',
  PICKUP: 'В пункте выдачи',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
  RETURNED: 'Возвращён',
  PARTIALLY_RETURNED: 'Частично возвращён',
};

export function YandexOrderDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const acts = can('yandex.orders'); // the manager only views
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['yandex-order', id], queryFn: () => api<Order>(`/staff/yandex-orders/${id}`) });
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const done = (o: Order) => {
    client.setQueryData(['yandex-order', id], o);
    void client.invalidateQueries({ queryKey: ['yandex-orders'] });
    void client.invalidateQueries({ queryKey: ['units'] });
    setMessage(o.message ?? null);
  };
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const allPicked = o.lines.every((l) => l.units.length === l.qty && l.picked === l.qty);
  const before = o.status === 'NEW' || o.status === 'ASSEMBLED';
  return (
    <>
      <PageHead
        title={
          <>
            Яндекс № {o.external_number} <StatusBadge status={o.status} /> <TestBadge show={o.is_test} />
          </>
        }
      >
        <Link className="btn btn-ghost" to="/yandex-orders">
          К списку
        </Link>
      </PageHead>
      {message && <div className="alert alert-ok">{message}</div>}
      <section className="card">
        <dl className="props">
          <dt>Дата заказа</dt>
          <dd>{ruDate(o.order_date)}</dd>
          {o.customer_name && (
            <>
              <dt>Покупатель</dt>
              <dd>{o.customer_name}</dd>
            </>
          )}
          <dt>Сумма</dt>
          <dd>{money(o.total_uzs)}</dd>
          <dt>Создал</dt>
          <dd>
            {o.created_by_name ?? (o.source === 'yandex_api' ? 'синхронизация Яндекса' : '—')}, {dateTime(o.created_at)}
          </dd>
          {o.note && (
            <>
              <dt>Примечание</dt>
              <dd>{o.note}</dd>
            </>
          )}
          {o.cancel_reason && (
            <>
              <dt>{o.status === 'RETURNED' ? 'Причина возврата' : 'Причина отмены'}</dt>
              <dd>{o.cancel_reason}</dd>
            </>
          )}
        </dl>
      </section>

      {o.yandex && (
        <section className="card">
          <dl className="props">
            <dt>Статус Яндекса</dt>
            <dd>
              {YANDEX_STATUS_RU[o.yandex.status] ?? o.yandex.status}
              {o.yandex.substatus ? ` · ${o.yandex.substatus}` : ''}
              {o.yandex.updated_at && <span className="muted small"> · обновлён в Яндексе {dateTime(o.yandex.updated_at)}</span>}
            </dd>
            <dt>Отгрузить до</dt>
            <dd>{o.ship_by ? <ShipBy value={o.ship_by} status={o.status} /> : <span className="muted">срок не указан Яндексом</span>}</dd>
            <dt>Заказ в Яндексе</dt>
            <dd>
              № {o.external_number}
              {o.yandex.campaign_id ? <span className="muted small"> · кампания {o.yandex.campaign_id}</span> : null}
              {o.source === 'yandex_api' && <span className="muted small"> · создан автоматически синхронизацией</span>}
            </dd>
          </dl>
          <p className="muted small">Статус Яндекса только показывается: наши статусы меняют сотрудники (отмену в Яндексе система переносит сама).</p>
        </section>
      )}
      {o.stock_shortage && o.status === 'NEW' && (
        <div className="alert alert-warn">
          Не хватает остатка: банки этого заказа не зарезервированы. Когда остаток появится — «Зарезервировать банки».
          {acts && (
            <div style={{ marginTop: 8 }}>
              <ActionButton id={o.id} action="reserve" onDone={done}>
                Зарезервировать банки
              </ActionButton>
            </div>
          )}
        </div>
      )}
      {acts && o.status === 'NEW' && !o.stock_shortage && <PickBox order={o} onDone={done} />}

      <section className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Товар</th>
              <th className="num">Кол-во</th>
              <th className="num">Цена</th>
              <th>Банки</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => {
              const waiting = l.units.filter((u) => !u.picked).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
              return (
                <tr key={l.id}>
                  <td>
                    <Link to={`/products/${l.product.id}`}>{l.product.sku}</Link>
                    <div className="muted small">{l.product.name_ru}</div>
                  </td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{money(l.unit_price_uzs)}</td>
                  <td>
                    {l.units.map((u) => (
                      <div key={u.assignment_id} className="small">
                        <span className="id-chip">{u.physical_id}</span> срок {ruDate(u.expiry_date)} ·{' '}
                        {o.status === 'NEW' ? (u.picked ? <Badge tone="ok">собрана</Badge> : <Badge tone="warn">взять с полки</Badge>) : <Badge>{UNIT_STATUS[u.status] ?? u.status}</Badge>}
                        {u.fefo_override && <span className="muted"> · не ранний срок: {u.fefo_override}</span>}
                        {u.actual_cost_uzs !== undefined && <span className="muted"> · себестоимость {money(u.actual_cost_uzs)}</span>}
                      </div>
                    ))}
                    {o.status === 'NEW' && waiting[0] && (
                      <div className="muted small">
                        Рекомендуем {waiting[0].physical_id}, срок {ruDate(waiting[0].expiry_date)}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {acts && (
      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        {o.status === 'NEW' && (
          <ActionButton id={o.id} action="assemble" disabled={!allPicked} onDone={done}>
            Собран
          </ActionButton>
        )}
        {o.status === 'ASSEMBLED' && (
          <button className="btn btn-lg" onClick={() => setConfirm('hand-over')}>
            Передан в доставку
          </button>
        )}
        {o.status === 'HANDED_TO_DELIVERY' && (
          <ActionButton id={o.id} action="deliver" onDone={done}>
            Доставлен
          </ActionButton>
        )}
        {(before || o.status === 'HANDED_TO_DELIVERY' || o.status === 'DELIVERED') && (
          <button className="btn btn-ghost" onClick={() => setConfirm('cancel')}>
            {before ? 'Отменить заказ' : 'Оформить возврат'}
          </button>
        )}
      </div>
      )}
      {acts && o.status === 'NEW' && !allPicked && <p className="muted small">«Собран» станет доступно, когда все банки отмечены по Physical ID.</p>}

      {o.commission_percent !== undefined && <MoneyCard order={o} onDone={done} />}
      {o.own_delivery_cost_uzs !== undefined && (
        <OrderFinance
          key={`${o.is_test}|${o.own_delivery_cost_uzs}`}
          channel="yandex"
          id={o.id}
          isTest={!!o.is_test}
          ownDelivery={o.own_delivery_cost_uzs}
          onDone={() => {
            void q.refetch();
            void client.invalidateQueries({ queryKey: ['yandex-orders'] });
          }}
        />
      )}

      {o.released.length > 0 && (
        <section className="card">
          <h3>Снятые с заказа банки</h3>
          <ul className="timeline">
            {o.released.map((r) => (
              <li key={`${r.physical_id}-${r.released_at}`}>
                <span className="id-chip">{r.physical_id}</span> {UNIT_STATUS[r.status] ?? r.status}
                {r.return_decision && <span className="muted"> · решение: {r.return_decision === 'ACCEPTED' ? 'возвращена на склад' : 'списана'}</span>}
                <div className="muted small">
                  {dateTime(r.released_at)}
                  {r.reason ? ` · ${r.reason}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>История</h3>
        <ul className="timeline">
          {o.history.map((h, i) => (
            <li key={i}>
              <strong>{historyText(h)}</strong>
              <div className="muted small">
                {dateTime(h.at)} · {h.staff_name ?? 'система'}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {confirm === 'hand-over' && (
        <ConfirmModal title="Передать в доставку?" onClose={() => setConfirm(null)}>
          <p>Банки уйдут со склада: остаток уменьшится. Отменить после этого можно только как возврат.</p>
          <ActionButton id={o.id} action="hand-over" onDone={(x) => (setConfirm(null), done(x))}>
            Да, передан в доставку
          </ActionButton>
        </ConfirmModal>
      )}
      {confirm === 'cancel' && <CancelModal order={o} before={before} onClose={() => setConfirm(null)} onDone={(x) => (setConfirm(null), done(x))} />}
    </>
  );
}

function historyText(h: Order['history'][number]): string {
  const d = h.details ?? {};
  if (h.action === 'yandex_order.status') return `Статус: ${YANDEX_STATUS[String(d.status)]?.[0] ?? d.status}${d.reason ? ` — ${d.reason}` : ''}`;
  if (h.action === 'yandex_order.unit_replaced') return `Заменена банка ${d.from} → ${d.to}${d.fefo_reason ? ` (не ранний срок: ${d.fefo_reason})` : ''}`;
  if (h.action === 'yandex_order.picked') return `Собрана ${d.physical_id}`;
  if (h.action === 'yandex_order.created') return `Создан, зарезервированы: ${Array.isArray(d.reserved) ? d.reserved.join(', ') : ''}`;
  return AUDIT_ACTION[h.action] ?? h.action;
}

/** Physical ID field for the assembly; on «not the earliest expiry» asks for a reason and sends again. */
function PickBox({ order, onDone }: { order: Order; onDone: (o: Order) => void }) {
  const [code, setCode] = useState('');
  const [fefo, setFefo] = useState<{ code: string; message: string } | null>(null);
  const [reason, setReason] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const pick = useMutation({
    mutationFn: (body: { physical_id: string; fefo_reason?: string }) =>
      api<Order>(`/staff/yandex-orders/${order.id}/pick`, { method: 'POST', headers: { 'Idempotency-Key': newKey() }, body }),
    onSuccess: (o) => {
      setCode('');
      setFefo(null);
      onDone(o);
    },
    onError: (e, body) => {
      if (e instanceof ApiError && e.code === 'FEFO_REASON_REQUIRED') setFefo({ code: body.physical_id, message: e.message });
    },
    onSettled: () => input.current?.focus(),
  });
  const fefoError = pick.error instanceof ApiError && pick.error.code === 'FEFO_REASON_REQUIRED';
  return (
    <section className="card">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) pick.mutate({ physical_id: code.trim() });
        }}
      >
        <Field label="Сборка: введите или отсканируйте Physical ID банки и нажмите Enter" hint="Подходит V-000184, 000184 или 184. Другая банка того же товара заменит зарезервированную.">
          <input ref={input} className="scan-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="V-000184" autoComplete="off" />
        </Field>
      </form>
      {!fefoError && <ErrorBox error={pick.error} />}
      {fefo && (
        <Modal title="Не самый ранний срок годности" onClose={() => setFefo(null)}>
          <div className="alert alert-warn">{fefo.message}</div>
          <ReasonPicker options={REASONS.fefo} onChange={setReason} label="Почему берёте эту банку" />
          <ErrorBox error={fefoError ? null : pick.error} />
          <div className="modal-actions">
            <button className="btn" disabled={reason.length < 3 || pick.isPending} onClick={() => pick.mutate({ physical_id: fefo.code, fefo_reason: reason })}>
              Взять {fefo.code} с причиной
            </button>
            <button className="btn btn-ghost" onClick={() => setFefo(null)}>
              Взять рекомендованную
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ActionButton({ id, action, disabled, onDone, children }: { id: string; action: Action; disabled?: boolean; onDone: (o: Order) => void; children: ReactNode }) {
  const [key] = useState(newKey);
  const m = useMutation({
    mutationFn: () => api<Order>(`/staff/yandex-orders/${id}/${action}`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: {} }),
    onSuccess: onDone,
  });
  return (
    <>
      <button className="btn btn-lg" disabled={disabled || m.isPending} onClick={() => m.mutate()}>
        {children}
      </button>
      <ErrorBox error={m.error} />
    </>
  );
}

function ConfirmModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Не сейчас
        </button>
      </div>
    </Modal>
  );
}

function CancelModal({ order, before, onClose, onDone }: { order: Order; before: boolean; onClose: () => void; onDone: (o: Order) => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(newKey);
  const m = useMutation({
    mutationFn: () => api<Order>(`/staff/yandex-orders/${order.id}/cancel`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { reason } }),
    onSuccess: onDone,
  });
  return (
    <Modal title={before ? 'Отменить заказ?' : 'Оформить возврат?'} onClose={onClose}>
      <p>
        {before
          ? 'Все банки заказа (и уже собранные) вернутся на склад, резерв снимется.'
          : 'Заказ станет «Возврат», банки — «Возврат на проверке». Решение по каждой банке — на складе: Склад → Единицы → «Возвраты на проверке».'}
      </p>
      <ReasonPicker options={before ? REASONS.cancel : REASONS.return} onChange={setReason} />
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn" disabled={reason.length < 3 || m.isPending} onClick={() => m.mutate()}>
          {before ? 'Отменить заказ' : 'Оформить возврат'}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Назад
        </button>
      </div>
    </Modal>
  );
}

/** Admin only: commission, sale prices, unit costs and profit (no Yandex logistics). */
function MoneyCard({ order, onDone }: { order: Order; onDone: (o: Order) => void }) {
  const [edit, setEdit] = useState(false);
  const [commission, setCommission] = useState(String(order.commission_percent ?? 18.5));
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(order.lines.map((l) => [l.id, String(l.unit_price_uzs)])));
  const m = useMutation({
    mutationFn: () =>
      api<Order>(`/staff/yandex-orders/${order.id}`, {
        method: 'PATCH',
        body: {
          commission_percent: Number(commission.replace(',', '.')),
          prices: order.lines.map((l) => ({ line_id: l.id, unit_price_uzs: Number(String(prices[l.id]).replace(/\s/g, '')) })),
        },
      }),
    onSuccess: (o) => {
      setEdit(false);
      onDone(o);
    },
  });
  const mo = order.money;
  return (
    <section className="card narrow">
      <div className="section-head">
        <h2>Прибыль (видит только администратор)</h2>
        {!edit && (
          <button className="btn btn-sm btn-ghost" onClick={() => setEdit(true)}>
            Изменить цену или комиссию
          </button>
        )}
      </div>
      {mo ? (
        <dl className="props">
          <dt>Выручка</dt>
          <dd>{money(mo.revenue_uzs)}</dd>
          <dt>Комиссия {order.commission_percent}%</dt>
          <dd>− {money(mo.commission_uzs)}</dd>
          <dt>Себестоимость банок</dt>
          <dd>− {money(mo.cost_uzs)}</dd>
          <dt>Прибыль</dt>
          <dd className={mo.profit_uzs < 0 ? 'text-warn strong' : 'strong'}>{money(mo.profit_uzs)}</dd>
        </dl>
      ) : (
        <p className="muted">Заказ отменён или возвращён — прибыли нет.</p>
      )}
      <p className="muted small">Логистика Яндекса не учитывается.</p>
      {edit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="Комиссия, %">
              <input inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} required />
            </Field>
            {order.lines.map((l) => (
              <Field key={l.id} label={`Цена ${l.product.sku}, сум за шт.`}>
                <input inputMode="numeric" value={prices[l.id]} onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })} required />
              </Field>
            ))}
          </div>
          <ErrorBox error={m.error} />
          <button className="btn" disabled={m.isPending}>
            Сохранить
          </button>{' '}
          <button type="button" className="btn btn-ghost" onClick={() => setEdit(false)}>
            Отмена
          </button>
        </form>
      )}
    </section>
  );
}
