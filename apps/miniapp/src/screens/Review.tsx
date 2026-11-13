import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { money, orderNo } from '../lib/format';
import { errorText, useI18n, type MessageKey } from '../lib/i18n';
import { useReviewable, useReviewForm } from '../lib/queries';
import { haptic } from '../lib/telegram';
import type { ReviewableItem, ReviewTag } from '../lib/types';
import { CheckIcon, CloseIcon, GiftIcon, PlusIcon, StarIcon } from '../components/Icons';
import { Picture } from '../components/Picture';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { useToast } from '../components/Toast';

export const REVIEW_TAGS: ReviewTag[] = ['effect', 'easy', 'quality', 'price', 'no_effect', 'hard'];
const TEXT_MIN = 10;
const TEXT_MAX = 1000;
const PHOTOS_MAX = 2;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const canWrite = (i: ReviewableItem) => i.review_status === null || i.review_status === 'rejected';

/** 3.10-Б: «Оцените покупку» — the products of one delivered order; the bot's «Оставить отзыв» opens it. */
export function ReviewScreen() {
  const { orderId = '' } = useParams();
  const { t } = useI18n();
  const items = useReviewable(orderId);
  const [active, setActive] = useState<string | null>(null);
  const open = (items.data ?? []).filter(canWrite);
  const only = open.length === 1 ? open[0].product_id : null;
  // one product left to review — its form is open right away
  useEffect(() => {
    if (only) setActive((a) => a ?? only);
  }, [only]);

  if (items.isPending) return <Loading />;
  if (items.isError) return <ErrorState error={items.error} onRetry={() => void items.refetch()} />;
  const list = items.data;
  if (!list.length) {
    return (
      <div className="page">
        <EmptyState icon={StarIcon} title={t('review.title')} text={t('review.notDelivered')} />
      </div>
    );
  }
  return (
    <div className="page review-page">
      <h1>{t('review.title')}</h1>
      <p className="hint small">{t('orders.number', { n: orderNo(list[0].order_number) })}</p>
      <p className="hint">{t('review.intro')}</p>
      <BonusHint />
      {list.map((item) =>
        active === item.product_id && canWrite(item) ? (
          <ReviewForm key={item.product_id} item={item} onDone={() => setActive(null)} />
        ) : (
          <ReviewRow key={item.product_id} item={item} onOpen={() => setActive(item.product_id)} />
        ),
      )}
      {!open.length && <p className="notice notice-info">{t('review.allDone')}</p>}
      <Link to={`/orders/${orderId}`} className="btn btn-secondary btn-block">
        {t('common.back')}
      </Link>
    </div>
  );
}

function BonusHint() {
  const { t, lang } = useI18n();
  const form = useReviewForm();
  const b = form.data?.bonus;
  if (!b) return null;
  return (
    <p className="review-bonus">
      <GiftIcon width={18} height={18} aria-hidden /> <span>{t('review.bonus', { plain: money(b.plain_uzs, lang), photo: money(b.photo_uzs, lang) })}</span>
    </p>
  );
}

function ItemHead({ item }: { item: ReviewableItem }) {
  const { lang } = useI18n();
  const name = (lang === 'uz' && item.name_uz) || item.name_ru;
  return (
    <div className="review-item-head">
      <div className="review-item-img">{item.image && <Picture src={item.image} alt="" />}</div>
      <strong>{name}</strong>
    </div>
  );
}

function ReviewRow({ item, onOpen }: { item: ReviewableItem; onOpen: () => void }) {
  const { t } = useI18n();
  const status = item.review_status;
  return (
    <section className="card review-item">
      <ItemHead item={item} />
      {status && <span className={`review-status is-${status}`}>{t(`review.status.${status}` as MessageKey)}</span>}
      {canWrite(item) && (
        <button type="button" className="btn btn-block" onClick={onOpen}>
          {t('review.rateOrder')}
        </button>
      )}
    </section>
  );
}

function ReviewForm({ item, onDone }: { item: ReviewableItem; onDone: () => void }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const info = useReviewForm();
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState<ReviewTag[]>([]);
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [showName, setShowName] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const len = text.trim().length;
  const ready = rating > 0 && len >= TEXT_MIN && len <= TEXT_MAX && !busy;
  const id = item.product_id;

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const all = [...files];
    const ok = all.filter((f) => PHOTO_TYPES.includes(f.type) && f.size <= PHOTO_MAX_BYTES);
    setError(ok.length < all.length ? errorText(lang, 'REVIEW_PHOTO_TYPE') : null);
    setPhotos((p) => [...p, ...ok].slice(0, PHOTOS_MAX));
  };
  const toggleTag = (tag: ReviewTag) => setTags((s) => (s.includes(tag) ? s.filter((x) => x !== tag) : [...s, tag]));

  const send = async () => {
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
      haptic('success');
      toast(t('review.sent'));
      await qc.invalidateQueries({ queryKey: ['reviews', 'pending'] });
      onDone();
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card review-item review-form">
      <ItemHead item={item} />
      {item.review_status === 'rejected' && <span className="review-status is-rejected">{t('review.status.rejected')}</span>}

      <h2 className="review-label" id={`rate-${id}`}>
        {t('review.rate')}
      </h2>
      <div className="chat-stars review-stars" role="radiogroup" aria-labelledby={`rate-${id}`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={t('review.stars', { n })} className={rating >= n ? 'is-on' : ''} onClick={() => setRating(n)}>
            <StarIcon width={32} height={32} filled={rating >= n} />
          </button>
        ))}
      </div>

      <h2 className="review-label">{t('review.tags')}</h2>
      <div className="chips wrap review-tags">
        {REVIEW_TAGS.map((tag) => {
          const on = tags.includes(tag);
          return (
            <button key={tag} type="button" className={`chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggleTag(tag)}>
              {on && <CheckIcon width={14} height={14} aria-hidden />}
              {t(`review.tag.${tag}` as MessageKey)}
            </button>
          );
        })}
      </div>

      <label className="review-label" htmlFor={`text-${id}`}>
        {t('review.text')}
      </label>
      <textarea id={`text-${id}`} rows={5} maxLength={TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
      <p className="hint small review-count">
        <span>{t('review.textHint')}</span>
        <span aria-live="polite">
          {len}/{TEXT_MAX}
        </span>
      </p>

      <h2 className="review-label">{t('review.photos')}</h2>
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

      <h2 className="review-label" id={`sign-${id}`}>
        {t('review.signature')}
      </h2>
      <div className="segmented review-sign" role="radiogroup" aria-labelledby={`sign-${id}`}>
        <button type="button" role="radio" aria-checked={showName} className={showName ? 'is-on' : ''} onClick={() => setShowName(true)}>
          {info.data?.author_name ?? '…'}
        </button>
        <button type="button" role="radio" aria-checked={!showName} className={!showName ? 'is-on' : ''} onClick={() => setShowName(false)}>
          {info.data?.anonymous_name ?? '…'}
        </button>
      </div>

      {error && <div className="notice notice-error">{error}</div>}
      <button type="button" className="btn btn-block" disabled={!ready} onClick={() => void send()}>
        {t('review.send')}
      </button>
    </section>
  );
}
