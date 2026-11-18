'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { dateTime, money, orderNo } from '@/lib/format';
import { errorText, type Key } from '@/lib/i18n';
import type { OrderReturns, ReturnReasonCode } from '@/lib/types';
import { useSession } from '@/components/Session';
import { PhotoPicker } from '@/components/PhotoPicker';

const PHOTOS_MAX = 3;
const COMMENT_MAX = 1000;

/** «Вернуть товар» (3.10-В) on the site: which jars, why, photos; the manager decides, the answer comes to the bot. */
export function ReturnView({ id }: { id: string }) {
  const { t, lang, user } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [d, setD] = useState<OrderReturns | null>(null);
  const [failed, setFailed] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<ReturnReasonCode | null>(null);
  const [comment, setComment] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, router, path]);
  useEffect(() => {
    if (user) void api<OrderReturns>(`/returns/order/${id}`).then(setD, () => setFailed(true));
  }, [user, id]);

  if (failed) return <div className="notice notice-error">{t('common.error')}</div>;
  if (!user || !d) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }
  if (!d.can_request) {
    return (
      <div className="empty">
        <h2>{t('return.title')}</h2>
        <p>{t(`return.blocked.${d.blocked ?? 'RETURN_NOT_DELIVERED'}` as Key, { days: d.days })}</p>
        <Link href={`/order/${id}`} className="btn btn-secondary">
          {t('common.back')}
        </Link>
      </div>
    );
  }

  const chosen = d.lines.filter((l) => (qty[l.order_item_id] ?? 0) > 0);
  const total = chosen.reduce((s, l) => s + l.unit_paid_uzs * (qty[l.order_item_id] ?? 0), 0);
  const ready = chosen.length > 0 && reason !== null && photos.length > 0 && !busy;

  async function send() {
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
      router.replace(`/order/${id}?returned=1`);
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
      setBusy(false);
    }
  }

  return (
    <div className="narrow" style={{ display: 'grid', gap: 16 }}>
      <div>
        <h1 className="page-title" style={{ marginBottom: 4 }}>{t('return.title')}</h1>
        <p className="hint">{t('orders.number', { n: orderNo(d.order_number) })}</p>
      </div>
      {d.deadline ? <div className="notice notice-info">{t('return.until', { date: dateTime(d.deadline, lang) })}</div> : null}

      <section className="card ck-section">
        <h2>{t('return.which')}</h2>
        {d.lines.map((l) => {
          const v = qty[l.order_item_id] ?? 0;
          const set = (n: number) => setQty((q) => ({ ...q, [l.order_item_id]: n }));
          return (
            <div key={l.order_item_id} className="return-line">
              <label className="check">
                <input type="checkbox" checked={v > 0} disabled={l.max_qty === 0} onChange={(e) => set(e.target.checked ? 1 : 0)} />
                <span className="ph">{l.image ? <img src={l.image.webp} alt="" /> : null}</span>
                <span style={{ display: 'grid', minWidth: 0 }}>
                  <b>{(lang === 'uz' && l.name_uz) || l.name_ru}</b>
                  <span className="hint">{l.max_qty === 0 ? t('return.alreadyReturned') : t('return.bought', { n: l.qty, sum: money(l.unit_paid_uzs, lang) })}</span>
                </span>
              </label>
              {v > 0 && l.max_qty > 1 ? (
                <div className="qty" aria-label={t('return.qty')}>
                  <button type="button" disabled={v <= 1} onClick={() => set(v - 1)} aria-label="−">
                    <Minus size={16} />
                  </button>
                  <span>{v}</span>
                  <button type="button" disabled={v >= l.max_qty} onClick={() => set(v + 1)} aria-label="+">
                    <Plus size={16} />
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

      <section className="card ck-section">
        <h2>{t('return.why')}</h2>
        <div className="choice-list" role="radiogroup" aria-label={t('return.why')}>
          {d.reasons.map((r) => (
            <label key={r} className={`choice${reason === r ? ' is-on' : ''}`}>
              <input type="radio" name="return-reason" checked={reason === r} onChange={() => setReason(r)} />
              <span>{t(`return.reason.${r}` as Key)}</span>
            </label>
          ))}
        </div>
        <p className="hint">{t('return.reasonsNote')}</p>
      </section>

      <section className="card ck-section">
        <h2>{t('return.photos')}</h2>
        <p className="hint">{t('return.photosHint')}</p>
        <PhotoPicker photos={photos} max={PHOTOS_MAX} onChange={setPhotos} onRejected={(bad) => setError(bad ? errorText(lang, 'RETURN_PHOTO_TYPE') : null)} />
        <label className="field">
          <span>{t('return.comment')}</span>
          <textarea className="input" rows={3} maxLength={COMMENT_MAX} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
      </section>

      {total > 0 ? <p className="sum-total" style={{ borderTop: 0 }}>{t('return.total', { sum: money(total, lang) })}</p> : null}
      <p className="hint">{t('return.how')}</p>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <button type="button" className="btn btn-lg" disabled={!ready} onClick={() => void send()}>
        {busy ? t('common.loading') : t('return.send')}
      </button>
    </div>
  );
}
