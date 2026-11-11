import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading, OrderStatus, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { useSession, type Permission } from '../lib/auth';
import { money, ORDER_STATUS } from '../lib/format';
import { ForwardIcon } from '../components/Icons';
import { FunnelCard } from './Funnel';

type Channel = 'vitalo' | 'yandex';
interface Day {
  day: string;
  vitalo_orders: number;
  yandex_orders: number;
  vitalo_revenue_uzs?: number;
  yandex_revenue_uzs?: number;
}

/**
 * Генплан, этап 2. Money fields come only with dashboard.revenue (not for marketer); `margin` and `ai_spend` — admin only.
 * Revenue (D-55) = the same rule as «Аналитика»: delivered orders of both channels, goods only, returns subtracted.
 */
export interface DashboardData {
  days: number;
  from: string;
  to: string;
  sales: {
    orders: number;
    units: number;
    revenue_uzs?: number;
    average_check_uzs?: number;
    channels: Record<Channel, { orders: number; revenue_uzs?: number }>;
    by_day: Day[];
  };
  margin?: { gross_uzs: number; percent: number | null; revenue_with_cost_uzs: number; revenue_without_cost_uzs: number };
  orders_created: Record<Channel, number>;
  statuses: Record<string, number>;
  /** of «Отменён»: cancelled because the reserve expired (аудит 10.11, п. 1.6) */
  cancelled_expired?: number;
  top_products: { product_id: string; sku: string; name_ru: string; qty: number; revenue_uzs?: number }[];
  low_stock: { id: string; sku: string; name_ru: string; min_stock: number; available: number; incoming: number }[];
  attention: {
    awaiting_confirmation: number;
    units_attention: number;
    yandex_to_ship: number;
    ai_red: number;
    compat_pending: number;
    expiring_units: number;
    waitlist: { products: number; people: number; in_stock: number; no_supply?: number };
    yandex_sync_attention?: number;
    stale_receiving?: number;
    awaiting_payment?: number;
  };
  ai_spend?: { month_usd: number; budget_usd: number };
}

const PERIODS = [
  [1, 'Сегодня'],
  [7, '7 дней'],
  [30, '30 дней'],
  [90, '90 дней'],
] as const;

const CHANNEL = { vitalo: 'Mini App', yandex: 'Яндекс Маркет' } as const;

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
        <DashboardView data={q.data} can={can} />
      )}
    </>
  );
}

export function DashboardView({ data, can }: { data: DashboardData; can: (p: Permission) => boolean }) {
  const s = data.sales;
  const withRevenue = s.revenue_uzs !== undefined;
  const split = (c: Channel) => (withRevenue ? money(s.channels[c].revenue_uzs ?? 0) : `${s.channels[c].orders} зак.`);
  return (
    <>
      <div className="kpis">
        {withRevenue && <Kpi label="Выручка" value={money(s.revenue_uzs ?? 0)} hint={`Mini App ${split('vitalo')} · Яндекс ${split('yandex')}`} />}
        <Kpi label="Доставлено заказов" value={String(s.orders)} hint={`Mini App ${s.channels.vitalo.orders} · Яндекс ${s.channels.yandex.orders}`} />
        {withRevenue && <Kpi label="Средний чек" value={money(s.average_check_uzs ?? 0)} />}
        {data.margin && (
          <Kpi
            label="Валовая маржа"
            value={data.margin.percent === null ? '—' : `${data.margin.percent.toLocaleString('ru-RU')} %`}
            hint={
              data.margin.revenue_without_cost_uzs > 0
                ? `${money(data.margin.gross_uzs)}; без себестоимости ${money(data.margin.revenue_without_cost_uzs)} — не учтено`
                : money(data.margin.gross_uzs)
            }
          />
        )}
        <Kpi label="Новых заказов" value={String(data.orders_created.vitalo + data.orders_created.yandex)} hint={`Mini App ${data.orders_created.vitalo} · Яндекс ${data.orders_created.yandex}`} />
        {data.ai_spend && (
          <Kpi
            label="Расход VITALO AI за месяц"
            value={`$${data.ai_spend.month_usd.toLocaleString('ru-RU')}`}
            hint={`из $${data.ai_spend.budget_usd.toLocaleString('ru-RU')} бюджета`}
            tone={data.ai_spend.month_usd >= data.ai_spend.budget_usd * 0.8 ? 'warn' : undefined}
          />
        )}
      </div>
      <p className="muted small">
        Выручка и заказы — по дате доставки, без платы за доставку, возвраты вычтены; так же считает «Аналитика». Тестовые заказы не входят.
      </p>

      <Attention a={data.attention} can={can} />

      {data.days > 1 && <SalesChart days={s.by_day} money={withRevenue} />}

      <FunnelCard />

      <div className="grid-2">
        <section className="card">
          <h2>Топ-5 товаров</h2>
          <p className="muted small">Оба канала, по проданным штукам</p>
          {data.top_products.length === 0 ? (
            <p className="muted">За период продаж нет</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th className="num">Шт.</th>
                  {withRevenue && <th className="num">Выручка</th>}
                </tr>
              </thead>
              <tbody>
                {data.top_products.map((p) => (
                  <tr key={p.product_id}>
                    <td>
                      <Link to={`/products/${p.product_id}`}>{p.name_ru}</Link>
                      <div className="muted small">{p.sku}</div>
                    </td>
                    <td className="num">{p.qty}</td>
                    {withRevenue && <td className="num">{money(p.revenue_uzs ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Заказы Mini App по статусам</h2>
          <table className="table">
            <tbody>
              {Object.keys(ORDER_STATUS).map((st) => (
                <tr key={st}>
                  <td>
                    {can('orders.view') ? (
                      <Link to={`/orders?status=${st}`}>
                        <OrderStatus status={st} />
                      </Link>
                    ) : (
                      <OrderStatus status={st} />
                    )}
                  </td>
                  <td className="num">
                    {data.statuses[st] ?? 0}
                    {st === 'cancelled' && (data.cancelled_expired ?? 0) > 0 && <div className="muted small">из них истёк резерв: {data.cancelled_expired}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h2>Низкие остатки</h2>
        {data.low_stock.length === 0 ? (
          <p className="muted">Все товары выше минимального остатка</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Доступно</th>
                <th className="num">Минимум</th>
                <th className="num">Уже едет</th>
              </tr>
            </thead>
            <tbody>
              {data.low_stock.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name_ru} <span className="muted small">{p.sku}</span>
                  </td>
                  <td className={`num ${p.available <= 0 ? 'text-bad' : 'text-warn'}`}>{p.available}</td>
                  <td className="num">{p.min_stock}</td>
                  <td className="num">{p.incoming > 0 ? p.incoming : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {can('inventory.view') && (
          <Link to="/inventory?low_only=true" className="link">
            Открыть склад <ForwardIcon />
          </Link>
        )}
      </section>
    </>
  );
}

/** «Требует внимания»: only what is not zero; each line opens the list it counts (when the employee may open it). */
function Attention({ a, can }: { a: DashboardData['attention']; can: (p: Permission) => boolean }) {
  const rows: { n: number; text: string; to: string; perm: Permission }[] = [
    { n: a.awaiting_confirmation, text: 'заказов ждут подтверждения или проверки оплаты', to: '/orders?awaiting_confirmation=true', perm: 'orders.view' },
    { n: a.units_attention, text: 'оплаченных заказов ждут банки (внимание склада)', to: '/orders?units_attention=true', perm: 'orders.view' },
    { n: a.yandex_to_ship, text: 'заказов Яндекса отгрузить сегодня или уже просрочены', to: '/orders?ship_today=true', perm: 'yandex.orders.view' },
    { n: a.ai_red, text: 'красных ответов VITALO AI не проверены', to: '/compat?tab=ai', perm: 'compat.view' },
    { n: a.compat_pending, text: 'вопросов о совместимости без ответа', to: '/compat', perm: 'compat.view' },
    { n: a.expiring_units, text: 'банок со сроком годности меньше 90 дней', to: '/analytics', perm: 'finance.manage' },
    {
      n: a.waitlist.in_stock,
      text: `товаров из листа ожидания уже есть на складе (всего ждут ${a.waitlist.people} чел.)`,
      to: '/waitlist',
      perm: 'customers.view',
    },
    {
      n: a.waitlist.no_supply ?? 0,
      text: 'товаров ждут покупатели, а на складе ноль и закупки нет',
      to: '/waitlist',
      perm: 'customers.view',
    },
    { n: a.awaiting_payment ?? 0, text: 'заказов Mini App ожидают оплаты', to: '/orders?status=awaiting_payment', perm: 'orders.view' },
    { n: a.yandex_sync_attention ?? 0, text: 'заказов Яндекса требуют разбора в синхронизации', to: '/yandex-sync', perm: 'yandex.sync' },
    { n: a.stale_receiving ?? 0, text: 'приёмок начаты больше суток назад и не завершены', to: '/inventory?tab=receiving', perm: 'receiving.perform' },
  ];
  const shown = rows.filter((r) => r.n > 0);
  return (
    <section className="card attention">
      <h2>Требует внимания</h2>
      {shown.length === 0 ? (
        <p className="muted">Сейчас ничего срочного нет</p>
      ) : (
        <ul className="attention-list">
          {shown.map((r) => (
            <li key={r.to + r.text}>
              <span className="attention-count">{r.n}</span>
              {can(r.perm) ? (
                <Link to={r.to}>
                  {r.text} <ForwardIcon />
                </Link>
              ) : (
                <span>{r.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const shortDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/**
 * Stacked bars by day: Mini App (navy) under Yandex (light navy). Revenue when the employee may see money,
 * otherwise the number of delivered orders. Plain SVG; the table under it carries the same numbers for screen readers.
 */
export function SalesChart({ days, money: withMoney }: { days: Day[]; money: boolean }) {
  const value = (d: Day, c: Channel) => (withMoney ? (d[`${c}_revenue_uzs`] ?? 0) : d[`${c}_orders`]);
  const max = Math.max(1, ...days.map((d) => Math.max(0, value(d, 'vitalo')) + Math.max(0, value(d, 'yandex'))));
  const W = 720;
  const H = 180;
  const gap = days.length > 40 ? 1 : 3;
  const bar = (W - gap * (days.length - 1)) / days.length;
  const labelEvery = days.length <= 7 ? 1 : days.length <= 31 ? 5 : 15;
  const total = days.reduce((s, d) => s + value(d, 'vitalo') + value(d, 'yandex'), 0);
  return (
    <section className="card">
      <h2>{withMoney ? 'Выручка по дням' : 'Доставленные заказы по дням'}</h2>
      <div className="chart-legend small">
        <span>
          <i className="swatch swatch-vitalo" /> {CHANNEL.vitalo}
        </span>
        <span>
          <i className="swatch swatch-yandex" /> {CHANNEL.yandex}
        </span>
        {total > 0 && <span className="muted">Максимум за день: {withMoney ? money(max) : max}</span>}
      </div>
      {total === 0 ? (
        <p className="muted">За период доставленных заказов нет</p>
      ) : (
        <svg className="sales-chart" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={withMoney ? 'Выручка по дням по каналам' : 'Доставленные заказы по дням по каналам'}>
          <line x1={0} x2={W} y1={H} y2={H} className="chart-axis" />
          {days.map((d, i) => {
            const v = Math.max(0, value(d, 'vitalo'));
            const y = Math.max(0, value(d, 'yandex'));
            const hv = (v / max) * (H - 4);
            const hy = (y / max) * (H - 4);
            const x = i * (bar + gap);
            const title = `${shortDay(d.day)}: Mini App ${withMoney ? money(value(d, 'vitalo')) : value(d, 'vitalo')}, Яндекс ${withMoney ? money(value(d, 'yandex')) : value(d, 'yandex')}`;
            return (
              <g key={d.day}>
                <title>{title}</title>
                {hv > 0 && <rect x={x} y={H - hv} width={bar} height={hv} className="bar-vitalo" rx={Math.min(2, bar / 4)} />}
                {hy > 0 && <rect x={x} y={H - hv - hy - (hv > 0 ? 1 : 0)} width={bar} height={hy} className="bar-yandex" rx={Math.min(2, bar / 4)} />}
                {/* invisible full-height target so the hover title works on empty days too */}
                <rect x={x} y={0} width={bar} height={H} fill="transparent" />
                {(i % labelEvery === 0 || i === days.length - 1) && (
                  <text x={x + bar / 2} y={H + 14} textAnchor="middle" className="chart-label">
                    {shortDay(d.day)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className={tone ? `kpi kpi-${tone}` : 'kpi'}>
      <div className="muted small">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}
