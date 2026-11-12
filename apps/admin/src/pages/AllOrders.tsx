import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChannelTabs } from '../components/ChannelTabs';
import { Badge, ErrorBox, Loading, OrderStatus, PageHead, Pagination } from '../components/ui';
import { ExportButton } from '../components/ExportButton';
import { api, qs } from '../lib/api';
import { cancelLabel, dateTime, money, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, YANDEX_STATUS, type CancelInfo } from '../lib/format';
import { ShipBy } from './YandexOrders';

type Channel = 'vitalo' | 'yandex';
interface Row {
  channel: Channel;
  id: string;
  number: string;
  created_at: string;
  status: string;
  payment_method: string | null;
  customer: string | null;
  qty: number;
  total_uzs: number;
  ship_by: { date: string; time: string | null } | null;
  is_test: boolean;
  payment_status: string | null;
  /** who cancelled (аудит 10.11, п. 1.6) */
  cancel?: CancelInfo | null;
}
interface Page {
  items: Row[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  total_sum_uzs: number;
  ship_today: number;
}

/** Аудит 2.1: the status filter — Mini App and Yandex statuses in one list (a status of one channel leaves the other out). */
function StatusFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (s: string) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  const names = value.map((s) => ORDER_STATUS[s] ?? YANDEX_STATUS[s]?.[0] ?? s);
  return (
    <details className="multi-select">
      <summary>{value.length ? `Статус: ${names.join(', ')}` : 'Все статусы'}</summary>
      <div className="multi-select-menu">
        <div className="muted small">Mini App</div>
        {Object.entries(ORDER_STATUS).map(([s, label]) => (
          <label key={s} className="check">
            <input type="checkbox" checked={value.includes(s)} onChange={() => toggle(s)} />
            {label}
          </label>
        ))}
        <div className="muted small">Яндекс</div>
        {Object.entries(YANDEX_STATUS).map(([s, [label]]) => (
          <label key={s} className="check">
            <input type="checkbox" checked={value.includes(s)} onChange={() => toggle(s)} />
            {label}
          </label>
        ))}
        {value.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
            Сбросить
          </button>
        )}
      </div>
    </details>
  );
}

export const CHANNEL_LABEL: Record<Channel, string> = { vitalo: 'Mini App', yandex: 'Яндекс' };

/** Orders of both channels in one list (newest first); the row opens the card of its channel. */
export function AllOrders() {
  const [params, setParams] = useSearchParams();
  // аудит 10.11, п. 1.7: тестовые скрыты по умолчанию; ?show_test=true — показать
  const showTest = params.get('show_test') === 'true';
  const f = {
    ship_today: params.get('ship_today') ?? '',
    hide_test: showTest ? '' : 'true',
    q: params.get('q') ?? '',
    // аудит 2.1
    status: params.get('status') ?? '',
    payment_method: params.get('payment_method') ?? '',
    date_from: params.get('date_from') ?? '',
    date_to: params.get('date_to') ?? '',
    page_size: params.get('page_size') ?? '',
  };
  const statuses = f.status ? f.status.split(',') : [];
  const page = Number(params.get('page')) || 1;
  const [text, setText] = useState(f.q);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const id = setTimeout(() => text.trim() !== f.q && set('q', text.trim()), 400);
    return () => clearTimeout(id);
  });
  const q = useQuery({
    queryKey: ['all-orders', f, page],
    queryFn: () => api<Page>(`/staff/all-orders${qs({ ...f, page })}`),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHead title="Заказы">
        <ChannelTabs current="all" />
        <ExportButton path={`/staff/export/orders${qs({ ...f, page_size: undefined })}`} />
      </PageHead>
      <div className="filters">
        <input placeholder="Номер заказа, телефон или имя" value={text} onChange={(e) => setText(e.target.value)} />
        <StatusFilter value={statuses} onChange={(v) => set('status', v.join(','))} />
        <select value={f.payment_method} onChange={(e) => set('payment_method', e.target.value)} aria-label="Способ оплаты">
          <option value="">Любая оплата</option>
          {Object.entries(PAYMENT_METHOD).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <input type="date" value={f.date_from} onChange={(e) => set('date_from', e.target.value)} aria-label="Создан с" />
        <input type="date" value={f.date_to} onChange={(e) => set('date_to', e.target.value)} aria-label="Создан по" />
        <label className="check">
          <input type="checkbox" checked={f.ship_today === 'true'} onChange={(e) => set('ship_today', e.target.checked ? 'true' : '')} />
          Отгрузить сегодня{q.data ? ` (${q.data.ship_today})` : ''}
        </label>
        <label className="check">
          <input type="checkbox" checked={showTest} onChange={(e) => set('show_test', e.target.checked ? 'true' : '')} />
          Показать тестовые
        </label>
      </div>
      {f.ship_today === 'true' && (
        <p className="muted small">Mini App — подтверждённые и собираемые заказы; Яндекс — «Отгрузить до» сегодня или уже прошло.</p>
      )}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <p className="muted">Заказов нет</p>
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Канал</th>
                <th>Номер</th>
                <th>Создан</th>
                <th>Покупатель</th>
                <th>Статус</th>
                <th>Оплата</th>
                <th>Отгрузить до</th>
                <th className="num">Шт.</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((o) => (
                <tr key={`${o.channel}-${o.id}`}>
                  <td>
                    <Badge tone={o.channel === 'vitalo' ? 'info' : undefined}>{CHANNEL_LABEL[o.channel]}</Badge>
                  </td>
                  <td className="nowrap">
                    <Link to={o.channel === 'vitalo' ? `/orders/${o.id}` : `/yandex-orders/${o.id}`}>{o.number}</Link>
                    {o.is_test && (
                      <>
                        {' '}
                        <Badge tone="warn">Тест</Badge>
                      </>
                    )}
                  </td>
                  <td className="small">{dateTime(o.created_at)}</td>
                  <td>{o.customer ?? '—'}</td>
                  <td>
                    {o.channel === 'vitalo' ? <OrderStatus status={o.status} cod={o.payment_method === 'cod'} /> : <YandexStatus status={o.status} />}
                    {o.cancel && <div className="muted small">{cancelLabel(o.cancel)}</div>}
                  </td>
                  <td className="small">
                    {o.channel === 'vitalo' ? (
                      <>
                        {o.payment_method ? (PAYMENT_METHOD[o.payment_method] ?? o.payment_method) : '—'}
                        {o.payment_status && <div className="muted">{PAYMENT_STATUS[o.payment_status] ?? o.payment_status}</div>}
                      </>
                    ) : (
                      <span className="muted">Яндекс</span>
                    )}
                  </td>
                  <td className="small">{o.channel === 'yandex' ? <ShipBy value={o.ship_by} status={o.status} /> : '—'}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num">{money(o.total_uzs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">
              Заказов: {q.data.total} · на сумму {money(q.data.total_sum_uzs)}
            </span>
            <select value={String(q.data.page_size)} onChange={(e) => set('page_size', e.target.value === '30' ? '' : e.target.value)} aria-label="Строк на странице">
              <option value="30">30 на странице</option>
              <option value="100">100 на странице</option>
            </select>
            <Pagination page={q.data.page} totalPages={q.data.total_pages} onPage={(p) => set('page', p > 1 ? String(p) : '')} />
          </div>
        </section>
      )}
    </>
  );
}

function YandexStatus({ status }: { status: string }) {
  const [label, tone] = YANDEX_STATUS[status] ?? [status, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}
