import { Link } from 'react-router-dom';
import { SearchIcon } from '../components/Icons';
import { ErrorState, Loading, ProductStrip } from '../components/ui';
import { nameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useCategories, useProducts } from '../lib/queries';

/** Home (Flow §3): search, categories of both trees, popular, new arrivals. No admin-managed banners yet. */
export function Home() {
  const { t, lang } = useI18n();
  const categories = useCategories();
  const popular = useProducts({ sort: 'popular', in_stock: true });
  const fresh = useProducts({ sort: 'new', in_stock: true });

  return (
    <div className="page">
      <Link to="/search" className="search-entry">
        <SearchIcon width={20} height={20} />
        <span>{t('home.search')}</span>
      </Link>

      {categories.isPending ? (
        <Loading />
      ) : categories.isError ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <>
          <section className="section">
            <div className="section-head">
              <h2>{t('home.byNeed')}</h2>
            </div>
            <div className="chips scroll-x">
              {categories.data.need.map((c) => (
                <Link key={c.id} className="chip" to={`/catalog/products?category=${c.slug}`}>
                  {nameOf(c, lang)}
                </Link>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>{t('home.byType')}</h2>
              <Link to="/catalog" className="link">
                {t('home.all')}
              </Link>
            </div>
            <div className="type-grid">
              {categories.data.product_type.map((c) => (
                <Link key={c.id} className="type-card" to={`/catalog/products?category=${c.slug}`}>
                  {nameOf(c, lang)}
                </Link>
              ))}
            </div>
          </section>
        </>
      )}

      <ProductStrip
        title={t('home.popular')}
        products={popular.data?.pages[0].items.slice(0, 10) ?? []}
        more={<Link to="/catalog/products?sort=popular" className="link">{t('home.all')}</Link>}
      />
      <ProductStrip
        title={t('home.new')}
        products={fresh.data?.pages[0].items.slice(0, 10) ?? []}
        more={<Link to="/catalog/products?sort=new" className="link">{t('home.all')}</Link>}
      />
      {popular.isPending && <Loading />}
    </div>
  );
}
