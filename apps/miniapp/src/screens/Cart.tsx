import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CartIcon, MinusIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { QuoteTerm } from '../components/Delivery';
import { EmptyState, ErrorState, Loading, StickyAction } from '../components/ui';
import { RegionCitySelect } from '../components/PlacePicker';
import { OrderTotals } from '../components/OrderItems';
import { formLabel, money, shortNameOf } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useCart, useCartActions, useDeliveryCity, useRegions } from '../lib/queries';
import type { Cart as CartData, CartWarning, DeliveryQuote, Lang } from '../lib/types';

/** Human text for a cart warning (price changed / qty reduced / out of stock). */
export function warningText(w: CartWarning, cart: CartData, lang: Lang, t: (k: MessageKey, p?: Record<string, string | number>) => string): string {
  const line = cart.items.find((i) => i.product_id === w.product_id);
  const name = line ? shortNameOf(line, lang) : '';
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
  // 3.1: one delivery city for the cart and checkout (starts as the primary saved address); a region picked without
  // its district yet is only a draft here, so the quote never shows a district the customer did not choose.
  const [shared, setShared] = useDeliveryCity();
  const [draftRegion, setDraftRegion] = useState('');
  const selected = draftRegion ? null : shared;
  const city = { region_id: draftRegion || (shared?.region_id ?? ''), city_id: selected?.city_id ?? '' };
  const setCity = (v: { region_id: string; city_id: string }) => {
    if (v.city_id) {
      setShared(v);
      setDraftRegion('');
    } else setDraftRegion(v.region_id);
  };
  const cart = useCart(selected);
  const { setQty, remove } = useCartActions();
  // The API reports each warning once (then stores the correction). Any screen may have loaded the cart
  // first (cards with quick add do), so warnings are kept in a shared store until seen here.
  const client = useQueryClient();
  const warnings = useQuery({ queryKey: ['cart-warnings'], queryFn: () => [] as CartWarning[], enabled: false, initialData: [] as CartWarning[] }).data;
  useEffect(() => () => void client.setQueryData(['cart-warnings'], []), [client]);

  if (cart.isPending && !cart.data) return <div className="page"><Loading variant="list" count={3} /></div>;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => void cart.refetch()} />;
  const data = cart.data!;

  if (data.items.length === 0) {
    return (
      <div className="page">
        <h1>{t('cart.title')}</h1>
        <EmptyState icon={CartIcon} title={t('cart.emptyTitle')} text={t('cart.empty')} action={<Link to="/catalog" className="btn">{t('common.toCatalog')}</Link>} />
      </div>
    );
  }

  const delivery = data.delivery;
  const busy = setQty.isPending || remove.isPending;
  // Amount to pay: goods after discounts + delivery once the city is known (updates with every change).
  const payable = data.goods_total_uzs - data.discount_total_uzs + (delivery?.cost_uzs ?? 0);

  return (
    <div className="page cart">
      <h1>{t('cart.title')}</h1>
      <CartWarnings cart={data} warnings={warnings} />

      <ul className="cart-lines">
        {data.items.map((l) => (
          <li key={l.product_id} className={`cart-line ${l.status === 'unavailable' ? 'is-out' : ''}`}>
            <Link to={`/product/${l.product_id}`} className="cart-img">
              {l.image_url && <img src={l.image_url} alt="" width={72} height={72} loading="lazy" decoding="async" />}
            </Link>
            <div className="cart-info">
              <Link to={`/product/${l.product_id}`} className="cart-name">
                {shortNameOf(l, lang)}
              </Link>
              <div className="hint small">{[l.brand, l.form && formLabel(l.form, lang)].filter(Boolean).join(' · ')}</div>
              {l.status === 'unavailable' ? (
                <div className="error-text small">{t('cart.unavailable')}</div>
              ) : (
                <div className="cart-row">
                  <div className="stepper">
                    <button aria-label="−" disabled={busy || l.qty <= 1} onClick={() => setQty.mutate({ product_id: l.product_id, qty: l.qty - 1 })}>
                      <MinusIcon width={18} height={18} />
                    </button>
                    <span>{l.qty}</span>
                    <button aria-label="+" disabled={busy || l.qty >= l.available_qty} onClick={() => setQty.mutate({ product_id: l.product_id, qty: l.qty + 1 })}>
                      <PlusIcon width={18} height={18} />
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
        {delivery ? (
          <>
            <QuoteTerm min={delivery.min_days} max={delivery.max_days} note={lang === 'uz' ? delivery.note_uz : delivery.note_ru} />
            <FreeShippingProgress quote={delivery} />
          </>
        ) : (
          <p className="hint small">{t('cart.chooseCity')}</p>
        )}
      </section>

      <section className="card summary">
        <OrderTotals
          goods={data.goods_total_uzs - data.discount_total_uzs}
          goodsCount={data.items_count}
          delivery={delivery ? (delivery.is_free ? 0 : delivery.cost_uzs) : null}
          firstOrder={!!delivery?.first_order}
          total={payable}
        />
      </section>

      <StickyAction>
        <button className="btn btn-block" disabled={!data.can_checkout} onClick={() => navigate('/checkout')}>
          {t('cart.checkout', { sum: money(payable, lang) })}
        </button>
      </StickyAction>
    </div>
  );
}
