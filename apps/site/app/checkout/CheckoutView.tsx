'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, CreditCard, Gift, Send, Smartphone, Truck, Wallet } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { composeAddress, EMPTY_DETAILS, type AddressDetails } from '@/lib/address';
import { createIdempotencyKeys } from '@/lib/idempotency';
import { money, nameOf, normalizePhone, prettyPhone, shortNameOf } from '@/lib/format';
import { errorText } from '@/lib/i18n';
import type { Address, CheckoutDefaults, Lang, OnlinePaymentStart, Order, OrderPreview, PaymentMethodCode, Region, ShopInfo } from '@/lib/types';

/** Payme payment page for the order; after paying Payme returns the customer to /order/<id> on the site. */
export const startPayme = (orderId: string, lang: Lang) =>
  api<OnlinePaymentStart>(`/payments/online/payme/orders/${orderId}/start`, { method: 'POST', body: { lang, return_to: 'site' } });
import { useSession } from '@/components/Session';

interface Form {
  name: string;
  phone: string;
  addressId: string; // a saved address id or 'new'
  region_id: string;
  city_id: string;
  street: string;
  details: AddressDetails;
  comment: string;
  saveAddress: boolean;
}
type Errors = Partial<Record<'name' | 'phone' | 'city_id' | 'street', string>>;

/**
 * Checkout on the site (stage 6.3) — the same server rules as the Mini App: prices only from /orders/preview, the order
 * is created with an Idempotency-Key (a double click or a retry never makes two orders), and it appears in the Mini App
 * and the bot at once. ?buy=<productId>&qty=<n> = «Купить сейчас» (the cart is not touched).
 */
export function CheckoutView() {
  const { t, lang, user, refreshCart } = useSession();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const keys = useRef<ReturnType<typeof createIdempotencyKeys> | null>(null);
  const sending = useRef(false);

  const buyId = params.get('buy');
  const source = useMemo(
    () => (buyId ? { source: 'buy_now' as const, buy_now: { product_id: buyId, qty: Math.max(1, Math.min(99, Number(params.get('qty')) || 1)) } } : { source: 'cart' as const }),
    [buyId, params],
  );

  const [regions, setRegions] = useState<Region[] | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [method, setMethod] = useState<PaymentMethodCode>('card_transfer');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [buyPromo, setBuyPromo] = useState('');
  const [buyBonus, setBuyBonus] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(`${path}${params.toString() ? `?${params}` : ''}`)}`);
  }, [user, router, path, params]);

  // First load: regions, saved addresses, the last order's recipient.
  useEffect(() => {
    if (!user) return;
    keys.current ??= createIdempotencyKeys();
    void Promise.all([
      api<Region[]>('/delivery/regions'),
      api<Address[]>('/addresses').catch(() => [] as Address[]),
      api<CheckoutDefaults | null>('/orders/checkout-defaults').catch(() => null),
      api<ShopInfo>('/shop/info', { auth: false }).catch(() => null),
    ]).then(([r, a, d, s]) => {
      setRegions(r);
      setAddresses(a);
      setShop(s);
      const primary = a.find((x) => x.is_primary) ?? a[0];
      setForm({
        name: d?.recipient_name ?? [user.first_name, user.last_name].filter(Boolean).join(' '),
        phone: d?.recipient_phone ? prettyPhone(d.recipient_phone) : user.phone ? prettyPhone(user.phone) : '',
        addressId: primary ? primary.id : 'new',
        region_id: d?.region_id ?? '',
        city_id: d?.city_id ?? '',
        street: d?.address_text ?? '',
        details: EMPTY_DETAILS,
        comment: '',
        saveAddress: true,
      });
    }, () => setSubmitError(errorText(lang)));
  }, [user, lang]);

  const saved = addresses.find((a) => a.id === form?.addressId);
  const city = saved ? { region_id: saved.region.id, city_id: saved.city.id } : form?.region_id && form.city_id ? { region_id: form.region_id, city_id: form.city_id } : null;
  const cityKey = city ? `${city.region_id}:${city.city_id}` : '';

  const loadPreview = useCallback(
    async (extra: Record<string, unknown> = {}) => {
      if (!city) return null;
      setPreviewBusy(true);
      try {
        const body = { ...source, ...city, payment_method: method, ...(buyId ? { promo_code: buyPromo, use_bonus: buyBonus } : {}), ...extra };
        const p = await api<OrderPreview>('/orders/preview', { method: 'POST', body });
        setPreview(p);
        return p;
      } catch (e) {
        setSubmitError(errorText(lang, e instanceof ApiError ? e.code : undefined));
        return null;
      } finally {
        setPreviewBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cityKey, source, method, buyId, buyPromo, buyBonus, lang],
  );

  useEffect(() => {
    if (user && form) void loadPreview();
  }, [user, form === null, loadPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // A method that the address no longer allows (cash outside Tashkent, Payme without ИКПУ) falls back to the card.
  const opts = preview?.payment_options;
  useEffect(() => {
    if (method === 'cod' && opts && !opts.cod) setMethod('card_transfer');
    if (method === 'payme' && opts && !opts.payme) setMethod('card_transfer');
  }, [method, opts]);

  if (!user || !form || !regions) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
        {submitError ? <p className="error-text">{submitError}</p> : null}
      </div>
    );
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm({ ...form, [key]: value });
    setErrors({ ...errors, [key]: undefined });
  };
  const region = regions.find((r) => r.id === form.region_id);

  async function applyPromo() {
    const code = promoInput.trim();
    if (!code || !city) return;
    setPromoError(null);
    try {
      if (buyId) {
        const p = await loadPreview({ promo_code: code });
        if (p?.promo) setBuyPromo(p.promo.code);
        else if (p?.promo_rejection) setPromoError(lang === 'uz' ? p.promo_rejection.message_uz : p.promo_rejection.message_ru);
      } else {
        await api('/cart/promo', { method: 'POST', body: { code, ...city } });
        const p = await loadPreview();
        if (p && !p.promo && p.promo_rejection) setPromoError(lang === 'uz' ? p.promo_rejection.message_uz : p.promo_rejection.message_ru);
      }
      setPromoInput('');
    } catch (e) {
      const body = e instanceof ApiError ? e.body : {};
      setPromoError(typeof body.message_ru === 'string' ? String(lang === 'uz' ? body.message_uz : body.message_ru) : errorText(lang, e instanceof ApiError ? e.code : undefined));
    }
  }

  async function removePromo() {
    setPromoError(null);
    if (buyId) return setBuyPromo('');
    if (!city) return;
    await api(`/cart/promo?region_id=${city.region_id}&city_id=${city.city_id}`, { method: 'DELETE' }).catch(() => null);
    await loadPreview();
  }

  async function toggleBonus(use: boolean) {
    if (buyId) return setBuyBonus(use);
    if (!city) return;
    await api('/cart/bonus', { method: 'POST', body: { use, ...city } }).catch(() => null);
    await loadPreview();
  }

  function validate(): boolean {
    const e: Errors = {};
    if (!form!.name.trim()) e.name = t('checkout.required');
    if (!normalizePhone(form!.phone)) e.phone = t('checkout.phoneInvalid');
    if (form!.addressId === 'new') {
      if (!form!.region_id || !form!.city_id) e.city_id = t('checkout.required');
      if (!form!.street.trim()) e.street = t('checkout.required');
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!validate() || !city || !preview || sending.current) return;
    const body = {
      ...source,
      recipient_name: form!.name.trim(),
      recipient_phone: normalizePhone(form!.phone)!,
      ...city,
      address_text: saved ? composeAddress(saved.address_text, saved, lang) : composeAddress(form!.street, form!.details, lang),
      ...(saved && saved.latitude != null && saved.longitude != null ? { latitude: saved.latitude, longitude: saved.longitude } : {}),
      customer_comment: form!.comment.trim() || undefined,
      payment_method: method,
      promo_code: preview.promo?.code ?? '',
      use_bonus: !!preview.bonus?.use,
      expected_total_uzs: preview.totals.total_uzs,
    };
    sending.current = true;
    setPlacing(true);
    try {
      const order = await api<Order>('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': keys.current!.keyFor(body) } });
      if (form!.addressId === 'new' && form!.saveAddress) {
        void api('/addresses', { method: 'POST', body: { ...city, address_text: form!.street.trim(), ...form!.details } }).catch(() => null);
      }
      void refreshCart();
      if (method === 'payme') {
        // Payme opens right away; if it fails, the order page has the same «Оплатить» button (the order is already saved).
        const start = await startPayme(order.id, lang).catch(() => null);
        if (start) return void (window.location.href = start.checkout_url);
      }
      router.replace(`/order/${order.id}?new=1`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const b = err instanceof ApiError ? err.body : {};
      const promoText = code === 'PROMO_REJECTED' ? String(lang === 'uz' ? b.message_uz : b.message_ru) : null;
      setSubmitError(promoText ?? (err instanceof ApiError && err.status === 0 ? `${errorText(lang, code)} ${t('checkout.retrySafe')}` : errorText(lang, code)));
      if (code === 'PROMO_REJECTED' && buyId) setBuyPromo('');
      if (code === 'PRICE_CHANGED' || code === 'INSUFFICIENT_STOCK' || code === 'PROMO_REJECTED' || code === 'PAYME_RECEIPT_INCOMPLETE') void loadPreview();
      setPlacing(false);
    } finally {
      sending.current = false;
    }
  }

  const p = preview;
  const codMax = shop?.checkout?.cod_max_total_uzs ?? null;
  const methods: { code: PaymentMethodCode; icon: typeof Wallet; title: string; desc: string; enabled: boolean }[] = [];
  if (opts && opts.payme_unavailable !== 'off') methods.push({ code: 'payme', icon: Smartphone, title: t('pay.payme'), desc: opts.payme ? t('pay.paymeDesc') : t('pay.paymeIkpu'), enabled: !!opts.payme });
  methods.push({ code: 'card_transfer', icon: CreditCard, title: t('pay.card'), desc: t('pay.cardDesc'), enabled: true });
  if (opts && (opts.cod || opts.cod_unavailable === 'limit' || opts.cod_unavailable === 'cross_border')) {
    methods.push({
      code: 'cod',
      icon: Wallet,
      title: t('pay.cod'),
      desc: opts.cod ? t('pay.codDesc') : opts.cod_unavailable === 'cross_border' ? t('pay.codUsa') : codMax != null ? t('pay.codLimit', { max: money(codMax, lang) }) : t('pay.codDesc'),
      enabled: opts.cod,
    });
  }
  const blocked = !p || !p.can_place || placing || previewBusy;

  return (
    <form className="checkout-layout" onSubmit={(e) => void submit(e)} noValidate>
      <div style={{ display: 'grid', gap: 16 }}>
        {!buyId ? (
          <Link href="/cart" className="more" style={{ justifySelf: 'start' }}>
            <ChevronLeft size={16} /> {t('checkout.back')}
          </Link>
        ) : null}

        <section className="card ck-section">
          <h2>{t('checkout.recipient')}</h2>
          <div className="form-grid">
            <label className="field">
              <span>{t('checkout.name')}</span>
              <input className="input" autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!errors.name} />
              {errors.name ? <small className="error-text">{errors.name}</small> : null}
            </label>
            <label className="field">
              <span>{t('checkout.phone')}</span>
              <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+998 90 123 45 67" value={form.phone} onChange={(e) => set('phone', e.target.value)} aria-invalid={!!errors.phone} />
              {errors.phone ? <small className="error-text">{errors.phone}</small> : null}
            </label>
          </div>
        </section>

        <section className="card ck-section">
          <h2>{t('checkout.address')}</h2>
          {addresses.length ? (
            <div className="choice-list">
              {addresses.map((a) => (
                <label key={a.id} className={`choice${form.addressId === a.id ? ' is-on' : ''}`}>
                  <input type="radio" name="address" checked={form.addressId === a.id} onChange={() => set('addressId', a.id)} />
                  <span>
                    {a.label ? <b>{a.label}: </b> : null}
                    {composeAddress(a.address_text, a, lang)}
                    <small> · {nameOf(a.city, lang)}</small>
                  </span>
                </label>
              ))}
              <label className={`choice${form.addressId === 'new' ? ' is-on' : ''}`}>
                <input type="radio" name="address" checked={form.addressId === 'new'} onChange={() => set('addressId', 'new')} />
                <span>{t('checkout.newAddress')}</span>
              </label>
            </div>
          ) : null}
          {form.addressId === 'new' ? (
            <div className="form-grid" style={{ marginTop: addresses.length ? 16 : 0 }}>
              <label className="field">
                <span>{t('checkout.region')}</span>
                <select className="select input" value={form.region_id} onChange={(e) => setForm({ ...form, region_id: e.target.value, city_id: '' })} aria-invalid={!!errors.city_id}>
                  <option value="">{t('checkout.choose')}</option>
                  {regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {nameOf(r, lang)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('checkout.city')}</span>
                <select className="select input" value={form.city_id} disabled={!region} onChange={(e) => set('city_id', e.target.value)} aria-invalid={!!errors.city_id}>
                  <option value="">{t('checkout.choose')}</option>
                  {(region?.cities ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {nameOf(c, lang)}
                    </option>
                  ))}
                </select>
                {errors.city_id ? <small className="error-text">{errors.city_id}</small> : null}
              </label>
              <label className="field wide">
                <span>{t('checkout.street')}</span>
                <input className="input" autoComplete="street-address" value={form.street} maxLength={300} onChange={(e) => set('street', e.target.value)} aria-invalid={!!errors.street} />
                {errors.street ? <small className="error-text">{errors.street}</small> : null}
              </label>
              <div className="form-grid wide" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                {(['apartment', 'entrance', 'floor'] as const).map((k) => (
                  <label key={k} className="field">
                    <span>{t(`checkout.${k}`)}</span>
                    <input className="input" maxLength={20} value={form.details[k]} onChange={(e) => set('details', { ...form.details, [k]: e.target.value })} />
                  </label>
                ))}
              </div>
              <label className="field wide">
                <span>{t('checkout.landmark')}</span>
                <input className="input" maxLength={200} value={form.details.landmark} onChange={(e) => set('details', { ...form.details, landmark: e.target.value })} />
              </label>
              <label className="check wide">
                <input type="checkbox" checked={form.saveAddress} onChange={(e) => set('saveAddress', e.target.checked)} /> {t('checkout.saveAddress')}
              </label>
            </div>
          ) : null}
          <label className="field" style={{ marginTop: 16 }}>
            <span>{t('checkout.comment')}</span>
            <textarea className="input" rows={2} maxLength={500} value={form.comment} onChange={(e) => set('comment', e.target.value)} />
          </label>
        </section>

        <section className="card ck-section">
          <h2>{t('checkout.payment')}</h2>
          <div className="choice-list">
            {methods.map(({ code, icon: Icon, title, desc, enabled }) => (
              <label key={code} className={`choice pay${method === code ? ' is-on' : ''}${enabled ? '' : ' is-off'}`}>
                <input type="radio" name="pay" disabled={!enabled} checked={method === code} onChange={() => setMethod(code)} />
                <Icon size={22} strokeWidth={1.8} />
                <span>
                  <b>{title}</b>
                  <small>{desc}</small>
                </span>
              </label>
            ))}
          </div>
        </section>
      </div>

      <aside className="summary-box">
        <div className="card summary">
          <h2 style={{ fontSize: 18 }}>{t('checkout.summary')}</h2>
          {!city ? (
            <p className="hint">{t('checkout.fillAddress')}</p>
          ) : !p ? (
            <div className="wait">
              <span className="spinner" />
            </div>
          ) : (
            <>
              <ul className="ck-items">
                {p.items.map((i) => {
                  const problem = p.problems.find((x) => x.product_id === i.product_id);
                  return (
                    <li key={i.product_id}>
                      <span className="ph">{i.image_url ? <img src={i.image_url} alt="" /> : null}</span>
                      <span>
                        {shortNameOf(i, lang)} <small>× {i.qty}</small>
                        {problem ? <small className="error-text" style={{ display: 'block' }}>{t('checkout.maxQty', { n: problem.available })}</small> : null}
                      </span>
                      <b>{money(i.line_total_uzs, lang)}</b>
                    </li>
                  );
                })}
              </ul>
              {p.skipped_unavailable.length ? <p className="hint">{t('checkout.skipped')}</p> : null}

              {p.promo ? (
                <div className="sum-row">
                  <span>{t('checkout.promoLine', { code: p.promo.code })}</span>
                  <button type="button" className="link" onClick={() => void removePromo()}>
                    {t('checkout.promoRemove')}
                  </button>
                </div>
              ) : (
                <div className="promo-row">
                  <input className="input" placeholder={t('checkout.promo')} aria-label={t('checkout.promo')} value={promoInput} maxLength={40} onChange={(e) => setPromoInput(e.target.value.toUpperCase())} />
                  <button type="button" className="btn btn-secondary" disabled={!promoInput.trim()} onClick={() => void applyPromo()}>
                    {t('checkout.promoApply')}
                  </button>
                </div>
              )}
              {promoError ? <p className="error-text">{promoError}</p> : null}

              {p.bonus && !p.bonus.blocked && p.bonus.available_uzs > 0 ? (
                <label className="check">
                  <input type="checkbox" checked={p.bonus.use} onChange={(e) => void toggleBonus(e.target.checked)} />
                  <Gift size={16} strokeWidth={1.8} /> {t('checkout.bonus', { sum: money(p.bonus.available_uzs, lang) })}
                </label>
              ) : null}

              <div className="sum-row">
                <span>{t('cart.goods', { n: p.items.reduce((s, i) => s + i.qty, 0) })}</span>
                <span>{money(p.totals.goods_list_total_uzs ?? p.totals.goods_total_uzs, lang)}</span>
              </div>
              {(p.totals.campaign_discount_uzs ?? 0) + p.totals.discount_total_uzs > 0 ? (
                <div className="sum-row">
                  <span>{t('cart.discount')}</span>
                  <span>−{money((p.totals.campaign_discount_uzs ?? 0) + p.totals.discount_total_uzs, lang)}</span>
                </div>
              ) : null}
              {p.totals.bonus_used_uzs > 0 ? (
                <div className="sum-row">
                  <span>{t('checkout.bonusLine')}</span>
                  <span>−{money(p.totals.bonus_used_uzs, lang)}</span>
                </div>
              ) : null}
              <div className="sum-row">
                <span>{t('cart.delivery')}</span>
                <span>{p.totals.delivery_cost_uzs > 0 ? money(p.totals.delivery_cost_uzs, lang) : t('checkout.deliveryFree')}</span>
              </div>
              {p.delivery.min_days && p.delivery.max_days ? (
                <div className="shared-note">
                  <Truck size={16} strokeWidth={1.8} />
                  <span>{t('checkout.days', { min: p.delivery.min_days, max: p.delivery.max_days })}</span>
                </div>
              ) : null}
              <div className="sum-total">
                <span>{t('cart.total')}</span>
                <span>{money(p.totals.total_uzs, lang)}</span>
              </div>
              {p.bonus && p.bonus.cashback_uzs > 0 ? <p className="hint">{t('checkout.cashback', { sum: money(p.bonus.cashback_uzs, lang) })}</p> : null}
            </>
          )}
          {submitError ? (
            <div className="notice notice-error" role="alert">
              {submitError}
            </div>
          ) : null}
          <button type="submit" className="btn btn-lg btn-block" disabled={blocked}>
            {placing ? t('common.loading') : t('checkout.confirm', { sum: p ? money(p.totals.total_uzs, lang) : '…' })}
          </button>
          <div className="shared-note">
            <Send size={16} strokeWidth={1.8} />
            <span>{t('checkout.shared')}</span>
          </div>
        </div>
      </aside>
    </form>
  );
}
