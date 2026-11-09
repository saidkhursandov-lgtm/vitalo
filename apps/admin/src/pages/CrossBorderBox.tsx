import { Link } from 'react-router-dom';
import { Badge } from '../components/ui';
import { dateTime, ruDate } from '../lib/format';

/** D-61: «из США» of a foreign supplier, «у поставщика» of a local one. */
function stageLabels(from: string) {
  return {
    paid: `Оплачен, ждёт заказа ${from === 'у поставщика' ? 'у поставщика' : from}`,
    ordered: `Заказан ${from}`,
    shipped: `Отправлен ${from}`,
    arrived_uz: 'Прибыл в Узбекистан',
    in_stock: 'Банки на складе',
  } as Record<string, string>;
}

/** D-60/D-61: in the order card — what the customer sees about the «под заказ» lines, with a way to the deliveries. */
export function CrossBorderBox({
  cb,
}: {
  cb: {
    stage: string | null;
    kind?: 'foreign' | 'local';
    from_ru?: string | null;
    lines_waiting: number;
    expected_from: string | null;
    expected_to: string | null;
    steps: { stage: string; done: boolean; at: string | null }[];
    delays: { at: string; expected_to: string | null; reason: string | null }[];
  };
}) {
  const waiting = cb.stage !== 'in_stock';
  const from = cb.kind === 'local' ? 'у поставщика' : (cb.from_ru ?? 'из США');
  const STAGE = stageLabels(from);
  return (
    <section className="card">
      <div className="cb-box-head">
        <h2>{cb.kind === 'local' ? 'Товар под заказ у поставщика' : `Товар под заказ ${from}`}</h2>
        <Badge tone={waiting ? 'info' : 'ok'}>{cb.stage ? STAGE[cb.stage] ?? cb.stage : '—'}</Badge>
      </div>
      <p>
        {waiting ? (
          <>
            Ждём банок: строк — {cb.lines_waiting}. Обещали покупателю: {cb.expected_from && cb.expected_from !== cb.expected_to ? `${ruDate(cb.expected_from)} – ` : ''}
            {ruDate(cb.expected_to)}. Собрать заказ можно, когда все банки будут на складе.
          </>
        ) : (
          'Все банки под заказ на складе — заказ можно собирать.'
        )}{' '}
        <Link to="/cross-border">Поставки под заказ</Link>
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
