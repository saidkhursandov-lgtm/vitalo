import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CartIcon, MinusIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { QuoteTerm } from '../components/Delivery';
import { useQuickNotify } from '../components/QuickAdd';
import { useQuickCart } from '../lib/quick-cart';
import { tapHaptic } from '../lib/telegram';
import { track } from '../lib/analytics';
import { EmptyState, ErrorState, Loading, StickyAction } from '../components/ui';
import { RegionCitySelect } from '../components/PlacePicker';
import { OrderTotals } from '../components/OrderItems';
import { formLabel, money, shortNameOf } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useCart, useCartActions, useCartPromo, useDeliveryCity, useRegions, useUpsell, type CityRef } from '../lib/queries';
import { PromoBox } from '../components/Promo';
import { CompatBlock } from '../components/Compat';
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
    case 'promo_removed':
      return `${t('promo.line', { code: w.promo_code })}: ${lang === 'uz' ? w.message_uz : w.message_ru}`;
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

/**
 * 3.5: [+] in the strip adds one piece and takes the card out of the strip at once (no stepper here, it squeezed the
 * name and the price into a column); the product shows at the top of the cart list with its normal stepper, and the next
 * product (`spare`) takes the free place. A refused add brings the card back.
 */
function UpsellAdd({ productId, onAdd, onFail }: { productId: string; onAdd: () => void; onFail: () => void }) {
  const { t } = useI18n();
  const notify = useQuickNotify();
  const { set } = useQuickCart(productId, (n) => {
    if (n.kind === 'error' || (n.kind === 'left' && n.n === 0)) onFail();
    notify(n);
  });
  return (
    <button
      type="button"
      className="quick-round"
      aria-label={t('product.addToCart')}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        tapHaptic();
        set(1);
        track('add_to_cart', { product_id: productId, source: 'upsell' });
        onAdd();
      }}
    >
      <span className="quick-round-dot">
        <PlusIcon width={20} height={20} />
      </span>
    </button>
  );
}

/**
 * 3.1: 2–3 products under the free-delivery bar with a [+]. The server decides when there is a strip (see
 * CartService.upsell); upsell_shown is reported once per set of products, upsell_add on each [+].
 */
export function UpsellStrip({ city, goodsTotal, inCart }: { city: CityRef | null; goodsTotal: number; inCart: string[] }) {
  const { t, lang } = useI18n();
  const upsell = useUpsell(city, goodsTotal);
  const [added, setAdded] = useState<string[]>([]);
  const items = [...(upsell.data?.items ?? []), ...(upsell.data?.spare ?? [])].filter((p) => !inCart.includes(p.id) && !added.includes(p.id)).slice(0, 3);
  const shown = useRef('');
  const key = items.map((p) => p.id).join(',');
  useEffect(() => {
    if (!key || shown.current === key) return;
    shown.current = key;
    track('upsell_shown', { count: items.length, source: upsell.data?.source ?? 'auto' });
  }, [key, items.length, upsell.data?.source]);
  if (!city || items.length < 2) return null;
  return (
    <div className="upsell">
      <h3 className="upsell-title">{t('upsell.title')}</h3>
      <ul className="upsell-list">
        {items.map((p) => (
          <li key={p.id}>
            <Link to={`/product/${p.id}`} className="upsell-item">
              <span className="upsell-img">{p.image_url && <img src={p.image_url} alt="" width={56} height={56} loading="lazy" decoding="async" />}</span>
              <span className="upsell-info">
                <span className="upsell-name">{shortNameOf(p, lang)}</span>
                <strong className="upsell-price">{money(p.price_uzs, lang)}</strong>
              </span>
              <span className="upsell-add tile-action">
                <UpsellAdd
                  productId={p.id}
                  onAdd={() => {
                    setAdded((a) => [...a, p.id]);
                    track('upsell_add', { product_id: p.id, source: upsell.data?.source ?? 'auto' });
                  }}
                  onFail={() => setAdded((a) => a.filter((id) => id !== p.id))}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
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
  const promo = useCartPromo(selected, lang);
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

      <CompatBlock productIds={data.items.map((l) => l.product_id)} />

      <section className="card">
        <h2>{t('cart.deliveryTo')}</h2>
        {regions.data && <RegionCitySelect regions={regions.data} regionId={city.region_id} cityId={city.city_id} onChange={setCity} />}
        {delivery ? (
          <>
            <QuoteTerm min={delivery.min_days} max={delivery.max_days} note={lang === 'uz' ? delivery.note_uz : delivery.note_ru} />
            <FreeShippingProgress quote={delivery} />
            <UpsellStrip city={selected} goodsTotal={data.goods_total_uzs} inCart={data.items.map((l) => l.product_id)} />
          </>
        ) : (
          <p className="hint small">{t('cart.chooseCity')}</p>
        )}
      </section>

      <section className="card summary">
        <PromoBox applied={data.promo} place="cart" onApply={promo.apply} onRemove={promo.remove} />
        <OrderTotals
          goods={data.goods_total_uzs}
          goodsCount={data.items_count}
          discount={data.discount_total_uzs}
          promo={data.promo}
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
