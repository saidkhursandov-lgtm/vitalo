import { Link, useNavigate } from 'react-router-dom';
import { SearchIcon } from '../components/Icons';
import { ErrorState, Loading, ProductStrip } from '../components/ui';
import { nameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useCategories, useProducts } from '../lib/queries';
import type { CategoryNode, Lang } from '../lib/types';

/** "Коллаген · 8" — number of products customers can see in the category. */
export const withCount = (c: CategoryNode, lang: Lang) => `${nameOf(c, lang)} · ${c.product_count}`;

/** Home (Flow §3): search first, categories of both trees with counts, popular, new arrivals. */
export function Home() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const categories = useCategories();
  const popular = useProducts({ sort: 'popular', in_stock: true });
  const fresh = useProducts({ sort: 'new', in_stock: true });

  return (
    <div className="page">
      {/* Search is the main element: a big field that opens the search screen with the keyboard up. */}
      <button type="button" className="search-hero" onClick={() => navigate('/search')}>
        <SearchIcon width={22} height={22} />
        <span>{t('home.search')}</span>
      </button>

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
                  {withCount(c, lang)}
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
                  <span>{nameOf(c, lang)}</span>
                  <span className="hint small">{c.product_count}</span>
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
