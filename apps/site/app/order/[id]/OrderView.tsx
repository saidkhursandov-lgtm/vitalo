'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Copy, CreditCard, Phone, Send, Smartphone } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { dateTime, money, nameOf, orderNo, prettyPhone, shortNameOf } from '@/lib/format';
import { errorText } from '@/lib/i18n';
import type { BankTransfer, Order } from '@/lib/types';
import { useSession } from '@/components/Session';
import { startPayme } from '../../checkout/CheckoutView';

const STATUS_TONE: Record<string, string> = { awaiting_payment: 'warn', cancelled: 'muted', return: 'muted', delivered: 'ok', paid: 'ok' };
/** While the order can still change by itself (payment, receipt check), the page asks the server every 10 s. */
const LIVE = new Set(['new', 'awaiting_payment']);

/** «1234 5678 9012 3456» — the card number in groups of four, easy to retype in a bank app. */
export const cardGroups = (n: string) => n.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');

/**
 * The order on the site (stage 6.3): the same order as in the Mini App and the bot. Payme returns the customer here;
 * a card transfer shows the card number and «Я оплатил(а)»; cash on delivery waits for the manager's call.
 */
export function OrderView({ id }: { id: string }) {
  const { t, lang, user, botUsername } = useSession();
  const router = useRouter();
  const path = usePathname();
  const isNew = useSearchParams().get('new') === '1';
  const [order, setOrder] = useState<Order | null>(null);
  const [transfer, setTransfer] = useState<BankTransfer | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, router, path]);

  const load = useCallback(async () => {
    try {
      const o = await api<Order>(`/orders/${id}`);
      setOrder(o);
      const m = o.payment?.method;
      if ((m === 'card_transfer' || m === 'bank_transfer') && o.status === 'awaiting_payment') {
        setTransfer(await api<BankTransfer>(`/orders/${id}/payment/bank-transfer`).catch(() => null));
      } else setTransfer(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  const live = !!order && LIVE.has(order.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [live, load]);

  if (missing) {
    return (
      <div className="empty">
        <h2>{t('order.notFound')}</h2>
        <Link href="/account" className="btn">
          {t('nav.account')}
        </Link>
      </div>
    );
  }
  if (!order) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }

  const method = order.payment?.method;
  const waiting = order.status === 'awaiting_payment' && order.payment_status === 'payment_pending';

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
    } finally {
      setBusy(false);
    }
  }

  const payPayme = () =>
    act(async () => {
      const s = await startPayme(order.id, lang);
      window.location.href = s.checkout_url;
    });
  const reportPaid = () => act(async () => { await api(`/orders/${order.id}/payment/bank-transfer/paid`, { method: 'POST' }); await load(); });
  const cancel = () => {
    if (!window.confirm(t('order.cancelAsk'))) return;
    void act(async () => { await api(`/orders/${order.id}/cancel`, { method: 'POST', body: {} }); await load(); });
  };
  async function copyCard(n: string) {
    try {
      await navigator.clipboard.writeText(n.replace(/\D/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the number stays visible to copy by hand */
    }
  }

  const tone = STATUS_TONE[order.status] ?? 'info';
  return (
    <div className="order-layout">
      <div style={{ display: 'grid', gap: 16 }}>
        {isNew ? (
          <div className="notice notice-ok order-thanks">
            <CircleCheck size={20} strokeWidth={1.8} /> {t('order.thanks')}
          </div>
        ) : null}

        <section className="card ck-section">
          <div className="order-head">
            <div>
              <h1 className="page-title" style={{ margin: 0 }}>{t('order.title', { n: orderNo(order.order_number) })}</h1>
              <p className="hint">{dateTime(order.created_at, lang)}</p>
            </div>
            <span className={`status-badge is-${tone}`}>{t(`status.${order.status}`)}</span>
          </div>

          {waiting && method === 'payme' ? (
            <div className="pay-box">
              <Smartphone size={22} strokeWidth={1.8} />
              <div>
                <p>{t('order.paymeHint')}</p>
                {order.reserved_until ? <p className="hint">{t('order.payUntil', { date: dateTime(order.reserved_until, lang) })}</p> : null}
                <button type="button" className="btn btn-lg" disabled={busy} onClick={() => void payPayme()}>
                  {t('order.payWith')} · {money(order.totals.total_uzs, lang)}
                </button>
              </div>
            </div>
          ) : null}

          {waiting && transfer?.card ? (
            <div className="pay-box">
              <CreditCard size={22} strokeWidth={1.8} />
              <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
                <b>{t('order.cardTitle', { sum: money(transfer.amount_uzs, lang) })}</b>
                <div>
                  <span className="hint">{t('order.cardNumber')}</span>
                  <div className="card-number">
                    <span>{cardGroups(transfer.card.card_number)}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyCard(transfer.card!.card_number)}>
                      <Copy size={16} strokeWidth={1.8} /> {copied ? t('order.copied') : t('order.copy')}
                    </button>
                  </div>
                </div>
                <div>
                  <span className="hint">{t('order.purpose')}</span>
                  <div>{transfer.purpose}</div>
                </div>
                {transfer.pay_until ? <p className="hint">{t('order.payUntil', { date: dateTime(transfer.pay_until, lang) })}</p> : null}
                {transfer.customer_reported_paid_at ? (
                  <div className="notice notice-info">{t('order.reported')}</div>
                ) : (
                  <button type="button" className="btn btn-lg" disabled={busy} onClick={() => void reportPaid()}>
                    {t('order.iPaid')}
                  </button>
                )}
                {transfer.receipt?.bot_url ? (
                  <a className="btn btn-secondary" href={transfer.receipt.bot_url} target="_blank" rel="noopener noreferrer">
                    <Send size={18} strokeWidth={1.8} /> {t('order.receipt')}
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}

          {method === 'cod' && order.status === 'new' ? (
            <div className="pay-box">
              <Phone size={22} strokeWidth={1.8} />
              <p>{t('order.cod')}</p>
            </div>
          ) : null}
          {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        </section>

        <section className="card ck-section">
          <h2>{t('order.items')}</h2>
          <ul className="ck-items">
            {order.items.map((i) => (
              <li key={i.product_id}>
                <span className="ph">{i.image_url ? <img src={i.image_url} alt="" /> : null}</span>
                <span>
                  {shortNameOf(i, lang)} <small>× {i.qty}</small>
                </span>
                <b>{money(i.line_total_uzs, lang)}</b>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="summary-box">
        <div className="card summary">
          <div>
            <span className="hint">{t('order.recipient')}</span>
            <div>
              {order.recipient.name}, {prettyPhone(order.recipient.phone)}
            </div>
          </div>
          <div>
            <span className="hint">{t('order.address')}</span>
            <div>
              {nameOf(order.delivery.city, lang)}, {order.delivery.address_text}
            </div>
          </div>
          <div className="sum-row">
            <span>{t('cart.goods', { n: order.items.reduce((s, i) => s + i.qty, 0) })}</span>
            <span>{money(order.totals.goods_list_total_uzs ?? order.totals.goods_total_uzs, lang)}</span>
          </div>
          {(order.totals.campaign_discount_uzs ?? 0) + order.totals.discount_total_uzs > 0 ? (
            <div className="sum-row">
              <span>{t('cart.discount')}</span>
              <span>−{money((order.totals.campaign_discount_uzs ?? 0) + order.totals.discount_total_uzs, lang)}</span>
            </div>
          ) : null}
          {order.totals.bonus_used_uzs > 0 ? (
            <div className="sum-row">
              <span>{t('checkout.bonusLine')}</span>
              <span>−{money(order.totals.bonus_used_uzs, lang)}</span>
            </div>
          ) : null}
          <div className="sum-row">
            <span>{t('cart.delivery')}</span>
            <span>{order.totals.delivery_cost_uzs > 0 ? money(order.totals.delivery_cost_uzs, lang) : t('checkout.deliveryFree')}</span>
          </div>
          <div className="sum-total">
            <span>{t('cart.total')}</span>
            <span>{money(order.totals.total_uzs, lang)}</span>
          </div>
          <a className="btn btn-secondary btn-block" href={`https://t.me/${botUsername}?start=o_${order.id}`} target="_blank" rel="noopener noreferrer">
            <Send size={18} strokeWidth={1.8} /> {t('order.inTelegram')}
          </a>
          {order.can_cancel ? (
            <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={cancel}>
              {t('order.cancel')}
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
