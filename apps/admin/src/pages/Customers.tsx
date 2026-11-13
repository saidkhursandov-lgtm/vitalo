import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, Modal, OrderStatus, PageHead, Pagination } from '../components/ui';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money, prettyPhone } from '../lib/format';
import { BackIcon } from '../components/Icons';
import { TestFlag, useShowTest } from '../components/TestFlag';
import { CustomerBonus, type CustomerBonusInfo } from '../components/CustomerBonus';

interface CustomerRow {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  language: string;
  status: string;
  is_test?: boolean;
  created_at: string;
  paid_orders: number;
  spent_uzs: number;
  /** аудит 4.1: all orders, cancelled ones too */
  total_orders: number;
  last_activity_at: string;
  marketing_opt_in: boolean;
}

interface CustomerProfile extends CustomerRow {
  bonus_balance_uzs: number;
  /** 3.10-А */
  bonus?: CustomerBonusInfo;
  addresses: { id: string; label: string | null; region: string; city: string; address_text: string; is_primary: boolean }[];
  orders: { id: string; order_number: string; created_at: string; status: string; total_uzs: number; is_test?: boolean }[];
  support: { id: string; number: number; topic: string; status: string; last_message_at: string }[];
  compat: { id: string; created_at: string; status: string; verdict: string | null; source: string; products: string[] }[];
  notes: { id: string; text: string; created_at: string; staff_name: string }[];
}

const TOPIC: Record<string, string> = { medical: 'Здоровье и приём', order: 'Заказ', promo: 'Акции и бонусы', tech: 'Техническое' };
const SUPPORT_STATUS: Record<string, [string, 'warn' | 'ok' | 'neutral']> = { open: ['ждёт ответа', 'warn'], answered: ['ответили', 'ok'], closed: ['закрыто', 'neutral'] };
const VERDICT: Record<string, string> = { compatible: 'можно вместе', spread: 'разнести по времени', consult: 'нужна консультация' };
const COMPAT_STATUS: Record<string, string> = { pending: 'ждёт ответа', answered: 'отвечен', closed: 'закрыт (корзина изменилась)' };

const fullName = (c: { first_name: string; last_name: string | null }) => [c.first_name, c.last_name].filter(Boolean).join(' ');
const StatusBadge = ({ status }: { status: string }) => <Badge tone={status === 'active' ? 'ok' : 'bad'}>{status === 'active' ? 'Активен' : 'Заблокирован'}</Badge>;

export function Customers() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const page = Number(params.get('page')) || 1;
  const { hideTest, toggle: testToggle } = useShowTest();
  const q = useQuery({
    queryKey: ['customers', params.toString()],
    queryFn: () => api<{ items: CustomerRow[]; total: number; total_pages: number }>(`/staff/customers${qs({ q: params.get('q'), status: params.get('status'), hide_test: hideTest, page })}`),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHead title="Клиенты" />
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', text);
        }}
      >
        <input placeholder="Имя, @username, телефон или Telegram ID — Enter" value={text} onChange={(e) => setText(e.target.value)} />
        <select value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Статус">
          <option value="">Все</option>
          <option value="active">Активные</option>
          <option value="blocked">Заблокированные</option>
        </select>
        {testToggle}
      </form>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Telegram</th>
                <th>Регистрация</th>
                <th>Активность</th>
                <th className="num" title="Все заказы, с отменёнными / из них оплачено">Заказов / оплачено</th>
                <th className="num">Сумма покупок</th>
                <th>Язык</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/customers/${c.id}`} className="strong">
                      {fullName(c)}
                    </Link>
                    {c.is_test && (
                      <>
                        {' '}
                        <Badge tone="warn">Тест</Badge>
                      </>
                    )}
                    {c.phone && <div className="muted small">{prettyPhone(c.phone)}</div>}
                  </td>
                  <td>
                    {c.username ? `@${c.username}` : '—'}
                    <div className="muted small">ID {c.telegram_user_id}</div>
                  </td>
                  <td>{dateTime(c.created_at)}</td>
                  <td>{dateTime(c.last_activity_at)}</td>
                  <td className="num">
                    {c.total_orders} / {c.paid_orders}
                  </td>
                  <td className="num">{money(c.spent_uzs)}</td>
                  <td>
                    {c.language === 'uz' ? 'UZ' : 'RU'}
                    {!c.marketing_opt_in && <div className="muted small">без рассылок</div>}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Всего: {q.data.total}</span>
            <Pagination page={page} totalPages={q.data.total_pages} onPage={(p) => set('page', String(p))} />
          </div>
        </section>
      )}
    </>
  );
}

export function CustomerDetail() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api<CustomerProfile>(`/staff/customers/${id}`) });
  const [modal, setModal] = useState(false);
  const [reason, setReason] = useState('');
  const toggle = useMutation({
    mutationFn: (block: boolean) => api<CustomerProfile>(`/staff/customers/${id}/${block ? 'block' : 'unblock'}`, { method: 'POST', body: { reason } }),
    onSuccess: (c) => {
      client.setQueryData(['customer', id], c);
      void client.invalidateQueries({ queryKey: ['customers'] });
      setModal(false);
      setReason('');
    },
  });

  // аудит 4.1: staff notes about the customer
  const [note, setNote] = useState('');
  const addNote = useMutation({
    mutationFn: () => api<CustomerProfile>(`/staff/customers/${id}/notes`, { method: 'POST', body: { text: note } }),
    onSuccess: (c) => {
      client.setQueryData(['customer', id], c);
      setNote('');
    },
  });
  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) addNote.mutate();
  };

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const blocked = c.status !== 'active';

  return (
    <>
      <PageHead
        title={
          <>
            {fullName(c)} <StatusBadge status={c.status} />
          </>
        }
      >
        <Link to="/customers" className="btn btn-ghost">
          <BackIcon /> К списку
        </Link>
        {can('customers.block') && (
          <button className={`btn ${blocked ? '' : 'btn-danger'}`} onClick={() => setModal(true)}>
            {blocked ? 'Разблокировать' : 'Заблокировать'}
          </button>
        )}
      </PageHead>

      <div className="grid-2">
        <section className="card">
          <h2>Профиль</h2>
          <dl className="props">
            <dt>Telegram</dt>
            <dd>
              {c.username ? `@${c.username}` : '—'} · ID {c.telegram_user_id}
            </dd>
            <dt>Телефон</dt>
            <dd>{c.phone ? prettyPhone(c.phone) : '—'}</dd>
            <dt>Язык</dt>
            <dd>{c.language === 'uz' ? 'Узбекский' : 'Русский'}</dd>
            <dt>Регистрация</dt>
            <dd>{dateTime(c.created_at)}</dd>
            <dt>Последняя активность</dt>
            <dd>{dateTime(c.last_activity_at)}</dd>
            <dt>Рассылки</dt>
            <dd>{c.marketing_opt_in ? 'получает акции и новости' : 'отказался от рассылок'}</dd>
            <dt>Заказы</dt>
            <dd>
              всего {c.total_orders}, оплачено {c.paid_orders} на {money(c.spent_uzs)}
            </dd>
            <dt>Бонусы</dt>
            <dd>{money(c.bonus_balance_uzs)}{c.bonus?.expires_on && <span className="muted small"> · сгорят {c.bonus.expires_on.split('-').reverse().join('.')}</span>}</dd>
          </dl>
          <TestFlag entity="customer" id={c.id} value={!!c.is_test} invalidate={['customer', id]} />
          <h3>Адреса</h3>
          {c.addresses.length === 0 && <p className="muted">Нет сохранённых адресов</p>}
          {c.addresses.map((a) => (
            <p key={a.id} className="small">
              {a.is_primary && <Badge tone="ok">Основной</Badge>} {a.label && <strong>{a.label}: </strong>}
              {a.region}, {a.city}, {a.address_text}
            </p>
          ))}
        </section>
        <section className="card">
          <h2>Заказы</h2>
          {c.orders.length === 0 ? (
            <p className="muted">Заказов нет</p>
          ) : (
            <table className="table">
              <tbody>
                {c.orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {can('orders.view') ? <Link to={`/orders/${o.id}`}>{o.order_number}</Link> : o.order_number}
                      {o.is_test && (
                        <>
                          {' '}
                          <Badge tone="warn">Тест</Badge>
                        </>
                      )}
                    </td>
                    <td>{dateTime(o.created_at)}</td>
                    <td>
                      <OrderStatus status={o.status} />
                    </td>
                    <td className="num">{money(o.total_uzs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Обращения</h2>
          {c.support.length === 0 ? (
            <p className="muted">Обращений нет</p>
          ) : (
            <table className="table">
              <tbody>
                {c.support.map((t) => (
                  <tr key={t.id}>
                    <td>{can('support.view') ? <Link to={`/support/${t.id}`}>№{String(t.number).padStart(4, '0')}</Link> : `№${String(t.number).padStart(4, '0')}`}</td>
                    <td>{TOPIC[t.topic] ?? t.topic}</td>
                    <td>
                      <Badge tone={SUPPORT_STATUS[t.status]?.[1] ?? 'neutral'}>{SUPPORT_STATUS[t.status]?.[0] ?? t.status}</Badge>
                    </td>
                    <td className="muted small">{dateTime(t.last_message_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>Вопросы о совместимости</h2>
          {c.compat.length === 0 ? (
            <p className="muted">Вопросов нет</p>
          ) : (
            <table className="table">
              <tbody>
                {c.compat.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{r.products.join(', ') || '—'}</td>
                    <td>{r.verdict ? VERDICT[r.verdict] ?? r.verdict : COMPAT_STATUS[r.status] ?? r.status}</td>
                    <td className="muted small">{dateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {c.compat.length > 0 && can('compat.view') && (
            <p className="small">
              <Link to="/compat">Комментарии покупателя — в разделе «Вопросы о совместимости»</Link>
            </p>
          )}
        </section>
        {c.bonus && <CustomerBonus customerId={c.id} bonus={c.bonus} />}
        <section className="card">
          <h2>Заметки</h2>
          <p className="muted small">Видят сотрудники с доступом к клиентам. Заметки не удаляются.</p>
          <form onSubmit={submitNote} className="note-form">
            <textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Например: просит звонить после 18:00" aria-label="Новая заметка" />
            <button type="submit" className="btn btn-sm" disabled={!note.trim() || addNote.isPending}>
              Добавить заметку
            </button>
          </form>
          <ErrorBox error={addNote.error} />
          {c.notes.map((n) => (
            <div key={n.id} className="note">
              <p>{n.text}</p>
              <div className="muted small">
                {n.staff_name} · {dateTime(n.created_at)}
              </div>
            </div>
          ))}
        </section>
      </div>

      {modal && (
        <Modal title={blocked ? 'Разблокировать клиента' : 'Заблокировать клиента'} onClose={() => setModal(false)}>
          <p>{blocked ? 'Клиент снова сможет входить в магазин.' : 'Клиент сразу выйдет из магазина и не сможет войти снова.'}</p>
          <Field label="Причина (обязательно, попадёт в журнал)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBox error={toggle.error} />
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setModal(false)}>
              Отмена
            </button>
            <button className={`btn ${blocked ? '' : 'btn-danger'}`} disabled={!reason.trim() || toggle.isPending} onClick={() => toggle.mutate(!blocked)}>
              {blocked ? 'Разблокировать' : 'Заблокировать'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
