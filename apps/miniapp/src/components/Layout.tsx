import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { useCartCount } from '../lib/queries';
import { telegram } from '../lib/telegram';
import { BackIcon, CartIcon, GridIcon, HeartIcon, HomeIcon, UserIcon } from './Icons';
import { Logo } from './Logo';
import { NetworkBanner } from './NetworkBanner';

const TABS = ['/', '/catalog', '/favorites', '/profile'];
/** Focused flows hide the bottom navigation. */
const NO_NAV = [/^\/checkout/, /^\/orders\/[^/]+\/pay/];

/** Telegram's own Back button on inner screens (outside Telegram we draw one in the top bar). */
function useTelegramBackButton(visible: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    const back = telegram()?.BackButton;
    if (!back) return;
    const onClick = () => navigate(-1);
    if (visible) {
      back.show();
      back.onClick(onClick);
    } else back.hide();
    return () => back.offClick(onClick);
  }, [visible, navigate]);
}

export function Layout() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const cartCount = useCartCount();
  const isTab = TABS.includes(pathname);
  const showNav = !NO_NAV.some((re) => re.test(pathname));
  const count = cartCount.data ?? 0;

  useTelegramBackButton(!isTab);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and React treats an effect's return value as cleanup.
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className={`app ${showNav ? 'with-nav' : ''}`}>
      <header className="topbar">
        {!isTab && !telegram() ? (
          <button className="icon-btn" aria-label={t('common.back')} onClick={() => navigate(-1)}>
            <BackIcon />
          </button>
        ) : (
          <Link to="/" className="logo-link">
            <Logo />
          </Link>
        )}
        <Link to="/cart" className="icon-btn cart-btn" aria-label={t('nav.cart')}>
          <CartIcon />
          {count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>}
        </Link>
      </header>

      <NetworkBanner />
      <main className="content">
        <Outlet />
      </main>

      {showNav && (
        <nav className="bottom-nav">
          <NavLink to="/" end>
            <HomeIcon />
            <span>{t('nav.home')}</span>
          </NavLink>
          <NavLink to="/catalog">
            <GridIcon />
            <span>{t('nav.catalog')}</span>
          </NavLink>
          <NavLink to="/favorites">
            <HeartIcon />
            <span>{t('nav.favorites')}</span>
          </NavLink>
          <NavLink to="/profile">
            <UserIcon />
            <span>{t('nav.profile')}</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
}
