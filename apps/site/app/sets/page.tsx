import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { catalog } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { SetCard } from '@/components/SetCard';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'nav.sets'), alternates: { canonical: '/sets' } };
}

export default async function SetsPage() {
  const lang = await getLang();
  const bundles = (await catalog.bundles()) ?? [];
  return (
    <div className="page">
      <div className="container">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <ChevronRight size={14} />
          <span>{t(lang, 'nav.sets')}</span>
        </nav>
        <h1 className="page-title">{t(lang, 'home.sets')}</h1>
        <p className="hint">{t(lang, 'home.setsLead')}</p>
        <div className="sets" style={{ marginTop: 24 }}>
          {bundles.map((b) => (
            <SetCard key={b.id} b={b} lang={lang} />
          ))}
        </div>
      </div>
    </div>
  );
}
