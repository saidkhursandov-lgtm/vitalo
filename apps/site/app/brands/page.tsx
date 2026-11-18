import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { catalog } from '@/lib/server-api';
import { productsCount, t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import type { BrandCard } from '@/lib/types';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'brands.title'), alternates: { canonical: '/brands' } };
}

export default async function BrandsPage() {
  const lang = await getLang();
  const brands = ((await catalog.brands()) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map<string, BrandCard[]>();
  for (const b of brands) {
    const first = b.name.charAt(0).toUpperCase();
    const key = /\d/.test(first) ? '0–9' : first;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  return (
    <div className="page">
      <div className="container">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <ChevronRight size={14} />
          <span>{t(lang, 'brands.title')}</span>
        </nav>
        <h1 className="page-title">{t(lang, 'brands.title')}</h1>
        <p className="hint">{t(lang, 'brands.lead')}</p>
        <nav className="alpha" aria-label="A–Z">
          {[...groups.keys()].map((l) => (
            <a key={l} href={`#l-${l}`}>
              {l}
            </a>
          ))}
        </nav>
        {[...groups.entries()].map(([l, items]) => (
          <section key={l}>
            <h2 className="letter" id={`l-${l}`}>
              {l}
            </h2>
            <div className="brand-row">
              {items.map((b) => (
                <Link key={b.id} href={`/brand/${b.slug}`} className="brand-card">
                  {b.logo_url ? <img src={b.logo_url} alt="" loading="lazy" /> : <span className="brand-letter">{b.name.charAt(0)}</span>}
                  <b>{(lang === 'uz' && b.name_uz) || b.name}</b>
                  <span>{productsCount(lang, b.product_count)}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
