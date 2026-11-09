import { useEffect, useState } from 'react';
import { money } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import type { CampaignLine, CampaignSkin, CampaignSummary, Lang, ShopCampaign, PromoLabel } from '../lib/types';

/**
 * 3.7 «Акции»: the skin draws the badge on the photo and the colour of the sale price.
 * Black Friday — dark badge with a gold %, the card gets a dark frame; 11.11 — orange badge with dark text;
 * «Акция / Chegirma» — teal badge with white text; «Без плашки» — no badge, only the two prices.
 */
export const saleTitle = (c: { title_ru: string; title_uz: string | null }, lang: Lang) => (lang === 'uz' && c.title_uz) || c.title_ru;

const skinKey = (skin: Exclude<CampaignSkin, 'none'>) => `sale.skin.${skin}` as MessageKey;

/** The badge in the top left corner of the photo: «−30% Black Friday»; the % first, so a narrow card never cuts it. */
export function SaleBadge({ campaign, className = '' }: { campaign: Pick<ShopCampaign, 'skin' | 'discount_pct'>; className?: string }) {
  const { t } = useI18n();
  if (campaign.skin === 'none') return null;
  return (
    <span className={`sale-badge sale-${campaign.skin} ${className}`}>
      <span className="sale-badge-pct">−{campaign.discount_pct}%</span>
      <span className="sale-badge-name">{t(skinKey(campaign.skin))}</span>
    </span>
  );
}

/** Old price on top (small, grey, crossed out), the sale price under it (big, in the skin colour). */
export function SalePrice({ price, campaign, size = 'md' }: { price: number; campaign: ShopCampaign; size?: 'md' | 'lg' }) {
  const { lang } = useI18n();
  return (
    <div className={`sale-price sale-price-${size}`}>
      <s className="sale-price-old">{money(campaign.list_price_uzs, lang)}</s>
      <span className={`sale-price-now sale-text-${campaign.skin}`}>{money(price, lang)}</span>
    </div>
  );
}

/** «2 дн. 14:20» till the end; under a day — «14:20»; the end passed — null. */
export function countdownText(endsAt: string, now: number, t: (k: MessageKey, p?: Record<string, string | number>) => string): string | null {
  const left = Math.floor((new Date(endsAt).getTime() - now) / 60_000);
  if (left <= 0) return null;
  const days = Math.floor(left / 1440);
  const hh = String(Math.floor((left % 1440) / 60)).padStart(2, '0');
  const mm = String(left % 60).padStart(2, '0');
  return `${days ? `${t('sale.days', { n: days })} ` : ''}${hh}:${mm}`;
}

/** «До конца: 2 дн. 14:20», ticks every 20 s; a sale without an end date shows nothing. */
export function Countdown({ endsAt, className = '' }: { endsAt: string | null; className?: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, [endsAt]);
  if (!endsAt) return null;
  const text = countdownText(endsAt, now, t);
  if (!text) return null;
  return <span className={`sale-countdown ${className}`}>{t('sale.endsIn', { time: text })}</span>;
}

/** The home slide of a running sale: drawn in the skin, first in the carousel; a tap opens all products of the sale. */
export function CampaignSlideBody({ campaign }: { campaign: CampaignSummary }) {
  const { t, lang } = useI18n();
  return (
    <>
      {campaign.skin !== 'none' && <span className={`sale-slide-tag sale-${campaign.skin}`}>{t(skinKey(campaign.skin))}</span>}
      <h2>{saleTitle(campaign, lang)}</h2>
      <p>
        {campaign.max_discount_pct > 0 && <strong>{t('sale.upTo', { pct: campaign.max_discount_pct })}</strong>}
        <Countdown endsAt={campaign.ends_at} className="sale-slide-time" />
      </p>
    </>
  );
}

/** «Акция «11.11»: −X сум» lines in the cart, checkout and order totals. */
export function CampaignRows({ campaigns }: { campaigns?: CampaignLine[] }) {
  const { t, lang } = useI18n();
  if (!campaigns?.length) return null;
  return (
    <>
      {campaigns.map((c) => (
        <div key={c.promotion_id} className="sum-row sale-row">
          <span>{t('sale.line', { title: saleTitle(c, lang) })}</span>
          <span className="sale-amount">−{money(c.amount_uzs, lang)}</span>
        </div>
      ))}
    </>
  );
}

/** 6а-В (D-62): the manual label in the top left corner of the photo: «11.11», «Black Friday», «Хит», «Новинка». */
export function PromoLabelBadge({ label, className = '' }: { label: PromoLabel; className?: string }) {
  const { t } = useI18n();
  return <span className={`promo-label promo-${label} ${className}`}>{t(`promo.label.${label}` as MessageKey)}</span>;
}
