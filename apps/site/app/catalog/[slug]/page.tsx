import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CatalogView, type Params } from '@/components/CatalogView';
import { catalog, NotFound } from '@/lib/server-api';
import { nameOf } from '@/lib/format';
import { getLang } from '@/lib/lang';
import type { CategoryNode } from '@/lib/types';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Params> };

function find(nodes: CategoryNode[], slug: string): CategoryNode | null {
  for (const n of nodes) {
    if (n.slug === slug) return n;
    const d = find(n.children, slug);
    if (d) return d;
  }
  return null;
}

async function category(slug: string) {
  const cats = await catalog.categories().catch(() => null);
  return cats ? find([...cats.need, ...cats.product_type], slug) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const [c, lang] = await Promise.all([category(slug), getLang()]);
  return c ? { title: nameOf(c, lang), alternates: { canonical: `/catalog/${slug}` } } : {};
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!(await category(slug))) notFound();
  try {
    return <CatalogView lang={await getLang()} slug={slug} sp={await searchParams} />;
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}
