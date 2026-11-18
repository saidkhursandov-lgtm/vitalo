'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Minus, Plus, Send, ShoppingBag, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/client';
import { money, productPath, shortNameOf } from '@/lib/format';
import type { Cart, ProductCard } from '@/lib/types';
import { useSession } from '@/components/Session';

interface Line {
  id: string;
  href: string;
  name: string;
  brand: string;
  image: string | null;
  qty: number;
  max: number;
  unit: number;
  total: number;
  available: boolean;
}

/**
 * The cart. Signed in — the account cart (the same one the Mini App shows); a guest — the lines saved in this browser,
 * which move into the account cart on sign-in.
 */
export function CartView() {
  const { t, lang, user, guestCart, setGuestLine, refreshCart, botUsername } = useSession();
  const [cart, setCart] = useState<Cart | null>(null);
  const [guest, setGuest] = useState<Record<string, ProductCard | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadCart = useCallback(async () => {
    setCart(await api<Cart>('/cart'));
  }, []);

  useEffect(() => {
    if (user) void loadCart().catch(() => setCart(null));
  }, [user, loadCart]);

  // Guest lines: product details from the public catalog.
  useEffect(() => {
    if (user !== null) return;
    const missing = guestCart.filter((l) => !(l.product_id in guest));
    if (!missing.length) return;
    void Promise.all(missing.map((l) => api<ProductCard>(`/catalog/products/${l.product_id}`, { auth: false }).catch(() => null))).then((cards) =>
      setGuest((cur) => {
        const n = { ...cur };
        missing.forEach((l, i) => (n[l.product_id] = cards[i]));
        return n;
      }),
    );
  }, [user, guestCart, guest]);

  async function setQty(id: string, qty: number) {
    if (!user) return setGuestLine(id, qty);
    setBusy(id);
    try {
      if (qty <= 0) await api(`/cart/items/${id}`, { method: 'DELETE' });
      else await api(`/cart/items/${id}`, { method: 'PATCH', body: { qty } });
      await Promise.all([loadCart(), refreshCart()]);
    } catch {
      await loadCart().catch(() => null);
    } finally {
      setBusy(null);
    }
  }

  if (user === undefined || (user && !cart)) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }

  const lines: Line[] = user
    ? cart!.items.map((l) => ({
        id: l.product_id,
        href: productPath({ id: l.product_id }),
        name: shortNameOf(l, lang),
        brand: l.brand,
        image: l.image_url,
        qty: l.qty,
        max: Math.max(l.qty, Math.min(99, l.available_qty || 99)),
        unit: l.unit_price_uzs,
        total: l.line_total_uzs,
        available: l.status === 'available',
      }))
    : guestCart.flatMap((g) => {
        const p = guest[g.product_id];
        if (!p) return [];
        return [
          {
            id: p.id,
            href: productPath(p),
            name: shortNameOf(p, lang),
            brand: p.brand,
            image: p.image?.webp ?? p.image_url,
            qty: g.qty,
            max: 99,
            unit: p.price_uzs,
            total: p.price_uzs * g.qty,
            available: p.in_stock || !!p.under_order,
          },
        ];
      });

  const count = lines.reduce((s, l) => s + l.qty, 0);
  const goods = user ? cart!.goods_total_uzs : lines.reduce((s, l) => s + l.total, 0);
  const discount = user ? cart!.discount_total_uzs : 0;
  const total = goods - discount;

  if (!lines.length && (user || guestCart.every((g) => g.product_id in guest))) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        <span className="empty-ic">
          <ShoppingBag size={40} strokeWidth={1.6} />
        </span>
        <h2>{t('cart.empty')}</h2>
        <p>{t('cart.emptyText')}</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Link href="/catalog" className="btn btn-secondary">
            {t('home.heroCatalog')}
          </Link>
          <Link href="/ai" className="btn">
            <Sparkles size={18} strokeWidth={1.8} /> {t('home.heroAi')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="cart-layout">
      <div className="card">
        {lines.map((l) => (
          <div key={l.id} className="cart-line">
            <Link href={l.href} className="ph" aria-hidden="true" tabIndex={-1}>
              {l.image ? <img src={l.image} alt="" loading="lazy" /> : null}
            </Link>
            <div>
              <div className="br">{l.brand}</div>
              <Link href={l.href} className="nm">
                {l.name}
              </Link>
              {!l.available ? <div className="error-text" style={{ fontSize: 13 }}>{t('cart.unavailable')}</div> : null}
            </div>
            <div className="sum">{money(l.total, lang)}</div>
            <div className="ctrl">
              <div className="qty">
                <button type="button" aria-label={t('cart.less')} disabled={busy === l.id || l.qty <= 1} onClick={() => void setQty(l.id, l.qty - 1)}>
                  <Minus size={16} />
                </button>
                <span>{l.qty}</span>
                <button type="button" aria-label={t('cart.more')} disabled={busy === l.id || l.qty >= l.max} onClick={() => void setQty(l.id, l.qty + 1)}>
                  <Plus size={16} />
                </button>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy === l.id} onClick={() => void setQty(l.id, 0)}>
                <Trash2 size={16} strokeWidth={1.8} /> {t('cart.remove')}
              </button>
            </div>
          </div>
        ))}
      </div>
      <aside className="summary-box">
        <div className="card summary">
          <div className="sum-row">
            <span>{t('cart.goods', { n: count })}</span>
            <span>{money(goods, lang)}</span>
          </div>
          {discount > 0 ? (
            <div className="sum-row">
              <span>{t('cart.discount')}</span>
              <span>−{money(discount, lang)}</span>
            </div>
          ) : null}
          <div className="sum-row">
            <span>{t('cart.delivery')}</span>
            <span>{t('cart.deliveryLater')}</span>
          </div>
          <div className="sum-total">
            <span>{t('cart.total')}</span>
            <span>{money(total, lang)}</span>
          </div>
          {user ? (
            <a className="btn btn-lg btn-block" href={`https://t.me/${botUsername}?start=cart`} target="_blank" rel="noopener noreferrer">
              <Send size={18} strokeWidth={1.8} /> {t('cart.checkout')}
            </a>
          ) : (
            <Link className="btn btn-lg btn-block" href="/login?next=/cart">
              {t('cart.loginToCheckout')}
            </Link>
          )}
          <div className="shared-note">
            <Send size={16} strokeWidth={1.8} />
            <span>{user ? t('cart.shared') : t('cart.guestNote')}</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
