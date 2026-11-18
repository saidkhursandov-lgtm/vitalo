'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Gift, Heart, LogOut, MapPin, Package, Send, ShoppingBag } from 'lucide-react';
import { api } from '@/lib/client';
import { prettyPhone } from '@/lib/format';
import type { ProductListItem } from '@/lib/types';
import { useSession } from '@/components/Session';
import { ProductTile } from '@/components/ProductTile';

/** Stage 6.2: the account shell. Orders, addresses and bonuses come in 6.4 — until then they open in Telegram. */
export function AccountView({ section }: { section: 'home' | 'favorites' }) {
  const { t, lang, user, signOut, botUsername, cartCount } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [favs, setFavs] = useState<ProductListItem[] | null>(null);

  useEffect(() => {
    if (user === null) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [user, router, path]);

  useEffect(() => {
    if (user && section === 'favorites') void api<ProductListItem[]>('/favorites').then(setFavs, () => setFavs([]));
  }, [user, section]);

  if (!user) {
    return (
      <div className="wait" style={{ padding: '64px 0' }}>
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }

  const tg = `https://t.me/${botUsername}`;
  const uz = lang === 'uz';
  const menu = [
    { href: '/account', icon: Package, label: t('footer.orders'), on: section === 'home' },
    { href: '/account/favorites', icon: Heart, label: t('nav.favorites'), on: section === 'favorites' },
    { href: '/cart', icon: ShoppingBag, label: `${t('nav.cart')}${cartCount ? ` (${cartCount})` : ''}`, on: false },
  ];

  return (
    <div className="account-layout" style={{ display: 'grid', gap: 24, marginTop: 16 }}>
      <aside className="card" style={{ padding: 8, alignSelf: 'start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 12 }}>
          <span className="avatar" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, borderRadius: '50%', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 700, fontSize: 18, flex: 'none' }}>
            {user.first_name.charAt(0).toUpperCase()}
          </span>
          <div style={{ minWidth: 0 }}>
            <b style={{ display: 'block' }}>
              {user.first_name} {user.last_name ?? ''}
            </b>
            <span className="hint" style={{ fontSize: 13 }}>
              {user.phone ? prettyPhone(user.phone) : user.username ? `@${user.username}` : ''}
            </span>
          </div>
        </div>
        <nav className="cat-links" style={{ padding: 4 }}>
          {menu.map(({ href, icon: Icon, label, on }) => (
            <Link key={href} href={href} className={on ? 'is-on' : ''} style={{ justifyContent: 'flex-start', gap: 12, minHeight: 44 }}>
              <Icon size={18} strokeWidth={1.8} /> {label}
            </Link>
          ))}
          <button type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start', minHeight: 44, padding: '0 10px', marginTop: 4 }} onClick={() => void signOut()}>
            <LogOut size={18} strokeWidth={1.8} /> {t('login.logout')}
          </button>
        </nav>
      </aside>

      <div>
        {section === 'favorites' ? (
          favs === null ? (
            <div className="wait">
              <span className="spinner" />
            </div>
          ) : favs.length ? (
            <div className="grid">
              {favs.map((p) => (
                <ProductTile key={p.id} p={p} />
              ))}
            </div>
          ) : (
            <div className="empty">
              <span className="empty-ic">
                <Heart size={40} strokeWidth={1.6} />
              </span>
              <h2>{uz ? 'Sevimlilar hozircha bo‘sh' : 'В избранном пока пусто'}</h2>
              <p>{uz ? 'Mahsulot kartasidagi yurakchani bosing — u shu yerda va Telegramda ko‘rinadi.' : 'Нажмите на сердечко на карточке товара — он появится здесь и в Telegram.'}</p>
              <Link href="/catalog" className="btn btn-secondary">
                {t('home.heroCatalog')}
              </Link>
            </div>
          )
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <div className="tg-block">
              <h2>{uz ? `Salom, ${user.first_name}!` : `Здравствуйте, ${user.first_name}!`}</h2>
              <p>
                {uz
                  ? 'Buyurtmalar, manzillar va VITALO Bonus — sayt va Telegram uchun umumiy. Saytdagi kabinet bo‘limlari tez orada ochiladi; hozircha ular Telegramdagi do‘konda.'
                  : 'Заказы, адреса и VITALO Bonus — общие для сайта и Telegram. Разделы кабинета на сайте скоро откроются; пока они в магазине в Telegram.'}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <a className="btn btn-light" href={tg} target="_blank" rel="noopener noreferrer">
                  <Send size={18} strokeWidth={1.8} /> {t('footer.orders')}
                </a>
              </div>
            </div>
            <div className="trust" style={{ marginTop: 0 }}>
              {[
                [Package, t('footer.orders')],
                [MapPin, uz ? 'Manzillar' : 'Адреса'],
                [Gift, 'VITALO Bonus'],
                [Heart, t('nav.favorites')],
              ].map(([Icon, label]) => {
                const I = Icon as typeof Package;
                return (
                  <div key={label as string} className="trust-item">
                    <I size={24} strokeWidth={1.8} />
                    <b>{label as string}</b>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
