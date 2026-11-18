'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Bell, Gift, Heart, LayoutGrid, LifeBuoy, LogOut, MapPin, Package } from 'lucide-react';
import { api } from '@/lib/client';
import { prettyPhone } from '@/lib/format';
import type { CentreCounts } from '@/lib/types';
import { useSession } from './Session';

export type AccountSection = 'home' | 'orders' | 'addresses' | 'bonus' | 'notifications' | 'support' | 'favorites';

/**
 * The account frame (stage 6.4): sign-in check, the menu (a side column on a computer, a scrolling row on a phone)
 * and the page itself. Everything inside is the same data as in the Mini App.
 */
export function AccountShell({ section, title, children }: { section: AccountSection; title?: string; children: ReactNode }) {
  const { t, user, signOut } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, router, path]);

  useEffect(() => {
    if (!user) return;
    void api<CentreCounts>('/notifications/unread').then((c) => setUnread(c.unread), () => null);
  }, [user, path]);

  if (!user) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }

  const menu: { key: AccountSection; href: string; icon: typeof Package; label: string; count?: number }[] = [
    { key: 'home', href: '/account', icon: LayoutGrid, label: t('acc.overview') },
    { key: 'orders', href: '/account/orders', icon: Package, label: t('acc.orders') },
    { key: 'notifications', href: '/account/notifications', icon: Bell, label: t('acc.notifications'), count: unread },
    { key: 'support', href: '/account/support', icon: LifeBuoy, label: t('acc.support') },
    { key: 'bonus', href: '/account/bonus', icon: Gift, label: t('acc.bonus') },
    { key: 'addresses', href: '/account/addresses', icon: MapPin, label: t('acc.addresses') },
    { key: 'favorites', href: '/account/favorites', icon: Heart, label: t('nav.favorites') },
  ];

  return (
    <div className="account-layout">
      <aside className="card account-side">
        <div className="account-user">
          <span className="avatar">{user.first_name.charAt(0).toUpperCase()}</span>
          <div style={{ minWidth: 0 }}>
            <b>
              {user.first_name} {user.last_name ?? ''}
            </b>
            <span className="hint">{user.phone ? prettyPhone(user.phone) : user.username ? `@${user.username}` : ''}</span>
          </div>
        </div>
        <nav className="account-menu" aria-label={t('nav.account')}>
          {menu.map(({ key, href, icon: Icon, label, count }) => (
            <Link key={key} href={href} className={section === key ? 'is-on' : ''} aria-current={section === key ? 'page' : undefined}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {count ? <span className="count">{count}</span> : null}
            </Link>
          ))}
          <button type="button" onClick={() => void signOut()}>
            <LogOut size={18} strokeWidth={1.8} />
            <span>{t('login.logout')}</span>
          </button>
        </nav>
      </aside>
      <div className="account-main">
        {title ? <h1 className="page-title">{title}</h1> : null}
        {children}
      </div>
    </div>
  );
}

/** Notification and bot links are Mini App addresses; on the site some pages live elsewhere. */
export function sitePath(path: string | null): string | null {
  if (!path) return null;
  const order = /^\/orders\/([0-9a-f-]{36})(?:\/(?:pay|payme))?$/.exec(path);
  if (order) return `/order/${order[1]}`;
  const ret = /^\/orders\/([0-9a-f-]{36})\/return$/.exec(path);
  if (ret) return `/order/${ret[1]}/return`;
  if (path === '/orders') return '/account/orders';
  if (path === '/bonus') return '/account/bonus';
  if (path === '/favorites') return '/account/favorites';
  if (path === '/notifications') return '/account/notifications';
  if (path === '/profile/addresses') return '/account/addresses';
  const support = /^\/support(?:\/([0-9a-f-]{36}))?$/.exec(path);
  if (support) return support[1] ? `/account/support/${support[1]}` : '/account/support';
  if (/^\/(product|review|set|brand)\/[^/]+$/.test(path) || path === '/cart' || path === '/catalog') return path;
  return '/';
}
