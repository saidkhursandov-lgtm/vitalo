import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime } from '../lib/format';

type Status = 'open' | 'answered' | 'closed';
export const TOPIC_LABELS: Record<string, string> = {
  product: 'Вопрос о товаре',
  medical: 'Медицинский вопрос / Подбор',
  order: 'По заказу',
  promo: 'Акции и промокоды',
  tech: 'Технический вопрос',
};
const STATUS_LABELS: Record<Status, string> = { open: 'Ждут ответа', answered: 'Отвечены', closed: 'Закрыты' };
const STATUS_ONE: Record<Status, string> = { open: 'Ждёт ответа', answered: 'Есть ответ', closed: 'Закрыто' };
const STATUS_TONE: Record<Status, 'warn' | 'ok' | 'neutral'> = { open: 'warn', answered: 'ok', closed: 'neutral' };

interface Row {
  id: string;
  number: string;
  topic: string;
  status: Status;
  lang: 'ru' | 'uz';
  rating: number | null;
  started_by: 'customer' | 'staff';
  customer: string;
  product: string | null;
  order_number: string | null;
  last_text: string;
  last_author: 'customer' | 'staff';
  last_message_at: string;
}
interface Thread {
  id: string;
  number: string;
  topic: string;
  status: Status;
  lang: 'ru' | 'uz';
  rating: number | null;
  started_by: 'customer' | 'staff';
  closed_at: string | null;
  closed_by: string | null;
  customer: { name: string; phone: string | null; username: string | null };
  product: { id: string; sku: string; name: string } | null;
  order: { id: string; number: string } | null;
  messages: { id: string; author: 'customer' | 'staff'; staff: string | null; text: string; created_at: string }[];
}

const Stars = ({ n }: { n: number }) => (
  <span className="support-stars" aria-label={`Оценка ${n} из 5`}>
    {'★'.repeat(n)}
    <span className="muted">{'★'.repeat(5 - n)}</span>
  </span>
);

/**
 * 6а-Д (D-62), 6б-Б (D-63): «Обращения» — requests from the Mini App and the ones the shop started from an order.
 * A reply goes to the customer's «Уведомления → Личные» and as a bot message. Medical requests are seen only by
 * admins and specialists (D-40). Closing asks the customer to rate the answer (1–5).
 */
export function SupportList() {
  const [status, setStatus] = useState<Status>('open');
  const list = useQuery({ queryKey: ['support', status], queryFn: () => api<{ counts: Partial<Record<Status, number>>; items: Row[] }>(`/staff/support/threads?status=${status}`) });
  return (
    <div className="page">
      <PageHead title="Обращения покупателей" />
      <p className="muted">Вопросы из Mini App и переписка по заказам. Ответ придёт покупателю в «Уведомления → Личные» и сообщением в бот. Написать первым — в карточке заказа.</p>
      <div className="segmented" role="tablist">
        {(Object.keys(STATUS_LABELS) as Status[]).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={s === status} className={s === status ? 'is-on' : ''} onClick={() => setStatus(s)}>
            {STATUS_LABELS[s]}
            {!!list.data?.counts[s] && ` · ${list.data.counts[s]}`}
          </button>
        ))}
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <p className="muted">Здесь пусто.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>№</th>
                <th>Когда</th>
                <th>Тема</th>
                <th>Покупатель</th>
                <th>Последнее сообщение</th>
                {status === 'closed' && <th>Оценка</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">
                    <Link to={`/support/${r.id}`}>№{r.number}</Link>
                  </td>
                  <td className="nowrap">{dateTime(r.last_message_at)}</td>
                  <td>
                    <Link to={`/support/${r.id}`}>{TOPIC_LABELS[r.topic] ?? r.topic}</Link>
                    {r.order_number && <div className="muted small">Заказ {r.order_number}</div>}
                    {r.product && <div className="muted small">{r.product}</div>}
                  </td>
                  <td>
                    {r.customer} <Badge>{r.lang.toUpperCase()}</Badge>
                  </td>
                  <td>
                    {r.last_author === 'staff' && <span className="muted">Вы: </span>}
                    {r.last_text}
                  </td>
                  {status === 'closed' && <td className="nowrap">{r.rating ? <Stars n={r.rating} /> : <span className="muted">—</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SupportThread() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const [text, setText] = useState('');
  const thread = useQuery({ queryKey: ['support', 'thread', id], queryFn: () => api<Thread>(`/staff/support/threads/${id}`) });
  const done = (t: Thread) => {
    client.setQueryData(['support', 'thread', id], t);
    void client.invalidateQueries({ queryKey: ['support'] });
    setText('');
  };
  const reply = useMutation({
    mutationFn: () => api<Thread>(`/staff/support/threads/${id}/reply`, { method: 'POST', body: { text: text.trim() } }),
    onSuccess: done,
  });
  // 6б-Б: closing may carry the last message (it goes to the customer with the request to rate)
  const close = useMutation({ mutationFn: () => api<Thread>(`/staff/support/threads/${id}/close`, { method: 'POST', body: { text: text.trim() || undefined } }), onSuccess: done });

  if (thread.isPending) return <Loading />;
  if (thread.isError) return <ErrorBox error={thread.error} onRetry={() => void thread.refetch()} />;
  const t = thread.data;
  const mayAnswer = can('support.answer');
  const closed = t.status === 'closed';
  return (
    <div className="page">
      <Link to="/support">‹ Обращения</Link>
      <PageHead title={`Обращение №${t.number} · ${TOPIC_LABELS[t.topic] ?? t.topic}`}>
        <Badge tone={STATUS_TONE[t.status]}>{STATUS_ONE[t.status]}</Badge>
      </PageHead>
      <div className="card support-head">
        <p>
          <strong>{t.customer.name}</strong> {t.customer.username && <span className="muted">@{t.customer.username}</span>} {t.customer.phone && <span className="muted">{t.customer.phone}</span>} · язык ответа: {t.lang === 'uz' ? 'узбекский' : 'русский'}
        </p>
        {t.order && (
          <p>
            Заказ: <Link to={`/orders/${t.order.id}`}>{t.order.number}</Link>
            {t.started_by === 'staff' && <span className="muted"> · переписку начал магазин</span>}
          </p>
        )}
        {t.product && (
          <p>
            Товар: <Link to={`/products/${t.product.id}`}>{t.product.sku} {t.product.name}</Link>
          </p>
        )}
        {closed && (
          <p>
            Закрыто {t.closed_at && dateTime(t.closed_at)}
            {t.closed_by && ` · ${t.closed_by}`} · оценка: {t.rating ? <Stars n={t.rating} /> : <span className="muted">ещё не поставлена</span>}
          </p>
        )}
      </div>
      <ol className="support-chat">
        {t.messages.map((m) => (
          <li key={m.id} className={`support-msg is-${m.author}`}>
            <div className="muted small">
              {m.author === 'staff' ? m.staff ?? 'Сотрудник' : 'Покупатель'} · {dateTime(m.created_at)}
            </div>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      {mayAnswer && (
        <div className="card">
          <Field
            label={closed ? 'Написать снова (обращение откроется)' : 'Ответ покупателю'}
            hint="Покупатель получит его в Mini App («Личные») и сообщением в бот. Пишите на языке покупателя. «Закрыть обращение» отправит этот текст последним сообщением (можно пусто) и попросит оценить ответ."
          >
            <textarea rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ErrorBox error={reply.error ?? close.error} />
          <div className="row-actions">
            <button type="button" className="btn" disabled={!text.trim() || reply.isPending} onClick={() => reply.mutate()}>
              {reply.isPending ? 'Отправляем…' : 'Ответить'}
            </button>
            {!closed && (
              <button type="button" className="btn btn-secondary" disabled={close.isPending} onClick={() => close.mutate()}>
                {text.trim() ? 'Ответить и закрыть' : 'Закрыть обращение'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 6б-Б: in the order card — the requests about this order and «Написать покупателю» (the shop writes first). */
export function OrderSupport({ orderId }: { orderId: string }) {
  const { can } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const list = useQuery({ queryKey: ['support', 'order', orderId], queryFn: () => api<{ id: string; number: string; topic: string; status: Status; last_message_at: string }[]>(`/staff/support/orders/${orderId}`) });
  const start = useMutation({
    mutationFn: () => api<Thread>('/staff/support/threads', { method: 'POST', body: { order_id: orderId, text: text.trim() } }),
    onSuccess: (t) => navigate(`/support/${t.id}`),
  });
  return (
    <section className="card">
      <h2>Переписка с покупателем</h2>
      {list.data && list.data.length > 0 ? (
        <ul className="plain-list">
          {list.data.map((t) => (
            <li key={t.id}>
              <Link to={`/support/${t.id}`}>Обращение №{t.number}</Link> · {TOPIC_LABELS[t.topic] ?? t.topic} · <Badge tone={STATUS_TONE[t.status]}>{STATUS_ONE[t.status]}</Badge> <span className="muted small">{dateTime(t.last_message_at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">По этому заказу переписки нет.</p>
      )}
      {can('support.answer') &&
        (open ? (
          <>
            <Field label="Сообщение покупателю" hint="Придёт в Mini App («Уведомления → Личные») и в бот как «Обращение №… · заказ …». Покупатель ответит прямо в Mini App.">
              <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <ErrorBox error={start.error} />
            <div className="row-actions">
              <button type="button" className="btn" disabled={!text.trim() || start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? 'Отправляем…' : 'Отправить'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Отмена
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
            Написать покупателю
          </button>
        ))}
    </section>
  );
}
