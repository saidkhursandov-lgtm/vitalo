import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, Loading } from '../components/ui';
import { api } from '../lib/api';

interface FunnelStep {
  event: string;
  users: number;
  conversion_pct: number | null;
}

const STEP_NAMES: Record<string, string> = {
  app_open: 'Открыли магазин',
  product_view: 'Смотрели товар',
  add_to_cart: 'Добавили в корзину',
  checkout_start: 'Начали оформление',
  order_created: 'Создали заказ',
  payment_marked: 'Нажали «Я оплатил(а)»',
  payment_confirmed: 'Оплата подтверждена',
};
const PERIODS = [
  ['today', 'Сегодня'],
  ['7', '7 дней'],
  ['30', '30 дней'],
] as const;

/** Funnel for the period: unique customers on each step and the share that came from the previous step (B3). */
export function FunnelCard() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>('7');
  const q = useQuery({ queryKey: ['funnel', period], queryFn: () => api<{ steps: FunnelStep[] }>(`/staff/dashboard/funnel?period=${period}`) });
  const top = Math.max(1, ...(q.data?.steps.map((s) => s.users) ?? [1]));
  return (
    <section className="card">
      <div className="section-head">
        <h2>Воронка за период</h2>
        <div className="segmented">
          {PERIODS.map(([p, label]) => (
            <button key={p} className={period === p ? 'is-on' : ''} onClick={() => setPeriod(p)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">Уникальные покупатели на каждом шаге; процент — сколько дошло с предыдущего шага.</p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <table className="table funnel">
          <tbody>
            {q.data.steps.map((s) => (
              <tr key={s.event}>
                <td>{STEP_NAMES[s.event] ?? s.event}</td>
                <td className="funnel-bar-cell">
                  <span className="funnel-bar" style={{ width: `${(s.users / top) * 100}%` }} />
                </td>
                <td className="num strong">{s.users}</td>
                <td className="num muted">{s.conversion_pct == null ? '' : `${s.conversion_pct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
