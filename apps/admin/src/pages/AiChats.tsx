import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Help, Loading, Modal, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { GOAL, type Goal } from './CompatGoals';

type Topic = Goal | 'compat' | 'other';
type Outcome = 'answered' | 'clarify' | 'off_topic' | 'red_flag' | 'failed';
type Review = 'ok' | 'wrong';
type Fit = 'helps' | 'maybe' | 'unlikely' | 'no_data';

interface ChatUser {
  id: string;
  name: string;
  username: string | null;
}
export interface AiChatRow {
  id: string;
  number: string;
  created_at: string;
  lang: 'ru' | 'uz';
  topic: Topic | null;
  outcome: Outcome | null;
  questions: number;
  empty_cart: boolean;
  cost_usd: number;
  model: string | null;
  review: Review | null;
  deleted: boolean;
  purged: boolean;
  user: ChatUser;
}
interface ChatList {
  month: string;
  months: string[];
  total: number;
  cost_usd: number;
  items: AiChatRow[];
}
interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  kind: string;
  text: string | null;
  created_at: string;
  model: string | null;
  cost_usd: number;
  latency_ms: number | null;
  error: string | null;
  products?: { product_id: string; name: string; fit: Fit | null; level_text: string | null; text: string; in_cart: boolean }[];
  steps?: string[];
  followups?: string[];
  options?: string[];
  doctor?: string | null;
}
interface ChatDetail extends Omit<AiChatRow, 'review'> {
  updated_at: string;
  cart: { product_id: string; sku: string; name: string }[];
  review: Review | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  messages: ChatMessage[];
}

export const TOPIC: Record<Topic, string> = { ...GOAL, compat: 'Совместимость', other: 'Другое' };
export const OUTCOME: Record<Outcome, [string, 'ok' | 'info' | 'warn' | 'bad' | 'neutral']> = {
  answered: ['Ответ', 'ok'],
  clarify: ['Уточнение', 'info'],
  off_topic: ['Не по теме', 'neutral'],
  red_flag: ['К врачу', 'warn'],
  failed: ['Не ответил', 'bad'],
};
const REVIEW: Record<Review, [string, 'ok' | 'bad']> = { ok: ['Верно', 'ok'], wrong: ['Ошибка', 'bad'] };
const FIT: Record<Fit, string> = { helps: 'Может помочь', maybe: 'Поможет при условии', unlikely: 'Скорее не поможет', no_data: 'Данных немного' };
const KIND: Record<string, string> = {
  question: 'Вопрос',
  answer: 'Ответ',
  clarify: 'Уточнение',
  off_topic: 'Не по теме',
  red_flag: 'К врачу (без модели)',
  failed: 'Не ответил',
};
const usd = (v: number) => `$${v.toFixed(v < 0.01 && v > 0 ? 4 : 2)}`;
const monthName = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1, 15)).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const FILTERS = ['month', 'lang', 'topic', 'outcome', 'empty', 'review', 'q'] as const;

/**
 * D-70: «VITALO AI → Переписки» — the conversations of customers with VITALO AI by month. Only the admin and the
 * specialist; each opening of a conversation is in the audit log. The texts are kept 12 months («Настройки → VITALO
 * AI»), phones and e-mails are cut out; the customer may delete a conversation.
 */
export function AiChats() {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState(params.get('q') ?? '');
  const filter = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTERS)[number], string>;
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ['ai-chats', query], queryFn: () => api<ChatList>(`/staff/ai/chats${query ? `?${query}` : ''}`) });
  const set = (k: (typeof FILTERS)[number], v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const d = list.data;

  return (
    <>
      <PageHead title="VITALO AI → Переписки" />
      <Help id="ai-chats">
        Вопросы покупателей к VITALO AI из корзины и средней кнопки меню. Номер — AI-ГГГГММДД-NNNN. Телефоны и почта
        вырезаны; текст хранится 12 месяцев, покупатель может удалить переписку сам. Каждое открытие переписки
        записывается в журнал действий. Отметьте ответ «Верно» или «Ошибка» — это помогает улучшать VITALO AI.
      </Help>
      <div className="filters">
        <select aria-label="Месяц" value={d?.month ?? filter.month} onChange={(e) => set('month', e.target.value)}>
          {(d?.months ?? []).map((m) => (
            <option key={m} value={m}>
              {monthName(m)}
            </option>
          ))}
        </select>
        <select aria-label="Язык" value={filter.lang} onChange={(e) => set('lang', e.target.value)}>
          <option value="">Все языки</option>
          <option value="ru">RU</option>
          <option value="uz">UZ</option>
        </select>
        <select aria-label="Тема" value={filter.topic} onChange={(e) => set('topic', e.target.value)}>
          <option value="">Все темы</option>
          {(Object.keys(TOPIC) as Topic[]).map((t) => (
            <option key={t} value={t}>
              {TOPIC[t]}
            </option>
          ))}
        </select>
        <select aria-label="Итог" value={filter.outcome} onChange={(e) => set('outcome', e.target.value)}>
          <option value="">Любой итог</option>
          {(Object.keys(OUTCOME) as Outcome[]).map((o) => (
            <option key={o} value={o}>
              {OUTCOME[o][0]}
            </option>
          ))}
        </select>
        <select aria-label="Корзина" value={filter.empty} onChange={(e) => set('empty', e.target.value)}>
          <option value="">Любая корзина</option>
          <option value="no">С товарами</option>
          <option value="yes">Пустая корзина</option>
        </select>
        <select aria-label="Проверка" value={filter.review} onChange={(e) => set('review', e.target.value)}>
          <option value="">Любая проверка</option>
          <option value="none">Не проверено</option>
          <option value="ok">Верно</option>
          <option value="wrong">Ошибка</option>
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q.trim());
          }}
        >
          <input type="search" placeholder="Номер или покупатель" aria-label="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : d && d.items.length === 0 ? (
        <section className="card">
          <p className="muted">За этот месяц переписок нет.</p>
        </section>
      ) : (
        d && (
          <>
            <p className="muted small">
              Переписок: {d.total}
              {d.total > d.items.length && ` (показаны последние ${d.items.length})`} · расход модели: {usd(d.cost_usd)}
            </p>
            <div className="card flush table-scroll">
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th>Номер</th>
                    <th>Дата</th>
                    <th>Покупатель</th>
                    <th>Тема</th>
                    <th>Итог</th>
                    <th>Вопросов</th>
                    <th>Проверка</th>
                    <th>Стоимость</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.id} onClick={() => setOpen(c.id)}>
                      <td>
                        <button type="button" className="link" onClick={() => setOpen(c.id)}>
                          {c.number}
                        </button>
                        {c.deleted && <Badge>Удалена покупателем</Badge>}
                        {c.purged && <Badge>Текст стёрт</Badge>}
                      </td>
                      <td>{dateTime(c.created_at)}</td>
                      <td>
                        {c.user.name || (c.user.username ? `@${c.user.username}` : '—')} <span className="muted">{c.lang.toUpperCase()}</span>
                      </td>
                      <td>
                        {c.topic ? TOPIC[c.topic] : '—'}
                        {c.empty_cart && <span className="muted"> · пустая корзина</span>}
                      </td>
                      <td>{c.outcome ? <Badge tone={OUTCOME[c.outcome][1]}>{OUTCOME[c.outcome][0]}</Badge> : '—'}</td>
                      <td>{c.questions}</td>
                      <td>{c.review ? <Badge tone={REVIEW[c.review][1]}>{REVIEW[c.review][0]}</Badge> : <span className="muted">—</span>}</td>
                      <td>{usd(c.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
      {open && <ChatModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ChatModal({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useQueryClient();
  const chat = useQuery({ queryKey: ['ai-chat', id], queryFn: () => api<ChatDetail>(`/staff/ai/chats/${id}`), staleTime: Infinity });
  const [note, setNote] = useState<string | null>(null);
  const review = useMutation({
    mutationFn: (v: { review: Review | 'none'; note: string }) => api(`/staff/ai/chats/${id}`, { method: 'PATCH', body: v }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['ai-chat', id] });
      void client.invalidateQueries({ queryKey: ['ai-chats'] });
    },
  });
  const c = chat.data;
  const text = note ?? c?.review_note ?? '';
  return (
    <Modal title={c ? `Переписка ${c.number}` : 'Переписка'} onClose={onClose} wide>
      {chat.isLoading ? (
        <Loading />
      ) : chat.error ? (
        <ErrorBox error={chat.error} />
      ) : (
        c && (
          <div className="ai-chat-detail">
            <dl className="kv">
              <dt>Покупатель</dt>
              <dd>
                <Link to={`/customers/${c.user.id}`}>{c.user.name || (c.user.username ? `@${c.user.username}` : 'Открыть')}</Link> · {c.lang.toUpperCase()}
              </dd>
              <dt>Начата</dt>
              <dd>{dateTime(c.created_at)}</dd>
              <dt>Корзина</dt>
              <dd>{c.empty_cart ? 'пустая' : c.cart.map((p) => `${p.name} (${p.sku})`).join(', ')}</dd>
              <dt>Модель и расход</dt>
              <dd>
                {c.model ?? '—'} · {usd(c.cost_usd)}
              </dd>
            </dl>
            {c.deleted || c.purged ? (
              <p className="muted small">{c.deleted ? 'Покупатель удалил переписку — текст стёрт.' : 'Срок хранения истёк — текст стёрт.'}</p>
            ) : (
              <ol className="ai-chat-log">
                {c.messages.map((m) => (
                  <li key={m.id} className={`is-${m.role}`}>
                    <div className="ai-chat-log-head">
                      <strong>{m.role === 'user' ? 'Покупатель' : 'VITALO AI'}</strong>
                      <span className="muted">
                        {KIND[m.kind] ?? m.kind} · {dateTime(m.created_at)}
                        {m.role === 'ai' && m.model && ` · ${m.model}, ${usd(m.cost_usd)}${m.latency_ms ? `, ${(m.latency_ms / 1000).toFixed(1)} с` : ''}`}
                      </span>
                    </div>
                    {m.text && <p>{m.text}</p>}
                    {m.error && <p className="muted small">Причина: {m.error}</p>}
                    {!!m.options?.length && <p className="muted">Варианты: {m.options.join(' · ')}</p>}
                    {!!m.products?.length && (
                      <ul>
                        {m.products.map((p) => (
                          <li key={p.product_id}>
                            <strong>{p.name}</strong>
                            {p.fit && ` — ${FIT[p.fit]}`}
                            {p.level_text && <span className="muted"> ({p.level_text})</span>}
                            {!p.in_cart && <span className="muted"> · из каталога</span>}: {p.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!!m.steps?.length && <p className="muted">Советы: {m.steps.join(' · ')}</p>}
                    {m.doctor && <p className="muted">{m.doctor}</p>}
                    {!!m.followups?.length && <p className="muted">Следующие вопросы: {m.followups.join(' · ')}</p>}
                  </li>
                ))}
              </ol>
            )}
            <div className="card">
              <Field label="Проверка специалиста" hint={c.reviewed_by ? `${c.reviewed_by}, ${dateTime(c.reviewed_at!)}` : undefined}>
                <textarea rows={2} maxLength={1000} placeholder="Комментарий: что не так или что учесть" value={text} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="modal-actions">
                <button type="button" className={`btn${c.review === 'ok' ? '' : ' btn-ghost'}`} disabled={review.isPending} onClick={() => review.mutate({ review: 'ok', note: text })}>
                  Верно
                </button>
                <button type="button" className={`btn${c.review === 'wrong' ? ' btn-danger' : ' btn-ghost'}`} disabled={review.isPending} onClick={() => review.mutate({ review: 'wrong', note: text })}>
                  Ошибка
                </button>
                {c.review && (
                  <button type="button" className="btn btn-ghost" disabled={review.isPending} onClick={() => review.mutate({ review: 'none', note: '' })}>
                    Снять отметку
                  </button>
                )}
              </div>
              {review.error && <ErrorBox error={review.error} />}
            </div>
          </div>
        )
      )}
    </Modal>
  );
}
