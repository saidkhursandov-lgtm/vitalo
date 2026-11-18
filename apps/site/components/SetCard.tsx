import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { t } from '@/lib/i18n';
import { money } from '@/lib/format';
import type { Lang, ShopBundle } from '@/lib/types';

export function SetCard({ b, lang }: { b: ShopBundle; lang: Lang }) {
  const title = (lang === 'uz' && b.title_uz) || b.title_ru;
  const text = (lang === 'uz' && b.doctor_text_uz) || b.doctor_text_ru;
  return (
    <Link href={`/set/${b.slug}`} className="set-card">
      <div className="set-imgs">
        {b.items.slice(0, 4).map(({ product }) => (
          <span key={product.id}>{product.image?.webp || product.image_url ? <img src={product.image?.webp ?? product.image_url ?? ''} alt="" loading="lazy" /> : null}</span>
        ))}
      </div>
      <div>
        <span className="tag">
          −{b.discount_pct}%{b.days ? ` · ${t(lang, 'tile.days', { n: b.days })}` : ''}
        </span>
      </div>
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      <div className="set-foot">
        <div className="price">
          <span className="price-old">{money(b.list_total_uzs, lang)}</span>
          <span className="price-now">{money(b.sale_total_uzs, lang)}</span>
        </div>
        <ArrowRight size={20} strokeWidth={2} color="var(--primary)" />
      </div>
    </Link>
  );
}
