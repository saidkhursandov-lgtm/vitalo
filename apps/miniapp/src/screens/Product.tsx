import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { nameOf, textOf } from '../lib/format';
import { errorText, useI18n, type MessageKey } from '../lib/i18n';
import { useCartActions, useProduct } from '../lib/queries';
import { haptic } from '../lib/telegram';
import { Empty, ErrorState, FavoriteButton, Loading, Price, ProductStrip, Stepper, useToast } from '../components/ui';

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
  const navigate = useNavigate();
  const product = useProduct(id);
  const { add } = useCartActions();
  const toast = useToast();
  const [qty, setQty] = useState(1);
  const [imageIdx, setImageIdx] = useState(0);

  if (product.isPending) return <Loading />;
  if (product.isError) {
    if (product.error instanceof ApiError && product.error.status === 404) return <Empty>{t('product.notFound')}</Empty>;
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  }

  const p = product.data;
  const images = p.media.filter((m) => m.type === 'image');
  const documents = p.media.filter((m) => m.type === 'document');
  const description = textOf(p, 'short_description', lang);
  const max = Math.max(1, p.available_qty);

  const addToCart = () =>
    add.mutate(
      { product_id: p.id, qty },
      {
        onSuccess: () => {
          haptic('success');
          toast.show(t('product.added'), <Link to="/cart" className="toast-action">{t('product.goToCart')}</Link>);
        },
        onError: (e) => toast.show(errorText(lang, e instanceof ApiError ? e.code : undefined)),
      },
    );

  return (
    <div className="page product">
      <div className="gallery">
        {images[imageIdx] && <img src={images[imageIdx].url} alt={nameOf(p, lang)} />}
        <FavoriteButton productId={p.id} className="gallery-fav" />
      </div>
      {images.length > 1 && (
        <div className="thumbs">
          {images.map((m, i) => (
            <button key={m.url} className={i === imageIdx ? 'is-on' : ''} onClick={() => setImageIdx(i)}>
              <img src={m.url} alt="" />
            </button>
          ))}
        </div>
      )}

      <div className="hint small">{p.brand}</div>
      <h1 className="product-title">{nameOf(p, lang)}</h1>
      <Price price={p.price_uzs} old={p.old_price_uzs} size="lg" />
      <div className={`stock ${p.in_stock ? 'is-in' : 'is-out'}`}>{p.in_stock ? t('product.inStock') : t('product.outOfStock')}</div>

      {p.in_stock && (
        <div className="buy-box">
          <Stepper value={qty} max={max} onChange={setQty} />
          {qty >= max && <span className="hint small">{t('product.maxQty', { n: max })}</span>}
          <div className="buy-actions">
            <button className="btn btn-secondary" disabled={add.isPending} onClick={addToCart}>
              {t('product.addToCart')}
            </button>
            <button className="btn" onClick={() => navigate(`/checkout?buy=${p.id}&qty=${qty}`)}>
              {t('product.buyNow')}
            </button>
          </div>
        </div>
      )}

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

      {documents.length > 0 && (
        <section className="card">
          {documents.map((d) => (
            <a key={d.url} href={d.url} target="_blank" rel="noreferrer" className="link">
              {d.title ?? d.url}
            </a>
          ))}
        </section>
      )}

      <section className="card">
        <h2>{t('product.delivery')}</h2>
        <p className="hint">{t('product.deliveryInfo')}</p>
      </section>

      <ProductStrip title={t('product.similar')} products={p.similar} />
      <ProductStrip title={t('product.alsoBought')} products={p.also_bought} />
      {toast.node}
    </div>
  );
}
