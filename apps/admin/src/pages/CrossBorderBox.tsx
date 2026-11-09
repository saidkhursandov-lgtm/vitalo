import { Link } from 'react-router-dom';
import { Badge } from '../components/ui';
import { dateTime, ruDate } from '../lib/format';

const STAGE: Record<string, string> = {
  paid: 'Оплачен, ждёт заказа в США',
  ordered: 'Заказан в США',
  shipped: 'Отправлен из США',
  arrived_uz: 'Прибыл в Узбекистан',
  in_stock: 'Банки на складе',
};

/** D-60: in the order card — what the customer sees about the lines «из США», with a way to the parcels. */
export function CrossBorderBox({
  cb,
}: {
  cb: { stage: string | null; lines_waiting: number; expected_from: string | null; expected_to: string | null; steps: { stage: string; done: boolean; at: string | null }[]; delays: { at: string; expected_to: string | null; reason: string | null }[] };
}) {
  const waiting = cb.stage !== 'in_stock';
  return (
    <section className="card">
      <div className="cb-box-head">
        <h2>Товар из США</h2>
        <Badge tone={waiting ? 'info' : 'ok'}>{cb.stage ? STAGE[cb.stage] ?? cb.stage : '—'}</Badge>
      </div>
      <p>
        {waiting ? (
          <>
            Ждём банок: строк — {cb.lines_waiting}. Обещали покупателю: {cb.expected_from && cb.expected_from !== cb.expected_to ? `${ruDate(cb.expected_from)} – ` : ''}
            {ruDate(cb.expected_to)}. Собрать заказ можно, когда все банки будут на складе.
          </>
        ) : (
          'Все банки из США на складе — заказ можно собирать.'
        )}{' '}
        <Link to="/cross-border">Посылки из США</Link>
      </p>
      <ol className="cb-steps">
        {cb.steps.map((s) => (
          <li key={s.stage} className={s.done ? 'is-done' : ''}>
            <span>{s.stage === 'paid' ? 'Оплачен' : STAGE[s.stage] ?? s.stage}</span>
            <span className="muted small">{s.at ? dateTime(s.at) : '—'}</span>
          </li>
        ))}
      </ol>
      {cb.delays.map((d) => (
        <p key={d.at} className="small">
          {dateTime(d.at)}: дата сдвинута до {ruDate(d.expected_to)}
          {d.reason && ` — ${d.reason}`}
        </p>
      ))}
    </section>
  );
}
