import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, isNetworkError } from '../lib/api';
import { digits, discountPercent, money, shortNameOf, tileLine, NBSP } from '../lib/format';
import { errorText, shownStatus, orderStatusKey, useI18n } from '../lib/i18n';
import { useFavoriteIds, useToggleFavorite } from '../lib/queries';
import type { OrderStatus, ProductListItem, ShopCampaign } from '../lib/types';
import { useUnderOrderText } from './CrossBorder';
import { PromoLabelBadge, SaleBadge, SalePrice } from './Campaign';
import { Picture, SafeImg } from './Picture';
import { QuickAdd } from './QuickAdd';
import { TileRating } from './Reviews';
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
  const I = STATUS_ICONS[shown];
  return (
    <span className={`status status-${shown}${large ? ' status-lg' : ''}`}>
      {large && I ? <I width={18} height={18} /> : <span className="status-dot" aria-hidden />}
      {t(orderStatusKey(status, { reported, cod }))}
    </span>
  );
}

export function Price({ price, old, size = 'md', campaign }: { price: number; old?: number | null; size?: 'md' | 'lg'; campaign?: ShopCampaign | null }) {
  const { lang } = useI18n();
  // 3.7: a sale shows its own two prices (up to 35%, not capped at 25% like a Market old price)
  if (campaign) return <SalePrice price={price} campaign={campaign} size={size} />;
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
 * 6а-Б: «На 30 дн. · 3 260 сум/день» always on ONE line. On a narrow card the line drops «На» first, then the word «сум»
 * (container queries in styles.css), so it never wraps; no course days (or under 7) — an empty line of the same height.
 */
function TileMeta({ product }: { product: ProductListItem }) {
  const { lang } = useI18n();
  const line = tileLine(product.price_uzs, product.course_days);
  if (!line) return <div className="tile-meta">{' '}</div>;
  const perDay = digits(line.perDay);
  const uz = lang === 'uz';
  return (
    <div className="tile-meta">
      {!uz && <span className="tile-meta-on">На{NBSP}</span>}
      {line.days}
      {NBSP}
      {uz ? 'kun' : 'дн.'}
      {' · '}
      {perDay}
      <span className="tile-meta-unit">{NBSP}{uz ? 'so‘m' : 'сум'}</span>/{uz ? 'kun' : 'день'}
    </div>
  );
}

/** 6а-Б: «125 000 сум» on a card — the number never cuts; on a narrow card «сум» gets smaller, then hides (styles.css). */
function TilePrice({ amount }: { amount: number }) {
  const { lang } = useI18n();
  return (
    <>
      {digits(amount)}
      <span className="tile-price-unit">
        {NBSP}
        {lang === 'uz' ? 'so‘m' : 'сум'}
      </span>
    </>
  );
}

export function ProductTile({ product }: { product: ProductListItem }) {
  const { t, lang } = useI18n();
  const uo = useUnderOrderText();
  const sale = product.campaign ?? null;
  const pct = sale ? null : discountPercent(product.price_uzs, product.old_price_uzs ?? null);
  // 6а-Б: the old price crossed out over the price (a sale or a Market old price); the slot is kept empty otherwise
  const old = sale ? sale.list_price_uzs : pct && product.in_stock ? product.old_price_uzs : null;
  return (
    <Link to={`/product/${product.id}`} className={`tile ${product.in_stock || product.cross_border ? '' : 'is-out'}${sale ? ` sale-card-${sale.skin}` : ''}`}>
      <div className="tile-img">
        {product.image ? <Picture src={product.image} /> : product.image_url && <SafeImg src={product.image_url} alt="" loading="lazy" decoding="async" />}
        <FavoriteButton productId={product.id} className="tile-fav" />
        {/* the badges live on the photo (top left, one under another): a sale or the manual promo label, then −% */}
        <div className="tile-badges">
          {sale ? <SaleBadge campaign={sale} className="tile-sale" /> : product.promo_label && <PromoLabelBadge label={product.promo_label} />}
          {pct && product.in_stock && <span className="tile-discount">−{pct}%</span>}
        </div>
        {!product.in_stock && (product.cross_border ? <span className="tile-usa">{uo('short', product.under_order)}</span> : <span className="tile-out">{t('product.outOfStock')}</span>)}
      </div>
      <div className="tile-body">
        <div className="tile-brand-row">
          <div className="tile-brand">{product.brand}</div>
          {/* 3.10-Б: stars from 3 published reviews */}
          <TileRating rating={product.rating} />
        </div>
        {/* 2.3: the short name, exactly 2 lines, whole words; the full one stays in search */}
        <div className="tile-name">{shortNameOf(product, lang)}</div>
        <TileMeta product={product} />
        {/* 6б-А: the price (the old one over it), under it a wide «В корзину» / «− 1 +» / «Сообщить» — fixed heights,
            so in a row of cards the prices and the buttons are on one level and the button never covers the price */}
        <div className="tile-foot">
          <div className="tile-prices">
            <s className="tile-price-old">{old ? <TilePrice amount={old} /> : ''}</s>
            <div className={`tile-price${sale ? ` sale-text-${sale.skin}` : ''}`}>
              <TilePrice amount={product.price_uzs} />
            </div>
          </div>
          <div className="tile-action">
            <QuickAdd productId={product.id} inStock={product.in_stock || !!product.cross_border} campaignId={sale?.id} />
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
