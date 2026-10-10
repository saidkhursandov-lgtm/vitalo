import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Loading, OrderStatus, PageHead, Pagination, PaymentStatus } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateTime, money, ORDER_STATUS, PAYMENT_STATUS, prettyPhone } from '../lib/format';
import { TestBadge } from '../components/OrderFinance';

interface OrderRow {
  id: string;
  order_number: string;
  created_at: string;
  status: string;
  payment_status: string;
  total_uzs: number;
  is_test: boolean;
  /** Stage 2E/3: paid, but the jars are not reserved («Нужно внимание склада») */
  units_attention: string | null;
  customer_reported_paid: boolean;
  customer: { name: string; username: string | null };
  recipient_name: string;
  recipient_phone: string;
}

interface Page<T> {
  items: T[];
  page: number;
  total: number;
  total_pages: number;
  attention_count?: number;
}

const FILTER_KEYS = ['q', 'status', 'payment_status', 'date_from', 'date_to', 'awaiting_confirmation', 'hide_test', 'units_attention', 'page'] as const;

/** Orders list; filters are kept in the URL so a filtered view can be shared or bookmarked. */
export function Orders() {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;
  const [text, setText] = useState(filters.q);
  const page = Number(filters.page) || 1;

  const set = (patch: Partial<typeof filters>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: '', ...patch })) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const id = setTimeout(() => text !== filters.q && set({ q: text }), 400);
    return () => clearTimeout(id);
  });

  const q = useQuery({
    queryKey: ['orders', filters],
    queryFn: () => api<Page<OrderRow>>(`/staff/orders${qs({ ...filters, page })}`),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHead title="Заказы" />
      <div className="filters">
        <input placeholder="Номер, имя или телефон" value={text} onChange={(e) => setText(e.target.value)} />
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Статус">
          <option value="">Все статусы</option>
          {Object.entries(ORDER_STATUS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={filters.payment_status} onChange={(e) => set({ payment_status: e.target.value })} aria-label="Оплата">
          <option value="">Любая оплата</option>
          {Object.entries(PAYMENT_STATUS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input type="date" value={filters.date_from} onChange={(e) => set({ date_from: e.target.value })} aria-label="С даты" />
        <input type="date" value={filters.date_to} onChange={(e) => set({ date_to: e.target.value })} aria-label="По дату" />
        <label className="check">
          <input type="checkbox" checked={filters.awaiting_confirmation === 'true'} onChange={(e) => set({ awaiting_confirmation: e.target.checked ? 'true' : '' })} />
          Ждут подтверждения оплаты
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hide_test === 'true'} onChange={(e) => set({ hide_test: e.target.checked ? 'true' : '' })} />
          Скрыть тестовые
        </label>
      </div>
      {q.data && (q.data.attention_count ?? 0) > 0 && (
        <div className="alert alert-warn">
          Нужно внимание склада: {q.data.attention_count} заказ(ов) оплачены, но банки не закреплены.{' '}
          {filters.units_attention === 'true' ? (
            <button className="btn btn-sm btn-ghost" onClick={() => set({ units_attention: '' })}>
              Показать все заказы
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => set({ units_attention: 'true' })}>
              Показать только их
            </button>
          )}
        </div>
      )}
      {q.data && !q.data.attention_count && filters.units_attention === 'true' && (
        <div className="alert alert-ok">
          Заказов, которым нужно внимание склада, нет.{' '}
          <button className="btn btn-sm btn-ghost" onClick={() => set({ units_attention: '' })}>
            Показать все заказы
          </button>
        </div>
      )}

      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Создан</th>
                <th>Клиент / получатель</th>
                <th>Статус</th>
                <th>Оплата</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    Заказов не найдено
                  </td>
                </tr>
              )}
              {q.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/orders/${o.id}`} className="strong">
                      {o.order_number}
                    </Link>{' '}
                    <TestBadge show={o.is_test} />
                  </td>
                  <td>{dateTime(o.created_at)}</td>
                  <td>
                    {o.recipient_name}
                    <div className="muted small">
                      {prettyPhone(o.recipient_phone)} · {o.customer.name}
                      {o.customer.username && ` @${o.customer.username}`}
                    </div>
                  </td>
                  <td>
                    <OrderStatus status={o.status} />
                    {o.units_attention && (
                      <div title={o.units_attention}>
                        <Badge tone="bad">Нужно внимание склада</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <PaymentStatus status={o.payment_status} />
                    {o.customer_reported_paid && o.payment_status === 'payment_pending' && <div className="small text-warn">Клиент: «Я оплатил»</div>}
                  </td>
                  <td className="num">{money(o.total_uzs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Всего: {q.data.total}</span>
            <Pagination page={page} totalPages={q.data.total_pages} onPage={(p) => set({ page: String(p) })} />
          </div>
        </section>
      )}
    </>
  );
}
