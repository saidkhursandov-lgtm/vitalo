'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, LayoutGrid, ShoppingBag, Sparkles, User } from 'lucide-react';
import { useSession } from './Session';

/** Phone only: the five main places, always under the thumb. */
export function BottomNav() {
  const { t, user, cartCount } = useSession();
  const path = usePathname();
  const on = (p: string) => (p === '/' ? path === '/' : path.startsWith(p));
  const items = [
    { href: '/', icon: Home, label: t('nav.home'), match: '/', badge: 0 },
    { href: '/catalog', icon: LayoutGrid, label: t('nav.catalog'), match: '/catalog', badge: 0 },
    { href: '/ai', icon: Sparkles, label: 'VITALO AI', match: '/ai', badge: 0 },
    { href: '/cart', icon: ShoppingBag, label: t('nav.cart'), match: '/cart', badge: cartCount },
    { href: user ? '/account' : '/login', icon: User, label: user ? t('nav.account') : t('nav.login'), match: user ? '/account' : '/login', badge: 0 },
  ];
  return (
    <nav className="bottom-nav" aria-label={t('nav.menu')}>
      {items.map(({ href, icon: Icon, label, match, badge }) => (
        <Link key={match} href={href} className={on(match) ? 'is-on' : ''} aria-current={on(match) ? 'page' : undefined}>
          <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
          {badge > 0 ? <span className="badge-count">{badge > 99 ? '99+' : badge}</span> : null}
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Desktop: a floating «Подбор VITALO AI» button (not on the AI and login pages). */
export function AiFab() {
  const { t } = useSession();
  const path = usePathname();
  if (path.startsWith('/ai') || path.startsWith('/login')) return null;
  return (
    <Link href="/ai" className="ai-fab">
      <span className="dot">
        <Sparkles size={20} strokeWidth={1.8} />
      </span>
      {t('nav.ai')}
    </Link>
  );
}
