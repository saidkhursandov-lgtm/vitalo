import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, Modal, OrderStatus, PageHead, Pagination } from '../components/ui';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money, prettyPhone } from '../lib/format';
import { BackIcon } from '../components/Icons';
import { TestFlag, useShowTest } from '../components/TestFlag';

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
}

interface CustomerProfile extends Omit<CustomerRow, 'paid_orders' | 'spent_uzs'> {
  bonus_balance_uzs: number;
  addresses: { id: string; label: string | null; region: string; city: string; address_text: string; is_primary: boolean }[];
  orders: { id: string; order_number: string; created_at: string; status: string; total_uzs: number }[];
}

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
                <th className="num">Оплачено заказов</th>
                <th className="num">Сумма покупок</th>
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
                  <td className="num">{c.paid_orders}</td>
                  <td className="num">{money(c.spent_uzs)}</td>
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
            <dt>Бонусы</dt>
            <dd>{money(c.bonus_balance_uzs)}</dd>
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
                    <td>{can('orders.view') ? <Link to={`/orders/${o.id}`}>{o.order_number}</Link> : o.order_number}</td>
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
