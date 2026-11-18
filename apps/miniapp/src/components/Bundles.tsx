import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthed, useLoginGate } from '../lib/auth';
import { applyCart } from '../lib/cart-cache';
import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useBundles } from '../lib/queries';
import type { Cart, Lang, ShopBundle } from '../lib/types';
import { Picture, SafeImg } from './Picture';
import { useToast } from './Toast';

export const bundleTitle = (b: Pick<ShopBundle, 'title_ru' | 'title_uz'>, lang: Lang) => (lang === 'uz' && b.title_uz) || b.title_ru;

/** The photos of the set's jars side by side. */
export function BundlePhotos({ bundle, eager = false }: { bundle: ShopBundle; eager?: boolean }) {
  return (
    <span className="set-photos" aria-hidden>
      {bundle.items.map(({ product: p }) => (
        <span key={p.id} className="set-photo">
          {p.image ? <Picture src={p.image} eager={eager} /> : p.image_url && <SafeImg src={p.image_url} alt="" loading="lazy" decoding="async" />}
        </span>
      ))}
    </span>
  );
}

/** «205 200 сум» and the crossed-out price without the set discount. */
export function BundlePrice({ bundle }: { bundle: ShopBundle }) {
  const { lang } = useI18n();
  const off = bundle.list_total_uzs - bundle.sale_total_uzs;
  return (
    <span className="set-price">
      <b>{money(bundle.sale_total_uzs, lang)}</b>
      {off > 0 && <s>{money(bundle.list_total_uzs, lang)}</s>}
    </span>
  );
}

/** 4.3: «Сеты от врача» on the home page — a horizontal strip; nothing when no set is shown now. */
export function BundleStrip() {
  const { t, lang } = useI18n();
  const q = useBundles();
  if (!q.data?.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t('set.strip')}</h2>
      </div>
      <div className="set-strip scroll-x">
        {q.data.map((b) => (
          <Link key={b.id} to={`/set/${b.slug}`} className="set-card card">
            <BundlePhotos bundle={b} />
            {b.discount_pct > 0 && <span className="set-badge">−{b.discount_pct}%</span>}
            <span className="set-card-title">{bundleTitle(b, lang)}</span>
            {b.days != null && <span className="set-days">{t('set.days', { n: b.days })}</span>}
            <BundlePrice bundle={b} />
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * «Добавить сет в корзину»: every jar of the set in its quantity (on top of what the cart already has). The cart answers
 * each time with the fresh totals; the last answer already carries «Скидка сета».
 */
export function AddBundleButton({ bundle }: { bundle: ShopBundle }) {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const authed = useAuthed();
  const requireLogin = useLoginGate();
  const add = async () => {
    if (!authed) return requireLogin();
    setBusy(true);
    try {
      let cart: Cart | null = null;
      for (const i of bundle.items) cart = await api<Cart>('/cart/items', { method: 'POST', body: { product_id: i.product.id, qty: i.qty } });
      if (cart) applyCart(client, cart);
      toast(
        t('set.added'),
        <Link to="/cart" className="link">
          {t('nav.cart')}
        </Link>,
      );
    } catch {
      toast(t('set.addFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-block set-add" disabled={busy} onClick={() => void add()}>
      {t('set.add')}
    </button>
  );
}
