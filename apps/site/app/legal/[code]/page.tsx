import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { apiTry } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { Markdown } from '@/components/Markdown';

interface LegalDoc {
  code: 'offer' | 'privacy';
  version: string;
  text_ru: string;
  text_uz: string;
}

const TITLE = { offer: 'footer.offer', privacy: 'footer.privacy' } as const;

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const key = TITLE[code as keyof typeof TITLE];
  return key ? { title: t(await getLang(), key), alternates: { canonical: `/legal/${code}` } } : {};
}

/** /legal/offer, /legal/privacy — the active version from the API, the same text the Mini App shows. */
export default async function LegalPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const key = TITLE[code as keyof typeof TITLE];
  if (!key) notFound();
  const lang = await getLang();
  const docs = await apiTry<LegalDoc[]>('/legal/documents', 600);
  const doc = docs?.find((d) => d.code === code);
  if (!doc) notFound();
  return (
    <div className="page">
      <div className="container legal">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <ChevronRight size={14} />
          <span>{t(lang, key)}</span>
        </nav>
        <h1 className="page-title">{t(lang, key)}</h1>
        <p className="hint">{lang === 'uz' ? 'Versiya' : 'Версия'} {doc.version}</p>
        <section className="card legal-card">
          <Markdown text={lang === 'uz' ? doc.text_uz : doc.text_ru} />
        </section>
      </div>
    </div>
  );
}
