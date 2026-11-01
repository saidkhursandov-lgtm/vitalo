import type { MouseEvent } from 'react';
import { errorText, useI18n } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { useSubscribeWaitlist, useUnsubscribeWaitlist, useWaitlistIds } from '../lib/queries';
import { useQuickCart, type QuickNotice } from '../lib/quick-cart';
import { track } from '../lib/analytics';
import { haptic, tapHaptic } from '../lib/telegram';
import { BellCheckIcon, BellIcon, CartIcon, MinusIcon, PlusIcon } from './Icons';
import { useToast } from './Toast';

/** Buttons inside a product card (a link): never open the card, never move the page. */
const stop = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/** Messages after the server answered: errors only (out of stock, only N left, network). A successful add has no toast. */
export function useQuickNotify() {
  const { t, lang } = useI18n();
  const toast = useToast();
  return (n: QuickNotice) => {
    if (n.kind === 'left') toast(n.n > 0 ? t('quick.left', { n: n.n }) : t('product.outOfStock'));
    else toast(n.code === 'OUT_OF_STOCK' ? t('product.outOfStock') : errorText(lang, n.code));
  };
}

/**
 * One-tap add (F1): on a card (add-on v3.1) a round [+] 40×40 with a 44×44 tap area opposite the price, then a compact
 * «− 1 +»; on the product page the wide «В корзину». The number is the same on all cards of the
 * product and in the cart; «−» at 1 removes the product. Out of stock (2.4): «Сообщить о поступлении» — a bell of the
 * same size on a card, a wide button on the product page.
 */
export function QuickAdd({ productId, inStock, variant = 'card', onAdd, campaignId }: { productId: string; inStock: boolean; variant?: 'card' | 'panel'; onAdd?: () => void; campaignId?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const notify = useQuickNotify();
  const { qty, max, set } = useQuickCart(productId, notify);

  if (!inStock && qty === 0) return <WaitlistButton productId={productId} variant={variant} />;

  if (variant === 'card' && qty === 0) {
    return (
      <button
        type="button"
        className="quick-round"
        aria-label={t('product.addToCart')}
        onClick={(e) => {
          stop(e);
          tapHaptic();
          set(1);
          track('add_to_cart', { product_id: productId, source: variant });
          if (campaignId) track('campaign_add_to_cart', { campaign_id: campaignId, product_id: productId });
          onAdd?.();
        }}
      >
        <span className="quick-round-dot">
          <PlusIcon width={20} height={20} />
        </span>
      </button>
    );
  }

  if (qty === 0) {
    return (
      <button
        type="button"
        className={`quick-add quick-${variant}`}
        onClick={(e) => {
          stop(e);
          tapHaptic();
          set(1);
          track('add_to_cart', { product_id: productId, source: variant });
          if (campaignId) track('campaign_add_to_cart', { campaign_id: campaignId, product_id: productId });
        }}
      >
        <CartIcon width={18} height={18} />
        <span>{t('product.addToCart')}</span>
      </button>
    );
  }

  // At the maximum «+» turns grey but stays tappable: a tap says «Максимум в наличии» instead of a line under the card
  // (2.3 fixes: the card never grows).
  const atMax = qty >= max;
  const icon = variant === 'card' ? 16 : 18;
  return (
    <div className={`qty-control quick-${variant}`} onClick={stop} role="group" aria-label={t('product.addToCart')}>
      <button type="button" aria-label={t('quick.less')} onClick={(e) => (stop(e), tapHaptic(), set(qty - 1))}>
        <MinusIcon width={icon} height={icon} />
      </button>
      <span aria-live="polite">{qty}</span>
      <button
        type="button"
        aria-label={t('quick.more')}
        aria-disabled={atMax || undefined}
        className={atMax ? 'is-max' : undefined}
        onClick={(e) => {
          stop(e);
          if (atMax) return toast(t('quick.max'));
          tapHaptic();
          set(qty + 1);
        }}
      >
        <PlusIcon width={icon} height={icon} />
      </button>
    </div>
  );
}

/**
 * 2.4: «Сообщить о поступлении» for a product that is out of stock. 2.4 patch: a switch — the first tap subscribes
 * (toast with «Отменить»), a tap on the active bell or on «Отменить» switches it off (the row is marked, not deleted).
 */
export function WaitlistButton({ productId, variant }: { productId: string; variant: 'card' | 'panel' }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const ids = useWaitlistIds();
  const subscribe = useSubscribeWaitlist();
  const unsubscribe = useUnsubscribeWaitlist();
  const waiting = ids.data?.has(productId) ?? false;
  const busy = subscribe.isPending || unsubscribe.isPending;
  const fail = (err: unknown) => toast(errorText(lang, err instanceof ApiError ? err.code : undefined));
  const turnOff = () =>
    unsubscribe.mutate(productId, {
      onSuccess: () => toast(t('waitlist.off')),
      onError: fail,
    });
  const onClick = (e: MouseEvent) => {
    stop(e);
    if (busy) return;
    tapHaptic();
    if (waiting) return turnOff();
    subscribe.mutate(productId, {
      onSuccess: () => {
        haptic('success');
        toast(
          t('waitlist.done'),
          <button type="button" className="toast-action" onClick={turnOff}>
            {t('waitlist.undo')}
          </button>,
        );
      },
      onError: fail,
    });
  };
  if (variant === 'card') {
    return (
      <button type="button" className={`quick-round quick-bell ${waiting ? 'is-on' : ''}`} aria-label={t(waiting ? 'waitlist.cancel' : 'waitlist.notify')} aria-pressed={waiting} onClick={onClick}>
        <span className="quick-round-dot">{waiting ? <BellCheckIcon width={20} height={20} /> : <BellIcon width={20} height={20} />}</span>
      </button>
    );
  }
  return (
    <button type="button" className={`btn btn-block waitlist-btn ${waiting ? 'is-on' : ''}`} aria-pressed={waiting} onClick={onClick}>
      {waiting ? <BellCheckIcon width={20} height={20} /> : <BellIcon width={20} height={20} />}
      <span>{t(waiting ? 'waitlist.cancel' : 'waitlist.notify')}</span>
    </button>
  );
}
