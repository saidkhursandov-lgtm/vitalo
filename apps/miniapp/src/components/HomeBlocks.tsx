import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { openSupport } from '../lib/shop';
import type { HomeContent, Lang, LocalizedText, ShopInfo } from '../lib/types';
import { generalTerms } from './Delivery';
import { BadgeIcon, DoctorIcon, ShieldIcon, StarIcon, SupportIcon, TRUST_ICONS } from './Icons';
import { useSupportUrl } from './Support';

const pick = (t: LocalizedText, lang: Lang) => (lang === 'uz' ? t.uz : t.ru);

/**
 * Home banner (120–140 px): two slides — «Отбор врачом • 4,9★ на Яндекс Маркете» and the delivery offer. The offer is
 * what is true for this customer (the server decides): the first order is free, or delivery is free from the tariff's threshold.
 */
export function HomeCarousel({ firstOrderFree, freeFromUzs }: { firstOrderFree: boolean; freeFromUzs: number | null }) {
  const { t, lang } = useI18n();
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const slides = [
    {
      key: 'doctor',
      title: t('home.slide1.title'),
      sub: (
        <>
          <strong>4,9</strong>
          <StarIcon filled width={14} height={14} aria-label="★" />
          {t('home.slide1.sub')}
        </>
      ),
    },
    // a new customer: «Первый заказ — бесплатная доставка»; everybody else: «Бесплатная доставка от {порог}» (the tariff's threshold)
    ...(firstOrderFree
      ? [{ key: 'free', title: t('home.slide2.title'), sub: <>{t('home.slide2.sub')}</> }]
      : freeFromUzs
        ? [{ key: 'free', title: t('home.slide2.from', { sum: money(freeFromUzs, lang) }), sub: <>{t('home.slide2.sub')}</> }]
        : []),
  ];
  return (
    <section className="hero" aria-roledescription="carousel">
      <div
        className="hero-track"
        ref={track}
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
      >
        {slides.map((s) => (
          <div key={s.key} className="hero-slide">
            <BadgeIcon className="banner-mark" width={96} height={96} />
            <h2>{s.title}</h2>
            <p>{s.sub}</p>
          </div>
        ))}
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

/** Three short trust chips under the search field. */
export function TrustChips() {
  const { t } = useI18n();
  const chips = [
    { key: 'original', Icon: ShieldIcon, text: t('home.chip.original') },
    { key: 'doctor', Icon: DoctorIcon, text: t('home.chip.doctor') },
    { key: 'delivery', Icon: TRUST_ICONS.delivery, text: t('home.chip.delivery') },
  ];
  return (
    <div className="chips scroll-x trust-chips">
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
