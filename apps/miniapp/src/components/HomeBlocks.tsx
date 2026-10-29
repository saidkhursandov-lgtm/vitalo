import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { openSupport } from '../lib/shop';
import type { HomeContent, Lang, LocalizedText, ShopBanner, ShopInfo } from '../lib/types';
import { generalTerms } from './Delivery';
import { BadgeIcon, DoctorIcon, ShieldIcon, StarIcon, SupportIcon, TRUST_ICONS } from './Icons';
import { useSupportUrl } from './Support';

const pick = (t: LocalizedText, lang: Lang) => (lang === 'uz' ? t.uz : t.ru);

/** Quiet line art for the navy banner: two thin rings and a small cross; the orange dot is the only accent. */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 120 120" width="120" height="120" aria-hidden fill="none">
      <circle cx="78" cy="42" r="40" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1.5" />
      <circle cx="78" cy="42" r="24" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
      <path d="M78 33v18M69 42h18" stroke="currentColor" strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="104" cy="74" r="4" fill="var(--accent)" />
    </svg>
  );
}

/**
 * Home banner (navy, about 116 px): two slides — «Отбор врачом • 4,9★ на Яндекс Маркете» and the delivery offer. The offer is
 * what is true for this customer (the server decides): the first order is free, or delivery is free from the tariff's threshold.
 */
/** The two slides the shop always had: used until the admin list arrives, and in tests. */
const BUILT_IN_BANNERS: ShopBanner[] = [
  { id: 'doctor', kind: 'doctor', image_url: null, image_jpeg_url: null, link: null },
  { id: 'delivery', kind: 'delivery', image_url: null, image_jpeg_url: null, link: null },
];

/** Where a tap on the banner leads (null — nowhere). */
export function bannerHref(link: ShopBanner['link']): string | null {
  if (!link) return null;
  if (link.type === 'product') return `/product/${link.value}`;
  if (link.type === 'category') return `/catalog/products?category=${encodeURIComponent(link.value)}`;
  // 2.2: a brand banner opens the brand page (the server finds the brand by its name too)
  return `/brand/${encodeURIComponent(link.value)}`;
}

/**
 * Home banners in the order set in the admin panel (Настройки → Главная → Баннеры).
 * doctor / delivery are the navy slides; the delivery one keeps its rule: a new customer — «Первый заказ — бесплатная доставка»,
 * everybody else — «Бесплатная доставка от {порог}» (the tariff's threshold), neither — no slide. Nothing to show — no block at all.
 */
export function HomeCarousel({
  firstOrderFree,
  freeFromUzs,
  banners = BUILT_IN_BANNERS,
}: {
  firstOrderFree: boolean;
  freeFromUzs: number | null;
  banners?: ShopBanner[];
}) {
  const { t, lang } = useI18n();
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const slides = banners.flatMap((b) => {
    const href = bannerHref(b.link);
    if (b.kind === 'image') {
      if (!b.image_url) return [];
      const picture = (
        <picture>
          <source srcSet={b.image_url} type="image/webp" />
          <img src={b.image_jpeg_url ?? b.image_url} alt="" width={1200} height={400} decoding="async" />
        </picture>
      );
      return [{ key: b.id, className: 'hero-slide hero-image', href, body: picture }];
    }
    const text =
      b.kind === 'doctor'
        ? {
            title: t('home.slide1.title'),
            sub: (
              <>
                <strong>4,9</strong>
                <StarIcon filled className="hero-star" width={15} height={15} aria-label="★" />
                {t('home.slide1.sub')}
              </>
            ),
          }
        : firstOrderFree
          ? { title: t('home.slide2.title'), sub: <>{t('home.slide2.sub')}</> }
          : freeFromUzs
            ? { title: t('home.slide2.from', { sum: money(freeFromUzs, lang) }), sub: <>{t('home.slide2.sub')}</> }
            : null;
    if (!text) return [];
    const body = (
      <>
        <HeroArt />
        <h2>{text.title}</h2>
        <p>{text.sub}</p>
      </>
    );
    return [{ key: b.id, className: 'hero-slide', href, body }];
  });
  if (slides.length === 0) return null;
  return (
    <section className="hero" aria-roledescription="carousel">
      <div
        className="hero-track"
        ref={track}
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
      >
        {slides.map((s) =>
          s.href ? (
            <Link key={s.key} to={s.href} className={s.className}>
              {s.body}
            </Link>
          ) : (
            <div key={s.key} className={s.className}>
              {s.body}
            </div>
          ),
        )}
      </div>
      {slides.length > 1 && (
        <div className="hero-dots" aria-hidden>
          {slides.map((s, i) => (
            <span key={s.key} className={i === index ? 'is-on' : ''} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Two trust markers under the search field (ТЗ 2.1): they wrap instead of running off the screen edge. */
export function TrustChips() {
  const { t } = useI18n();
  const chips = [
    { key: 'doctor', Icon: DoctorIcon, text: t('home.chip.doctor') },
    { key: 'original', Icon: ShieldIcon, text: t('home.chip.original') },
  ];
  return (
    <div className="chips trust-chips">
      {chips.map(({ key, Icon, text }) => (
        <span key={key} className="chip chip-static">
          <Icon width={16} height={16} />
          {text}
        </span>
      ))}
    </div>
  );
}

/** «Поможем с выбором» — opens the support chat. */
export function HelpButton() {
  const { t } = useI18n();
  const url = useSupportUrl();
  return (
    <button type="button" className="btn btn-secondary btn-block help-btn" onClick={() => openSupport(url)}>
      <SupportIcon width={20} height={20} /> {t('home.help')}
    </button>
  );
}

/** Banner on the brand background: title, subtitle, «Смотреть каталог». */
export function HomeBanner({ content }: { content: HomeContent }) {
  const { lang } = useI18n();
  const b = content.banner;
  if (!b.enabled) return null;
  return (
    <section className="banner">
      <BadgeIcon className="banner-mark" width={96} height={96} />
      <h2>{pick(b.title, lang)}</h2>
      <p>{pick(b.subtitle, lang)}</p>
      <Link to="/catalog" className="btn banner-btn">
        {pick(b.button, lang)}
      </Link>
    </section>
  );
}

/** Four trust tiles; {delivery} becomes the delivery terms, {from}/{to} the payment check hours. */
export function TrustTiles({ shop }: { shop: ShopInfo }) {
  const { t, lang } = useI18n();
  const content = shop.home_content;
  const tiles = content?.trust.filter((x) => x.enabled) ?? [];
  if (!tiles.length) return null;
  const fill = (s: string) =>
    s
      .replace('{delivery}', generalTerms(shop, lang, t) ?? '')
      .replace('{from}', shop.payment_check_hours.from)
      .replace('{to}', shop.payment_check_hours.to)
      .trim();
  return (
    <section className="trust-grid">
      {tiles.map((tile) => {
        const I = TRUST_ICONS[tile.key];
        const text = fill(pick(tile.text, lang));
        return (
          <div key={tile.key} className="trust-tile">
            <span className="trust-icon">
              <I width={22} height={22} />
            </span>
            <strong>{fill(pick(tile.title, lang))}</strong>
            {text && <span className="hint small">{text}</span>}
          </div>
        );
      })}
    </section>
  );
}

/** «Как заказать» in three steps. */
export function HowToOrder({ content }: { content: HomeContent }) {
  const { t, lang } = useI18n();
  if (!content.steps.enabled || !content.steps.items.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t('home.howTitle')}</h2>
      </div>
      <ol className="steps card">
        {content.steps.items.map((s, i) => (
          <li key={i}>
            <span className="step-num" aria-hidden>
              {i + 1}
            </span>
            <span>{pick(s, lang)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
