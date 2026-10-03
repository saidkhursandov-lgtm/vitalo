import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, Loading, ProductGrid } from '../components/ui';
import { useI18n } from '../lib/i18n';
import { useFavorites } from '../lib/queries';

export function Favorites() {
  const { t } = useI18n();
  const favorites = useFavorites();

  return (
    <div className="page">
      <h1>{t('favorites.title')}</h1>
      {favorites.isPending ? (
        <Loading />
      ) : favorites.isError ? (
        <ErrorState error={favorites.error} onRetry={() => void favorites.refetch()} />
      ) : favorites.data.length === 0 ? (
        <EmptyState
          title={t('favorites.emptyTitle')}
          text={t('favorites.empty')}
          action={<Link to="/catalog" className="btn">{t('common.toCatalog')}</Link>}
        />
      ) : (
        <ProductGrid products={favorites.data} />
      )}
    </div>
  );
}
