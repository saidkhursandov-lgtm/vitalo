import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorState, Loading, RegionCitySelect } from '../components/ui';
import { api, ApiError, isNetworkError } from '../lib/api';
import { useUser } from '../lib/auth';
import { money, normalizePhone, prettyPhone } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { createIdempotencyKeys } from '../lib/idempotency';
import { useAddressActions, useAddresses, useCheckoutDefaults, useRegions, useShopTexts, type CityRef } from '../lib/queries';
import { canRequestPhone, haptic, requestPhone } from '../lib/telegram';
import { track } from '../lib/analytics';
import { PhoneIcon } from '../components/Icons';
import type { Order, OrderPreview, PaymentMethodCode } from '../lib/types';

/**
 * Release 1: «Перевод по реквизитам компании» is gone (D-06). «Оплата при получении» is added only where the server
 * says it is possible (the city of Tashkent, up to the limit). Online providers are shown as «Скоро» only while the
 * switch show_online_soon is on (Настройки → Оплата).
 */
const SOON_METHODS = ['Payme', 'Click', 'Uzum'] as const;
import { FreeShippingProgress } from './Cart';
import { QuoteTerm } from '../components/Delivery';

interface Form {
  name: string;
  phone: string;
  addressId: string; // saved address id or 'new'
  region_id: string;
  city_id: string;
  address_text: string;
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
  const user = useUser();
  const navigate = useNavigate();
  const client = useQueryClient();
  const location = useLocation();
  const [params] = useSearchParams();
  const regions = useRegions();
  const addresses = useAddresses();
  const defaults = useCheckoutDefaults();
  const shop = useShopTexts();
  const { create: saveAddress } = useAddressActions();
  const keys = useRef(createIdempotencyKeys()).current;
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

  // Prefill once: last order's recipient, the primary address, or the city chosen in the cart.
  useEffect(() => {
    if (form || !addresses.data || defaults.isPending) return;
    const primary = addresses.data.find((a) => a.is_primary);
    const fromCart = location.state as CityRef | null;
    const d = defaults.data;
    setForm({
      name: d?.recipient_name ?? [user.first_name, user.last_name].filter(Boolean).join(' '),
      phone: d?.recipient_phone ? prettyPhone(d.recipient_phone) : user.phone ? prettyPhone(user.phone) : '',
      addressId: primary ? primary.id : 'new',
      region_id: fromCart?.region_id ?? d?.region_id ?? '',
      city_id: fromCart?.city_id ?? d?.city_id ?? '',
      address_text: d?.address_text ?? '',
      comment: '',
      saveAddress: true,
    });
  }, [form, addresses.data, defaults.isPending, defaults.data, location.state, user]);

  const saved = addresses.data?.find((a) => a.id === form?.addressId);
  const city: CityRef | null = saved
    ? { region_id: saved.region.id, city_id: saved.city.id }
    : form?.region_id && form.city_id
      ? { region_id: form.region_id, city_id: form.city_id }
      : null;

  const preview = useQuery({
    queryKey: ['preview', source, city, method],
    queryFn: () => api<OrderPreview>('/orders/preview', { method: 'POST', body: { ...source, ...city, payment_method: method } }),
    enabled: !!city,
    placeholderData: keepPreviousData, // no flicker of the payment options while the method or the address changes
  });

  // «Оплата при получении» disappears when the address moves out of Tashkent: fall back to the card transfer.
  const codOption = preview.data?.payment_options;
  useEffect(() => {
    if (method === 'cod' && codOption && !codOption.cod) setMethod('card_transfer');
  }, [method, codOption]);

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
      address_text: saved ? saved.address_text : form.address_text.trim(),
      customer_comment: form.comment.trim() || undefined,
      payment_method: method,
      expected_total_uzs: preview.data.totals.total_uzs,
    };
    try {
      const order = await placeOrder.mutateAsync({ body, key: keys.keyFor(body) });
      haptic('success');
      if (form.addressId === 'new' && form.saveAddress) {
        saveAddress.mutate({ ...city, address_text: body.address_text }); // best effort, never blocks the order
      }
      void client.invalidateQueries({ queryKey: ['cart'] });
      void client.invalidateQueries({ queryKey: ['orders'] });
      // Cash on delivery has no transfer screen: the order waits for the manager's call
      navigate(order.payment?.method === 'cod' ? `/orders/${order.id}` : `/orders/${order.id}/pay`, { replace: true });
    } catch (err) {
      haptic('error');
      const code = err instanceof ApiError ? err.code : undefined;
      setSubmitError(isNetworkError(err) ? `${errorText(lang, code)} ${t('checkout.retrySafe')}` : errorText(lang, code));
      if (code === 'PRICE_CHANGED' || code === 'INSUFFICIENT_STOCK') {
        void preview.refetch();
        void client.invalidateQueries({ queryKey: ['cart'] });
      }
    }
  }

  const p = preview.data;
  const blocked = !p || !p.can_place || placeOrder.isPending;

  return (
    <form className="page checkout" onSubmit={(e) => void submit(e)} noValidate>
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
                <input type="radio" name="address" checked={form.addressId === a.id} onChange={() => set('addressId', a.id)} />
                <span>
                  {a.label && <strong>{a.label}: </strong>}
                  {a.address_text}
                  <span className="hint small"> · {lang === 'uz' && a.city.name_uz ? a.city.name_uz : a.city.name_ru}</span>
                </span>
              </label>
            ))}
            <label className="radio-row">
              <input type="radio" name="address" checked={form.addressId === 'new'} onChange={() => set('addressId', 'new')} />
              <span>{t('checkout.newAddress')}</span>
            </label>
          </div>
        )}
        {form.addressId === 'new' && (
          <>
            <RegionCitySelect regions={regions.data} regionId={form.region_id} cityId={form.city_id} onChange={(v) => setForm({ ...form, ...v })} />
            {errors.city_id && <small className="error-text">{errors.city_id}</small>}
            <label className="field">
              <span>{t('checkout.addressText')}</span>
              <input autoComplete="street-address" value={form.address_text} onChange={(e) => set('address_text', e.target.value)} aria-invalid={!!errors.address_text} />
              {errors.address_text && <small className="error-text">{errors.address_text}</small>}
            </label>
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
        <label className={`pay-option ${method === 'card_transfer' ? 'is-on' : ''}`}>
          <input type="radio" name="payment" checked={method === 'card_transfer'} onChange={() => setMethod('card_transfer')} />
          <span>
            <strong>{t('pay.card')}</strong>
            <span className="hint small block">{t('pay.cardDesc')}</span>
          </span>
        </label>
        {/* Hidden for other regions; for an order above the limit it is shown disabled with the reason */}
        {codOption && (codOption.cod || codOption.cod_unavailable === 'limit') && (
          <label className={`pay-option ${method === 'cod' ? 'is-on' : ''} ${codOption.cod ? '' : 'is-disabled'}`}>
            <input
              type="radio"
              name="payment"
              checked={method === 'cod'}
              disabled={!codOption.cod}
              onChange={() => {
                setMethod('cod');
                track('cod_selected');
              }}
            />
            <span>
              <strong>{t('pay.codTitle')}</strong>
              <span className="hint small block">
                {codOption.cod || shop.data?.checkout?.cod_max_total_uzs == null
                  ? t('pay.codDesc')
                  : t('pay.codLimit', { max: money(shop.data.checkout.cod_max_total_uzs, lang) })}
              </span>
            </span>
          </label>
        )}
        {shop.data?.checkout?.show_online_soon &&
          SOON_METHODS.map((name) => (
            <div key={name} className="pay-option is-disabled" aria-disabled="true">
              <input type="radio" disabled />
              <span>{name}</span>
              <span className="soon-badge">{t('pay.soon')}</span>
            </div>
          ))}
        <p className="hint small">{t(method === 'cod' ? 'pay.codHint' : 'checkout.bankTransferHint')}</p>
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
              {p.items.map((i) => {
                const problem = p.problems.find((x) => x.product_id === i.product_id);
                return (
                  <div key={i.product_id} className="sum-row">
                    <span>
                      {(lang === 'uz' && i.name_uz) || i.name_ru} × {i.qty}
                      {problem && <span className="error-text small block">{t('product.maxQty', { n: problem.available })}</span>}
                    </span>
                    <span>{money(i.line_total_uzs, lang)}</span>
                  </div>
                );
              })}
              {p.skipped_unavailable.length > 0 && <p className="hint small">{t('checkout.skipped')}</p>}
              <div className="sum-row">
                <span>{t('cart.delivery')}</span>
                <span>{p.totals.delivery_cost_uzs ? money(p.totals.delivery_cost_uzs, lang) : t('cart.free')}</span>
              </div>
              <FreeShippingProgress quote={p.delivery} />
              <QuoteTerm min={p.delivery.min_days} max={p.delivery.max_days} note={lang === 'uz' ? p.delivery.note_uz : p.delivery.note_ru} />
              <div className="sum-row total">
                <span>{t('cart.total')}</span>
                <span>{money(p.totals.total_uzs, lang)}</span>
              </div>
            </>
          )
        )}
      </section>

      {submitError && (
        <div className="notice notice-error" role="alert">
          {submitError}
        </div>
      )}

      <div className="sticky-action">
        <button type="submit" className="btn btn-block" disabled={blocked}>
          {placeOrder.isPending ? t('common.loading') : t('checkout.confirm', { sum: p ? money(p.totals.total_uzs, lang) : '…' })}
        </button>
      </div>
    </form>
  );
}
