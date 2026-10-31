import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { BackIcon } from '../components/Icons';
import { Badge, ErrorBox, Loading, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, prettyPhone } from '../lib/format';

interface WaitlistProduct {
  product_id: string;
  sku: string;
  name: string;
  status: string;
  available_qty: number;
  waiting: number;
  notified: number;
  /** 2.4 patch: switched the bell off before the product came back */
  cancelled: number;
  last_at: string | null;
}

interface WaitlistDetail {
  product: { id: string; sku: string; name: string; available_qty: number };
  customers: { user_id: string; name: string; username: string | null; telegram_user_id: string; phone: string | null; created_at: string; notified_at: string | null; cancelled_at: string | null }[];
}

/**
 * 2.4: «Лист ожидания» — products customers asked «Сообщить о поступлении» for. The bot writes to them by itself when the
 * product is in stock again (once per subscription); here staff only see who waits.
 */
export function Waitlist() {
  const q = useQuery({ queryKey: ['waitlist'], queryFn: () => api<WaitlistProduct[]>('/staff/waitlist') });
  return (
    <>
      <PageHead title="Лист ожидания" />
      <p className="muted">
        Когда остаток товара станет больше нуля, бот сам напишет ожидающим «… снова в наличии» с кнопкой «Открыть товар» —
        один раз на каждую заявку. «Ждут» — только действующие заявки; кто сам выключил колокольчик, считается отдельно в
        «Отменили» и сообщения не получит.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data.length ? (
        <section className="card">
          <p className="muted">Заявок пока нет.</p>
        </section>
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Ждут</th>
                <th className="num">Уже уведомлены</th>
                <th className="num">Отменили</th>
                <th className="num">Остаток</th>
                <th>Последняя заявка</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.product_id}>
                  <td>
                    <Link to={`/waitlist/${p.product_id}`} className="strong">
                      {p.name}
                    </Link>
                    <div className="muted small">{p.sku}</div>
                  </td>
                  <td className="num">{p.waiting ? <strong>{p.waiting}</strong> : 0}</td>
                  <td className="num">{p.notified}</td>
                  <td className="num">{p.cancelled}</td>
                  <td className="num">{p.available_qty > 0 ? p.available_qty : <Badge tone="warn">нет</Badge>}</td>
                  <td>{p.last_at ? dateTime(p.last_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export function WaitlistProductPage() {
  const { productId = '' } = useParams();
  const q = useQuery({ queryKey: ['waitlist', productId], queryFn: () => api<WaitlistDetail>(`/staff/waitlist/${productId}`) });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const { product, customers } = q.data;
  return (
    <>
      <PageHead
        title={
          <>
            <Link to="/waitlist" className="icon-btn" aria-label="Назад">
              <BackIcon />
            </Link>{' '}
            {product.name}
          </>
        }
      />
      <p className="muted">
        {product.sku} · остаток: {product.available_qty > 0 ? product.available_qty : 'нет'} · ждут: {customers.filter((c) => !c.notified_at && !c.cancelled_at).length}
      </p>
      <section className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Telegram</th>
              <th>Телефон</th>
              <th>Заявка</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.user_id}>
                <td>
                  <Link to={`/customers/${c.user_id}`} className="strong">
                    {c.name}
                  </Link>
                </td>
                <td>
                  {c.username ? `@${c.username}` : '—'}
                  <div className="muted small">ID {c.telegram_user_id}</div>
                </td>
                <td>{c.phone ? prettyPhone(c.phone) : '—'}</td>
                <td>{dateTime(c.created_at)}</td>
                <td>
                  {c.notified_at ? (
                    <Badge tone="ok">Уведомлён {dateTime(c.notified_at)}</Badge>
                  ) : c.cancelled_at ? (
                    <Badge>Отменил {dateTime(c.cancelled_at)}</Badge>
                  ) : (
                    <Badge tone="info">Ждёт</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
