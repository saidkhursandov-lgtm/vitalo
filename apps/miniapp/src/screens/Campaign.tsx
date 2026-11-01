import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import { useCampaignPage } from '../lib/queries';
import { Countdown, saleTitle } from '../components/Campaign';
import { EmptyState, ErrorState, Loading, ProductGrid } from '../components/ui';

/** 3.7: «Все товары акции» — opened from the home slide and from the start message; in stock and biggest discount first. */
export function CampaignScreen() {
  const { t, lang } = useI18n();
  const { slug = '' } = useParams();
  const page = useCampaignPage(slug);
  const id = page.data?.campaign.id;
  useEffect(() => {
    if (id) track('campaign_view', { campaign_id: id });
  }, [id]);

  if (page.isPending) return <div className="page"><Loading variant="grid" count={4} /></div>;
  if (page.isError) {
    return (
      <div className="page">
        {(page.error as { status?: number }).status === 404 ? (
          <EmptyState title={t('sale.notRunning')} action={<Link to="/catalog" className="btn">{t('cart.toCatalog')}</Link>} />
        ) : (
          <ErrorState error={page.error} onRetry={() => void page.refetch()} />
        )}
      </div>
    );
  }
  const c = page.data.campaign;
  return (
    <div className="page">
      <section className={`sale-head sale-slide-${c.skin}`}>
        <h1>{saleTitle(c, lang)}</h1>
        <p>
          {c.max_discount_pct > 0 && <strong>{t('sale.upTo', { pct: c.max_discount_pct })}</strong>}
          <Countdown endsAt={c.ends_at} className="sale-slide-time" />
        </p>
      </section>
      <h2 className="brand-products-title">{t('sale.all')}</h2>
      {page.data.items.length ? <ProductGrid products={page.data.items} /> : <EmptyState title={t('sale.notRunning')} />}
    </div>
  );
}
