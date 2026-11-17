import { Link, useParams } from 'react-router-dom';
import { AddBundleButton, BundlePrice, bundleTitle } from '../components/Bundles';
import { Picture, SafeImg } from '../components/Picture';
import { EmptyState, ErrorState, Loading, StickyAction } from '../components/ui';
import { money, shortNameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useBundle } from '../lib/queries';

/**
 * 4.3: a doctor's set — the jars, the doctor's text, «Хватит на X дней», the price with the set discount and one button
 * that puts every jar into the cart. A set that is off or has a jar out of stock is «недоступен».
 */
export function BundleScreen() {
  const { t, lang } = useI18n();
  const { slug = '' } = useParams();
  const q = useBundle(slug);

  if (q.isPending) return <div className="page"><Loading variant="grid" count={3} /></div>;
  if (q.isError) {
    return (
      <div className="page">
        {(q.error as { status?: number }).status === 404 ? (
          <EmptyState title={t('set.gone')} action={<Link to="/catalog" className="btn">{t('cart.toCatalog')}</Link>} />
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  }
  const b = q.data;
  const doctor = lang === 'uz' ? b.doctor_text_uz || b.doctor_text_ru : b.doctor_text_ru;
  const save = b.list_total_uzs - b.sale_total_uzs;
  return (
    <div className="page set-page">
      <h1 className="set-title">{bundleTitle(b, lang)}</h1>
      <div className="set-meta">
        {b.discount_pct > 0 && <span className="set-badge">−{b.discount_pct}%</span>}
        {b.days != null && <span className="set-days">{t('set.days', { n: b.days })}</span>}
      </div>

      <section className="card set-items" aria-label={t('set.items')}>
        <h2>{t('set.items')}</h2>
        {b.items.map(({ qty, product: p }) => (
          <Link key={p.id} to={`/product/${p.id}`} className="set-item">
            <span className="set-item-img">{p.image ? <Picture src={p.image} /> : p.image_url && <SafeImg src={p.image_url} alt="" loading="lazy" decoding="async" />}</span>
            <span className="set-item-text">
              <span className="set-item-name">{shortNameOf(p, lang)}</span>
              <span className="set-item-price">
                {qty > 1 ? `${qty} × ` : ''}
                {money(p.price_uzs, lang)}
              </span>
            </span>
          </Link>
        ))}
      </section>

      {doctor && (
        <section className="card set-doctor">
          <h2>{t('set.doctor')}</h2>
          <p>{doctor}</p>
        </section>
      )}

      <StickyAction>
        <div className="set-buy-sum">
          <BundlePrice bundle={b} />
          {save > 0 && <span className="set-save">{t('set.save', { sum: money(save, lang) })}</span>}
        </div>
        <AddBundleButton bundle={b} />
        <p className="hint small set-hint">{t('set.hint')}</p>
      </StickyAction>
    </div>
  );
}
