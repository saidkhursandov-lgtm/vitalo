import type { Metadata } from 'next';
import { CatalogView, type Params } from '@/components/CatalogView';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  return { title: t(lang, 'catalog.title'), alternates: { canonical: '/catalog' } };
}

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Params> }) {
  return <CatalogView lang={await getLang()} sp={await searchParams} />;
}
