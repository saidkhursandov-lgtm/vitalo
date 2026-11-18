'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Heart, LayoutGrid, Menu, Search, ShoppingBag, Sparkles, Truck, User, X, Send, Layers, Tag, Home } from 'lucide-react';
import type { CategoryTrees } from '@/lib/types';
import { nameOf } from '@/lib/format';
import { useSession } from './Session';
import { NeedIcon } from './NeedIcon';

function SearchForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const [q, setQ] = useState(pathname === '/search' ? (params.get('q') ?? '') : '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (v) router.push(`/search?q=${encodeURIComponent(v)}`);
  };
  return (
    <form className="header-search" role="search" onSubmit={submit}>
      <Search size={18} strokeWidth={1.8} aria-hidden="true" />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('header.search')} aria-label={t('header.search')} autoFocus={autoFocus} enterKeyHint="search" />
      <button type="submit" aria-label={t('search.title')}>
        <Search size={18} strokeWidth={2} />
      </button>
    </form>
  );
}

export function Header({ categories }: { categories: CategoryTrees | null }) {
  const { t, lang, setLang, user, cartCount, botUsername } = useSession();
  const pathname = usePathname();
  const [mega, setMega] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const megaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMega(false);
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    if (!mega) return;
    const close = (e: MouseEvent) => {
      if (megaRef.current && !megaRef.current.contains(e.target as Node)) setMega(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMega(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [mega]);

  const needs = categories?.need ?? [];
  const types = categories?.product_type ?? [];
  const tgUrl = `https://t.me/${botUsername}`;

  return (
    <>
      <div className="topbar">
        <div className="container">
          <span className="tb-item">
            <Truck size={15} strokeWidth={1.8} aria-hidden="true" style={{ flex: 'none' }} /> <span className="tb-txt">{t('header.delivery')}</span>
          </span>
          <span className="tb-item tb-hide">{t('header.doctor')}</span>
          <div className="tb-end">
            <a className="tb-hide" href={tgUrl} target="_blank" rel="noopener noreferrer">
              <Send size={14} strokeWidth={1.8} aria-hidden="true" /> {t('header.telegram')}
            </a>
            <div className="lang-switch" role="group" aria-label={t('header.lang')}>
              <button type="button" className={lang === 'ru' ? 'is-on' : ''} aria-pressed={lang === 'ru'} onClick={() => setLang('ru')}>
                RU
              </button>
              <button type="button" className={lang === 'uz' ? 'is-on' : ''} aria-pressed={lang === 'uz'} onClick={() => setLang('uz')}>
                UZ
              </button>
            </div>
          </div>
        </div>
      </div>

      <header className="header">
        <div className="container">
          <div className="header-row">
            <button type="button" className="icon-btn menu-toggle" aria-label={t('nav.menu')} onClick={() => setDrawer(true)}>
              <Menu size={24} strokeWidth={1.8} />
            </button>
            <Link href="/" className="logo" aria-label="VITALO">
              <img src="/brand/logo.png" alt="VITALO" width={140} height={34} />
            </Link>
            <div className="mega-wrap" ref={megaRef}>
              <button type="button" className="btn catalog-btn" aria-expanded={mega} onClick={() => setMega((v) => !v)}>
                {mega ? <X size={18} strokeWidth={2} /> : <LayoutGrid size={18} strokeWidth={2} />} {t('nav.catalog')}
              </button>
              {mega && (
                <div className="mega">
                  <div>
                    <h3>{t('nav.needs')}</h3>
                    <ul>
                      {needs.map((c) => (
                        <li key={c.id}>
                          <Link href={`/catalog/${c.slug}`}>
                            {nameOf(c, lang)} <em>{c.product_count}</em>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>{t('catalog.types')}</h3>
                    <ul>
                      {types.map((c) => (
                        <li key={c.id}>
                          <Link href={`/catalog/${c.slug}`}>
                            {nameOf(c, lang)} <em>{c.product_count}</em>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="mega-foot">
                    <Link className="btn btn-sm" href="/catalog">
                      {t('catalog.allProducts')}
                    </Link>
                    <Link className="btn btn-sm btn-secondary" href="/brands">
                      {t('nav.brands')}
                    </Link>
                    <Link className="btn btn-sm btn-secondary" href="/ai">
                      <Sparkles size={16} strokeWidth={1.8} /> {t('nav.ai')}
                    </Link>
                  </div>
                </div>
              )}
            </div>
            <SearchForm />
            <nav className="header-end" aria-label={t('nav.menu')}>
              <Link className="header-action" href={user ? '/account/favorites' : '/login?next=/account/favorites'} aria-label={t('nav.favorites')}>
                <Heart size={22} strokeWidth={1.8} />
                <span className="lbl">{t('nav.favorites')}</span>
              </Link>
              <Link className="header-action" href={user ? '/account' : '/login'} aria-label={user ? t('nav.account') : t('nav.login')}>
                <User size={22} strokeWidth={1.8} />
                <span className="lbl">{user ? user.first_name : t('nav.login')}</span>
              </Link>
              <Link className="header-action" href="/cart" aria-label={t('nav.cart')}>
                <ShoppingBag size={22} strokeWidth={1.8} />
                {cartCount > 0 && <span className="badge-count">{cartCount > 99 ? '99+' : cartCount}</span>}
                <span className="lbl">{t('nav.cart')}</span>
              </Link>
            </nav>
          </div>
          <div className="mobile-search">
            <SearchForm />
          </div>
        </div>
        <nav className="subnav" aria-label={t('nav.needs')}>
          <div className="container">
            <Link href="/ai" className="is-ai">
              <Sparkles size={16} strokeWidth={1.8} /> {t('nav.ai')}
            </Link>
            <Link href="/sets">
              <Layers size={16} strokeWidth={1.8} /> {t('nav.sets')}
            </Link>
            <Link href="/brands">
              <Tag size={16} strokeWidth={1.8} /> {t('nav.brands')}
            </Link>
            <span className="sep" />
            {needs.slice(0, 8).map((c) => (
              <Link key={c.id} href={`/catalog/${c.slug}`}>
                {nameOf(c, lang)}
              </Link>
            ))}
          </div>
        </nav>
      </header>

      {drawer && (
        <>
          <div className="drawer-back" onClick={() => setDrawer(false)} />
          <aside className="drawer" aria-label={t('nav.menu')}>
            <div className="drawer-head">
              <img src="/brand/logo.png" alt="VITALO" width={120} height={29} style={{ height: 28, width: 'auto' }} />
              <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={() => setDrawer(false)}>
                <X size={24} strokeWidth={1.8} />
              </button>
            </div>
            <div>
              <Link href="/">
                <Home size={20} strokeWidth={1.8} /> {t('nav.home')}
              </Link>
              <Link href="/catalog">
                <LayoutGrid size={20} strokeWidth={1.8} /> {t('nav.catalog')}
              </Link>
              <Link href="/ai">
                <Sparkles size={20} strokeWidth={1.8} /> {t('nav.ai')}
              </Link>
              <Link href="/sets">
                <Layers size={20} strokeWidth={1.8} /> {t('nav.sets')}
              </Link>
              <Link href="/brands">
                <Tag size={20} strokeWidth={1.8} /> {t('nav.brands')}
              </Link>
            </div>
            <div>
              <h3>{t('nav.needs')}</h3>
              {needs.map((c) => (
                <Link key={c.id} href={`/catalog/${c.slug}`}>
                  <NeedIcon slug={c.slug} size={20} /> {nameOf(c, lang)}
                </Link>
              ))}
            </div>
            <a className="btn btn-secondary" href={tgUrl} target="_blank" rel="noopener noreferrer">
              <Send size={18} strokeWidth={1.8} /> {t('header.telegram')}
            </a>
          </aside>
        </>
      )}
    </>
  );
}
