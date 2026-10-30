import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, isNetworkError } from '../lib/api';
import { discountPercent, money, nameOf, shortNameOf, tileMeta } from '../lib/format';
import { errorText, pluralForm, shownStatus, statusKey, useI18n, type MessageKey } from '../lib/i18n';
import { useFavoriteIds, useToggleFavorite } from '../lib/queries';
import type { OrderStatus, ProductListItem, Region } from '../lib/types';
import { Picture } from './Picture';
import { QuickAdd } from './QuickAdd';
import { HeartIcon, MinusIcon, OfflineIcon, PlusIcon, SearchEmptyIcon, STATUS_ICONS, type Icon } from './Icons';

// ---------------------------------------------------------------- loading skeletons (no spinners)

const Bar = ({ w = '100%', h = 14, r }: { w?: string | number; h?: number; r?: number }) => (
  <span className="skel" style={{ width: w, height: h, borderRadius: r }} />
);

function SkeletonTile() {
  return (
    <div className="tile tile-skel">
      <span className="skel tile-img" />
      <div className="tile-body">
        <Bar w="55%" h={16} />
        <Bar w="90%" />
        <Bar w="40%" h={12} />
      </div>
    </div>
  );
}

export type SkeletonVariant = 'grid' | 'strip' | 'list' | 'product' | 'chips' | 'block';

/** Grey placeholders in the shape of the content that is loading. */
/**
 * Bottom action bar fixed above the menu (Корзина, Оформление, Оплата). Its real height (an error line may appear above
 * the button) goes to --action-h, and html.has-action gives the scrolling content that much room at the bottom,
 * so the last line (e.g. «Срок доставки») is never hidden under the button.
 */
export function StickyAction({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const apply = () => root.style.setProperty('--action-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    apply();
    root.classList.add('has-action');
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.classList.remove('has-action');
      root.style.removeProperty('--action-h');
    };
  }, []);
  return (
    <div className="sticky-action" ref={ref}>
      {children}
    </div>
  );
}

export function Loading({ variant = 'block', count }: { variant?: SkeletonVariant; count?: number }) {
  const { t } = useI18n();
  const n = (d: number) => Array.from({ length: count ?? d }, (_, i) => i);
  let body: ReactNode;
  switch (variant) {
    case 'grid':
      body = <div className="grid">{n(4).map((i) => <SkeletonTile key={i} />)}</div>;
      break;
    case 'strip':
      body = <div className="strip">{n(3).map((i) => <SkeletonTile key={i} />)}</div>;
      break;
    case 'chips':
      body = <div className="chips">{n(4).map((i) => <Bar key={i} w={96 + (i % 2) * 28} h={44} r={22} />)}</div>;
      break;
    case 'list':
      body = (
        <div className="card list">
          {n(4).map((i) => (
            <div key={i} className="list-row skel-row">
              <span className="skel-col">
                <Bar w="60%" h={15} />
                <Bar w="35%" h={12} />
              </span>
              <Bar w={64} h={24} r={12} />
            </div>
          ))}
        </div>
      );
      break;
    case 'product':
      body = (
        <>
          <span className="skel gallery" />
          <span className="skel-col">
            <Bar w="30%" h={12} />
            <Bar w="85%" h={22} />
            <Bar w="40%" h={24} />
            <Bar w="100%" h={48} r={12} />
          </span>
        </>
      );
      break;
    default:
      body = (
        <div className="card skel-col">
          <Bar w="45%" h={18} />
          <Bar />
          <Bar w="80%" />
          <Bar w="65%" />
        </div>
      );
  }
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={t('common.loading')}>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- empty and error states

/** One look for every empty screen: icon, title, explanation and an action button. */
export function EmptyState({ icon: I = SearchEmptyIcon, title, text, action }: { icon?: Icon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="state-icon">
        <I width={28} height={28} />
      </span>
      <h2>{title}</h2>
      {text && <p className="hint">{text}</p>}
      {action}
    </div>
  );
}

/** Short empty message (old call sites): same component, title only. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <EmptyState title={String(children)} action={action} />;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, lang } = useI18n();
  const code = error instanceof ApiError ? error.code : undefined;
  const text = errorText(lang, code);
  const offline = isNetworkError(error);
  return (
    <div className="empty-state is-error" role="alert">
      <span className="state-icon">
        <OfflineIcon width={28} height={28} />
      </span>
      <h2>{offline ? t('net.title') : t('common.error')}</h2>
      <p className="hint">{text === t('common.error') ? t('common.errorHint') : text}</p>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- order status pill

/** Coloured pill: dot + text in lists, SVG icon + text on the order screen. */
export function StatusPill({ status, reported = false, large = false, cod = false }: { status: OrderStatus; reported?: boolean; large?: boolean; cod?: boolean }) {
  const { t } = useI18n();
  const shown = shownStatus(status, reported);
  // «Оплата при получении»: a new order waits for the manager, not for a payment
  const waitsForManager = cod && status === 'new';
  const I = STATUS_ICONS[shown];
  return (
    <span className={`status status-${shown}${large ? ' status-lg' : ''}`}>
      {large && I ? <I width={18} height={18} /> : <span className="status-dot" aria-hidden />}
      {t(waitsForManager ? 'status.codWaiting' : statusKey(status, reported))}
    </span>
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
      {/* 44×44 tap area, smaller visible circle */}
      <span className="fav-dot">
        <HeartIcon filled={on} width={18} height={18} />
      </span>
    </button>
  );
}

/**
 * 2.3 fixes: «Цитрат магния + Вит. B6 • 50 дн.» on one line; when it does not fit — only «На 50 дней»
 * (without days — the form with «…»). The line is always there, empty or not, so all cards of a row are equal.
 */
function TileMeta({ product }: { product: ProductListItem }) {
  const { t, lang } = useI18n();
  const meta = tileMeta(product, lang, (n) => t('card.daysShort', { n }), (n) => t('card.days', { n, d: t(`card.day.${pluralForm(n)}` as MessageKey) }));
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !meta?.days) return;
    const check = () => setShort(!!probe.current && el.clientWidth > 0 && probe.current.offsetWidth > el.clientWidth + 1);
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [meta?.full, meta?.days]);
  return (
    <div className="tile-meta" ref={box}>
      {meta ? (short && meta.days ? meta.days : meta.full) : ' '}
      {meta?.days && (
        <span className="tile-meta-probe" ref={probe} aria-hidden>
          {meta.full}
        </span>
      )}
    </div>
  );
}

export function ProductTile({ product }: { product: ProductListItem }) {
  const { t, lang } = useI18n();
  const pct = discountPercent(product.price_uzs, product.old_price_uzs ?? null);
  return (
    <Link to={`/product/${product.id}`} className={`tile ${product.in_stock ? '' : 'is-out'}`}>
      <div className="tile-img">
        {product.image ? <Picture src={product.image} /> : product.image_url && <img src={product.image_url} alt="" loading="lazy" decoding="async" />}
        <FavoriteButton productId={product.id} className="tile-fav" />
        {/* the discount lives on the photo, so the price is always one line; the old price is on the product page */}
        {pct && product.in_stock && <span className="tile-discount">−{pct}%</span>}
        {!product.in_stock && <span className="tile-out">{t('product.outOfStock')}</span>}
      </div>
      <div className="tile-body">
        <div className="tile-brand">{product.brand}</div>
        {/* 2.3: the short name, exactly 2 lines, whole words; the full one stays in search */}
        <div className="tile-name">{shortNameOf(product, lang)}</div>
        <TileMeta product={product} />
        {/* price on its own line, the button row under it: the same in every card, so prices and [+] line up */}
        <div className="tile-foot">
          <div className="tile-price">{money(product.price_uzs, lang)}</div>
          <div className="tile-action">
            <QuickAdd productId={product.id} inStock={product.in_stock} />
          </div>
        </div>
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
        <MinusIcon width={18} height={18} />
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label="+" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        <PlusIcon width={18} height={18} />
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
    <div className="field-row region-city">
      <label className="field">
        <span>{t('checkout.region')}</span>
        <select value={regionId} onChange={(e) => onChange({ region_id: e.target.value, city_id: '' })}>
          <option value="">{t('checkout.choose')}</option>
          {[...regions].sort((a, b) => nameOf(a, lang).localeCompare(nameOf(b, lang), lang)).map((r) => (
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
          {[...(region?.cities ?? [])].sort((a, b) => nameOf(a, lang).localeCompare(nameOf(b, lang), lang)).map((c) => (
            <option key={c.id} value={c.id}>
              {nameOf(c, lang)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
