import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChannelTabs } from '../components/ChannelTabs';
import { Badge, ErrorBox, Loading, OrderStatus, PageHead, Pagination } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateTime, money, YANDEX_STATUS } from '../lib/format';
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
}
interface Page {
  items: Row[];
  page: number;
  total: number;
  total_pages: number;
  ship_today: number;
}

export const CHANNEL_LABEL: Record<Channel, string> = { vitalo: 'Mini App', yandex: 'Яндекс' };

/** Orders of both channels in one list (newest first); the row opens the card of its channel. */
export function AllOrders() {
  const [params, setParams] = useSearchParams();
  const f = { ship_today: params.get('ship_today') ?? '', hide_test: params.get('hide_test') ?? '', q: params.get('q') ?? '' };
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
      </PageHead>
      <div className="filters">
        <input placeholder="Номер заказа (VITALO или Яндекса)" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={f.ship_today === 'true'} onChange={(e) => set('ship_today', e.target.checked ? 'true' : '')} />
          Отгрузить сегодня{q.data ? ` (${q.data.ship_today})` : ''}
        </label>
        <label className="check">
          <input type="checkbox" checked={f.hide_test === 'true'} onChange={(e) => set('hide_test', e.target.checked ? 'true' : '')} />
          Скрыть тестовые
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
                  <td>{o.channel === 'vitalo' ? <OrderStatus status={o.status} cod={o.payment_method === 'cod'} /> : <YandexStatus status={o.status} />}</td>
                  <td className="small">{o.channel === 'yandex' ? <ShipBy value={o.ship_by} status={o.status} /> : '—'}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num">{money(o.total_uzs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={q.data.page} totalPages={q.data.total_pages} onPage={(p) => set('page', p > 1 ? String(p) : '')} />
        </section>
      )}
    </>
  );
}

function YandexStatus({ status }: { status: string }) {
  const [label, tone] = YANDEX_STATUS[status] ?? [status, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}
