import { Link } from 'react-router-dom';
import { money, productPath } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { tapHaptic } from '../lib/telegram';
import type { ProductVariant } from '../lib/types';

/** D-79 «Фасовка»: 60 / 120 капсул — each button opens that pack size (a product with its own price and stock). */
export function VariantChips({ variants }: { variants?: ProductVariant[] }) {
  const { t, lang } = useI18n();
  if (!variants?.length) return null;
  return (
    <section className="variants" aria-label={t('card.variants')}>
      <h2 className="variants-title">{t('card.variants')}</h2>
      <div className="chips scroll-x" role="list">
        {variants.map((v) => (
          <Link
            key={v.id}
            role="listitem"
            to={productPath(v)}
            replace
            aria-current={v.current ? 'true' : undefined}
            className={`variant-chip${v.current ? ' is-on' : ''}${v.in_stock ? '' : ' is-out'}`}
            onClick={() => tapHaptic()}
          >
            <span className="variant-label">{lang === 'uz' ? v.label_uz : v.label_ru}</span>
            <span className="variant-price">{v.in_stock ? money(v.price_uzs, lang) : t('card.variantOut')}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
