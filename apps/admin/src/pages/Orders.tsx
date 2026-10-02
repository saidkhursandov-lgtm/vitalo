import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ErrorBox, Loading, OrderStatus, PageHead, Pagination, PaymentStatus } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateTime, money, ORDER_STATUS, PAYMENT_STATUS, prettyPhone } from '../lib/format';

interface OrderRow {
  id: string;
  order_number: string;
  created_at: string;
  status: string;
  payment_status: string;
  total_uzs: number;
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
}

const FILTER_KEYS = ['q', 'status', 'payment_status', 'date_from', 'date_to', 'awaiting_confirmation', 'page'] as const;

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
      </div>

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
                    </Link>
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
