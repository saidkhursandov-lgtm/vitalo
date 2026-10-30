import type { MouseEvent } from 'react';
import { errorText, useI18n } from '../lib/i18n';
import { useQuickCart, type QuickNotice } from '../lib/quick-cart';
import { track } from '../lib/analytics';
import { tapHaptic } from '../lib/telegram';
import { CartIcon, MinusIcon, PlusIcon } from './Icons';
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
 * product and in the cart; «−» at 1 removes the product. Out of stock: a grey disabled «Нет в наличии».
 */
export function QuickAdd({ productId, inStock, variant = 'card' }: { productId: string; inStock: boolean; variant?: 'card' | 'panel' }) {
  const { t } = useI18n();
  const toast = useToast();
  const notify = useQuickNotify();
  const { qty, max, set } = useQuickCart(productId, notify);

  if (variant === 'card' && qty === 0) {
    // sold out: a grey disabled [+]; the photo already says «Нет в наличии»
    const out = !inStock;
    return (
      <button
        type="button"
        className={`quick-round ${out ? 'is-out' : ''}`}
        disabled={out}
        aria-label={out ? t('product.outOfStock') : t('product.addToCart')}
        onClick={(e) => {
          stop(e);
          if (out) return;
          tapHaptic();
          set(1);
          track('add_to_cart', { product_id: productId, source: variant });
        }}
      >
        <span className="quick-round-dot">
          <PlusIcon width={20} height={20} />
        </span>
      </button>
    );
  }

  if (!inStock && qty === 0) {
    return (
      <button type="button" className={`quick-add quick-${variant} is-out`} disabled onClick={stop}>
        {t('product.outOfStock')}
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
