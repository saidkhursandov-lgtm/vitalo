import type { Metadata } from 'next';
import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { catalog } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { ProductTile } from '@/components/ProductTile';
import { Pager } from '@/components/Pager';

type Props = { searchParams: Promise<{ q?: string; page?: string }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { q } = await searchParams;
  const lang = await getLang();
  return { title: q ? `${t(lang, 'search.title')}: ${q}` : t(lang, 'search.title'), robots: { index: false } };
}

export default async function SearchPage({ searchParams }: Props) {
  const lang = await getLang();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 100);
  const pageNo = Math.max(1, Number(sp.page) || 1);
  const res = q.length >= 2 ? await catalog.search(q, pageNo).catch(() => null) : null;
  return (
    <div className="page">
      <div className="container">
        <h1 className="page-title">{q ? t(lang, 'search.results', { q }) : t(lang, 'search.title')}</h1>
        {res ? <p className="hint">{t(lang, 'catalog.found', { n: res.total })}</p> : null}
        <div style={{ marginTop: 20 }}>
          {res && res.items.length ? (
            <>
              <div className="grid grid-5">
                {res.items.map((p) => (
                  <ProductTile key={p.id} p={p} />
                ))}
              </div>
              <Pager page={res.page} totalPages={res.total_pages} href={(n) => `/search?q=${encodeURIComponent(q)}&page=${n}`} />
            </>
          ) : (
            <div className="empty">
              <span className="empty-ic">
                <SearchX size={40} strokeWidth={1.6} />
              </span>
              <h2>{q.length >= 2 ? t(lang, 'search.empty', { q }) : t(lang, 'search.short')}</h2>
              <p>{t(lang, 'search.hint')}</p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <Link href="/catalog" className="btn btn-secondary">
                  {t(lang, 'home.heroCatalog')}
                </Link>
                <Link href="/ai" className="btn">
                  {t(lang, 'home.heroAi')}
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
