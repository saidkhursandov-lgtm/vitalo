import { useI18n, pluralForm, type MessageKey } from '../lib/i18n';
import { useProductReviews } from '../lib/queries';
import type { ProductReview } from '../lib/types';
import { BadgeIcon, DoctorIcon, StarIcon } from './Icons';
import { Picture } from './Picture';

/** Tiles show stars only from this many reviews: one or two reviews say little (D-71). */
export const TILE_RATING_MIN = 3;

const avgText = (avg: number, lang: string) => avg.toFixed(1).replace('.', lang === 'ru' ? ',' : '.');

function useCountWord() {
  const { t, lang } = useI18n();
  return (n: number) => (lang === 'uz' ? t('review.word.many') : t(`review.word.${pluralForm(n)}` as MessageKey));
}

/** «★ 4,8 (18 отзывов)» under the product title — a link to the reviews block. */
export function RatingLine({ rating }: { rating: { avg: number; count: number } | null | undefined }) {
  const { t, lang } = useI18n();
  const word = useCountWord();
  if (!rating || rating.count < 1) return null;
  return (
    <a
      className="rating-line"
      href="#reviews"
      aria-label={t('review.ratingAria', { avg: avgText(rating.avg, lang), n: rating.count, w: word(rating.count) })}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
    >
      <StarIcon width={16} height={16} filled aria-hidden />
      <strong>{avgText(rating.avg, lang)}</strong>
      <span>
        ({rating.count} {word(rating.count)})
      </span>
    </a>
  );
}

/** The small «★ 4,8 (18)» in a catalogue tile, from TILE_RATING_MIN reviews. */
export function TileRating({ rating }: { rating: { avg: number; count: number } | null | undefined }) {
  const { t, lang } = useI18n();
  const word = useCountWord();
  if (!rating || rating.count < TILE_RATING_MIN) return null;
  return (
    <span className="tile-rating" aria-label={t('review.ratingAria', { avg: avgText(rating.avg, lang), n: rating.count, w: word(rating.count) })}>
      <StarIcon width={12} height={12} filled aria-hidden />
      <span aria-hidden>
        {avgText(rating.avg, lang)} ({rating.count})
      </span>
    </span>
  );
}

function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span className="review-stars-row" aria-hidden>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} width={size} height={size} filled={value >= n} className={value >= n ? 'is-on' : ''} />
      ))}
    </span>
  );
}

/** «Отзывы покупателей»: the summary (average and the 5→1 bars) and the reviews, 10 at a time. */
export function ProductReviewsBlock({ productId }: { productId: string }) {
  const { t, lang } = useI18n();
  const word = useCountWord();
  const q = useProductReviews(productId);
  const first = q.data?.pages[0];
  if (!first?.summary) return null;
  const { summary } = first;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="card reviews-block" id="reviews">
      <h2>{t('review.block')}</h2>
      {summary.count === 0 || summary.avg === null ? (
        <p className="hint">{t('review.none')}</p>
      ) : (
        <div className="reviews-summary">
          <div className="reviews-avg">
            <strong>{avgText(summary.avg, lang)}</strong>
            <Stars value={Math.round(summary.avg)} size={16} />
            <span className="hint small">
              {summary.count} {word(summary.count)}
            </span>
          </div>
          <ul className="reviews-bars">
            {summary.stars.map((count, i) => {
              const n = 5 - i;
              return (
                <li key={n} aria-label={t('review.starsRow', { n, count })}>
                  <span aria-hidden>{n}</span>
                  <span className="reviews-bar" aria-hidden>
                    <span style={{ width: `${summary.count ? Math.round((count / summary.count) * 100) : 0}%` }} />
                  </span>
                  <span className="hint small" aria-hidden>
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {items.map((r) => (
        <ReviewCard key={r.id} review={r} />
      ))}
      {q.hasNextPage && (
        <button type="button" className="btn btn-secondary btn-block" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t('common.showMore')}
        </button>
      )}
    </section>
  );
}

function ReviewCard({ review: r }: { review: ProductReview }) {
  const { t, lang } = useI18n();
  const date = r.published_at ? new Date(r.published_at).toLocaleDateString(lang === 'uz' ? 'uz-Latn-UZ' : 'ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return (
    <article className="review-card">
      <header>
        <strong>{r.author}</strong>
        <span className="hint small">{date}</span>
      </header>
      <div className="review-card-meta">
        <span role="img" aria-label={t('review.stars', { n: r.rating })}>
          <Stars value={r.rating} />
        </span>
        {r.verified && (
          <span className="review-verified">
            <BadgeIcon width={14} height={14} aria-hidden /> {t('review.verified')}
          </span>
        )}
      </div>
      {r.tags.length > 0 && (
        <ul className="review-card-tags">
          {r.tags.map((tag) => (
            <li key={tag}>{t(`review.tag.${tag}` as MessageKey)}</li>
          ))}
        </ul>
      )}
      <p className="pre">{r.text}</p>
      {r.photos.length > 0 && (
        <div className="review-card-photos">
          {r.photos.map((p) => (
            <a key={p.url} href={p.url_jpeg ?? p.url} target="_blank" rel="noreferrer">
              <Picture src={{ webp: p.thumb_url ?? p.url, jpeg: p.thumb_url_jpeg ?? p.url_jpeg, width: p.width, height: p.height }} alt="" />
            </a>
          ))}
        </div>
      )}
      {r.reply && (
        <div className="review-reply">
          <strong>
            <DoctorIcon width={16} height={16} aria-hidden /> {t('review.reply')}
          </strong>
          <p className="pre">{r.reply.text}</p>
        </div>
      )}
    </article>
  );
}
