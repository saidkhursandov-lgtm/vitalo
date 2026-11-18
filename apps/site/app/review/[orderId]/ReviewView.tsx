'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Check, Gift, Star } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { money, orderNo } from '@/lib/format';
import { errorText, type Key } from '@/lib/i18n';
import type { ReviewableItem, ReviewFormInfo, ReviewTag } from '@/lib/types';
import { useSession } from '@/components/Session';
import { PhotoPicker } from '@/components/PhotoPicker';

export const REVIEW_TAGS: ReviewTag[] = ['effect', 'easy', 'quality', 'price', 'no_effect', 'hard'];
export const REVIEW_TEXT_MIN = 10;
const TEXT_MAX = 1000;
const PHOTOS_MAX = 2;

const canWrite = (i: ReviewableItem) => i.review_status === null || i.review_status === 'rejected';

/** «Оцените покупку» (3.10-Б) on the site: the products of one delivered order; the review goes to moderation. */
export function ReviewView({ orderId }: { orderId: string }) {
  const { t, lang, user } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [items, setItems] = useState<ReviewableItem[] | null>(null);
  const [info, setInfo] = useState<ReviewFormInfo | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, router, path]);

  const load = useCallback(() => api<ReviewableItem[]>(`/reviews/pending?order_id=${orderId}`).then(setItems, () => setItems([])), [orderId]);
  useEffect(() => {
    if (!user) return;
    void load();
    void api<ReviewFormInfo>('/reviews/form').then(setInfo, () => null);
  }, [user, load]);

  const open = (items ?? []).filter(canWrite);
  const only = open.length === 1 ? open[0].product_id : null;
  useEffect(() => {
    if (only) setActive((a) => a ?? only);
  }, [only]);

  if (!user || items === null) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="empty">
        <span className="empty-ic">
          <Star size={40} strokeWidth={1.6} />
        </span>
        <h2>{t('review.title')}</h2>
        <p>{t('review.notDelivered')}</p>
        <Link href={`/order/${orderId}`} className="btn btn-secondary">
          {t('common.back')}
        </Link>
      </div>
    );
  }
  return (
    <div className="narrow" style={{ display: 'grid', gap: 16 }}>
      <div>
        <h1 className="page-title" style={{ marginBottom: 4 }}>{t('review.title')}</h1>
        <p className="hint">{t('orders.number', { n: orderNo(items[0].order_number) })}</p>
      </div>
      <p>{t('review.intro')}</p>
      {info?.bonus ? (
        <div className="notice notice-info review-bonus">
          <Gift size={18} strokeWidth={1.8} /> <span>{t('review.bonus', { plain: money(info.bonus.plain_uzs, lang), photo: money(info.bonus.photo_uzs, lang) })}</span>
        </div>
      ) : null}
      {items.map((item) =>
        active === item.product_id && canWrite(item) ? (
          <ReviewForm
            key={item.product_id}
            item={item}
            info={info}
            onDone={() => {
              setActive(null);
              void load();
            }}
          />
        ) : (
          <section key={item.product_id} className="card ck-section">
            <ItemHead item={item} />
            {item.review_status ? <span className={`review-status is-${item.review_status}`}>{t(`review.status.${item.review_status}` as Key)}</span> : null}
            {canWrite(item) ? (
              <button type="button" className="btn" onClick={() => setActive(item.product_id)}>
                {t('review.rateOrder')}
              </button>
            ) : null}
          </section>
        ),
      )}
      {!open.length ? <div className="notice notice-ok">{t('review.allDone')}</div> : null}
      <Link href={`/order/${orderId}`} className="btn btn-secondary" style={{ justifySelf: 'start' }}>
        {t('common.back')}
      </Link>
    </div>
  );
}

function ItemHead({ item }: { item: ReviewableItem }) {
  const { lang } = useSession();
  return (
    <div className="review-head">
      <span className="ph">{item.image ? <img src={item.image.webp} alt="" /> : null}</span>
      <b>{(lang === 'uz' && item.name_uz) || item.name_ru}</b>
    </div>
  );
}

function ReviewForm({ item, info, onDone }: { item: ReviewableItem; info: ReviewFormInfo | null; onDone: () => void }) {
  const { t, lang } = useSession();
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState<ReviewTag[]>([]);
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [showName, setShowName] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const len = text.trim().length;
  const ready = rating > 0 && len >= REVIEW_TEXT_MIN && len <= TEXT_MAX && !busy;

  async function send() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set('order_id', item.order_id);
    body.set('product_id', item.product_id);
    body.set('rating', String(rating));
    body.set('text', text.trim());
    body.set('show_name', String(showName));
    if (tags.length) body.set('tags', tags.join(','));
    photos.forEach((f) => body.append('photos', f, f.name));
    try {
      await api('/reviews', { method: 'POST', body });
      onDone();
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ck-section">
      <ItemHead item={item} />
      {item.review_status === 'rejected' ? <span className="review-status is-rejected">{t('review.status.rejected')}</span> : null}
      <div>
        <h3 className="label">{t('review.rate')}</h3>
        <div className="stars" role="radiogroup" aria-label={t('review.rate')}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={t('review.stars', { n })} className={rating >= n ? 'is-on' : ''} onClick={() => setRating(n)}>
              <Star size={32} strokeWidth={1.6} fill={rating >= n ? 'currentColor' : 'none'} />
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="label">{t('review.tags')}</h3>
        <div className="chip-row wrap">
          {REVIEW_TAGS.map((tag) => {
            const on = tags.includes(tag);
            return (
              <button key={tag} type="button" className={`chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => setTags((s) => (on ? s.filter((x) => x !== tag) : [...s, tag]))}>
                {on ? <Check size={14} strokeWidth={2} /> : null}
                {t(`review.tag.${tag}` as Key)}
              </button>
            );
          })}
        </div>
      </div>
      <label className="field">
        <span>{t('review.text')}</span>
        <textarea className="input" rows={5} maxLength={TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
        <small className="hint count-row">
          <span>{t('review.textHint')}</span>
          <span aria-live="polite">
            {len}/{TEXT_MAX}
          </span>
        </small>
      </label>
      <div>
        <h3 className="label">{t('review.photos')}</h3>
        <PhotoPicker photos={photos} max={PHOTOS_MAX} onChange={setPhotos} onRejected={(bad) => setError(bad ? errorText(lang, 'REVIEW_PHOTO_TYPE') : null)} />
      </div>
      <div>
        <h3 className="label">{t('review.signature')}</h3>
        <div className="segmented" role="radiogroup" aria-label={t('review.signature')}>
          <button type="button" role="radio" aria-checked={showName} className={showName ? 'is-on' : ''} onClick={() => setShowName(true)}>
            {info?.author_name ?? '…'}
          </button>
          <button type="button" role="radio" aria-checked={!showName} className={!showName ? 'is-on' : ''} onClick={() => setShowName(false)}>
            {info?.anonymous_name ?? '…'}
          </button>
        </div>
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <button type="button" className="btn btn-lg" disabled={!ready} onClick={() => void send()}>
        {busy ? t('common.loading') : t('review.send')}
      </button>
    </section>
  );
}
