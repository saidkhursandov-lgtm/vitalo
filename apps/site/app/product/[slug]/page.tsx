import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { BadgeCheck, ChevronRight, FlaskConical, Leaf, MessageCircle, Sparkles, Star, Stethoscope } from 'lucide-react';
import { catalog, NotFound } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { botUsername, getLang, siteUrl } from '@/lib/lang';
import { countryName, formLabel, money, nameOf, productPath, shortNameOf, textOf } from '@/lib/format';
import type { ProductCard } from '@/lib/types';
import { ProductTile } from '@/components/ProductTile';
import { AddButton, BuyBox, Gallery } from '@/components/ProductClient';

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string): Promise<ProductCard> {
  try {
    return await catalog.product(slug);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const p = await catalog.product(slug).catch(() => null);
  if (!p) return {};
  const lang = await getLang();
  const desc = textOf(p, 'short_description', lang) ?? textOf(p, 'doctor_verdict', lang) ?? '';
  const img = p.media.find((m) => m.type === 'image');
  return {
    title: nameOf(p, lang),
    description: desc.slice(0, 160),
    alternates: { canonical: productPath(p) },
    openGraph: { title: nameOf(p, lang), description: desc.slice(0, 160), images: img ? [img.url_jpeg ?? img.url] : undefined },
  };
}

function Section({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;
  return (
    <section className="p-section">
      <h2>{title}</h2>
      <div className="rich">{text}</div>
    </section>
  );
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const lang = await getLang();
  const p = await load(slug);
  const bot = botUsername();
  const name = nameOf(p, lang);
  const images = p.media.filter((m) => m.type === 'image');
  const needCat = p.categories.find((c) => c.tree_type === 'need') ?? p.categories[0];
  const verdict = textOf(p, 'doctor_verdict', lang);
  const form = textOf(p, 'substance_form', lang);
  const brandName = (lang === 'uz' && p.brand_name_uz) || p.brand_name_ru || p.brand;
  // «Продолжить в Telegram»: the bot answers /start p_<id> with a button that opens this product in the Mini App
  // (the id, not the slug: a Telegram start parameter is at most 64 characters).
  const tgLink = `https://t.me/${bot}?start=p_${p.id}`;
  const qr = await QRCode.toString(tgLink, { type: 'svg', margin: 0, color: { dark: '#002d62', light: '#ffffff' } });
  const pairWhy = p.pair ? (lang === 'uz' && p.pair.why_uz) || p.pair.why_ru : null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    sku: p.sku,
    brand: { '@type': 'Brand', name: p.brand },
    image: images.map((m) => `${siteUrl()}${m.url_jpeg ?? m.url}`),
    description: textOf(p, 'short_description', lang) ?? verdict ?? undefined,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'UZS',
      price: p.price_uzs,
      availability: p.in_stock ? 'https://schema.org/InStock' : p.under_order ? 'https://schema.org/PreOrder' : 'https://schema.org/OutOfStock',
      url: `${siteUrl()}${productPath(p)}`,
    },
    ...(p.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating.avg, reviewCount: p.rating.count } } : {}),
  };

  const facts: [string, string | null][] = [
    [t(lang, 'product.facts.brand'), brandName],
    [t(lang, 'product.facts.maker'), p.manufacturer || null],
    [t(lang, 'product.facts.country'), p.country ? countryName(p.country, lang) : null],
    [t(lang, 'product.facts.form'), p.form ? formLabel(p.form, lang) : null],
    [t(lang, 'product.facts.course'), p.course_days && p.course_days >= 7 ? t(lang, 'product.course', { n: p.course_days }) : null],
  ];

  return (
    <div className="page" style={{ paddingBottom: 96 }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <div className="container">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <ChevronRight size={14} />
          <Link href="/catalog">{t(lang, 'nav.catalog')}</Link>
          {needCat ? (
            <>
              <ChevronRight size={14} />
              <Link href={`/catalog/${needCat.slug}`}>{nameOf(needCat, lang)}</Link>
            </>
          ) : null}
        </nav>

        <div className="product-layout">
          <Gallery images={images} alt={name} />
          <div>
            {p.brand_slug ? (
              <Link href={`/brand/${p.brand_slug}`} className="p-brand">
                {p.brand}
              </Link>
            ) : (
              <span className="p-brand">{p.brand}</span>
            )}
            <h1 className="p-title">{name}</h1>
            <div className="p-sub">
              {p.rating ? (
                <span className="rating" style={{ fontSize: 14 }}>
                  <Star size={15} strokeWidth={1.8} /> {t(lang, 'product.rating', { avg: p.rating.avg.toFixed(1), n: p.rating.count })}
                </span>
              ) : null}
              {form ? <span>{form}</span> : null}
              <span>SKU {p.sku}</span>
            </div>
            <div className="p-badges">
              {p.std_original ? (
                <span className="tag">
                  <BadgeCheck size={14} strokeWidth={2} /> {t(lang, 'product.original')}
                </span>
              ) : null}
              {p.std_tested ? (
                <span className="tag">
                  <FlaskConical size={14} strokeWidth={2} /> {t(lang, 'product.tested')}
                </span>
              ) : null}
              {p.std_bioavailability ? (
                <span className="tag">
                  <Sparkles size={14} strokeWidth={2} /> {t(lang, 'product.bio')}
                </span>
              ) : null}
              {p.halal_vege === 'halal' || p.halal_vege === 'halal_vege' ? <span className="tag tag-ok">{t(lang, 'product.halal')}</span> : null}
              {p.halal_vege === 'vege' || p.halal_vege === 'halal_vege' ? (
                <span className="tag tag-ok">
                  <Leaf size={14} strokeWidth={2} /> {t(lang, 'product.vege')}
                </span>
              ) : null}
            </div>

            {p.variants && p.variants.length > 1 ? (
              <div style={{ marginTop: 20 }}>
                <div className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                  {t(lang, 'product.variants')}
                </div>
                <div className="variants">
                  {p.variants.map((v) => (
                    <Link key={v.id} href={`/product/${v.id}`} className={`${v.current ? 'is-on' : ''}${v.in_stock ? '' : ' is-out'}`} aria-current={v.current ? 'page' : undefined}>
                      {(lang === 'uz' && v.label_uz) || v.label_ru}
                      <small>{money(v.price_uzs, lang)}</small>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}

            <BuyBox p={p} />

            {verdict ? (
              <div className="verdict">
                <b>
                  <Stethoscope size={16} strokeWidth={1.8} /> {t(lang, 'product.verdict')}
                </b>
                <p>{verdict}</p>
              </div>
            ) : null}

            <dl className="facts" style={{ marginTop: 24 }}>
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          </div>
        </div>

        {p.pair ? (
          <section className="section">
            <div className="section-head">
              <h2>{t(lang, 'product.pair')}</h2>
            </div>
            <div className="pair-card">
              <div className="ph">{p.pair.product.image?.webp || p.pair.product.image_url ? <img src={p.pair.product.image?.webp ?? p.pair.product.image_url ?? ''} alt="" /> : null}</div>
              <div>
                <Link className="nm" href={productPath(p.pair.product)}>
                  {shortNameOf(p.pair.product, lang)}
                </Link>
                {pairWhy ? <p>{pairWhy}</p> : null}
              </div>
              {p.pair.product.in_stock ? <AddButton productId={p.pair.product.id} label={t(lang, 'tile.add')} /> : null}
            </div>
          </section>
        ) : null}

        <div className="p-sections">
          <div>
            <Section title={t(lang, 'product.description')} text={textOf(p, 'short_description', lang)} />
            <Section title={t(lang, 'product.composition')} text={textOf(p, 'composition', lang) ?? textOf(p, 'nutrition', lang)} />
            <Section title={t(lang, 'product.directions')} text={textOf(p, 'directions', lang)} />
            <Section title={t(lang, 'product.warnings')} text={textOf(p, 'warnings', lang)} />
            <p className="disclaimer">{t(lang, 'product.notMedicine')}</p>
          </div>
          <aside style={{ display: 'grid', gap: 16 }}>
            <div className="ask-card">
              <h3>{t(lang, 'product.ask')}</h3>
              <p>{t(lang, 'product.askText')}</p>
              <a className="btn btn-secondary" href={`https://t.me/${bot}`} target="_blank" rel="noopener noreferrer">
                <MessageCircle size={18} strokeWidth={1.8} /> {t(lang, 'product.askButton')}
              </a>
            </div>
            <a className="qr-card" href={tgLink} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="qr" style={{ width: 112, height: 112, flex: 'none' }} dangerouslySetInnerHTML={{ __html: qr }} />
              <span>
                <b>{t(lang, 'product.continueTg')}</b>
                <p>{t(lang, 'product.continueTgText')}</p>
              </span>
            </a>
          </aside>
        </div>

        {p.similar.length ? (
          <section className="section">
            <div className="section-head">
              <h2>{t(lang, 'product.similar')}</h2>
            </div>
            <div className="rail">
              {p.similar.slice(0, 10).map((s) => (
                <ProductTile key={s.id} p={s} />
              ))}
            </div>
          </section>
        ) : null}
        {p.also_bought.length ? (
          <section className="section">
            <div className="section-head">
              <h2>{t(lang, 'product.alsoBought')}</h2>
            </div>
            <div className="rail">
              {p.also_bought.slice(0, 10).map((s) => (
                <ProductTile key={s.id} p={s} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
