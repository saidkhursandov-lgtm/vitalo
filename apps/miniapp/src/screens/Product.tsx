import { useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { countryName, formLabel, money, nameOf, pricePerDay, shortNameOf, textOf } from '../lib/format';
import { PromoLabelBadge } from '../components/Campaign';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import { useCart, useProduct, useShopTexts } from '../lib/queries';
import { useQuickCart } from '../lib/quick-cart';
import { QuickAdd, useQuickNotify, WaitlistButton } from '../components/QuickAdd';
import { BioIcon, CartIcon, ChevronIcon, DoctorIcon, LeafIcon, PlusIcon, ShieldIcon, SupportIcon, TestedIcon, type Icon } from '../components/Icons';
import { useSheets } from '../components/Sheets';
import type { ProductCard } from '../lib/types';
import { useUnderOrderDays, useUnderOrderText } from '../components/CrossBorder';
import { tapHaptic } from '../lib/telegram';
import { DeliveryTerm } from '../components/Delivery';
import { Picture } from '../components/Picture';
import { ClampText } from '../components/ClampText';
import { Empty, ErrorState, FavoriteButton, Loading, Price, ProductStrip } from '../components/ui';

/** Accordions; «Описание» comes first and is folded — the expert text on the first screen is the verdict (2.3 fixes). */
const SECTIONS: [field: string, title: MessageKey][] = [
  ['short_description', 'product.description'],
  ['composition', 'product.composition'],
  ['nutrition', 'product.nutrition'],
  ['directions', 'product.directions'],
  ['warnings', 'product.warnings'],
];

/** Product detail (Master TZ §5, Flow §5). */
export function Product() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const uo = useUnderOrderText();
  const uoDays = useUnderOrderDays();
  const product = useProduct(id);
  const texts = useShopTexts();
  const [imageIdx, setImageIdx] = useState(0);
  useEffect(() => {
    if (id) track('product_view', { product_id: id });
  }, [id]);

  if (product.isPending) return <div className="page"><Loading variant="product" /></div>;
  if (product.isError) {
    if (product.error instanceof ApiError && product.error.status === 404) return <Empty>{t('product.notFound')}</Empty>;
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  }

  const p = product.data;
  const images = p.media.filter((m) => m.type === 'image');
  const documents = p.media.filter((m) => m.type === 'document');
  const short = shortNameOf(p, lang);
  const substance = textOf(p, 'substance_form', lang);
  const dayWord = (n: number) => t(`card.day.${pluralForm(n)}` as MessageKey);
  const verdict = textOf(p, 'doctor_verdict', lang);
  const shell = textOf(p, 'shell', lang);
  const brandName = (lang === 'uz' && p.brand_name_uz) || p.brand_name_ru || p.brand;
  const brandWhy = (lang === 'uz' && p.brand_why_uz) || p.brand_why_ru;

  return (
    <div className="page product">
      <div className="gallery">
        {images[imageIdx] && (
          <Picture
            src={{ webp: images[imageIdx].url, jpeg: images[imageIdx].url_jpeg, width: images[imageIdx].width, height: images[imageIdx].height }}
            alt={nameOf(p, lang)}
            eager={imageIdx === 0}
          />
        )}
        <FavoriteButton productId={p.id} className="gallery-fav" />
        {/* 6а-В: the manual promo label (a running sale shows its own prices instead) */}
        {p.promo_label && !p.campaign && <PromoLabelBadge label={p.promo_label} className="gallery-label" />}
      </div>
      {images.length > 1 && (
        <div className="thumbs">
          {images.map((m, i) => (
            <button key={m.url} className={i === imageIdx ? 'is-on' : ''} onClick={() => setImageIdx(i)}>
              <img src={m.thumb_url ?? m.url} alt="" width={56} height={56} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}

      {/* 2.2 / 2.3: the brand is a chip that opens its page (logo, «Почему … в VITALO», all its products) */}
      {p.brand_slug ? (
        <Link className="brand-chip" to={`/brand/${p.brand_slug}`}>
          {p.brand}
        </Link>
      ) : (
        <div className="hint small">{p.brand}</div>
      )}
      {/* 2.3: the short name and the substance form; the full name is in «О товаре» and in search */}
      <h1 className="product-title">{short}</h1>
      {substance && <p className="product-sub">{substance}</p>}
      <div className="price-line">
        <Price price={p.price_uzs} old={p.old_price_uzs} size="lg" campaign={p.campaign} />
        {p.in_stock ? (
          <div className="stock is-in">{t('product.inStock')}</div>
        ) : p.cross_border ? (
          <div className="stock is-usa">{uoDays(p.cross_border_terms ?? p.under_order)}</div>
        ) : (
          <div className="stock is-out">{t('product.outOfStock')}</div>
        )}
      </div>
      {/* D-60: what «под заказ» means before the customer pays */}
      {p.cross_border && !p.in_stock && (
        <div className="notice notice-info usa-note">{uo('note', p.cross_border_terms ?? p.under_order, { days: (p.cross_border_terms ?? p.under_order)?.guarantee_days ?? 21 })}</div>
      )}
      {p.course_days ? (
        <p className="lasts">
          {t('card.lasts', { n: p.course_days, d: dayWord(p.course_days), price: money(pricePerDay(p.price_uzs, p.course_days), lang) })}
        </p>
      ) : null}
      {p.market_advantage_percent ? <span className="market-badge">{t('card.market', { n: p.market_advantage_percent })}</span> : null}
      <StandardStrip product={p} />
      {verdict && (
        <section className="verdict">
          <h2>
            <DoctorIcon width={18} height={18} /> {t('card.verdict')}
          </h2>
          <ClampText className="pre" text={verdict} />
        </section>
      )}
      <AskSpecialist id={p.id} name={short} />

      {/* «Почему [бренд] отобран в VITALO» — its own navy card right before «О товаре»; no text, no card */}
      {brandWhy && (
        <section className="why-brand">
          <p className="why-brand-mark">
            <PlusIcon width={11} height={11} strokeWidth={3.4} aria-hidden /> {t('card.brandMark')}
          </p>
          <h2>{t('card.whyBrand', { brand: brandName })}</h2>
          <ClampText className="pre" text={brandWhy} />
        </section>
      )}

      {/* the full name is not shown here any more: it stays for search (2.3 fixes) */}
      <section className="card">
        <h2>{t('product.about')}</h2>
        <dl className="props">
          <dt>{t('card.brand')}</dt>
          <dd>{brandName}</dd>
          <dt>{t('product.manufacturer')}</dt>
          <dd>{p.manufacturer}</dd>
          {p.country && (
            <>
              <dt>{t('product.country')}</dt>
              <dd>{countryName(p.country, lang)}</dd>
            </>
          )}
          {p.form && (
            <>
              <dt>{t('product.form')}</dt>
              <dd>{formLabel(p.form, lang)}</dd>
            </>
          )}
          {shell && (
            <>
              <dt>{t('card.shell')}</dt>
              <dd>{shell}</dd>
            </>
          )}
        </dl>
      </section>

      {SECTIONS.map(([field, title]) => {
        const text = textOf(p, field, lang);
        return text ? (
          <details key={field} className="card" open={field === 'warnings'}>
            <summary>{t(title)}</summary>
            <p className="pre">{text}</p>
          </details>
        ) : null;
      })}

      {/* Only when the product really has documents uploaded. */}
      {documents.length > 0 && (
        <section className="card docs">
          <h2>{t('product.documents')}</h2>
          {documents.map((d) => (
            <a key={d.url} href={d.url} target="_blank" rel="noreferrer" className="link">
              {d.title ?? d.url}
            </a>
          ))}
        </section>
      )}

      <section className="card">
        <h2>{t('product.delivery')}</h2>
        <DeliveryTerm />
        <p className="hint small">{t('product.deliveryInfo')}</p>
      </section>

      <ProductStrip title={t('product.similar')} products={p.similar} />
      <ProductStrip title={t('product.alsoBought')} products={p.also_bought} />
      {/* Mandatory note, once, as the last block (the fixed bottom belongs to the buy panel); edited in Настройки → Тексты. */}
      {texts.data && <p className="disclaimer-block">{lang === 'uz' ? texts.data.product_disclaimer.uz : texts.data.product_disclaimer.ru}</p>}

      <BuyPanel product={p} />
    </div>
  );
}

/**
 * Always on screen (F2, 2.3 fixes; 6а-Б: one storey — the price is in the page, no second price line here): one row of 48 px buttons — «В корзину» (filled, ~60%)
 * and «Купить сейчас» (outlined, ~40%); once the product is in the cart: «− n +» and «Перейти в корзину · сумма».
 */
function BuyPanel({ product: p }: { product: ProductCard }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const notify = useQuickNotify();
  const cart = useCart(null);
  const { qty, set } = useQuickCart(p.id, notify);
  const total = cart.data ? cart.data.goods_total_uzs - cart.data.discount_total_uzs : null;
  const soldOut = !p.in_stock && !p.cross_border && qty === 0;

  return (
    <div className="buy-panel" role="region" aria-label={t('product.addToCart')}>
      <div className="buy-panel-main">
        {soldOut ? (
          <WaitlistButton productId={p.id} variant="panel" />
        ) : qty === 0 ? (
          <>
            <button
              type="button"
              className="btn buy-add"
              onClick={() => {
                tapHaptic();
                set(1);
                track('add_to_cart', { product_id: p.id, source: 'product' });
                if (p.campaign) track('campaign_add_to_cart', { campaign_id: p.campaign.id, product_id: p.id });
              }}
            >
              <CartIcon width={20} height={20} />
              <span>{t('product.addToCart')}</span>
            </button>
            <button type="button" className="btn btn-secondary buy-now" onClick={() => navigate(`/checkout?buy=${p.id}&qty=1`)}>
              <span>{t('product.buyNow')}</span>
            </button>
          </>
        ) : (
          <>
            <QuickAdd productId={p.id} inStock={p.in_stock || !!p.cross_border} variant="panel" campaignId={p.campaign?.id} />
            <Link to="/cart" className="btn to-cart">
              <span>{t('panel.toCart')}</span>
              {total !== null && <small>{money(total, lang)}</small>}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

/** 2.3: «Стандарт VITALO» — a 2-column grid (2.3 fixes), only the badges the product has; Halal / VEGE by D-32 (never for «Нет» / «Не знаю»). */
function StandardStrip({ product: p }: { product: ProductCard }) {
  const { t } = useI18n();
  const chips: [Icon, MessageKey][] = [];
  if (p.std_bioavailability) chips.push([BioIcon, 'card.stdBio']);
  if (p.std_tested) chips.push([TestedIcon, 'card.stdTested']);
  if (p.std_original) chips.push([ShieldIcon, 'card.stdOriginal']);
  const hv = { halal: 'card.halal', vege: 'card.vege', halal_vege: 'card.halalVege' } as const;
  if (p.halal_vege && p.halal_vege in hv) chips.push([LeafIcon, hv[p.halal_vege as keyof typeof hv]]);
  if (!chips.length) return null;
  return (
    <>
      <p className="std-title">{t('card.standard')}</p>
      <div className="std-grid">
        {chips.map(([I, key]) => (
          <span key={key} className="std-chip">
            <I width={16} height={16} /> {t(key)}
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * 2.3 fixes: «Сомневаетесь, подойдёт ли вам препарат?» — a widget right under the verdict, the whole card is the button;
 * opens the support chat with the product's short name ready.
 */
function AskSpecialist({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  const { openAsk } = useSheets();
  // 6а-Д: the in-app sheet with this product attached (no jump to the Telegram chat)
  return (
    <button type="button" className="ask-card" onClick={() => openAsk({ product: { id, name }, topic: 'medical', source: 'product' })}>
      <span className="ask-icon" aria-hidden>
        <SupportIcon width={20} height={20} />
      </span>
      <span className="ask-text">
        <strong>{t('card.askTitle')}</strong>
        <span>{t('card.askSub')}</span>
      </span>
      <ChevronIcon className="ask-chevron" width={20} height={20} aria-hidden />
    </button>
  );
}
