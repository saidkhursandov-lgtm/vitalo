import { useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { money, nameOf, textOf } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useCart, useProduct, useShopTexts } from '../lib/queries';
import { useQuickCart } from '../lib/quick-cart';
import { QuickAdd, useQuickNotify } from '../components/QuickAdd';
import { useToast } from '../components/Toast';
import { CartIcon } from '../components/Icons';
import type { ProductCard } from '../lib/types';
import { tapHaptic } from '../lib/telegram';
import { DeliveryTerm } from '../components/Delivery';
import { Picture } from '../components/Picture';
import { Empty, ErrorState, FavoriteButton, Loading, Price, ProductStrip } from '../components/ui';

const SECTIONS: [field: string, title: MessageKey][] = [
  ['composition', 'product.composition'],
  ['nutrition', 'product.nutrition'],
  ['directions', 'product.directions'],
  ['warnings', 'product.warnings'],
];

/** Product detail (Master TZ §5, Flow §5). */
export function Product() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
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
  const description = textOf(p, 'short_description', lang);

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

      <div className="hint small">{p.brand}</div>
      <h1 className="product-title">{nameOf(p, lang)}</h1>
      <Price price={p.price_uzs} old={p.old_price_uzs} size="lg" />
      <div className={`stock ${p.in_stock ? 'is-in' : 'is-out'}`}>{p.in_stock ? t('product.inStock') : t('product.outOfStock')}</div>

      {description && (
        <section className="card">
          <h2>{t('product.description')}</h2>
          <p className="pre">{description}</p>
        </section>
      )}

      <section className="card">
        <h2>{t('product.about')}</h2>
        <dl className="props">
          <dt>{t('product.manufacturer')}</dt>
          <dd>{p.manufacturer}</dd>
          {p.country && (
            <>
              <dt>{t('product.country')}</dt>
              <dd>{p.country}</dd>
            </>
          )}
          {p.form && (
            <>
              <dt>{t('product.form')}</dt>
              <dd>{p.form}</dd>
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
 * Always on screen (F2): price and «Купить сейчас» on top, the main action below — «В корзину», or once
 * the product is in the cart: «− n +» and «Перейти в корзину · сумма». At most 88 px plus the iPhone safe area.
 */
function BuyPanel({ product: p }: { product: ProductCard }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const notify = useQuickNotify();
  const toast = useToast();
  const cart = useCart(null);
  const { qty, set } = useQuickCart(p.id, notify);
  const total = cart.data ? cart.data.goods_total_uzs - cart.data.discount_total_uzs : null;
  const soldOut = !p.in_stock && qty === 0;

  return (
    <div className="buy-panel" role="region" aria-label={t('product.addToCart')}>
      <div className="buy-panel-top">
        <Price price={p.price_uzs} old={p.old_price_uzs} />
        {!soldOut && (
          <button type="button" className="buy-now" onClick={() => navigate(`/checkout?buy=${p.id}&qty=${Math.max(qty, 1)}`)}>
            {t('product.buyNow')}
          </button>
        )}
      </div>
      <div className="buy-panel-main">
        {soldOut ? (
          <button type="button" className="btn btn-block is-out" disabled>
            {t('product.outOfStock')}
          </button>
        ) : qty === 0 ? (
          <button
            type="button"
            className="btn btn-block"
            onClick={() => {
              tapHaptic();
              set(1);
              track('add_to_cart', { product_id: p.id, source: 'product' });
              toast(t('product.added'), <Link to="/cart" className="toast-action">{t('quick.cart')}</Link>);
            }}
          >
            <CartIcon width={20} height={20} /> {t('product.addToCart')}
          </button>
        ) : (
          <>
            <QuickAdd productId={p.id} inStock={p.in_stock} variant="panel" />
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
