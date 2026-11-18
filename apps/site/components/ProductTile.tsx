'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Heart, Plus, Star } from 'lucide-react';
import type { ProductListItem } from '@/lib/types';
import { discountPercent, money, productPath, shortNameOf, textOf, tileLine } from '@/lib/format';
import { useSession } from './Session';

export function ProductTile({ p }: { p: ProductListItem }) {
  const { t, lang, addToCart, favorites, toggleFavorite, user } = useSession();
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const href = productPath(p);
  const name = shortNameOf(p, lang);
  const oldPrice = p.campaign?.list_price_uzs ?? p.old_price_uzs;
  const off = discountPercent(p.price_uzs, oldPrice ?? null);
  const line = tileLine(p.price_uzs, p.course_days);
  const form = textOf(p, 'substance_form', lang);
  const canBuy = p.in_stock || !!p.under_order;
  const fav = favorites.has(p.id);
  const label = p.promo_label === 'hit' ? (lang === 'uz' ? 'Xit' : 'Хит') : p.promo_label === 'new' ? (lang === 'uz' ? 'Yangi' : 'Новинка') : null;
  const img = p.image?.webp ?? p.image_url;

  async function add() {
    setBusy(true);
    try {
      await addToCart(p.id, 1);
      setDone(true);
      window.setTimeout(() => setDone(false), 1800);
    } catch {
      /* the toast stays silent; the button can be pressed again */
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`tile${canBuy ? '' : ' is-out'}`}>
      <div className="tile-img">
        {img ? <img src={img} alt="" loading="lazy" width={p.image?.width ?? 400} height={p.image?.height ?? 400} /> : null}
        <div className="tile-badges">
          {off ? <span className="tile-badge">−{off}%</span> : null}
          {label ? <span className="tile-badge navy">{label}</span> : null}
          {p.cross_border ? <span className="tile-badge light">{t('tile.usa')}</span> : null}
        </div>
      </div>
      <button
        type="button"
        className={`fav-btn${fav ? ' is-on' : ''}`}
        aria-pressed={fav}
        aria-label={t('nav.favorites')}
        onClick={() => (user ? void toggleFavorite(p.id) : router.push(`/login?next=${encodeURIComponent(href)}`))}
      >
        <Heart size={20} strokeWidth={1.8} />
      </button>
      <div className="tile-body">
        <div className="tile-top">
          <span className="tile-brand">{p.brand}</span>
          {p.rating ? (
            <span className="rating" aria-label={`${p.rating.avg.toFixed(1)} / 5`}>
              <Star size={12} strokeWidth={1.8} /> {p.rating.avg.toFixed(1)}
            </span>
          ) : null}
        </div>
        <Link href={href} className="tile-name">
          {name}
        </Link>
        {form || line ? <div className="tile-meta">{[form, line ? t('tile.days', { n: line.days }) : null].filter(Boolean).join(' · ')}</div> : null}
        <div className="tile-foot">
          <div className="price">
            {off && oldPrice ? <span className="price-old">{money(oldPrice, lang)}</span> : null}
            <span className="price-now">{money(p.price_uzs, lang)}</span>
          </div>
          {canBuy ? (
            <button type="button" className={`add-btn${done ? ' is-done' : ''}`} disabled={busy} onClick={() => void add()} aria-label={`${t('tile.add')}: ${name}`}>
              {done ? <Check size={20} strokeWidth={2.2} /> : <Plus size={20} strokeWidth={2.2} />}
            </button>
          ) : (
            <span className="tile-out">{t('tile.out')}</span>
          )}
        </div>
      </div>
    </article>
  );
}
