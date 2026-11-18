import Link from 'next/link';
import { Search } from 'lucide-react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';

export default async function NotFound() {
  const lang = await getLang();
  return (
    <div className="page">
      <div className="container">
        <div className="empty">
          <span className="code">404</span>
          <h1>{t(lang, 'notFound.title')}</h1>
          <p>{t(lang, 'notFound.text')}</p>
          <form className="hero-search" action="/search" method="get" role="search" style={{ width: '100%', margin: '8px 0' }}>
            <Search size={20} strokeWidth={1.8} aria-hidden="true" />
            <input type="search" name="q" placeholder={t(lang, 'header.search')} aria-label={t(lang, 'header.search')} style={{ border: '1px solid var(--border-strong)', boxShadow: 'none' }} />
            <button type="submit" className="btn">
              {t(lang, 'search.title')}
            </button>
          </form>
          <Link href="/catalog" className="btn btn-secondary">
            {t(lang, 'home.heroCatalog')}
          </Link>
        </div>
      </div>
    </div>
  );
}
