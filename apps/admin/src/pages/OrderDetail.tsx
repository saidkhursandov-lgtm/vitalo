import { OrderReceipts } from '../components/OrderReceipts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, Modal, OrderStatus, PageHead, PaymentStatus } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money, ORDER_STATUS, orderStatusLabel, PAYMENT_METHOD, prettyPhone, yandexMapsLink } from '../lib/format';
import { CheckIcon, ForwardIcon } from '../components/Icons';
import { OrderAssembly, ReturnOrderModal, type Assembly } from './OrderAssembly';
import { OrderFinance, TestBadge } from '../components/OrderFinance';
import { OrderShipping } from './OrderLabel';
import { CrossBorderBox } from './CrossBorderBox';

interface Named {
  id: string;
  name_ru: string;
}

export interface AdminOrder {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  created_at: string;
  reserved_until: string | null;
  paid_at: string | null;
  recipient: { name: string; phone: string };
  delivery: { region: Named; city: Named; address_text: string; latitude: number | null; longitude: number | null; cost_uzs: number; method: string };
  customer_comment: string | null;
  /** 3.7: list_price_uzs — the regular price when the line was bought in a sale (unit_price_uzs is the sale price) */
  items: { product_id: string; sku: string; name_ru: string; qty: number; unit_price_uzs: number; list_price_uzs?: number; line_total_uzs: number; cross_border?: boolean }[];
  /** D-60: lines «Под заказ из США» — the stage, the promised window, the moved dates */
  cross_border?: {
    stage: string | null;
    lines_waiting: number;
    expected_from: string | null;
    expected_to: string | null;
    steps: { stage: string; done: boolean; at: string | null }[];
    delays: { at: string; expected_to: string | null; reason: string | null }[];
  } | null;
  totals: { goods_list_total_uzs?: number; goods_total_uzs: number; discount_total_uzs: number; delivery_cost_uzs: number; total_uzs: number };
  /** 3.7: «Акция 11.11: −X сум» lines (frozen at checkout) */
  campaigns?: { promotion_id: string; title_ru: string; amount_uzs: number }[];
  /** 3.3: the promo code of the order (frozen at checkout) */
  promo?: { code: string; discount_uzs: number; free_delivery: boolean } | null;
  payment: { method: string; status: string; amount_uzs: number; customer_reported_paid_at: string | null; verified_at: string | null } | null;
  history: { from_status: string | null; to_status: string; reason: string | null; changed_by_type: string; created_at: string }[];
  customer: { id: string; name: string; username: string | null; telegram_user_id: number; status: string };
  edits: { reason: string; before: Record<string, unknown>; after: Record<string, unknown>; staff_name: string; created_at: string }[];
  tasks: { type: string; status: string; note: string | null; created_at: string }[];
  actions: { confirm_payment: boolean; next_status: string | null; cancel: boolean; edit: boolean; locked: boolean; units: boolean; return_order: boolean; print_label?: boolean; waybill?: boolean };
  is_test?: boolean;
  /** waybill number of the delivery service, printed on the label */
  delivery_waybill?: string | null;
  /** Stage 3: only for the admin */
  finance?: { own_delivery_cost_uzs: number };
  /** Stage 2E: jars of unit-tracked lines (null when the order has none) */
  assembly: Assembly | null;
  /** 3.2: what the customer was told (bot + Mini App centre) */
  customer_notifications?: CustomerNotification[];
}

export interface CustomerNotification {
  id: string;
  template: string;
  text: string;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  read_at: string | null;
}

interface Region extends Named {
  cities: Named[];
}

const ACTOR: Record<string, string> = { customer: 'клиент', staff: 'сотрудник', system: 'система' };
const FIELD: Record<string, string> = {
  recipient_name: 'Получатель',
  recipient_phone: 'Телефон',
  address_text: 'Адрес',
  customer_comment: 'Комментарий',
  region_id: 'Регион',
  city_id: 'Город',
  delivery_cost_uzs: 'Доставка',
  total_uzs: 'Итого',
};

export function OrderDetail() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<AdminOrder>(`/staff/orders/${id}`) });
  const [modal, setModal] = useState<'confirm' | 'cancel' | 'edit' | 'return' | null>(null);

  const done = (o: AdminOrder) => {
    client.setQueryData(['order', id], o);
    void client.invalidateQueries({ queryKey: ['orders'] });
    setModal(null);
  };
  const nextStatus = useMutation({
    mutationFn: (status: string) => api<AdminOrder>(`/staff/orders/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: done,
  });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const a = o.actions;

  return (
    <>
      <PageHead
        title={
          <>
            Заказ {o.order_number} <OrderStatus status={o.status} cod={o.payment?.method === 'cod'} /> <PaymentStatus status={o.payment_status} /> <TestBadge show={o.is_test} />
          </>
        }
      >
        {a.confirm_payment && (
          <button className="btn" onClick={() => setModal('confirm')}>
            {o.payment?.method === 'cod' ? 'Подтвердить заказ' : 'Подтвердить оплату'}
          </button>
        )}
        {a.next_status && (
          <button className="btn" disabled={nextStatus.isPending} onClick={() => nextStatus.mutate(a.next_status!)}>
            Перевести: {ORDER_STATUS[a.next_status]}
          </button>
        )}
        {a.edit && (
          <button className="btn btn-ghost" onClick={() => setModal('edit')}>
            Изменить
          </button>
        )}
        {a.cancel && (
          <button className="btn btn-danger" onClick={() => setModal('cancel')}>
            Отменить заказ
          </button>
        )}
        {a.return_order && (
          <button className="btn btn-ghost" onClick={() => setModal('return')}>
            Оформить возврат
          </button>
        )}
      </PageHead>

      <ErrorBox error={nextStatus.error} />
      {a.locked && (
        <div className="alert alert-info">
          Заказ передан в доставку: редактирование и отмена здесь заблокированы. Если заказ вернулся — «Оформить возврат» (склад и администратор).
        </div>
      )}
      <OrderAssembly order={o} onDone={(next) => client.setQueryData(['order', id], next)} />
      <OrderShipping
        key={o.delivery_waybill ?? ''}
        orderId={o.id}
        waybill={o.delivery_waybill ?? null}
        canPrint={!!a.print_label}
        canEdit={!!a.waybill}
        onSaved={() => void q.refetch()}
      />
      {o.finance && (
        <OrderFinance
          key={`${o.is_test}|${o.finance.own_delivery_cost_uzs}`}
          channel="vitalo"
          id={o.id}
          isTest={!!o.is_test}
          ownDelivery={o.finance.own_delivery_cost_uzs}
          onDone={() => {
            void q.refetch();
            void client.invalidateQueries({ queryKey: ['orders'] });
          }}
        />
      )}
      {modal === 'return' && <ReturnOrderModal order={o} onDone={done} onClose={() => setModal(null)} />}
      {o.payment?.method === 'cod' && o.payment_status === 'payment_pending' && o.status === 'new' && (
        <div className="alert alert-warn">
          Оплата при получении (только г. Ташкент). Позвоните клиенту и подтвердите заказ; деньги забирает курьер. Заказ не отменяется сам — через 3 часа придёт напоминание.
        </div>
      )}
      {o.payment?.customer_reported_paid_at && o.payment_status === 'payment_pending' && (
        <div className="alert alert-warn">
          Клиент нажал «Я оплатил» {dateTime(o.payment.customer_reported_paid_at)}. Проверьте поступление на счёт и подтвердите оплату.
        </div>
      )}
      {o.cross_border && <CrossBorderBox cb={o.cross_border} />}
      <OrderReceipts orderId={o.id} />

      <div className="grid-2">
        <section className="card">
          <h2>Состав заказа</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Цена</th>
                <th className="num">Кол-во</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i) => (
                <tr key={i.product_id}>
                  <td>
                    <Link to={`/products/${i.product_id}`}>{i.name_ru}</Link>
                    {i.cross_border && <> <Badge tone="info">из США</Badge></>}
                    <div className="muted small">{i.sku}</div>
                  </td>
                  <td className="num">
                    {money(i.unit_price_uzs)}
                    {i.list_price_uzs != null && i.list_price_uzs > i.unit_price_uzs && <div className="muted small strike">{money(i.list_price_uzs)}</div>}
                  </td>
                  <td className="num">{i.qty}</td>
                  <td className="num">{money(i.line_total_uzs)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Товары</td>
                <td className="num">{money(o.totals.goods_list_total_uzs ?? o.totals.goods_total_uzs)}</td>
              </tr>
              {(o.campaigns ?? []).map((c) => (
                <tr key={c.promotion_id}>
                  <td colSpan={3}>Акция «{c.title_ru}»</td>
                  <td className="num">−{money(c.amount_uzs)}</td>
                </tr>
              ))}
              {o.totals.discount_total_uzs > 0 && (
                <tr>
                  <td colSpan={3}>{o.promo ? `Промокод ${o.promo.code}` : 'Скидка'}</td>
                  <td className="num">−{money(o.totals.discount_total_uzs)}</td>
                </tr>
              )}
              <tr>
                <td colSpan={3}>Доставка</td>
                <td className="num">{o.totals.delivery_cost_uzs ? money(o.totals.delivery_cost_uzs) : o.promo?.free_delivery ? `бесплатно (промокод ${o.promo.code})` : 'бесплатно'}</td>
              </tr>
              <tr className="strong">
                <td colSpan={3}>Итого к оплате</td>
                <td className="num">{money(o.totals.total_uzs)}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        <section className="card">
          <h2>Доставка и клиент</h2>
          <dl className="props">
            <dt>Получатель</dt>
            <dd>
              {o.recipient.name}, {prettyPhone(o.recipient.phone)}
            </dd>
            <dt>Адрес</dt>
            <dd>
              {o.delivery.region.name_ru}, {o.delivery.city.name_ru}
              <br />
              {o.delivery.address_text}
            </dd>
            {/* 3.6: the point the customer chose on the map; orders without it — nothing */}
            {o.delivery.latitude != null && o.delivery.longitude != null && (
              <>
                <dt>Точка на карте</dt>
                <dd>
                  <a href={yandexMapsLink(o.delivery.latitude, o.delivery.longitude)} target="_blank" rel="noopener noreferrer">
                    Открыть в Яндекс Картах
                  </a>
                </dd>
              </>
            )}
            {o.customer_comment && (
              <>
                <dt>Комментарий</dt>
                <dd className="pre-line">{o.customer_comment}</dd>
              </>
            )}
            <dt>Клиент</dt>
            <dd>
              {can('customers.view') ? <Link to={`/customers/${o.customer.id}`}>{o.customer.name}</Link> : o.customer.name}
              {o.customer.username && <span className="muted"> @{o.customer.username}</span>}
              {o.customer.status !== 'active' && <span className="text-bad"> (заблокирован)</span>}
            </dd>
            <dt>Оплата</dt>
            <dd>
              {PAYMENT_METHOD[o.payment?.method ?? ''] ?? o.payment?.method} · {money(o.payment?.amount_uzs)}
              {o.payment?.verified_at && <div className="muted small">подтверждено {dateTime(o.payment.verified_at)}</div>}
            </dd>
            <dt>Создан</dt>
            <dd>{dateTime(o.created_at)}</dd>
            {o.reserved_until && (
              <>
                <dt>Резерв до</dt>
                <dd>{dateTime(o.reserved_until)}</dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>История статусов</h2>
          <ol className="timeline">
            {o.history.map((h, i) => (
              <li key={i}>
                <strong>{orderStatusLabel(h.to_status, o.payment?.method === 'cod')}</strong> <span className="muted small">{dateTime(h.created_at)} · {ACTOR[h.changed_by_type]}</span>
                {h.reason && <div className="small">{h.reason}</div>}
              </li>
            ))}
          </ol>
        </section>

        <section className="card">
          <h2>Изменения заказа</h2>
          {o.edits.length === 0 ? (
            <p className="muted">Заказ не редактировался</p>
          ) : (
            o.edits.map((e, i) => (
              <div key={i} className="edit-entry">
                <div className="small">
                  <strong>{e.staff_name}</strong> · {dateTime(e.created_at)} · «{e.reason}»
                </div>
                <ul className="small">
                  {Object.keys(e.after).map((k) => (
                    <li key={k}>
                      {FIELD[k] ?? k}: <s className="muted">{String(e.before[k] ?? '—')}</s> <ForwardIcon size={13} className="inline-icon" /> {String(e.after[k] ?? '—')}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {o.tasks.length > 0 && (
            <>
              <h3>Задачи менеджера</h3>
              {o.tasks.map((t, i) => (
                <div key={i} className="small">
                  {t.status === 'done' ? <CheckIcon size={14} className="inline-icon text-ok" /> : <span className="badge-dot inline-icon" aria-hidden />} {t.note ?? t.type} <span className="muted">({dateTime(t.created_at)})</span>
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      {o.customer_notifications && <CustomerNotifications rows={o.customer_notifications} />}

      {modal === 'confirm' && <ConfirmPayment order={o} onDone={done} onClose={() => setModal(null)} />}
      {modal === 'cancel' && <CancelOrder order={o} onDone={done} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditOrder order={o} onDone={done} onClose={() => setModal(null)} />}
    </>
  );
}

type ModalProps = { order: AdminOrder; onDone: (o: AdminOrder) => void; onClose: () => void };

const DELIVERY: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  sent: { label: 'Доставлено в бот', tone: 'ok' },
  queued: { label: 'В очереди', tone: 'warn' },
  sending: { label: 'Отправляется', tone: 'warn' },
  failed: { label: 'Не доставлено', tone: 'bad' },
  skipped: { label: 'Не отправлялось', tone: 'neutral' },
};

/** 3.2: messages the customer got about this order — what, when, delivered to the bot or not, read in the Mini App. */
function CustomerNotifications({ rows }: { rows: CustomerNotification[] }) {
  return (
    <section className="card">
      <h2>Уведомления клиенту</h2>
      {rows.length === 0 ? (
        <p className="muted">Клиенту ещё ничего не отправлялось</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Что</th>
                <th>Когда</th>
                <th>Доставка</th>
                <th>В Mini App</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => {
                const d = DELIVERY[n.status] ?? { label: n.status, tone: 'neutral' as const };
                return (
                  <tr key={n.id}>
                    <td>{n.text}</td>
                    <td className="small">{dateTime(n.created_at)}</td>
                    <td>
                      <Badge tone={d.tone}>{d.label}</Badge>
                      {n.sent_at && <div className="muted small">{dateTime(n.sent_at)}</div>}
                      {n.status !== 'sent' && n.error && <div className="muted small">{n.error}</div>}
                    </td>
                    <td className="small">{n.read_at ? `прочитано ${dateTime(n.read_at)}` : <span className="muted">не открыто</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ConfirmPayment({ order, onDone, onClose }: ModalProps) {
  const [comment, setComment] = useState('');
  const cod = order.payment?.method === 'cod';
  const m = useMutation({
    mutationFn: () => api<AdminOrder>(`/staff/orders/${order.id}/confirm-payment`, { method: 'POST', body: { comment: comment || undefined } }),
    onSuccess: onDone,
  });
  return (
    <Modal title={cod ? 'Подтвердить заказ' : 'Подтвердить оплату'} onClose={onClose}>
      {cod ? (
        <p>
          Вы связались с клиентом и он подтвердил заказ {order.order_number} на <strong>{money(order.payment?.amount_uzs)}</strong>? Оплата — курьеру при получении.
          Заказ пойдёт на сборку.
        </p>
      ) : (
        <p>
          {PAYMENT_METHOD[order.payment?.method ?? ''] ?? 'Перевод'}: деньги поступили — <strong>{money(order.payment?.amount_uzs)}</strong> за заказ {order.order_number}?
          Резерв товара превратится в списание, заказ станет «Оплачен».
        </p>
      )}
      <Field label="Комментарий (необязательно)">
        <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button className="btn" disabled={m.isPending} onClick={() => m.mutate()}>
          {cod ? 'Подтвердить заказ' : 'Подтвердить оплату'}
        </button>
      </div>
    </Modal>
  );
}

function CancelOrder({ order, onDone, onClose }: ModalProps) {
  const [reason, setReason] = useState('');
  // D-53: a confirmed cash-on-delivery order already holds stock like a paid one
  const paid = order.payment_status === 'payment_success' || !['new', 'awaiting_payment'].includes(order.status);
  const m = useMutation({
    mutationFn: () => api<AdminOrder>(`/staff/orders/${order.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: onDone,
  });
  return (
    <Modal title={`Отменить заказ ${order.order_number}`} onClose={onClose}>
      <p>
        {paid && order.payment_status === 'payment_pending'
          ? 'Заказ подтверждён (оплата при получении): товар вернётся на склад. Деньги курьеру ещё не отдавали — возвращать нечего.'
          : paid
          ? 'Заказ оплачен: товар вернётся на склад, будет создана задача «вернуть деньги клиенту» (возврат делается вручную).'
          : 'Резерв товара будет снят, товар снова станет доступен.'}
      </p>
      <Field label="Причина (обязательно, видна в истории)">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Не отменять
        </button>
        <button className="btn btn-danger" disabled={!reason.trim() || m.isPending} onClick={() => m.mutate()}>
          Отменить заказ
        </button>
      </div>
    </Modal>
  );
}

function EditOrder({ order, onDone, onClose }: ModalProps) {
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => api<Region[]>('/delivery/regions') });
  const [f, setF] = useState({
    recipient_name: order.recipient.name,
    recipient_phone: order.recipient.phone,
    region_id: order.delivery.region.id,
    city_id: order.delivery.city.id,
    address_text: order.delivery.address_text,
    customer_comment: order.customer_comment ?? '',
    reason: '',
  });
  const unpaid = order.payment_status === 'payment_pending';
  const m = useMutation({
    mutationFn: () => {
      const { reason, ...fields } = f;
      const body: Record<string, string> = { reason };
      if (fields.recipient_name !== order.recipient.name) body.recipient_name = fields.recipient_name;
      if (fields.recipient_phone !== order.recipient.phone) body.recipient_phone = fields.recipient_phone;
      if (fields.address_text !== order.delivery.address_text) body.address_text = fields.address_text;
      if (fields.customer_comment !== (order.customer_comment ?? '')) body.customer_comment = fields.customer_comment;
      if (fields.city_id !== order.delivery.city.id) Object.assign(body, { region_id: fields.region_id, city_id: fields.city_id });
      return api<AdminOrder>(`/staff/orders/${order.id}`, { method: 'PATCH', body });
    },
    onSuccess: onDone,
  });
  const region = regions.data?.find((r) => r.id === f.region_id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  return (
    <Modal title={`Изменить заказ ${order.order_number}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Получатель">
            <input value={f.recipient_name} onChange={(e) => setF({ ...f, recipient_name: e.target.value })} />
          </Field>
          <Field label="Телефон">
            <input value={f.recipient_phone} onChange={(e) => setF({ ...f, recipient_phone: e.target.value })} />
          </Field>
          <Field label="Регион" hint={unpaid ? 'Смена города пересчитает доставку' : 'Заказ оплачен — город менять нельзя'}>
            <select disabled={!unpaid} value={f.region_id} onChange={(e) => setF({ ...f, region_id: e.target.value, city_id: '' })}>
              {regions.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name_ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Город / район">
            <select disabled={!unpaid} value={f.city_id} onChange={(e) => setF({ ...f, city_id: e.target.value })}>
              <option value="">—</option>
              {region?.cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ru}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Адрес">
          <input value={f.address_text} onChange={(e) => setF({ ...f, address_text: e.target.value })} />
        </Field>
        <Field label="Комментарий клиента">
          <textarea rows={3} maxLength={500} value={f.customer_comment} onChange={(e) => setF({ ...f, customer_comment: e.target.value })} />
        </Field>
        <Field label="Причина изменения (обязательно, попадёт в журнал)">
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn" disabled={!f.reason.trim() || !f.city_id || m.isPending}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
