import { Link } from 'react-router-dom';
import { money, shortNameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { ProductPair } from '../lib/types';
import { Picture, SafeImg } from './Picture';
import { QuickAdd } from './QuickAdd';

/** 4.1 «Идеальная пара»: the second jar that works with this one (an approved synergy rule) and «почему вместе». */
export function PerfectPair({ pair }: { pair: ProductPair | null | undefined }) {
  const { t, lang } = useI18n();
  if (!pair) return null;
  const p = pair.product;
  const why = lang === 'uz' ? pair.why_uz || pair.why_ru : pair.why_ru;
  const price = p.price_uzs; // in a sale it is already the sale price
  return (
    <section className="pair card" aria-label={t('pair.title')}>
      <h2 className="pair-title">{t('pair.title')}</h2>
      <div className="pair-row">
        <Link to={`/product/${p.id}`} className="pair-link">
          <span className="pair-img">{p.image ? <Picture src={p.image} /> : p.image_url && <SafeImg src={p.image_url} alt="" loading="lazy" decoding="async" />}</span>
          <span className="pair-text">
            <span className="pair-name">{shortNameOf(p, lang)}</span>
            <span className="pair-price">{money(price, lang)}</span>
          </span>
        </Link>
        <div className="pair-add">
          <QuickAdd productId={p.id} inStock={p.in_stock} campaignId={p.campaign?.id} />
        </div>
      </div>
      {why && <p className="pair-why">{why}</p>}
    </section>
  );
}
