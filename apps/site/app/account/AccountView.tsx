'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Bell, Gift, Heart, LifeBuoy, MapPin, Package } from 'lucide-react';
import { api } from '@/lib/client';
import { money } from '@/lib/format';
import type { BonusAccount, OrderListItem, Page, ProductListItem } from '@/lib/types';
import { useSession } from '@/components/Session';
import { ProductTile } from '@/components/ProductTile';
import { AccountShell } from '@/components/AccountShell';
import { OrderRow } from '@/components/OrderBits';

/** /account — the overview: the latest orders, the bonus balance and the sections; /account/favorites — the favorites. */
export function AccountView({ section }: { section: 'home' | 'favorites' }) {
  const { t } = useSession();
  return (
    <AccountShell section={section} title={section === 'favorites' ? t('nav.favorites') : undefined}>
      {section === 'favorites' ? <Favorites /> : <Overview />}
    </AccountShell>
  );
}

function Overview() {
  const { t, lang, user } = useSession();
  const [orders, setOrders] = useState<OrderListItem[] | null>(null);
  const [bonus, setBonus] = useState<BonusAccount | null>(null);

  useEffect(() => {
    void api<Page<OrderListItem>>('/orders?page=1').then((p) => setOrders(p.items.slice(0, 3)), () => setOrders([]));
    void api<BonusAccount>('/bonus').then(setBonus, () => null);
  }, []);

  const tiles = [
    { href: '/account/orders', icon: Package, label: t('acc.orders') },
    { href: '/account/notifications', icon: Bell, label: t('acc.notifications') },
    { href: '/account/support', icon: LifeBuoy, label: t('acc.support') },
    { href: '/account/addresses', icon: MapPin, label: t('acc.addresses') },
    { href: '/account/favorites', icon: Heart, label: t('nav.favorites') },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="tg-block">
        <h2>{t('acc.hello', { name: user?.first_name ?? '' })}</h2>
        <p>{t('acc.shared')}</p>
      </div>

      <div className="acc-grid">
        <section className="card ck-section">
          <div className="sec-head">
            <h2>{t('acc.recent')}</h2>
            <Link href="/account/orders" className="more">
              {t('orders.all')}
            </Link>
          </div>
          {orders === null ? (
            <div className="wait">
              <span className="spinner" />
            </div>
          ) : orders.length ? (
            <div className="order-list">
              {orders.map((o) => (
                <OrderRow key={o.id} order={o} />
              ))}
            </div>
          ) : (
            <p className="hint">{t('acc.noOrders')}</p>
          )}
        </section>

        <Link href="/account/bonus" className="card bonus-card">
          <Gift size={24} strokeWidth={1.8} />
          <span className="hint">{t('acc.bonusBalance')}</span>
          <b>{bonus ? money(bonus.balance_uzs, lang) : '…'}</b>
          {bonus?.rules.enabled ? <span className="hint">{t('bonus.badge', { pct: bonus.rules.cashback_pct })}</span> : null}
        </Link>
      </div>

      <div className="acc-tiles">
        {tiles.map(({ href, icon: Icon, label }) => (
          <Link key={href} href={href} className="card acc-tile">
            <Icon size={22} strokeWidth={1.8} />
            <b>{label}</b>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Favorites() {
  const { t } = useSession();
  const [favs, setFavs] = useState<ProductListItem[] | null>(null);
  useEffect(() => {
    void api<ProductListItem[]>('/favorites').then(setFavs, () => setFavs([]));
  }, []);
  if (favs === null) {
    return (
      <div className="wait">
        <span className="spinner" />
      </div>
    );
  }
  if (!favs.length) {
    return (
      <div className="empty">
        <span className="empty-ic">
          <Heart size={40} strokeWidth={1.6} />
        </span>
        <h2>{t('acc.favEmpty')}</h2>
        <p>{t('acc.favEmptyText')}</p>
        <Link href="/catalog" className="btn btn-secondary">
          {t('home.heroCatalog')}
        </Link>
      </div>
    );
  }
  return (
    <div className="grid">
      {favs.map((p) => (
        <ProductTile key={p.id} p={p} />
      ))}
    </div>
  );
}
