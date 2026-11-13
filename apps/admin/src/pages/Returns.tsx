import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Help, Loading, Modal, PageHead, Pagination } from '../components/ui';
import { api, apiBlob } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money } from '../lib/format';

type Status = 'requested' | 'approved' | 'refunded' | 'rejected' | 'closed';
type Method = 'card' | 'cash' | 'payme' | 'click' | 'other';

interface ReturnRow {
  id: string;
  status: Status;
  reason: string;
  comment: string | null;
  full_order: boolean;
  created_at: string;
  order: { id: string; number: string; delivered_at: string | null; total_uzs: number; payment: string | null; recipient: string; phone: string };
  customer: { id: string; name: string };
  items: { sku: string; name: string; qty: number; line_qty: number; amount_uzs: number }[];
  suggested_uzs: number;
  media: string[];
  refund_amount_uzs: number | null;
  approved_by: string | null;
  approved_at: string | null;
  reject_reason: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  refund_method: Method | null;
  refund_comment: string | null;
  refunded_by: string | null;
  refunded_at: string | null;
  bonus_reversed_uzs: number;
  bonus_returned_uzs: number;
}
interface ReturnList {
  counts: Partial<Record<Status, number>>;
  total: number;
  items: ReturnRow[];
}

const STATUS: [Status, string][] = [
  ['requested', 'Новые'],
  ['approved', 'Одобрены — вернуть деньги'],
  ['refunded', 'Деньги возвращены'],
  ['rejected', 'Отклонены'],
];
export const RETURN_REASON: Record<string, string> = {
  damaged: 'Товар повреждён',
  wrong_item: 'Привезли не тот товар',
  not_as_described: 'Не соответствует описанию',
  unsuitable: 'Не подошёл',
  changed_mind: 'Передумал',
  other: 'Другое',
};
export const REFUND_METHOD: Record<Method, string> = { card: 'Перевод на карту', cash: 'Наличными', payme: 'Через Payme', click: 'Через Click', other: 'Другое' };
const PAYMENT: Record<string, string> = { card_transfer: 'перевод на карту', bank_transfer: 'банковский перевод', payme: 'Payme', click: 'Click', cod: 'при получении' };
const PAGE_SIZE = 30;

/**
 * 3.10-В: «Возвраты» — requests from «Мои заказы → Вернуть товар» (a damaged or a wrong item, photos, 14 days).
 * «Одобрить» with the amount: the whole order goes to «Возврат» (jars on check), a part — the order stays delivered,
 * the bonuses of the returned lines go back; then «Деньги возвращены» (the refund itself is manual).
 */
export function Returns() {
  const [params, setParams] = useSearchParams();
  const status = (STATUS.find(([k]) => k === params.get('status'))?.[0] ?? 'requested') as Status;
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ['returns', status, page], queryFn: () => api<ReturnList>(`/staff/returns?status=${status}&page=${page}`) });
  const d = list.data;
  return (
    <>
      <PageHead title="Возвраты" />
      <Help id="returns">
        Заявки покупателей из «Мои заказы → Вернуть товар»: в течение 14 дней после получения, только «товар повреждён» или
        «привезли не тот товар» (пока юрист не ответил про возврат БАД надлежащего качества), с фото. «Одобрить» — укажите
        сумму к возврату: если возвращают весь заказ, он перейдёт в «Возврат» и банки — на проверку склада; если часть —
        заказ остаётся доставленным, кешбэк за эти товары забирается, списанные бонусы возвращаются. Затем верните деньги
        и нажмите «Деньги возвращены». Покупатель получает сообщение на каждом шаге.
      </Help>
      <div className="segmented" role="group" aria-label="Статус">
        {STATUS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={status === k ? 'is-on' : ''}
            aria-pressed={status === k}
            onClick={() => {
              setParams({ status: k }, { replace: true });
              setPage(1);
            }}
          >
            {label}
            {d?.counts[k] ? ` · ${d.counts[k]}` : ''}
          </button>
        ))}
      </div>
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : d && d.items.length === 0 ? (
        <section className="card">
          <p className="muted">{status === 'requested' ? 'Новых заявок нет.' : 'Здесь пока пусто.'}</p>
        </section>
      ) : (
        d && (
          <>
            <div className="review-list">
              {d.items.map((r) => (
                <ReturnCard key={r.id} row={r} />
              ))}
            </div>
            <Pagination page={page} totalPages={Math.max(1, Math.ceil(d.total / PAGE_SIZE))} onPage={setPage} />
          </>
        )
      )}
    </>
  );
}

function ReturnCard({ row: r }: { row: ReturnRow }) {
  const { can } = useSession();
  const [modal, setModal] = useState<'approve' | 'reject' | 'refunded' | null>(null);
  return (
    <section className="card review-card" aria-label={`Возврат по заказу ${r.order.number}`}>
      <div className="review-card-head">
        <div>
          <strong>{RETURN_REASON[r.reason] ?? r.reason}</strong> ·{' '}
          {can('orders.view') ? <Link to={`/orders/${r.order.id}`}>Заказ {r.order.number}</Link> : `Заказ ${r.order.number}`}{' '}
          {r.full_order ? <Badge tone="warn">весь заказ</Badge> : <Badge>часть заказа</Badge>}
        </div>
        <span className="muted small">{dateTime(r.created_at)}</span>
      </div>
      <p className="muted small">
        {can('customers.view') ? <Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : r.customer.name} · {r.order.recipient}, {r.order.phone} · оплата:{' '}
        {PAYMENT[r.order.payment ?? ''] ?? r.order.payment ?? '—'} · доставлен {r.order.delivered_at ? dateTime(r.order.delivered_at) : '—'}
      </p>
      <ul className="return-items">
        {r.items.map((x) => (
          <li key={x.sku}>
            {x.name} <span className="muted small">{x.sku}</span> — {x.qty} из {x.line_qty} шт., {money(x.amount_uzs)}
          </li>
        ))}
      </ul>
      {r.comment && <p className="pre-wrap review-text">{r.comment}</p>}
      {r.media.length > 0 && (
        <div className="review-media">
          {r.media.map((m) => (
            <ReturnPhoto key={m} returnId={r.id} mediaId={m} />
          ))}
        </div>
      )}
      {r.status === 'requested' && <p className="small">По оплаченной цене: {money(r.suggested_uzs)}</p>}
      {r.refund_amount_uzs != null && (
        <p className="small">
          <Badge tone="ok">Одобрен</Badge> к возврату {money(r.refund_amount_uzs)} · {r.approved_by ?? ''} {r.approved_at ? dateTime(r.approved_at) : ''}
          {(r.bonus_reversed_uzs > 0 || r.bonus_returned_uzs > 0) && ` · бонусы: кешбэк −${money(r.bonus_reversed_uzs)}, возвращено +${money(r.bonus_returned_uzs)}`}
        </p>
      )}
      {r.status === 'refunded' && (
        <p className="small">
          <Badge tone="ok">Деньги возвращены</Badge> {r.refund_method ? REFUND_METHOD[r.refund_method] : ''}
          {r.refund_comment ? `: ${r.refund_comment}` : ''} · {r.refunded_by ?? ''} {r.refunded_at ? dateTime(r.refunded_at) : ''}
        </p>
      )}
      {r.status === 'rejected' && (
        <p className="small">
          <Badge tone="bad">Отклонён</Badge> {r.reject_reason} · {r.rejected_by ?? ''}
        </p>
      )}
      <div className="row-actions">
        {r.status === 'requested' && (
          <>
            <button type="button" className="btn" onClick={() => setModal('approve')}>
              Одобрить
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setModal('reject')}>
              Отклонить
            </button>
          </>
        )}
        {r.status === 'approved' && (
          <button type="button" className="btn" onClick={() => setModal('refunded')}>
            Деньги возвращены
          </button>
        )}
      </div>
      {modal === 'approve' && <ApproveModal row={r} onClose={() => setModal(null)} />}
      {modal === 'reject' && <RejectModal id={r.id} onClose={() => setModal(null)} />}
      {modal === 'refunded' && <RefundedModal row={r} onClose={() => setModal(null)} />}
    </section>
  );
}

function ReturnPhoto({ returnId, mediaId }: { returnId: string; mediaId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    apiBlob(`/staff/returns/${returnId}/media/${mediaId}`)
      .then((b) => setUrl((made = URL.createObjectURL(b))))
      .catch(() => setFailed(true));
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [returnId, mediaId]);
  if (failed) return <p className="muted small">Фото не открылось</p>;
  if (!url) return <p className="muted small">Загружаем…</p>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Фото из заявки на возврат" />
    </a>
  );
}

function useDone(onClose: () => void) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['returns'] });
    onClose();
  };
}

function ApproveModal({ row, onClose }: { row: ReturnRow; onClose: () => void }) {
  const done = useDone(onClose);
  const [amount, setAmount] = useState(String(row.suggested_uzs));
  const value = Number(amount.replace(/\s/g, ''));
  const valid = Number.isInteger(value) && value >= 1 && value <= row.order.total_uzs;
  const m = useMutation({ mutationFn: () => api(`/staff/returns/${row.id}/approve`, { method: 'POST', body: { amount_uzs: value } }), onSuccess: done });
  return (
    <Modal title={`Одобрить возврат · ${row.order.number}`} onClose={onClose}>
      <p className="muted small">
        {row.full_order
          ? 'Возвращают весь заказ: он перейдёт в «Возврат», банки — на проверку склада, все бонусы заказа пересчитаются.'
          : 'Возвращают часть заказа: заказ останется доставленным; кешбэк за эти товары заберётся, списанные бонусы вернутся. Товар примите через «Склад → Возврат».'}
      </p>
      <Field label="Сумма к возврату, сум" hint={`По оплаченной цене — ${money(row.suggested_uzs)}; не больше суммы заказа ${money(row.order.total_uzs)}`}>
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button type="button" className="btn" disabled={!valid || m.isPending} onClick={() => m.mutate()}>
          Одобрить на {valid ? money(value) : '…'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

function RejectModal({ id, onClose }: { id: string; onClose: () => void }) {
  const done = useDone(onClose);
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/staff/returns/${id}/reject`, { method: 'POST', body: { reason: reason.trim() } }), onSuccess: done });
  return (
    <Modal title="Отклонить заявку" onClose={onClose}>
      <p className="muted small">Покупатель увидит причину в сообщении и в заказе.</p>
      <Field label="Причина">
        <textarea rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button type="button" className="btn btn-danger" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>
          Отклонить
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

function RefundedModal({ row, onClose }: { row: ReturnRow; onClose: () => void }) {
  const done = useDone(onClose);
  const [method, setMethod] = useState<Method>('card');
  const [comment, setComment] = useState('');
  const m = useMutation({ mutationFn: () => api(`/staff/returns/${row.id}/refunded`, { method: 'POST', body: { method, comment: comment.trim() || undefined } }), onSuccess: done });
  return (
    <Modal title={`Деньги возвращены · ${money(row.refund_amount_uzs ?? 0)}`} onClose={onClose}>
      <Field label="Как вернули">
        <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
          {(Object.keys(REFUND_METHOD) as Method[]).map((k) => (
            <option key={k} value={k}>
              {REFUND_METHOD[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Комментарий (необязательно)">
        <textarea rows={2} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button type="button" className="btn" disabled={m.isPending} onClick={() => m.mutate()}>
          Отметить
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}
