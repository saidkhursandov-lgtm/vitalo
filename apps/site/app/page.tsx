import Link from 'next/link';
import { ArrowRight, BadgeCheck, Check, FileCheck2, Search, Send, ShieldCheck, Sparkles, Stethoscope, Truck, Layers, CreditCard } from 'lucide-react';
import { catalog } from '@/lib/server-api';
import { productsCount, t } from '@/lib/i18n';
import { botUsername, getLang } from '@/lib/lang';
import { money, nameOf, productPath, shortNameOf, textOf } from '@/lib/format';
import type { Lang, ProductCard, ProductListItem } from '@/lib/types';
import { ProductTile } from '@/components/ProductTile';
import { NeedIcon } from '@/components/NeedIcon';
import { SetCard } from '@/components/SetCard';

export const revalidate = 60;

function Rail({ title, href, lang, items }: { title: string; href: string; lang: Lang; items: ProductListItem[] }) {
  if (!items.length) return null;
  return (
    <section className="section container">
      <div className="section-head">
        <h2>{title}</h2>
        <Link className="more" href={href}>
          {t(lang, 'home.all')} <ArrowRight size={16} strokeWidth={2} />
        </Link>
      </div>
      <div className="rail">
        {items.slice(0, 10).map((p) => (
          <ProductTile key={p.id} p={p} />
        ))}
      </div>
    </section>
  );
}

export default async function Home() {
  const lang = await getLang();
  const bot = botUsername();
  const [home, cats, brands, bundles, all] = await Promise.all([
    catalog.home(),
    catalog.categories().catch(() => null),
    catalog.brands(),
    catalog.bundles(),
    catalog.products({ page: 1 }).catch(() => null),
  ]);
  const popular = home?.popular ?? [];
  const fresh = home?.fresh ?? [];
  const needs = cats?.need ?? [];

  // The hero shows a real product with the doctor's verdict: the first popular one that has it.
  let featured: ProductCard | null = null;
  for (const p of popular.slice(0, 4)) {
    const card = await catalog.product(p.slug || p.id).catch(() => null);
    if (card && textOf(card, 'doctor_verdict', lang)) {
      featured = card;
      break;
    }
  }

  return (
    <div className="page">
      <div className="container">
        <section className="hero">
          <div className="hero-grid">
            <div>
              <span className="kicker">{t(lang, 'home.heroKicker')}</span>
              <h1>{t(lang, 'home.heroTitle')}</h1>
              <p className="hero-text">{t(lang, 'home.heroText')}</p>
              <form className="hero-search" action="/search" method="get" role="search">
                <Search size={20} strokeWidth={1.8} aria-hidden="true" />
                <input type="search" name="q" placeholder={t(lang, 'header.search')} aria-label={t(lang, 'header.search')} enterKeyHint="search" />
                <button type="submit" className="btn">
                  {t(lang, 'search.title')}
                </button>
              </form>
              <div className="hero-cta">
                <Link href="/catalog" className="btn btn-light btn-lg">
                  {t(lang, 'home.heroCatalog')}
                </Link>
                <Link href="/ai" className="btn btn-outline-light btn-lg">
                  <Sparkles size={18} strokeWidth={1.8} /> {t(lang, 'home.heroAi')}
                </Link>
              </div>
              {needs.length ? (
                <div className="hero-quick">
                  {needs.slice(0, 5).map((c) => (
                    <Link key={c.id} href={`/catalog/${c.slug}`}>
                      {nameOf(c, lang)}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="hero-panel">
              {featured ? (
                <Link href={productPath(featured)} className="verdict-card" style={{ display: 'block', textDecoration: 'none' }}>
                  <div className="vc-top">
                    <div className="vc-img">{featured.image?.webp || featured.image_url ? <img src={featured.image?.webp ?? featured.image_url ?? ''} alt="" /> : null}</div>
                    <div>
                      <div className="vc-brand">{featured.brand}</div>
                      <div className="vc-name">{shortNameOf(featured, lang)}</div>
                      <div className="vc-price">{money(featured.price_uzs, lang)}</div>
                    </div>
                  </div>
                  <blockquote>
                    <b>
                      <Stethoscope size={16} strokeWidth={1.8} /> {t(lang, 'product.verdict')}
                    </b>
                    {clip(textOf(featured, 'doctor_verdict', lang) ?? '', 220)}
                  </blockquote>
                </Link>
              ) : null}
              <div className="hero-stats">
                <div>
                  <b>{all?.total ?? '—'}</b>
                  <span>{lang === 'uz' ? 'mahsulot' : 'товаров'}</span>
                </div>
                <div>
                  <b>{brands?.length ?? '—'}</b>
                  <span>{lang === 'uz' ? 'brend' : 'брендов'}</span>
                </div>
                <div>
                  <b>100%</b>
                  <span>{lang === 'uz' ? 'original' : 'оригинал'}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="trust">
          <div className="trust-item">
            <BadgeCheck size={28} strokeWidth={1.8} />
            <div>
              <b>{t(lang, 'home.how1')}</b>
              <span>{t(lang, 'product.original')}</span>
            </div>
          </div>
          <div className="trust-item">
            <Stethoscope size={28} strokeWidth={1.8} />
            <div>
              <b>{t(lang, 'home.how2')}</b>
              <span>{t(lang, 'header.doctor')}</span>
            </div>
          </div>
          <div className="trust-item">
            <Truck size={28} strokeWidth={1.8} />
            <div>
              <b>{t(lang, 'home.how4')}</b>
              <span>{lang === 'uz' ? 'Toshkent — 1 kundan' : 'Ташкент — от 1 дня'}</span>
            </div>
          </div>
          <div className="trust-item">
            <CreditCard size={28} strokeWidth={1.8} />
            <div>
              <b>Payme</b>
              <span>{lang === 'uz' ? 'naqd yoki o‘tkazma' : 'наличные или перевод'}</span>
            </div>
          </div>
        </div>
      </div>

      {needs.length ? (
        <section className="section container">
          <div className="section-head">
            <div>
              <h2>{t(lang, 'home.needs')}</h2>
              <p>{t(lang, 'home.needsLead')}</p>
            </div>
          </div>
          <div className="needs">
            {needs.map((c) => (
              <Link key={c.id} href={`/catalog/${c.slug}`} className="need">
                <span className="need-ic">
                  <NeedIcon slug={c.slug} />
                </span>
                <span>
                  <b>{nameOf(c, lang)}</b>
                  <span>{productsCount(lang, c.product_count)}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <Rail title={t(lang, 'home.popular')} href="/catalog?sort=popular" lang={lang} items={popular} />

      {bundles?.length ? (
        <section className="section container">
          <div className="section-head">
            <div>
              <h2>{t(lang, 'home.sets')}</h2>
              <p>{t(lang, 'home.setsLead')}</p>
            </div>
            <Link className="more" href="/sets">
              {t(lang, 'home.all')} <ArrowRight size={16} strokeWidth={2} />
            </Link>
          </div>
          <div className="sets">
            {bundles.slice(0, 3).map((b) => (
              <SetCard key={b.id} b={b} lang={lang} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section container">
        <div className="duo">
          <div className="ai-block">
            <span className="ai-badge">
              <Sparkles size={26} strokeWidth={1.8} />
            </span>
            <h2>{t(lang, 'home.aiTitle')}</h2>
            <p>{t(lang, 'home.aiText')}</p>
            <div className="ai-goals">
              {needs.slice(0, 6).map((c) => (
                <Link key={c.id} className="chip" href={`/ai?goal=${c.slug}`}>
                  {nameOf(c, lang)}
                </Link>
              ))}
            </div>
            <div>
              <Link href="/ai" className="btn btn-lg">
                {t(lang, 'home.aiButton')} <ArrowRight size={18} strokeWidth={2} />
              </Link>
            </div>
          </div>
          <div className="tg-block">
            <h2>{t(lang, 'home.tgTitle')}</h2>
            <p>{t(lang, 'home.tgText')}</p>
            <ul className="tg-list">
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'login.why1')}
              </li>
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'login.why2')}
              </li>
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'login.why3')}
              </li>
            </ul>
            <div>
              <a className="btn btn-light" href={`https://t.me/${bot}`} target="_blank" rel="noopener noreferrer">
                <Send size={18} strokeWidth={1.8} /> {t(lang, 'home.tgButton')}
              </a>
            </div>
          </div>
        </div>
      </section>

      <Rail title={t(lang, 'home.fresh')} href="/catalog?sort=new" lang={lang} items={fresh} />

      <section className="section container">
        <div className="section-head">
          <h2>{t(lang, 'home.how')}</h2>
        </div>
        <div className="how">
          {(
            [
              [ShieldCheck, 'home.how1', 'home.how1t'],
              [Stethoscope, 'home.how2', 'home.how2t'],
              [Layers, 'home.how3', 'home.how3t'],
              [FileCheck2, 'home.how4', 'home.how4t'],
            ] as const
          ).map(([Icon, title, text], i) => (
            <div key={title} className="how-step">
              <span className="num">0{i + 1}</span>
              <span className="ic">
                <Icon size={24} strokeWidth={1.8} />
              </span>
              <b>{t(lang, title)}</b>
              <p>{t(lang, text)}</p>
            </div>
          ))}
        </div>
      </section>

      {brands?.length ? (
        <section className="section container">
          <div className="section-head">
            <h2>{t(lang, 'home.brands')}</h2>
            <Link className="more" href="/brands">
              {t(lang, 'home.all')} <ArrowRight size={16} strokeWidth={2} />
            </Link>
          </div>
          <div className="brand-row">
            {brands.slice(0, 12).map((b) => (
              <Link key={b.id} href={`/brand/${b.slug}`} className="brand-card">
                {b.logo_url ? <img src={b.logo_url} alt="" loading="lazy" /> : <span className="brand-letter">{b.name.charAt(0)}</span>}
                <b>{(lang === 'uz' && b.name_uz) || b.name}</b>
                <span>{productsCount(lang, b.product_count)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s;
}
