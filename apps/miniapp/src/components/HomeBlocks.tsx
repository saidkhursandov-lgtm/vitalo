import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import type { HomeContent, Lang, LocalizedText, ShopInfo } from '../lib/types';
import { generalTerms } from './Delivery';
import { BadgeIcon, TRUST_ICONS } from './Icons';

const pick = (t: LocalizedText, lang: Lang) => (lang === 'uz' ? t.uz : t.ru);

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
