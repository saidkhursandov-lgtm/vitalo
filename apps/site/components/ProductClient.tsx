'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, CircleCheck, Clock, Heart, Minus, Plus, ShoppingBag, Truck } from 'lucide-react';
import type { ProductCard } from '@/lib/types';
import { discountPercent, money, pricePerDay } from '@/lib/format';
import { useSession } from './Session';

type Media = ProductCard['media'][number];

export function Gallery({ images, alt }: { images: Media[]; alt: string }) {
  const [i, setI] = useState(0);
  const cur = images[i];
  return (
    <div className="gallery">
      <div className="gallery-main">{cur ? <img src={cur.url} alt={alt} width={cur.width ?? 800} height={cur.height ?? 800} /> : null}</div>
      {images.length > 1 ? (
        <div className="thumbs">
          {images.map((m, n) => (
            <button key={m.url} type="button" className={`thumb${n === i ? ' is-on' : ''}`} onClick={() => setI(n)} aria-label={`${n + 1} / ${images.length}`} aria-pressed={n === i}>
              <img src={m.thumb_url ?? m.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Price, stock, quantity, «В корзину» and «Купить сейчас»; on a phone the same buttons stay at the bottom. */
export function BuyBox({ p }: { p: ProductCard }) {
  const { t, lang, addToCart, favorites, toggleFavorite, user } = useSession();
  const router = useRouter();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const terms = p.cross_border_terms ?? p.under_order ?? null;
  const fromWhere = terms?.kind === 'foreign' || p.cross_border;
  const canBuy = p.in_stock || !!terms;
  const max = p.in_stock ? Math.max(1, Math.min(99, p.available_qty || 99)) : 99;
  const oldPrice = p.campaign?.list_price_uzs ?? p.old_price_uzs;
  const off = discountPercent(p.price_uzs, oldPrice ?? null);
  const days = p.course_days && p.course_days >= 7 ? p.course_days : null;
  const fav = favorites.has(p.id);

  async function add(thenCart: boolean) {
    setBusy(true);
    try {
      await addToCart(p.id, qty);
      setAdded(true);
      if (thenCart) router.push('/cart');
    } catch {
      /* stays on the page; the button can be pressed again */
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="buy-box">
        <div className="buy-price">
          <span className="now">{money(p.price_uzs, lang)}</span>
          {off && oldPrice ? (
            <>
              <span className="old">{money(oldPrice, lang)}</span>
              <span className="off">−{off}%</span>
            </>
          ) : null}
        </div>
        <div className="buy-line">
          {p.in_stock ? (
            <span className="ok">
              <CircleCheck size={16} strokeWidth={2} /> {t('product.inStock')}
            </span>
          ) : terms ? (
            <span>
              <Clock size={16} strokeWidth={1.8} />
              {t(fromWhere ? 'product.usa' : 'product.underOrder', { min: terms.days_min, max: terms.days_max })}
            </span>
          ) : (
            <span>{t('product.out')}</span>
          )}
          {days ? (
            <span>
              {t('product.course', { n: days })} · {t('product.perDay', { sum: money(pricePerDay(p.price_uzs, days), lang) })}
            </span>
          ) : null}
        </div>
        {canBuy ? (
          <div className="buy-row">
            <div className="qty">
              <button type="button" aria-label={t('cart.less')} disabled={qty <= 1} onClick={() => setQty((q) => q - 1)}>
                <Minus size={18} />
              </button>
              <span aria-live="polite">{qty}</span>
              <button type="button" aria-label={t('cart.more')} disabled={qty >= max} onClick={() => setQty((q) => q + 1)}>
                <Plus size={18} />
              </button>
            </div>
            {added ? (
              <Link href="/cart" className="btn btn-secondary">
                <Check size={18} strokeWidth={2.2} /> {t('product.toCart')}
              </Link>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => void add(false)}>
                <ShoppingBag size={18} strokeWidth={1.8} /> {t('product.add')}
              </button>
            )}
          </div>
        ) : null}
        <div className="buy-row">
          {canBuy ? (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void add(true)}>
              {t('product.buyNow')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: 'none' }}
            aria-pressed={fav}
            onClick={() => (user ? void toggleFavorite(p.id) : router.push(`/login?next=${encodeURIComponent(location.pathname)}`))}
          >
            <Heart size={18} strokeWidth={1.8} fill={fav ? 'currentColor' : 'none'} /> {t('nav.favorites')}
          </button>
        </div>
        <div className="shared-note">
          <Truck size={16} strokeWidth={1.8} />
          <span>{t('header.delivery')}. {t('cart.shared')}.</span>
        </div>
      </div>
      {canBuy ? (
        <div className="mobile-buy">
          <div className="price">
            <span className="price-now">{money(p.price_uzs, lang)}</span>
          </div>
          {added ? (
            <Link href="/cart" className="btn btn-secondary">
              {t('product.toCart')}
            </Link>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void add(false)}>
              <ShoppingBag size={18} strokeWidth={1.8} /> {t('product.add')}
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

/** A small «В корзину» for «Идеальная пара» and similar blocks. */
export function AddButton({ productId, label }: { productId: string; label: string }) {
  const { addToCart, t } = useSession();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={done ? 'btn btn-secondary' : 'btn'}
      onClick={() =>
        void addToCart(productId, 1)
          .then(() => setDone(true))
          .catch(() => null)
      }
    >
      {done ? <Check size={18} strokeWidth={2.2} /> : <Plus size={18} strokeWidth={2.2} />} {done ? t('tile.inCart') : label}
    </button>
  );
}
