import { Link } from 'react-router-dom';
import { categoryIcon } from './Icons';
import { nameOf } from '../lib/format';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import { useBrandShowcase } from '../lib/queries';
import type { BrandCard, CategoryNode } from '../lib/types';

/**
 * The three catalog layers (ТЗ v3 §4.1), shared by the home screen and the «Каталог» tab:
 * «По потребности», «По типу» — one level, one tap to the product list — and the «Проверенные бренды» strip.
 */

/** Category: icon, name, and the number of products customers can see — small and grey. */
export function CategoryLink({ c, className }: { c: CategoryNode; className: string }) {
  const { t, lang } = useI18n();
  const Icon = categoryIcon(c.slug);
  return (
    <Link className={className} to={`/catalog/products?category=${c.slug}`}>
      <span className="cat-icon">
        <Icon width={20} height={20} />
      </span>
      <span className="cat-text">
        <span className="cat-name">{nameOf(c, lang)}</span>
        <span className="cat-count">{t(`home.count.${pluralForm(c.product_count)}` as MessageKey, { n: c.product_count })}</span>
      </span>
    </Link>
  );
}

/** Logo in a square; a brand without a logo yet gets its first letter on soft navy. */
export function BrandLogo({ brand, size }: { brand: Pick<BrandCard, 'name' | 'logo_url'>; size: number }) {
  return (
    <span className="brand-logo" style={{ width: size, height: size }}>
      {brand.logo_url ? <img src={brand.logo_url} alt="" width={size} height={size} loading="lazy" /> : <span aria-hidden>{brand.name.trim().slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** «Проверенные бренды»: a horizontal strip of brands that have products in stock; nothing to show — no block. */
export function BrandStrip() {
  const { t } = useI18n();
  const brands = useBrandShowcase();
  if (!brands.data?.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t('home.brands')}</h2>
      </div>
      <div className="brand-strip scroll-x">
        {brands.data.map((b) => (
          <Link key={b.id} className="brand-card" to={`/brand/${b.slug}`}>
            <BrandLogo brand={b} size={56} />
            <span className="brand-card-name">{b.name}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
