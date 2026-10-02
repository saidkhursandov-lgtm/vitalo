import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TrashIcon } from '../components/Icons';
import { Empty, ErrorState, Loading, RegionCitySelect } from '../components/ui';
import { money, nameOf } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useAddresses, useCart, useCartActions, useRegions, type CityRef } from '../lib/queries';
import type { Cart as CartData, CartWarning, DeliveryQuote, Lang } from '../lib/types';

/** Human text for a cart warning (price changed / qty reduced / out of stock). */
export function warningText(w: CartWarning, cart: CartData, lang: Lang, t: (k: MessageKey, p?: Record<string, string | number>) => string): string {
  const line = cart.items.find((i) => i.product_id === w.product_id);
  const name = line ? nameOf(line, lang) : '';
  switch (w.code) {
    case 'price_changed':
      return t('cart.warn.price_changed', { name, old: money(w.old_price_uzs, lang), new: money(w.new_price_uzs, lang) });
    case 'qty_reduced':
      return t('cart.warn.qty_reduced', { name, n: w.available_qty });
    case 'out_of_stock':
      return t('cart.warn.out_of_stock', { name });
  }
}

export function CartWarnings({ cart, warnings = cart.warnings }: { cart: CartData; warnings?: CartWarning[] }) {
  const { t, lang } = useI18n();
  if (!warnings.length) return null;
  return (
    <div className="notice notice-warn" role="alert">
      {warnings.map((w) => (
        <p key={`${w.code}-${w.product_id}`}>{warningText(w, cart, lang, t)}</p>
      ))}
    </div>
  );
}

/** Progress bar to the free-shipping threshold (Master TZ §9 messages come from the API). */
export function FreeShippingProgress({ quote }: { quote: DeliveryQuote }) {
  const { lang } = useI18n();
  const pct = quote.free_shipping_threshold_uzs ? Math.min(100, ((quote.free_shipping_threshold_uzs - quote.remaining_for_free_uzs) / quote.free_shipping_threshold_uzs) * 100) : 100;
  return (
    <div className={`progress-box ${quote.is_free ? 'is-done' : ''}`}>
      <p>{lang === 'uz' ? quote.message_uz : quote.message_ru}</p>
      <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Cart() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const regions = useRegions();
  const addresses = useAddresses();
  const [city, setCity] = useState<{ region_id: string; city_id: string }>({ region_id: '', city_id: '' });
  const selected: CityRef | null = city.region_id && city.city_id ? city : null;
  const cart = useCart(selected);
  const { setQty, remove } = useCartActions();
  // The API reports each warning once (then stores the correction), and this screen may load the cart
  // several times (e.g. again once the delivery city is known) — so keep every warning seen while it is open.
  const [warnings, setWarnings] = useState<CartWarning[]>([]);
  useEffect(() => {
    const fresh = cart.data?.warnings ?? [];
    if (fresh.length) {
      setWarnings((prev) => [...prev.filter((p) => !fresh.some((f) => f.code === p.code && f.product_id === p.product_id)), ...fresh]);
    }
  }, [cart.data]);

  // Default delivery city = the primary saved address.
  useEffect(() => {
    const primary = addresses.data?.find((a) => a.is_primary);
    if (primary && !city.region_id) setCity({ region_id: primary.region.id, city_id: primary.city.id });
  }, [addresses.data, city.region_id]);

  if (cart.isPending && !cart.data) return <Loading />;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => void cart.refetch()} />;
  const data = cart.data!;

  if (data.items.length === 0) {
    return (
      <div className="page">
        <h1>{t('cart.title')}</h1>
        <Empty action={<Link to="/catalog" className="btn">{t('cart.toCatalog')}</Link>}>{t('cart.empty')}</Empty>
      </div>
    );
  }

  const delivery = data.delivery;
  const busy = setQty.isPending || remove.isPending;

  return (
    <div className="page cart">
      <h1>{t('cart.title')}</h1>
      <CartWarnings cart={data} warnings={warnings} />

      <ul className="cart-lines">
        {data.items.map((l) => (
          <li key={l.product_id} className={`cart-line ${l.status === 'unavailable' ? 'is-out' : ''}`}>
            <Link to={`/product/${l.product_id}`} className="cart-img">
              {l.image_url && <img src={l.image_url} alt="" />}
            </Link>
            <div className="cart-info">
              <Link to={`/product/${l.product_id}`} className="cart-name">
                {nameOf(l, lang)}
              </Link>
              <div className="hint small">{l.brand}</div>
              {l.status === 'unavailable' ? (
                <div className="error-text small">{t('cart.unavailable')}</div>
              ) : (
                <div className="cart-row">
                  <div className="stepper">
                    <button aria-label="−" disabled={busy || l.qty <= 1} onClick={() => setQty.mutate({ product_id: l.product_id, qty: l.qty - 1 })}>
                      −
                    </button>
                    <span>{l.qty}</span>
                    <button aria-label="+" disabled={busy || l.qty >= l.available_qty} onClick={() => setQty.mutate({ product_id: l.product_id, qty: l.qty + 1 })}>
                      +
                    </button>
                  </div>
                  <strong>{money(l.line_total_uzs, lang)}</strong>
                </div>
              )}
            </div>
            <button className="icon-btn" aria-label={t('common.delete')} disabled={busy} onClick={() => remove.mutate(l.product_id)}>
              <TrashIcon width={20} height={20} />
            </button>
          </li>
        ))}
      </ul>

      <section className="card">
        <h2>{t('cart.deliveryTo')}</h2>
        {regions.data && <RegionCitySelect regions={regions.data} regionId={city.region_id} cityId={city.city_id} onChange={setCity} />}
        {delivery ? <FreeShippingProgress quote={delivery} /> : <p className="hint small">{t('cart.chooseCity')}</p>}
      </section>

      <section className="card summary">
        <div className="sum-row">
          <span>{t('cart.goods', { n: data.items_count })}</span>
          <span>{money(data.goods_total_uzs, lang)}</span>
        </div>
        {delivery && (
          <div className="sum-row">
            <span>{t('cart.delivery')}</span>
            <span>{delivery.is_free ? t('cart.free') : money(delivery.cost_uzs, lang)}</span>
          </div>
        )}
        <div className="sum-row total">
          <span>{t('cart.total')}</span>
          <span>{money(data.goods_total_uzs - data.discount_total_uzs + (delivery?.cost_uzs ?? 0), lang)}</span>
        </div>
      </section>

      <div className="sticky-action">
        <button className="btn btn-block" disabled={!data.can_checkout} onClick={() => navigate('/checkout', { state: selected })}>
          {t('cart.checkout')}
        </button>
      </div>
    </div>
  );
}
