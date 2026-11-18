import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, Stethoscope } from 'lucide-react';
import { catalog, NotFound } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { money } from '@/lib/format';
import { ProductTile } from '@/components/ProductTile';
import { AddSetButton } from './AddSetButton';

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  try {
    return await catalog.bundle(slug);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const b = await catalog.bundle(slug).catch(() => null);
  const lang = await getLang();
  return b ? { title: (lang === 'uz' && b.title_uz) || b.title_ru, alternates: { canonical: `/set/${slug}` } } : {};
}

export default async function SetPage({ params }: Props) {
  const { slug } = await params;
  const lang = await getLang();
  const b = await load(slug);
  const title = (lang === 'uz' && b.title_uz) || b.title_ru;
  const text = (lang === 'uz' && b.doctor_text_uz) || b.doctor_text_ru;
  return (
    <div className="page">
      <div className="container">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <ChevronRight size={14} />
          <Link href="/sets">{t(lang, 'nav.sets')}</Link>
        </nav>
        <div className="product-layout" style={{ gridTemplateColumns: undefined }}>
          <div>
            <span className="tag">
              −{b.discount_pct}%{b.days ? ` · ${t(lang, 'tile.days', { n: b.days })}` : ''}
            </span>
            <h1 className="page-title">{title}</h1>
            {text ? (
              <div className="verdict" style={{ marginTop: 16 }}>
                <b>
                  <Stethoscope size={16} strokeWidth={1.8} /> {t(lang, 'product.verdict')}
                </b>
                <p>{text}</p>
              </div>
            ) : null}
          </div>
          <div className="buy-box" style={{ margin: 0 }}>
            <div className="buy-price">
              <span className="now">{money(b.sale_total_uzs, lang)}</span>
              <span className="old">{money(b.list_total_uzs, lang)}</span>
              <span className="off">−{b.discount_pct}%</span>
            </div>
            <AddSetButton items={b.items.map((i) => ({ id: i.product.id, qty: i.qty, ok: i.product.in_stock }))} />
          </div>
        </div>
        <section className="section">
          <div className="grid">
            {b.items.map(({ product }) => (
              <ProductTile key={product.id} p={product} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
