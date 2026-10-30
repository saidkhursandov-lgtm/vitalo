import { Link } from 'react-router-dom';
import { money } from '../lib/format';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import { CartIcon, CloseIcon } from './Icons';

/**
 * «В корзине N товара • XXX XXX сум [Оформить]» above the bottom menu (UZ: «Savatda N ta mahsulot»). The whole bar,
 * the «Оформить» label included, opens the cart (+/−, delete); the way to checkout is the button inside the cart.
 * It is placed above the navigation and the page gets extra bottom padding (.has-float-cart), so it never covers buttons.
 * 2.3 (D-24): [✕] only hides the bar until the next add (onHide); the cart itself is never emptied here.
 */
export function FloatingCart({ count, total, onHide }: { count: number; total: number; onHide?: () => void }) {
  const { t, lang } = useI18n();
  return (
    <div className="float-cart-wrap">
      <Link to="/cart" className="float-cart" aria-label={t('nav.cart')}>
        <CartIcon width={22} height={22} />
        <span className="float-cart-text">
          <span>{t(`floatCart.${pluralForm(count)}` as MessageKey, { n: count })}</span>
          <strong>{money(total, lang)}</strong>
        </span>
        <span className="btn btn-sm float-cart-btn">{t('floatCart.checkout')}</span>
      </Link>
      {onHide && (
        <button type="button" className="float-close" aria-label={t('floatCart.hide')} onClick={onHide}>
          <span>
            <CloseIcon width={14} height={14} />
          </span>
        </button>
      )}
    </div>
  );
}
