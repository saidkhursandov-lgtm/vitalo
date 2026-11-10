import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { useCartCount, useUnreadCount } from '../lib/queries';
import { telegram } from '../lib/telegram';
import { FloatingCart } from './FloatingCart';
import { BrandBlock, LangSwitch } from './HeaderParts';
import { BackIcon, BellIcon, CartIcon, GridIcon, HeartIcon, HomeIcon, SparkIcon, UserIcon } from './Icons';
import { Logo } from './Logo';
import { NetworkBanner } from './NetworkBanner';
import { SheetsProvider, useSheets } from './Sheets';
import { ToastProvider } from './Toast';

const TABS = ['/', '/catalog', '/favorites', '/profile'];
/** Focused flows hide the bottom navigation. */
// 6б-Б: a conversation is a full-screen chat with its own input bar at the bottom — no menu, no floating cart
const NO_NAV = [/^\/checkout/, /^\/orders\/[^/]+\/pay/, /^\/product\//, /^\/support\/[^/]+/];
/** Product page: the buy panel takes the bottom of the screen instead of the navigation (F2). */
const BUY_PANEL = /^\/product\//;

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

/** A text field has focus = the on-screen keyboard is up (ТЗ v3 §3.4): the bottom menu and the floating cart hide. */
const isTextField = (el: Element | null) =>
  !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type)));

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onIn = (e: FocusEvent) => setOpen(isTextField(e.target as Element));
    // focus may jump straight to the next field: check after the browser has moved it
    const onOut = () => setTimeout(() => setOpen(isTextField(document.activeElement)), 0);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return open;
}

/** The cart badge "jumps" a little when the number grows. */
function useBump(count: number): boolean {
  const prev = useRef(count);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (count > prev.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 450);
      prev.current = count;
      return () => clearTimeout(t);
    }
    prev.current = count;
  }, [count]);
  return bump;
}

/** 2.4: centre «Подбор» (D-30): a raised navy → orange circle; until AI (release 5) it opens the «Подбор» sheet. */
function AiTab() {
  const { t } = useI18n();
  const { openAi } = useSheets();
  return (
    <button type="button" className="nav-ai" aria-haspopup="dialog" onClick={openAi}>
      <span className="nav-ai-dot" aria-hidden>
        <SparkIcon width={24} height={24} />
      </span>
      <span>{t('nav.ai')}</span>
    </button>
  );
}

export function Layout() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const cartCount = useCartCount();
  const unread = useUnreadCount().data?.unread ?? 0;
  const isTab = TABS.includes(pathname);
  const showNav = !NO_NAV.some((re) => re.test(pathname));
  const count = cartCount.data?.items_count ?? 0;
  const bump = useBump(count);
  const keyboard = useKeyboardOpen();
  // Floating cart bar: only where the bottom menu is, and not on the cart screen itself (it has its own big button)
  // 2.3 (D-24): [✕] hides the bar until the next add — it comes back when the cart sum grows again
  // (a new product or one more of the same); removing something only lowers the mark
  const total = cartCount.data?.goods_total_uzs ?? 0;
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);
  useEffect(() => {
    if (hiddenAt !== null && total < hiddenAt) setHiddenAt(total);
  }, [total, hiddenAt]);
  const hidden = hiddenAt !== null && total <= hiddenAt;
  const showFloatCart = showNav && count > 0 && pathname !== '/cart' && !hidden;

  useTelegramBackButton(!isTab);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and React treats an effect's return value as cleanup.
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className={`app ${showNav ? 'with-nav' : ''} ${BUY_PANEL.test(pathname) ? 'has-buy-panel' : ''} ${showFloatCart ? 'has-float-cart' : ''} ${keyboard ? 'kb-open' : ''}`}>
      <ToastProvider>
      <SheetsProvider>
      <header className="topbar">
        <div className="topbar-left">
          {!isTab && !telegram() && (
            <button className="icon-btn" aria-label={t('common.back')} onClick={() => navigate(-1)}>
              <BackIcon />
            </button>
          )}
          <Link to="/" className="logo-link">
            <BrandBlock logo={<Logo />} />
          </Link>
        </div>
        <div className="topbar-right">
          <LangSwitch />
          {/* 3.2: the notification centre, next to the cart; the same orange counter with a navy number */}
          <Link to="/notifications" className="icon-btn bell-btn" aria-label={unread ? `${t('nav.notifications')}: ${unread}` : t('nav.notifications')}>
            <BellIcon />
            {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <Link to="/cart" className="icon-btn cart-btn" aria-label={t('nav.cart')}>
            <CartIcon />
            {count > 0 && <span className={`badge ${bump ? 'is-bump' : ''}`}>{count > 99 ? '99+' : count}</span>}
          </Link>
        </div>
      </header>

      <NetworkBanner />
      <main className="content">
        <Outlet />
      </main>

      {showFloatCart && <FloatingCart count={count} total={total} onHide={() => setHiddenAt(total)} />}

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
          <AiTab />
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
    </SheetsProvider>
    </ToastProvider>
    </div>
  );
}
