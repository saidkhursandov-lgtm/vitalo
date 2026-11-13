import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, ErrorBox, Field, Help, Loading, Modal, PageHead, Pagination } from '../components/ui';
import { api, apiBlob } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money } from '../lib/format';

type Status = 'pending' | 'published' | 'rejected' | 'hidden';
type Reason = 'spam' | 'rude' | 'empty' | 'medical' | 'other';

interface ReviewRow {
  id: string;
  status: Status;
  rating: number;
  tags: string[];
  text: string;
  author: string;
  show_name: boolean;
  lang: string;
  medical_hint: boolean;
  media: string[];
  product: { id: string; sku: string; name: string };
  order: { id: string; number: string; delivered_at: string | null };
  customer: { id: string; name: string };
  bonus_uzs: number;
  reject_reason: Reason | null;
  reject_note: string | null;
  moderated_by: string | null;
  moderated_at: string | null;
  reply: { text: string; by: string | null; at: string | null } | null;
  created_at: string;
}
interface ReviewList {
  counts: Partial<Record<Status, number>>;
  total: number;
  items: ReviewRow[];
}

const STATUS: [Status, string][] = [
  ['pending', 'На проверке'],
  ['published', 'Опубликованы'],
  ['rejected', 'Отклонены'],
  ['hidden', 'Скрыты'],
];
export const REJECT_REASONS: Record<Reason, string> = {
  spam: 'Спам или реклама',
  rude: 'Грубые слова',
  empty: 'Нет смысла / пустой текст',
  medical: 'Обещания лечения (для БАД нельзя)',
  other: 'Другое',
};
const TAGS: Record<string, string> = {
  effect: 'Есть эффект',
  easy: 'Удобно принимать',
  quality: 'Хорошее качество',
  price: 'Цена радует',
  no_effect: 'Эффекта не заметно',
  hard: 'Неудобно принимать',
};
const PAGE_SIZE = 30;
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/**
 * 3.10-Б: «Отзывы» — premoderation. Reviews come only from delivered orders. «Опубликовать и начислить» shows the
 * review on the product card and posts the bonus (3 000 / 5 000 with a photo) once; a specialist may answer under it.
 */
export function Reviews() {
  const [status, setStatus] = useState<Status>('pending');
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ['reviews', status, page], queryFn: () => api<ReviewList>(`/staff/reviews?status=${status}&page=${page}`) });
  const d = list.data;
  return (
    <>
      <PageHead title="Отзывы" />
      <Help id="reviews">
        Отзывы оставляют только покупатели, получившие заказ. Проверьте текст и фото: «Опубликовать и начислить» —
        отзыв появится на карточке товара, покупателю придут бонусы (без фото и с фото — суммы в «Настройки → Бонусы»).
        Отклоняйте спам, грубость, пустой текст и обещания вылечить болезнь — для БАД это запрещённая реклама.
        Имя показывается коротко («Саидкомол Х.») или «Покупатель VITALO»; телефон и username не видны никому.
      </Help>
      <div className="segmented" role="group" aria-label="Статус">
        {STATUS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={status === k ? 'is-on' : ''}
            aria-pressed={status === k}
            onClick={() => {
              setStatus(k);
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
          <p className="muted">{status === 'pending' ? 'Новых отзывов нет.' : 'Здесь пока пусто.'}</p>
        </section>
      ) : (
        d && (
          <>
            <div className="review-list">
              {d.items.map((r) => (
                <ReviewCard key={r.id} review={r} />
              ))}
            </div>
            <Pagination page={page} totalPages={Math.max(1, Math.ceil(d.total / PAGE_SIZE))} onPage={setPage} />
          </>
        )
      )}
    </>
  );
}

function ReviewCard({ review: r }: { review: ReviewRow }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [rejecting, setRejecting] = useState(false);
  const [replying, setReplying] = useState(false);
  const done = () => void qc.invalidateQueries({ queryKey: ['reviews'] });
  const publish = useMutation({ mutationFn: () => api(`/staff/reviews/${r.id}/publish`, { method: 'POST' }), onSuccess: done });
  const hide = useMutation({ mutationFn: () => api(`/staff/reviews/${r.id}/hide`, { method: 'POST' }), onSuccess: done });
  const busy = publish.isPending || hide.isPending;
  return (
    <section className="card review-card" aria-label={`Отзыв на ${r.product.name}`}>
      <div className="review-card-head">
        <div>
          <span className="review-stars" aria-label={`Оценка ${r.rating} из 5`}>
            {stars(r.rating)}
          </span>{' '}
          {can('products.view') ? <Link to={`/products/${r.product.id}`}>{r.product.name}</Link> : r.product.name} <span className="muted small">{r.product.sku}</span>
        </div>
        <span className="muted small">{dateTime(r.created_at)}</span>
      </div>
      <p className="muted small">
        Заказ {can('orders.view') ? <Link to={`/orders/${r.order.id}`}>{r.order.number}</Link> : r.order.number} · покупатель{' '}
        {can('customers.view') ? <Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : r.customer.name} · подпись: {r.author}
        {r.lang === 'uz' ? ' · UZ' : ''}
      </p>
      {r.medical_hint && r.status === 'pending' && (
        <p className="alert alert-warn">Похоже на обещание лечения — проверьте: для БАД так писать нельзя.</p>
      )}
      {r.tags.length > 0 && (
        <div className="review-tags">
          {r.tags.map((t) => (
            <Badge key={t}>{TAGS[t] ?? t}</Badge>
          ))}
        </div>
      )}
      <p className="pre-wrap review-text">{r.text}</p>
      {r.media.length > 0 && (
        <div className="review-media">
          {r.media.map((m) => (
            <ReviewPhoto key={m} reviewId={r.id} mediaId={m} />
          ))}
        </div>
      )}
      {r.status === 'rejected' && r.reject_reason && (
        <p className="small">
          <Badge tone="bad">Отклонён</Badge> {REJECT_REASONS[r.reject_reason]}
          {r.reject_note ? `: ${r.reject_note}` : ''}
          {r.moderated_by ? ` · ${r.moderated_by}` : ''}
        </p>
      )}
      {r.status === 'published' && (
        <p className="small">
          <Badge tone="ok">Опубликован</Badge> {r.moderated_by ?? ''} {r.moderated_at ? dateTime(r.moderated_at) : ''} · бонус {money(r.bonus_uzs)}
        </p>
      )}
      {r.reply && (
        <div className="review-reply">
          <strong>Ответ специалиста VITALO</strong>
          {r.reply.by && <span className="muted small"> · {r.reply.by}</span>}
          <p className="pre-wrap">{r.reply.text}</p>
        </div>
      )}
      <ErrorBox error={publish.error ?? hide.error} />
      <div className="row-actions">
        {(r.status === 'pending' || r.status === 'hidden') && (
          <button type="button" className="btn" disabled={busy} onClick={() => publish.mutate()}>
            {r.status === 'pending' ? `Опубликовать и начислить ${money(r.bonus_uzs)}` : 'Вернуть на сайт'}
          </button>
        )}
        {r.status === 'pending' && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setRejecting(true)}>
            Отклонить
          </button>
        )}
        {(r.status === 'pending' || r.status === 'published') && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setReplying(true)}>
            {r.reply ? 'Изменить ответ' : 'Ответить'}
          </button>
        )}
        {r.status === 'published' && (
          <button type="button" className="btn btn-ghost text-bad" disabled={busy} onClick={() => hide.mutate()}>
            Скрыть
          </button>
        )}
      </div>
      {rejecting && <RejectModal id={r.id} medical={r.medical_hint} onClose={() => setRejecting(false)} onDone={done} />}
      {replying && <ReplyModal id={r.id} text={r.reply?.text ?? ''} onClose={() => setReplying(false)} onDone={done} />}
    </section>
  );
}

/** The photo loads with the staff token: it stays private until the review is published. */
function ReviewPhoto({ reviewId, mediaId }: { reviewId: string; mediaId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    apiBlob(`/staff/reviews/${reviewId}/media/${mediaId}`)
      .then((b) => setUrl((made = URL.createObjectURL(b))))
      .catch(() => setFailed(true));
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [reviewId, mediaId]);
  if (failed) return <p className="muted small">Фото не открылось</p>;
  if (!url) return <p className="muted small">Загружаем…</p>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Фото из отзыва" />
    </a>
  );
}

function RejectModal({ id, medical, onClose, onDone }: { id: string; medical: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<Reason>(medical ? 'medical' : 'spam');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/staff/reviews/${id}/reject`, { method: 'POST', body: { reason, note: note.trim() || undefined } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal title="Отклонить отзыв" onClose={onClose}>
      <p className="muted small">Покупатель получит сообщение с причиной и сможет написать отзыв заново.</p>
      <Field label="Причина">
        <select value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
          {(Object.keys(REJECT_REASONS) as Reason[]).map((k) => (
            <option key={k} value={k}>
              {REJECT_REASONS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Пояснение покупателю (необязательно)">
        <textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button type="button" className="btn btn-danger" disabled={m.isPending} onClick={() => m.mutate()}>
          Отклонить
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

function ReplyModal({ id, text: initial, onClose, onDone }: { id: string; text: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const m = useMutation({
    mutationFn: () => api(`/staff/reviews/${id}/reply`, { method: 'PUT', body: { text: text.trim() } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal title="Ответ специалиста VITALO" onClose={onClose}>
      <p className="muted small">Ответ виден под отзывом на карточке товара. Пустой текст убирает ответ.</p>
      <Field label="Текст ответа">
        <textarea rows={5} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button type="button" className="btn" disabled={m.isPending} onClick={() => m.mutate()}>
          Сохранить
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}
