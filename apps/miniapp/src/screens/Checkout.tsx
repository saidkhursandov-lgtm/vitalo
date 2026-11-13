import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorState, Loading, StickyAction } from '../components/ui';
import { AddressFields } from '../components/AddressFields';
import { composeAddress, EMPTY_DETAILS, type AddressDetails } from '../lib/address';
import { api, ApiError, isNetworkError } from '../lib/api';
import { useUser } from '../lib/auth';
import { money, normalizePhone, prettyPhone } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { createIdempotencyKeys } from '../lib/idempotency';
import { useAddressActions, useAddresses, useCartMapPick, useCartPromo, useCartBonus, useCheckoutDefaults, useDeliveryCity, useRegions, useShopTexts, type CityRef } from '../lib/queries';
import { PromoBox, type PromoApplyResult } from '../components/Promo';
import { BonusSwitch, CashbackLine } from '../components/Bonus';
import { canRequestPhone, haptic, requestPhone } from '../lib/telegram';
import { payPath } from '../lib/shop';
import { track } from '../lib/analytics';
import { PhoneIcon } from '../components/Icons';
import type { Order, OrderPreview, PaymentMethodCode } from '../lib/types';

import { FreeShippingProgress } from './Cart';
import { OrderItems, OrderTotals } from '../components/OrderItems';
import type { OnlineProvider } from '../lib/types';
import { PayMethods, type PayCard } from '../components/PayMethods';
import { PayReceiptSheet } from '../components/PayReceipt';
import { OrderTerm } from '../components/Delivery';
import { UsaWindowNotice, useUnderOrderText } from '../components/CrossBorder';

interface Form {
  name: string;
  phone: string;
  addressId: string; // saved address id or 'new'
  region_id: string;
  city_id: string;
  address_text: string;
  /** 3.6: apartment / entrance / floor / landmark and the point on the map of a new address */
  details: AddressDetails;
  point: { lat: number; lon: number } | null;
  comment: string;
  saveAddress: boolean;
}

/**
 * Checkout on one screen (Master TZ §7): recipient, phone, region, city, address, payment method and the
 * final summary. Prices come only from the server (/orders/preview); the order is created with an
 * Idempotency-Key, so a double tap or a retry after a network error never creates two orders.
 * ?buy=<productId>&qty=<n> = "Купить сейчас" (the cart is not touched).
 */
export function Checkout() {
  const { t, lang } = useI18n();
  const uo = useUnderOrderText();
  const user = useUser();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const regions = useRegions();
  const addresses = useAddresses();
  const defaults = useCheckoutDefaults();
  const shop = useShopTexts();
  const [deliveryCity, setDeliveryCity] = useDeliveryCity();
  const [cartPick] = useCartMapPick();
  const { create: saveAddress } = useAddressActions();
  const keys = useRef(createIdempotencyKeys()).current;
  // аудит 2.2: a second tap before React re-renders the disabled button must not send the order again
  const sending = useRef(false);
  useEffect(() => track('checkout_start', { source: params.get('buy') ? 'buy_now' : 'cart' }), [params]);
  const [sharing, setSharing] = useState(false);

  const buyId = params.get('buy');
  const source = useMemo(
    () => (buyId ? { source: 'buy_now' as const, buy_now: { product_id: buyId, qty: Math.max(1, Number(params.get('qty')) || 1) } } : { source: 'cart' as const }),
    [buyId, params],
  );

  const [form, setForm] = useState<Form | null>(null);
  const [method, setMethod] = useState<PaymentMethodCode>('card_transfer');
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 6а-Г: the order is placed with an online payment — «Чек VITALO» opens over the checkout
  const [receipt, setReceipt] = useState<{ id: string; provider: OnlineProvider } | null>(null);
  // 3.3: «Купить сейчас» keeps its code here; a cart checkout uses the code saved on the cart (the server reads it)
  const [buyPromo, setBuyPromo] = useState<string | null>(null);
  const [promoNotice, setPromoNotice] = useState<string | null>(null);

  // Prefill once: last order's recipient; the address = the delivery city chosen in the cart (3.1: shared with the
  // cart, starts as the primary address). A saved address in that city is selected (the primary one first);
  // otherwise «Новый адрес» opens with that region and district already filled in.
  useEffect(() => {
    if (form || !addresses.data || defaults.isPending) return;
    const d = defaults.data;
    const inCity = deliveryCity ? addresses.data.filter((a) => a.city.id === deliveryCity.city_id) : [];
    const savedInCity = inCity.find((a) => a.is_primary) ?? inCity[0];
    const region_id = deliveryCity?.region_id ?? d?.region_id ?? '';
    const city_id = deliveryCity?.city_id ?? d?.city_id ?? '';
    // 3.6: a point chosen on the map in the cart, in this district: a new address with that street and point
    const pick = cartPick && cartPick.city_id === city_id ? cartPick : null;
    setForm({
      name: d?.recipient_name ?? [user.first_name, user.last_name].filter(Boolean).join(' '),
      phone: d?.recipient_phone ? prettyPhone(d.recipient_phone) : user.phone ? prettyPhone(user.phone) : '',
      addressId: savedInCity && !pick ? savedInCity.id : 'new',
      region_id,
      city_id,
      // the last order's street only when it was in this same district
      address_text: pick ? pick.street_line : d?.address_text && d.city_id === city_id ? d.address_text : '',
      details: EMPTY_DETAILS,
      point: pick ? { lat: pick.lat, lon: pick.lon } : null,
      comment: '',
      saveAddress: true,
    });
  }, [form, addresses.data, defaults.isPending, defaults.data, deliveryCity, user, cartPick]);

  const saved = addresses.data?.find((a) => a.id === form?.addressId);
  const city: CityRef | null = saved
    ? { region_id: saved.region.id, city_id: saved.city.id }
    : form?.region_id && form.city_id
      ? { region_id: form.region_id, city_id: form.city_id }
      : null;

  // 3.10-А: «Купить сейчас» keeps the bonus switch here; the cart checkout uses the switch of the cart
  const [buyBonus, setBuyBonus] = useState(false);
  const promoBody = buyId ? { promo_code: buyPromo ?? '', use_bonus: buyBonus } : {};
  const preview = useQuery({
    queryKey: ['preview', source, city, method, buyPromo, buyBonus],
    queryFn: () => api<OrderPreview>('/orders/preview', { method: 'POST', body: { ...source, ...city, payment_method: method, ...promoBody } }),
    enabled: !!city,
    placeholderData: keepPreviousData, // no flicker of the payment options while the method or the address changes
  });

  // «Оплата при получении» disappears when the address moves out of Tashkent: fall back to the card transfer.
  const codOption = preview.data?.payment_options;
  useEffect(() => {
    if (method === 'cod' && codOption && !codOption.cod) setMethod('card_transfer');
    // Payme: a product without ИКПУ (or Payme switched off) — back to the card transfer
    if (method === 'payme' && codOption && !codOption.payme) setMethod('card_transfer');
  }, [method, codOption]);
  // the server decides per customer: «Работает» for all, «Тест» only for staff (others see «Скоро»)
  const paymeOpen = !!codOption && codOption.payme_unavailable !== 'off';

  // 3.3: the code stopped fitting (another district, the cart changed…): it is removed, the customer sees why
  const rejected = preview.data?.promo_rejection;
  useEffect(() => {
    if (!rejected) return;
    setPromoNotice(`${t('promo.line', { code: rejected.code })}: ${lang === 'uz' ? rejected.message_uz : rejected.message_ru}`);
    if (buyId) setBuyPromo(null);
    else void client.invalidateQueries({ queryKey: ['cart'] });
  }, [rejected, buyId, client, lang, t]);

  const cartPromo = useCartPromo(city, lang);
  async function applyPromo(code: string): Promise<PromoApplyResult> {
    setPromoNotice(null);
    if (!buyId) {
      const r = await cartPromo.apply(code);
      if (r.ok) await preview.refetch();
      return r;
    }
    const r = await api<OrderPreview>('/orders/preview', { method: 'POST', body: { ...source, ...city, payment_method: method, promo_code: code } });
    if (r.promo) {
      setBuyPromo(r.promo.code);
      return { ok: true, promo: r.promo };
    }
    const why = r.promo_rejection!;
    return { ok: false, reason: why.reason, message: lang === 'uz' ? why.message_uz : why.message_ru };
  }
  async function removePromo() {
    setPromoNotice(null);
    if (buyId) return setBuyPromo(null);
    await cartPromo.remove();
    await preview.refetch();
  }

  const cartBonus = useCartBonus(city);
  async function toggleBonus(use: boolean) {
    if (buyId) return setBuyBonus(use);
    await cartBonus.mutateAsync(use);
    await preview.refetch();
  }

  const placeOrder = useMutation({
    mutationFn: ({ body, key }: { body: object; key: string }) => api<Order>('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
  });

  if (!form || regions.isPending) return <div className="page"><Loading /><Loading /></div>;
  if (regions.isError) return <ErrorState error={regions.error} onRetry={() => void regions.refetch()} />;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm({ ...form, [key]: value });
    setErrors({ ...errors, [key]: undefined });
  };

  /** Telegram sends the contact to our bot, which saves it; we take it from the answer or from the profile. */
  async function sharePhone() {
    setSharing(true);
    try {
      let phone = await requestPhone();
      for (let i = 0; phone === '' && i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        phone = (await api<{ phone: string | null }>('/auth/me')).phone ?? '';
      }
      if (phone) set('phone', prettyPhone(normalizePhone(phone) ?? phone));
    } finally {
      setSharing(false);
    }
  }

  function validate(f: Form) {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!f.name.trim()) e.name = t('checkout.required');
    if (!normalizePhone(f.phone)) e.phone = t('checkout.phoneInvalid');
    if (f.addressId === 'new') {
      if (!f.region_id || !f.city_id) e.city_id = t('checkout.required');
      if (!f.address_text.trim()) e.address_text = t('checkout.required');
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!form || !validate(form) || !city || !preview.data) return;

    const body = {
      ...source,
      recipient_name: form.name.trim(),
      recipient_phone: normalizePhone(form.phone)!,
      ...city,
      // 3.6: street + apartment / entrance / floor / landmark in one line; the map point when there is one
      address_text: saved ? composeAddress(saved.address_text, saved, lang) : composeAddress(form.address_text, form.details, lang),
      ...(saved
        ? saved.latitude != null && saved.longitude != null && { latitude: saved.latitude, longitude: saved.longitude }
        : form.point && { latitude: form.point.lat, longitude: form.point.lon }),
      customer_comment: form.comment.trim() || undefined,
      payment_method: method,
      // 3.3: exactly the code of the shown total ('' = none)
      promo_code: preview.data.promo?.code ?? '',
      // 3.10-А: exactly the bonuses of the shown total
      use_bonus: !!preview.data.bonus?.use,
      expected_total_uzs: preview.data.totals.total_uzs,
    };
    if (sending.current) return;
    sending.current = true;
    try {
      const order = await placeOrder.mutateAsync({ body, key: keys.keyFor(body) });
      haptic('success');
      if (form.addressId === 'new' && form.saveAddress) {
        // best effort, never blocks the order
        saveAddress.mutate({ ...city, address_text: form.address_text.trim(), latitude: form.point?.lat, longitude: form.point?.lon, ...form.details });
      }
      void client.invalidateQueries({ queryKey: ['cart'] });
      void client.invalidateQueries({ queryKey: ['orders'] });
      void client.invalidateQueries({ queryKey: ['free-shipping'] }); // the first-order offer is gone now
      // 6а-Г: Payme — «Чек VITALO» over the checkout, no screen in between; cash on delivery waits for the manager's
      // call (the order screen); the card transfer has its own screen with the card number
      if (order.payment?.method === 'payme') setReceipt({ id: order.id, provider: 'payme' });
      else navigate(order.payment?.method === 'cod' ? `/orders/${order.id}` : payPath(order.id, order.payment?.method), { replace: true });
    } catch (err) {
      haptic('error');
      const code = err instanceof ApiError ? err.code : undefined;
      const body = err instanceof ApiError ? err.body : {};
      const promoText = code === 'PROMO_REJECTED' ? String(lang === 'uz' ? body.message_uz : body.message_ru) : null;
      setSubmitError(promoText ?? (isNetworkError(err) ? `${errorText(lang, code)} ${t('checkout.retrySafe')}` : errorText(lang, code)));
      if (code === 'PROMO_REJECTED' && buyId) setBuyPromo(null);
      if (code === 'PRICE_CHANGED' || code === 'INSUFFICIENT_STOCK' || code === 'PROMO_REJECTED' || code === 'PAYME_RECEIPT_INCOMPLETE') {
        void preview.refetch();
        void client.invalidateQueries({ queryKey: ['cart'] });
      }
    } finally {
      sending.current = false;
    }
  }

  const p = preview.data;
  const blocked = !p || !p.can_place || placeOrder.isPending || !!receipt;

  // 6а-Г: every method is the same card. Payme / Click / Uzum by their mode in Настройки → Оплата: «Скоро» — a grey
  // card that explains, «Скрыта» — none; Payme «Работает» (or «Тест» for staff) — a real choice. «При получении» only
  // where the server allows it (Tashkent, up to the limit: above it shown disabled with the reason).
  const online = shop.data?.checkout?.online;
  const soonCard = (code: OnlineProvider): PayCard => ({ code, state: 'soon', desc: t('pay.soonDesc') });
  const cards: PayCard[] = [];
  if (paymeOpen && codOption) cards.push({ code: 'payme', state: codOption.payme ? 'ok' : 'disabled', desc: codOption.payme ? t('pay.paymeDesc') : t('pay.paymeIkpu') });
  else if (online?.payme === 'soon') cards.push(soonCard('payme'));
  for (const s of ['click', 'uzum'] as const) if (online?.[s] === 'soon') cards.push(soonCard(s));
  cards.push({ code: 'card_transfer', state: 'ok', desc: t('pay.cardDesc') });
  if (codOption && (codOption.cod || codOption.cod_unavailable === 'limit')) {
    const desc = codOption.cod || shop.data?.checkout?.cod_max_total_uzs == null ? t('pay.codDesc') : t('pay.codLimit', { max: money(shop.data.checkout.cod_max_total_uzs, lang) });
    cards.push({ code: 'cod', state: codOption.cod ? 'ok' : 'disabled', desc });
  }

  return (
    <form className="page checkout" onSubmit={(e) => void submit(e)} noValidate>
      {/* back to the cart (not for «Купить сейчас», which does not touch the cart) */}
      {!buyId && (
        <Link to="/cart" className="link back-to-cart">
          ‹ {t('checkout.backToCart')}
        </Link>
      )}
      <h1>{t('checkout.title')}</h1>

      <section className="card">
        <h2>{t('checkout.recipient')}</h2>
        <label className="field">
          <span>{t('checkout.name')}</span>
          <input autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!errors.name} />
          {errors.name && <small className="error-text">{errors.name}</small>}
        </label>
        <label className="field">
          <span>{t('checkout.phone')}</span>
          <input type="tel" inputMode="tel" autoComplete="tel" placeholder="+998 90 123 45 67" value={form.phone} onChange={(e) => set('phone', e.target.value)} aria-invalid={!!errors.phone} />
          {errors.phone && <small className="error-text">{errors.phone}</small>}
        </label>
        {canRequestPhone() && (
          <button type="button" className="btn btn-secondary btn-block" disabled={sharing} onClick={() => void sharePhone()}>
            <PhoneIcon width={18} height={18} /> {sharing ? t('checkout.phoneWaiting') : t('checkout.sharePhone')}
          </button>
        )}
      </section>

      <section className="card">
        <h2>{t('checkout.address')}</h2>
        {addresses.data && addresses.data.length > 0 && (
          <div className="radio-list">
            {addresses.data.map((a) => (
              <label key={a.id} className="radio-row">
                <input type="radio" name="address" checked={form.addressId === a.id} onChange={() => {
                    set('addressId', a.id);
                    setDeliveryCity({ region_id: a.region.id, city_id: a.city.id });
                  }}
                />
                <span>
                  {a.label && <strong>{a.label}: </strong>}
                  {composeAddress(a.address_text, a, lang)}
                  <span className="hint small"> · {lang === 'uz' && a.city.name_uz ? a.city.name_uz : a.city.name_ru}</span>
                </span>
              </label>
            ))}
            <label className="radio-row">
              <input type="radio" name="address" checked={form.addressId === 'new'} onChange={() => {
                  set('addressId', 'new');
                  if (form.region_id && form.city_id) setDeliveryCity({ region_id: form.region_id, city_id: form.city_id });
                }}
              />
              <span>{t('checkout.newAddress')}</span>
            </label>
          </div>
        )}
        {form.addressId === 'new' && (
          <>
            <AddressFields
              regions={regions.data}
              value={form}
              place="checkout"
              errors={errors}
              onChange={(v, why) => {
                setForm({ ...form, ...v });
                setErrors({ ...errors, ...(why !== 'text' && { city_id: undefined }), ...(v.address_text.trim() && { address_text: undefined }) });
                // a new district (by hand or from the map) recalculates delivery, terms and «оплата при получении»
                if (v.city_id && v.city_id !== form.city_id) setDeliveryCity({ region_id: v.region_id, city_id: v.city_id });
              }}
            />
            <label className="check-row">
              <input type="checkbox" checked={form.saveAddress} onChange={(e) => set('saveAddress', e.target.checked)} />
              {t('checkout.saveAddress')}
            </label>
          </>
        )}
        <label className="field">
          <span>{t('checkout.comment')}</span>
          <textarea rows={2} maxLength={500} value={form.comment} onChange={(e) => set('comment', e.target.value)} />
        </label>
      </section>

      <section className="card">
        <h2>{t('checkout.payment')}</h2>
        {/* D-60: lines from the USA — when it comes, prepayment only, cancel and money back */}
        {preview.data?.cross_border && <UsaWindowNotice window={preview.data.cross_border} />}
        <PayMethods
          cards={cards}
          value={method}
          onChange={(code) => {
            setMethod(code);
            if (code === 'cod') track('cod_selected');
          }}
        />
        {codOption?.cod_unavailable === 'cross_border' && (
          <p className="hint small">{uo('codOff', { kind: 'foreign', from_ru: preview.data?.cross_border?.from_ru, from_uz: preview.data?.cross_border?.from_uz })}</p>
        )}
        <p className="hint small pay-hint">{t(method === 'cod' ? 'pay.codHint' : method === 'payme' ? 'pay.paymeHint' : 'checkout.bankTransferHint')}</p>
      </section>

      <section className="card summary">
        <h2>{t('checkout.summary')}</h2>
        {!city ? (
          <p className="hint">{t('checkout.fillAddress')}</p>
        ) : preview.isPending ? (
          <Loading />
        ) : preview.isError ? (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        ) : (
          p && (
            <>
              <OrderItems
                items={p.items}
                note={(i) => {
                  const problem = p.problems.find((x) => x.product_id === i.product_id);
                  return problem && <span className="error-text small block">{t('product.maxQty', { n: problem.available })}</span>;
                }}
              />
              {p.skipped_unavailable.length > 0 && <p className="hint small">{t('checkout.skipped')}</p>}
              {promoNotice && <div className="notice notice-warn" role="alert">{promoNotice}</div>}
              <PromoBox applied={p.promo} place="checkout" onApply={applyPromo} onRemove={removePromo} />
              <BonusSwitch bonus={p.bonus} busy={cartBonus.isPending || preview.isFetching} onToggle={(use) => void toggleBonus(use)} />
              <OrderTotals
                goods={p.totals.goods_list_total_uzs ?? p.totals.goods_total_uzs}
                campaigns={p.campaigns}
                saleHint={!!p.promo && p.items.some((i) => (i.campaign?.discount_pct ?? 0) > 15)}
                discount={p.totals.discount_total_uzs}
                promo={p.promo}
                bonus={p.totals.bonus_used_uzs}
                delivery={p.totals.delivery_cost_uzs}
                firstOrder={!!p.delivery.first_order}
                total={p.totals.total_uzs}
              />
              <CashbackLine bonus={p.bonus} />
              <FreeShippingProgress quote={p.delivery} />
              <OrderTerm window={p.cross_border} min={p.delivery.min_days} max={p.delivery.max_days} note={lang === 'uz' ? p.delivery.note_uz : p.delivery.note_ru} />
            </>
          )
        )}
      </section>

      {submitError && (
        <div className="notice notice-error" role="alert">
          {submitError}
        </div>
      )}

      <StickyAction>
        <button type="submit" className="btn btn-block" disabled={blocked}>
          {placeOrder.isPending ? t('common.loading') : t(method === 'cod' ? 'checkout.confirmCod' : 'checkout.confirm', { sum: p ? money(p.totals.total_uzs, lang) : '…' })}
        </button>
      </StickyAction>
      {receipt && <PayReceiptSheet orderId={receipt.id} provider={receipt.provider} onClose={() => navigate(`/orders/${receipt.id}`, { replace: true })} />}
    </form>
  );
}
