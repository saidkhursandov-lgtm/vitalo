import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, Send, Sparkles } from 'lucide-react';
import { catalog } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { botUsername, getLang } from '@/lib/lang';
import { nameOf } from '@/lib/format';
import { NeedIcon } from '@/components/NeedIcon';
import { ProductTile } from '@/components/ProductTile';

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  return { title: t(lang, 'ai.title'), description: t(lang, 'ai.lead'), alternates: { canonical: '/ai' } };
}

/**
 * VITALO AI, stage 6.1: pick a goal — the site shows the doctor-approved products for it; the chat itself (the same
 * history as in the Mini App) comes in stage 6.5 and opens in Telegram until then.
 */
export default async function AiPage({ searchParams }: { searchParams: Promise<{ goal?: string }> }) {
  const lang = await getLang();
  const { goal } = await searchParams;
  const cats = await catalog.categories().catch(() => null);
  const needs = cats?.need ?? [];
  const current = needs.find((n) => n.slug === goal) ?? null;
  const picks = current ? await catalog.products({ category: current.slug, in_stock: true, sort: 'popular' }).catch(() => null) : null;
  const tg = `https://t.me/${botUsername()}`;

  return (
    <div className="page">
      <div className="container">
        <section className="ai-block" style={{ padding: 32 }}>
          <span className="ai-badge">
            <Sparkles size={26} strokeWidth={1.8} />
          </span>
          <h1 className="page-title" style={{ margin: 0 }}>
            {t(lang, 'ai.title')}
          </h1>
          <p style={{ maxWidth: 720 }}>{t(lang, 'ai.lead')}</p>
          <h2 style={{ fontSize: 17, marginTop: 8 }}>{t(lang, 'ai.goals')}</h2>
          <div className="needs">
            {needs.map((c) => (
              <Link key={c.id} href={`/ai?goal=${c.slug}`} className="need" aria-current={c.slug === goal ? 'true' : undefined} style={c.slug === goal ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 2px var(--primary)' } : undefined}>
                <span className="need-ic">
                  <NeedIcon slug={c.slug} />
                </span>
                <span>
                  <b>{nameOf(c, lang)}</b>
                </span>
              </Link>
            ))}
          </div>
        </section>

        {current && picks ? (
          <section className="section">
            <div className="section-head">
              <div>
                <h2>{nameOf(current, lang)}</h2>
                <p>{t(lang, 'header.doctor')}</p>
              </div>
              <Link className="more" href={`/catalog/${current.slug}`}>
                {t(lang, 'home.all')} <ArrowRight size={16} strokeWidth={2} />
              </Link>
            </div>
            <div className="grid grid-5">
              {picks.items.slice(0, 10).map((p) => (
                <ProductTile key={p.id} p={p} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="section">
          <div className="tg-block">
            <h2>{t(lang, 'home.aiTitle')}</h2>
            <p>{t(lang, 'ai.soon')}</p>
            <ul className="tg-list">
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'home.how3t')}
              </li>
            </ul>
            <div>
              <a className="btn btn-light" href={tg} target="_blank" rel="noopener noreferrer">
                <Send size={18} strokeWidth={1.8} /> {t(lang, 'ai.openTg')}
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
