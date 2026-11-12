import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, ErrorBox, Loading, PageHead } from '../components/ui';
import { api, qs } from '../lib/api';
import { money, ruDate } from '../lib/format';

/**
 * Stage 3 «Аналитика» (admin only). Every number comes from the server (one way of counting), so the channel rows
 * always add up to the total. Test orders are never counted.
 */

interface Totals {
  revenue: number;
  cost: number;
  revenue_without_cost: number;
  commission: number;
  delivery: number;
  tax: number;
  profit: number;
  orders: number;
  units: number;
}

interface ProductRow {
  product_id: string;
  sku: string;
  name: string;
  qty: number;
  revenue: number;
  cost: number;
  commission: number;
  profit: number;
  margin_percent: number | null;
  incomplete: boolean;
}

interface AnalyticsData {
  channels: { yandex: Totals; vitalo: Totals };
  sales: Totals;
  other_expenses: number;
  salaries: number;
  net_profit: number;
  incomplete: boolean;
  shared_expenses_included: boolean;
  purchases_invested_uzs: number;
  products: ProductRow[];
  top_products: { sku: string; name: string; qty: number; revenue: number }[];
  attention: {
    expiring: { id: string; physical_id: string; sku: string; name: string; expiry_date: string; expired: boolean }[];
    stale: { product_id: string; sku: string; name: string; on_shelf: number }[];
    orders_waiting_units: { id: string; order_number: string; reason: string | null }[];
  };
}

type Channel = '' | 'yandex' | 'vitalo';
const CHANNELS: [Channel, string][] = [
  ['', 'Все каналы'],
  ['yandex', 'Яндекс'],
  ['vitalo', 'VITALO'],
];

const pad = (n: number) => String(n).padStart(2, '0');
const tashkentToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
/** First and last day of the month `shift` months away from today. */
export function monthRange(today: string, shift: number): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const total = y * 12 + (m - 1) + shift;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return { from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(new Date(Date.UTC(yy, mm, 0)).getUTCDate())}` };
}

export function Analytics() {
  const today = tashkentToday();
  const [preset, setPreset] = useState<'this' | 'last' | 'custom'>('this');
  const [custom, setCustom] = useState(monthRange(today, 0));
  const [channel, setChannel] = useState<Channel>('');
  const period = preset === 'this' ? monthRange(today, 0) : preset === 'last' ? monthRange(today, -1) : custom;
  const ok = period.from <= period.to;
  const q = useQuery({
    queryKey: ['analytics', period, channel],
    queryFn: () => api<AnalyticsData>(`/staff/finance/analytics${qs({ ...period, channel })}`),
    enabled: ok,
  });

  return (
    <>
      <PageHead title="Аналитика">
        <div className="segmented">
          {(['this', 'last', 'custom'] as const).map((p) => (
            <button key={p} className={preset === p ? 'is-on' : ''} onClick={() => setPreset(p)}>
              {p === 'this' ? 'Этот месяц' : p === 'last' ? 'Прошлый месяц' : 'Свой период'}
            </button>
          ))}
        </div>
        <div className="segmented">
          {CHANNELS.map(([c, label]) => (
            <button key={c} className={channel === c ? 'is-on' : ''} onClick={() => setChannel(c)}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>
      {preset === 'custom' && (
        <div className="filters">
          <label className="muted small">
            с <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="Период с" />
          </label>
          <label className="muted small">
            по <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="Период по" />
          </label>
        </div>
      )}
      <p className="muted small">
        Период: {ruDate(period.from)} — {ruDate(period.to)}. Продажа считается в день, когда заказ стал «Доставлен»; возврат — в день возврата. Тестовые заказы не учитываются.
      </p>
      {!ok ? (
        <div className="alert alert-warn">Начало периода позже конца.</div>
      ) : q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Report d={q.data} channel={channel} />
      )}
    </>
  );
}

function Report({ d, channel }: { d: AnalyticsData; channel: Channel }) {
  const s = d.sales;
  const shared = d.shared_expenses_included;
  return (
    <>
      {d.incomplete && (
        <div className="alert alert-warn">
          Прибыль неполная: у части проданных товаров себестоимость неизвестна (выручка по ним {money(s.revenue_without_cost)}). Она не считается нулём — эти продажи показаны отдельной строкой.
        </div>
      )}
      <div className="kpis">
        <Kpi label="Выручка" value={money(s.revenue)} hint={`заказов: ${s.orders}, банок: ${s.units}`} />
        <Kpi label="Себестоимость" value={money(s.cost)} hint={d.incomplete ? 'без товаров с неизвестной себестоимостью' : undefined} />
        <Kpi label={shared ? 'ЧИСТАЯ ПРИБЫЛЬ' : 'Прибыль канала'} value={money(d.net_profit)} hint={d.incomplete ? 'неполная' : shared ? undefined : 'до общих расходов и зарплат'} />
        <Kpi label="Вложено в закупки" value={money(d.purchases_invested_uzs)} hint="за период, для сведения" />
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Сводка</h2>
          <table className="table">
            <tbody>
              <Line label="Выручка" value={s.revenue} />
              <Line label="− Себестоимость проданных банок" value={-s.cost} />
              {d.incomplete && <Line label="  себестоимость неизвестна (выручка этих продаж)" value={s.revenue_without_cost} muted />}
              <Line label="− Комиссия Яндекса" value={-s.commission} />
              <Line label="− Расходы на доставку (наши)" value={-s.delivery} />
              <Line label="− Налог с оборота" value={-s.tax} />
              {shared ? (
                <>
                  {/* аудит 2.13: прибыль от продаж до общих расходов — отдельной строкой, чтобы не путать с чистой */}
                  <tr>
                    <td className="strong">= Маржинальная прибыль (с продаж)</td>
                    <td className="num strong">{money(d.net_profit + d.other_expenses + d.salaries)}</td>
                  </tr>
                  <Line label="− Прочие расходы" value={-d.other_expenses} />
                  <Line label="− Зарплаты (начислено за период)" value={-d.salaries} />
                </>
              ) : (
                <tr>
                  <td colSpan={2} className="muted small">
                    Прочие расходы и зарплаты общие для магазина — они вычитаются только в режиме «Все каналы».
                  </td>
                </tr>
              )}
              <tr>
                <td className="strong">
                  {shared ? 'ЧИСТАЯ ПРИБЫЛЬ' : 'Прибыль канала'} {d.incomplete && <Badge tone="warn">неполная</Badge>}
                </td>
                <td className={`num strong ${d.net_profit < 0 ? 'text-bad' : ''}`}>{money(d.net_profit)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>По каналам</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Канал</th>
                <th className="num">Выручка</th>
                <th className="num">Себест.</th>
                <th className="num">Комиссия</th>
                <th className="num">Доставка</th>
                <th className="num">Налог</th>
                <th className="num">Прибыль</th>
              </tr>
            </thead>
            <tbody>
              {(['yandex', 'vitalo'] as const)
                .filter((c) => !channel || c === channel)
                .map((c) => (
                  <ChannelRow key={c} label={c === 'yandex' ? 'Яндекс' : 'VITALO'} t={d.channels[c]} />
                ))}
              {shared && (
                <>
                  <tr>
                    <td>Общие (расходы и зарплаты)</td>
                    <td colSpan={5} className="muted small">
                      не делятся по каналам
                    </td>
                    <td className="num">{money(-(d.other_expenses + d.salaries))}</td>
                  </tr>
                  <tr>
                    <td className="strong">Итого</td>
                    <td className="num strong">{money(s.revenue)}</td>
                    <td className="num">{money(s.cost)}</td>
                    <td className="num">{money(s.commission)}</td>
                    <td className="num">{money(s.delivery)}</td>
                    <td className="num">{money(s.tax)}</td>
                    <td className="num strong">{money(d.net_profit)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {/* аудит 10.11, п. 1.11: один блок «Топ товаров» — таблица с прибылью и маржой (список-дубль убран) */}
      <section className="card flush">
        <div className="section-head pad">
          <h2>Топ товаров</h2>
        </div>
        <table className="table table-hover">
          <thead>
            <tr>
              <th>Товар</th>
              <th className="num">Шт.</th>
              <th className="num">Выручка</th>
              <th className="num">Прибыль</th>
              <th className="num">Маржа</th>
            </tr>
          </thead>
          <tbody>
            {d.products.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  За период продаж нет
                </td>
              </tr>
            )}
            {d.products.map((p) => (
              <tr key={p.product_id}>
                <td>
                  <Link to={`/products/${p.product_id}`} className="strong">
                    {p.sku}
                  </Link>{' '}
                  {p.name}
                </td>
                <td className="num">{p.qty}</td>
                <td className="num">{money(p.revenue)}</td>
                <td className="num">
                  {money(p.profit)} {p.incomplete && <Badge tone="warn">неполная</Badge>}
                </td>
                <td className="num">{p.margin_percent === null ? '—' : `${p.margin_percent}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-foot">
          <span className="muted small">Прибыль товара = выручка − себестоимость банок − комиссия Яндекса (без доставки, налога и общих расходов).</span>
        </div>
      </section>

      <h2 className="section-title">Требует внимания</h2>
      <div className="grid-2">
        <section className="card">
          <h2>Заказы «Нужно внимание склада» ({d.attention.orders_waiting_units.length})</h2>
          {d.attention.orders_waiting_units.length ? (
            <ul className="plain-list">
              {d.attention.orders_waiting_units.map((o) => (
                <li key={o.id}>
                  <Link to={`/orders/${o.id}`} className="strong">
                    {o.order_number}
                  </Link>{' '}
                  <span className="muted small">{o.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Таких заказов нет.</p>
          )}
        </section>
        <section className="card">
          <h2>Залежалые: есть на полке, нет продаж 60 дней ({d.attention.stale.length})</h2>
          {d.attention.stale.length ? (
            <ul className="plain-list">
              {d.attention.stale.slice(0, 30).map((p) => (
                <li key={p.product_id}>
                  <Link to={`/products/${p.product_id}`} className="strong">
                    {p.sku}
                  </Link>{' '}
                  {p.name} — {p.on_shelf} шт.
                </li>
              ))}
              {d.attention.stale.length > 30 && <li className="muted small">…и ещё {d.attention.stale.length - 30}</li>}
            </ul>
          ) : (
            <p className="muted">Залежалых товаров нет.</p>
          )}
        </section>
      </div>
      <section className="card">
        <h2>Банки со сроком годности меньше 90 дней ({d.attention.expiring.length})</h2>
        {d.attention.expiring.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Physical ID</th>
                <th>Товар</th>
                <th>Годен до</th>
              </tr>
            </thead>
            <tbody>
              {d.attention.expiring.map((u) => (
                <tr key={u.id} className={u.expired ? 'row-bad' : ''}>
                  <td className="strong">{u.physical_id}</td>
                  <td>
                    {u.sku} {u.name}
                  </td>
                  <td>
                    {ruDate(u.expiry_date)} {u.expired && <Badge tone="bad">истёк</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Таких банок на складе нет.</p>
        )}
      </section>
    </>
  );
}

const ChannelRow = ({ label, t }: { label: string; t: Totals }) => (
  <tr>
    <td>{label}</td>
    <td className="num">{money(t.revenue)}</td>
    <td className="num">{money(t.cost)}</td>
    <td className="num">{money(t.commission)}</td>
    <td className="num">{money(t.delivery)}</td>
    <td className="num">{money(t.tax)}</td>
    <td className="num">{money(t.profit)}</td>
  </tr>
);

const Line = ({ label, value, muted }: { label: string; value: number; muted?: boolean }) => (
  <tr className={muted ? 'muted small' : ''}>
    <td>{label}</td>
    <td className="num">{money(value)}</td>
  </tr>
);

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="muted small">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}
