import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
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

/** Messages after the server answered (shared by cards and the product page panel). */
export function useQuickNotify() {
  const { t, lang } = useI18n();
  const toast = useToast();
  return (n: QuickNotice) => {
    if (n.kind === 'left') toast(n.n > 0 ? t('quick.left', { n: n.n }) : t('product.outOfStock'));
    else toast(n.code === 'OUT_OF_STOCK' ? t('product.outOfStock') : errorText(lang, n.code));
  };
}

/**
 * One-tap add (F1): «В корзину» -> «− 1 +» on every product card. The number is the same on all cards of the
 * product and in the cart; «−» at 1 removes the product. Out of stock: a grey disabled «Нет в наличии».
 */
export function QuickAdd({ productId, inStock, variant = 'card' }: { productId: string; inStock: boolean; variant?: 'card' | 'panel' }) {
  const { t } = useI18n();
  const toast = useToast();
  const notify = useQuickNotify();
  const { qty, max, set } = useQuickCart(productId, notify);

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
          toast(t('product.added'), <ToCart />);
        }}
      >
        <CartIcon width={18} height={18} />
        <span>{t('product.addToCart')}</span>
      </button>
    );
  }

  const atMax = qty >= max;
  return (
    <div className={`qty-control quick-${variant} ${atMax && variant === 'card' ? 'at-max' : ''}`} onClick={stop} role="group" aria-label={t('product.addToCart')}>
      <button type="button" aria-label={t('quick.less')} onClick={(e) => (stop(e), tapHaptic(), set(qty - 1))}>
        <MinusIcon width={18} height={18} />
      </button>
      <span aria-live="polite">{qty}</span>
      <button
        type="button"
        aria-label={t('quick.more')}
        disabled={atMax}
        title={atMax ? t('quick.max') : undefined}
        onClick={(e) => (stop(e), tapHaptic(), set(qty + 1))}
      >
        <PlusIcon width={18} height={18} />
      </button>
      {atMax && variant === 'card' && <span className="qty-max">{t('quick.max')}</span>}
    </div>
  );
}

function ToCart(): ReactNode {
  const { t } = useI18n();
  return (
    <Link to="/cart" className="toast-action">
      {t('quick.cart')}
    </Link>
  );
}
