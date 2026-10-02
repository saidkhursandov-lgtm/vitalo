import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { discountPercent, money, nameOf } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useFavoriteIds, useToggleFavorite } from '../lib/queries';
import type { ProductListItem, Region } from '../lib/types';
import { HeartIcon } from './Icons';

export function Loading() {
  const { t } = useI18n();
  return <div className="state hint">{t('common.loading')}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, lang } = useI18n();
  const code = error instanceof ApiError ? error.code : undefined;
  return (
    <div className="state">
      <p>{errorText(lang, code)}</p>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state hint">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Price({ price, old, size = 'md' }: { price: number; old?: number | null; size?: 'md' | 'lg' }) {
  const { lang } = useI18n();
  const pct = discountPercent(price, old ?? null);
  return (
    <div className={`price price-${size}`}>
      <span className="price-now">{money(price, lang)}</span>
      {pct && (
        <>
          <span className="price-old">{money(old!, lang)}</span>
          <span className="price-badge">−{pct}%</span>
        </>
      )}
    </div>
  );
}

export function FavoriteButton({ productId, className = '' }: { productId: string; className?: string }) {
  const { t } = useI18n();
  const ids = useFavoriteIds();
  const toggle = useToggleFavorite();
  const on = ids.data?.has(productId) ?? false;
  return (
    <button
      type="button"
      className={`fav-btn ${on ? 'is-on' : ''} ${className}`}
      aria-label={on ? t('product.favRemove') : t('product.favAdd')}
      aria-pressed={on}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ id: productId, on: !on });
      }}
    >
      <HeartIcon filled={on} width={20} height={20} />
    </button>
  );
}

export function ProductTile({ product }: { product: ProductListItem }) {
  const { t, lang } = useI18n();
  return (
    <Link to={`/product/${product.id}`} className={`tile ${product.in_stock ? '' : 'is-out'}`}>
      <div className="tile-img">
        {product.image_url && <img src={product.image_url} alt="" loading="lazy" />}
        <FavoriteButton productId={product.id} className="tile-fav" />
        {!product.in_stock && <span className="tile-out">{t('product.outOfStock')}</span>}
      </div>
      <div className="tile-body">
        <Price price={product.price_uzs} old={product.old_price_uzs} />
        <div className="tile-name">{nameOf(product, lang)}</div>
        <div className="tile-brand hint">{product.brand}</div>
      </div>
    </Link>
  );
}

export function ProductGrid({ products }: { products: ProductListItem[] }) {
  return (
    <div className="grid">
      {products.map((p) => (
        <ProductTile key={p.id} product={p} />
      ))}
    </div>
  );
}

/** Horizontal strip of product tiles (Home, "Похожие", "Покупают вместе"). */
export function ProductStrip({ title, products, more }: { title: string; products: ProductListItem[]; more?: ReactNode }) {
  if (!products.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {more}
      </div>
      <div className="strip">
        {products.map((p) => (
          <ProductTile key={p.id} product={p} />
        ))}
      </div>
    </section>
  );
}

export function Stepper({ value, min = 1, max, onChange, disabled }: { value: number; min?: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="stepper">
      <button type="button" aria-label="−" disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label="+" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** Region + city dropdowns; changing the region resets the city. */
export function RegionCitySelect({
  regions,
  regionId,
  cityId,
  onChange,
}: {
  regions: Region[];
  regionId: string;
  cityId: string;
  onChange: (v: { region_id: string; city_id: string }) => void;
}) {
  const { t, lang } = useI18n();
  const region = regions.find((r) => r.id === regionId);
  return (
    <div className="field-row">
      <label className="field">
        <span>{t('checkout.region')}</span>
        <select value={regionId} onChange={(e) => onChange({ region_id: e.target.value, city_id: '' })}>
          <option value="">{t('checkout.choose')}</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {nameOf(r, lang)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('checkout.city')}</span>
        <select value={cityId} disabled={!region} onChange={(e) => onChange({ region_id: regionId, city_id: e.target.value })}>
          <option value="">{t('checkout.choose')}</option>
          {region?.cities.map((c) => (
            <option key={c.id} value={c.id}>
              {nameOf(c, lang)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Short message at the bottom of the screen, optionally with an action link. */
export function Toast({ message, action, onClose }: { message: string; action?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const id = setTimeout(onClose, 3500);
    return () => clearTimeout(id);
  }, [onClose]);
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      {action}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; action?: ReactNode } | null>(null);
  const node = toast ? <Toast message={toast.message} action={toast.action} onClose={() => setToast(null)} /> : null;
  return { show: (message: string, action?: ReactNode) => setToast({ message, action }), node };
}
