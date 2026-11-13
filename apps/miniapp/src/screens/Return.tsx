import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { dateTime, money, orderNo } from '../lib/format';
import { errorText, useI18n, type MessageKey } from '../lib/i18n';
import { useOrderReturns } from '../lib/queries';
import { haptic } from '../lib/telegram';
import type { ReturnLine, ReturnReasonCode } from '../lib/types';
import { CloseIcon, PlusIcon } from '../components/Icons';
import { Picture } from '../components/Picture';
import { EmptyState, ErrorState, Loading, Stepper } from '../components/ui';
import { useToast } from '../components/Toast';

const PHOTOS_MAX = 3;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const COMMENT_MAX = 1000;

/** 3.10-В: «Вернуть товар» — which jars, why (damaged / wrong item), photos; the manager decides. */
export function ReturnScreen() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const data = useOrderReturns(id);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<ReturnReasonCode | null>(null);
  const [comment, setComment] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  if (data.isPending) return <Loading />;
  if (data.isError) return <ErrorState error={data.error} onRetry={() => void data.refetch()} />;
  const d = data.data;
  if (!d.can_request) {
    return (
      <div className="page">
        <EmptyState title={t('return.title')} text={t(`return.blocked.${d.blocked ?? 'RETURN_NOT_DELIVERED'}` as MessageKey, { days: d.days })} />
        <Link to={`/orders/${id}`} className="btn btn-secondary btn-block">
          {t('common.back')}
        </Link>
      </div>
    );
  }

  const chosen = d.lines.filter((l) => (qty[l.order_item_id] ?? 0) > 0);
  const total = chosen.reduce((s, l) => s + l.unit_paid_uzs * (qty[l.order_item_id] ?? 0), 0);
  const ready = chosen.length > 0 && reason !== null && photos.length > 0 && !busy;

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const all = [...files];
    const ok = all.filter((f) => PHOTO_TYPES.includes(f.type) && f.size <= PHOTO_MAX_BYTES);
    setError(ok.length < all.length ? errorText(lang, 'RETURN_PHOTO_TYPE') : null);
    setPhotos((p) => [...p, ...ok].slice(0, PHOTOS_MAX));
  };

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set('order_id', id);
    body.set('reason', reason!);
    if (comment.trim()) body.set('comment', comment.trim());
    body.set('items', JSON.stringify(chosen.map((l) => ({ order_item_id: l.order_item_id, qty: qty[l.order_item_id] }))));
    photos.forEach((f) => body.append('photos', f, f.name));
    try {
      await api('/returns', { method: 'POST', body });
      haptic('success');
      toast(t('return.sent'));
      await qc.invalidateQueries({ queryKey: ['returns', id] });
      navigate(`/orders/${id}`, { replace: true });
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page return-page">
      <h1>{t('return.title')}</h1>
      <p className="hint small">{t('orders.number', { n: orderNo(d.order_number) })}</p>
      {d.deadline && <p className="notice notice-info">{t('return.until', { date: dateTime(d.deadline, lang) })}</p>}

      <section className="card">
        <h2>{t('return.which')}</h2>
        {d.lines.map((l) => (
          <ReturnLineRow key={l.order_item_id} line={l} value={qty[l.order_item_id] ?? 0} onChange={(v) => setQty((q) => ({ ...q, [l.order_item_id]: v }))} />
        ))}
      </section>

      <section className="card">
        <h2 id="return-reason">{t('return.why')}</h2>
        <div role="radiogroup" aria-labelledby="return-reason">
          {d.reasons.map((r) => (
            <label key={r} className="radio-row">
              <input type="radio" name="return-reason" checked={reason === r} onChange={() => setReason(r)} />
              <span>{t(`return.reason.${r}` as MessageKey)}</span>
            </label>
          ))}
        </div>
        <p className="hint small">{t('return.reasonsNote')}</p>
      </section>

      <section className="card">
        <h2>{t('return.photos')}</h2>
        <p className="hint small">{t('return.photosHint')}</p>
        <div className="review-photos">
          {previews.map((src, i) => (
            <div key={src} className="review-photo">
              <img src={src} alt="" />
              <button type="button" className="review-photo-x" aria-label={t('review.removePhoto')} onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}>
                <CloseIcon width={16} height={16} />
              </button>
            </div>
          ))}
          {photos.length < PHOTOS_MAX && (
            <label className="review-photo review-photo-add">
              <PlusIcon width={22} height={22} aria-hidden />
              <span>{t('review.addPhoto')}</span>
              <input
                type="file"
                accept={PHOTO_TYPES.join(',')}
                multiple
                onChange={(e) => {
                  addPhotos(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
        <label className="review-label" htmlFor="return-comment">
          {t('return.comment')}
        </label>
        <textarea id="return-comment" rows={3} maxLength={COMMENT_MAX} value={comment} onChange={(e) => setComment(e.target.value)} />
      </section>

      {total > 0 && <p className="return-total">{t('return.total', { sum: money(total, lang) })}</p>}
      <p className="hint small">{t('return.how')}</p>
      {error && <div className="notice notice-error">{error}</div>}
      <button type="button" className="btn btn-block" disabled={!ready} onClick={() => void send()}>
        {t('return.send')}
      </button>
    </div>
  );
}

function ReturnLineRow({ line: l, value, onChange }: { line: ReturnLine; value: number; onChange: (v: number) => void }) {
  const { t, lang } = useI18n();
  const name = (lang === 'uz' && l.name_uz) || l.name_ru;
  const on = value > 0;
  return (
    <div className="return-line">
      <label className="check-row">
        <input type="checkbox" checked={on} disabled={l.max_qty === 0} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
        <span className="return-line-img">{l.image && <Picture src={l.image} alt="" />}</span>
        <span className="return-line-name">
          <strong>{name}</strong>
          <span className="hint small">{l.max_qty === 0 ? t('return.alreadyReturned') : t('return.bought', { n: l.qty, sum: money(l.unit_paid_uzs, lang) })}</span>
        </span>
      </label>
      {on && l.max_qty > 1 && (
        <div className="return-line-qty">
          <span className="hint small">{t('return.qty')}</span>
          <Stepper value={value} min={1} max={l.max_qty} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
