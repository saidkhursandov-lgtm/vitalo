import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime } from '../lib/format';

type Status = 'open' | 'answered' | 'closed';
export const TOPIC_LABELS: Record<string, string> = {
  medical: 'Медицинский вопрос / Подбор',
  order: 'По заказу',
  promo: 'Акции и промокоды',
  tech: 'Технический вопрос',
};
const STATUS_LABELS: Record<Status, string> = { open: 'Ждут ответа', answered: 'Отвечены', closed: 'Закрыты' };

interface Row {
  id: string;
  topic: string;
  status: Status;
  lang: 'ru' | 'uz';
  customer: string;
  product: string | null;
  last_text: string;
  last_author: 'customer' | 'staff';
  last_message_at: string;
}
interface Thread {
  id: string;
  topic: string;
  status: Status;
  lang: 'ru' | 'uz';
  customer: { name: string; phone: string | null; username: string | null };
  product: { id: string; sku: string; name: string } | null;
  messages: { id: string; author: 'customer' | 'staff'; staff: string | null; text: string; created_at: string }[];
}

/**
 * 6а-Д (D-62): «Обращения» — questions from «Спросить специалиста» in the Mini App. The reply goes to the customer's
 * «Уведомления → Личные» and as a bot message. Medical questions are seen only by admins and specialists (D-40).
 */
export function SupportList() {
  const [status, setStatus] = useState<Status>('open');
  const list = useQuery({ queryKey: ['support', status], queryFn: () => api<{ counts: Partial<Record<Status, number>>; items: Row[] }>(`/staff/support/threads?status=${status}`) });
  return (
    <div className="page">
      <PageHead title="Обращения покупателей" />
      <p className="muted">Вопросы из Mini App («Спросить специалиста»). Ответ придёт покупателю в «Уведомления → Личные» и сообщением в бот.</p>
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
                <th>Когда</th>
                <th>Тема</th>
                <th>Покупатель</th>
                <th>Последнее сообщение</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{dateTime(r.last_message_at)}</td>
                  <td>
                    <Link to={`/support/${r.id}`}>{TOPIC_LABELS[r.topic] ?? r.topic}</Link>
                    {r.product && <div className="muted small">{r.product}</div>}
                  </td>
                  <td>
                    {r.customer} <Badge>{r.lang.toUpperCase()}</Badge>
                  </td>
                  <td>
                    {r.last_author === 'staff' && <span className="muted">Вы: </span>}
                    {r.last_text}
                  </td>
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
  };
  const reply = useMutation({
    mutationFn: () => api<Thread>(`/staff/support/threads/${id}/reply`, { method: 'POST', body: { text: text.trim() } }),
    onSuccess: (t) => {
      done(t);
      setText('');
    },
  });
  const close = useMutation({ mutationFn: () => api<Thread>(`/staff/support/threads/${id}/close`, { method: 'POST' }), onSuccess: done });

  if (thread.isPending) return <Loading />;
  if (thread.isError) return <ErrorBox error={thread.error} onRetry={() => void thread.refetch()} />;
  const t = thread.data;
  const mayAnswer = can('support.answer');
  return (
    <div className="page">
      <Link to="/support">‹ Обращения</Link>
      <PageHead title={TOPIC_LABELS[t.topic] ?? t.topic}>
        <Badge tone={t.status === 'open' ? 'warn' : t.status === 'answered' ? 'ok' : 'neutral'}>{STATUS_LABELS[t.status]}</Badge>
      </PageHead>
      <div className="card">
        <p>
          <strong>{t.customer.name}</strong> {t.customer.username && <span className="muted">@{t.customer.username}</span>} {t.customer.phone && <span className="muted">{t.customer.phone}</span>} · язык ответа: {t.lang === 'uz' ? 'узбекский' : 'русский'}
        </p>
        {t.product && (
          <p>
            Товар: <Link to={`/products/${t.product.id}`}>{t.product.sku} {t.product.name}</Link>
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
          <Field label="Ответ покупателю" hint="Покупатель получит его в Mini App («Личные») и сообщением в бот. Пишите на языке покупателя.">
            <textarea rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ErrorBox error={reply.error ?? close.error} />
          <div className="row-actions">
            <button type="button" className="btn" disabled={!text.trim() || reply.isPending} onClick={() => reply.mutate()}>
              {reply.isPending ? 'Отправляем…' : 'Ответить'}
            </button>
            {t.status !== 'closed' && (
              <button type="button" className="btn btn-secondary" disabled={close.isPending} onClick={() => close.mutate()}>
                Закрыть без ответа
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
