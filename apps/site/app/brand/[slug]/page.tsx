import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, Stethoscope } from 'lucide-react';
import { catalog, NotFound } from '@/lib/server-api';
import { productsCount, t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { countryName, textOf } from '@/lib/format';
import { ProductTile } from '@/components/ProductTile';
import { hrefWith, parseQuery, type Params } from '@/components/CatalogView';
import { SortSelect } from '@/components/SortSelect';
import { Pager } from '@/components/Pager';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Params> };

async function load(slug: string) {
  try {
    return await catalog.brand(slug);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const b = await catalog.brand(slug).catch(() => null);
  if (!b) return {};
  return { title: b.name, description: textOf(b, 'why_vitalo', await getLang())?.slice(0, 160), alternates: { canonical: `/brand/${slug}` } };
}

export default async function BrandPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const lang = await getLang();
  const b = await load(slug);
  const q = parseQuery(await searchParams);
  const page = await catalog.products({ ...q, brand: [b.name] });
  const why = textOf(b, 'why_vitalo', lang);
  const country = textOf(b, 'country', lang);
  const base = `/brand/${slug}`;
  return (
    <div className="page">
      <div className="container">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <ChevronRight size={14} />
          <Link href="/brands">{t(lang, 'brands.title')}</Link>
          <ChevronRight size={14} />
          <span>{b.name}</span>
        </nav>
        <div className="brand-hero">
          <div className="logo-box">{b.logo_url ? <img src={b.logo_url} alt="" /> : <span className="brand-letter">{b.name.charAt(0)}</span>}</div>
          <div>
            <h1>{(lang === 'uz' && b.name_uz) || b.name}</h1>
            <div className="p-sub" style={{ marginTop: 6 }}>
              {country ? <span>{countryName(country, lang)}</span> : null}
              <span>{productsCount(lang, b.product_count)}</span>
            </div>
            {why ? (
              <div className="verdict" style={{ marginTop: 16 }}>
                <b>
                  <Stethoscope size={16} strokeWidth={1.8} /> {t(lang, 'brand.why', { brand: b.name })}
                </b>
                <p>{why}</p>
              </div>
            ) : null}
          </div>
        </div>
        <div className="section-head" style={{ marginTop: 32 }}>
          <h2>{t(lang, 'brand.products', { brand: b.name })}</h2>
          <SortSelect lang={lang} value={q.sort ?? 'popular'} />
        </div>
        <div className="grid grid-5">
          {page.items.map((p) => (
            <ProductTile key={p.id} p={p} />
          ))}
        </div>
        <Pager page={page.page} totalPages={page.total_pages} href={(n) => hrefWith(base, q, { page: n })} />
      </div>
    </div>
  );
}
