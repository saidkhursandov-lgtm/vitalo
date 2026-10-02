import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading, OrderStatus, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { money, ORDER_STATUS } from '../lib/format';

interface DashboardData {
  revenue_uzs: number;
  paid_orders: number;
  orders_created: number;
  average_check_uzs: number;
  statuses: Record<string, number>;
  top_products: { product_id: string; sku: string; name_ru: string; qty: number; revenue_uzs: number }[];
  low_stock: { id: string; sku: string; name_ru: string; min_stock: number; available: number }[];
}

const PERIODS = [
  [1, 'Сегодня'],
  [7, '7 дней'],
  [30, '30 дней'],
  [90, '90 дней'],
] as const;

export function Dashboard() {
  const { can } = useSession();
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['dashboard', days], queryFn: () => api<DashboardData>(`/staff/dashboard?days=${days}`) });

  return (
    <>
      <PageHead title="Дашборд">
        <div className="segmented">
          {PERIODS.map(([d, label]) => (
            <button key={d} className={days === d ? 'is-on' : ''} onClick={() => setDays(d)}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Выручка" value={money(q.data.revenue_uzs)} hint="оплаченные заказы за период" />
            <Kpi label="Оплачено заказов" value={String(q.data.paid_orders)} />
            <Kpi label="Создано заказов" value={String(q.data.orders_created)} />
            <Kpi label="Средний чек" value={money(q.data.average_check_uzs)} />
          </div>

          <div className="grid-2">
            <section className="card">
              <h2>Заказы по статусам</h2>
              <table className="table">
                <tbody>
                  {Object.keys(ORDER_STATUS).map((s) => (
                    <tr key={s}>
                      <td>
                        {can('orders.view') ? (
                          <Link to={`/orders?status=${s}`}>
                            <OrderStatus status={s} />
                          </Link>
                        ) : (
                          <OrderStatus status={s} />
                        )}
                      </td>
                      <td className="num">{q.data.statuses[s] ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card">
              <h2>Топ товаров</h2>
              {q.data.top_products.length === 0 ? (
                <p className="muted">За период продаж нет</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Товар</th>
                      <th className="num">Продано, шт.</th>
                      <th className="num">Выручка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.top_products.map((p) => (
                      <tr key={p.product_id}>
                        <td>
                          <Link to={`/products/${p.product_id}`}>{p.name_ru}</Link>
                          <div className="muted small">{p.sku}</div>
                        </td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{money(p.revenue_uzs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="card">
            <h2>Низкие остатки</h2>
            {q.data.low_stock.length === 0 ? (
              <p className="muted">Все товары выше минимального остатка</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Товар</th>
                    <th className="num">Доступно</th>
                    <th className="num">Минимум</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.low_stock.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.name_ru} <span className="muted small">{p.sku}</span>
                      </td>
                      <td className={`num ${p.available <= 0 ? 'text-bad' : 'text-warn'}`}>{p.available}</td>
                      <td className="num">{p.min_stock}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {can('inventory.view') && (
              <Link to="/inventory?low_only=true" className="link">
                Открыть склад →
              </Link>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="muted small">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}
