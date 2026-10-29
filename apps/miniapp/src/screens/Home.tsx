import { Link, useNavigate } from 'react-router-dom';
import { categoryIcon, SearchIcon } from '../components/Icons';
import { ErrorState, Loading, ProductStrip } from '../components/ui';
import { nameOf } from '../lib/format';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import { useCategories, useFreeShipping, useProducts, useShopTexts } from '../lib/queries';
import { HelpButton, HomeCarousel, HowToOrder, TrustChips } from '../components/HomeBlocks';
import type { CategoryNode } from '../lib/types';

/** Category on the home screen: icon, name, and the number of products customers can see — small and grey. */
function CategoryLink({ c, className }: { c: CategoryNode; className: string }) {
  const { t, lang } = useI18n();
  const Icon = categoryIcon(c.slug);
  return (
    <Link className={className} to={`/catalog/products?category=${c.slug}`}>
      <span className="cat-icon">
        <Icon width={20} height={20} />
      </span>
      <span className="cat-text">
        <span className="cat-name">{nameOf(c, lang)}</span>
        <span className="cat-count">{t(`home.count.${pluralForm(c.product_count)}` as MessageKey, { n: c.product_count })}</span>
      </span>
    </Link>
  );
}

/**
 * Home (Flow §3, ТЗ 2.1): search, two trust markers, the navy banner, needs, then «Популярное» already on the first
 * screen, product types, new arrivals.
 */
export function Home() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const categories = useCategories();
  const popular = useProducts({ sort: 'popular', in_stock: true });
  const fresh = useProducts({ sort: 'new', in_stock: true });
  const shop = useShopTexts();
  const freeShipping = useFreeShipping();

  return (
    <div className="page home">
      {/* Search is the main element: a big field that opens the search screen with the keyboard up. */}
      <button type="button" className="search-hero" onClick={() => navigate('/search')}>
        <SearchIcon width={22} height={22} />
        <span>{t('home.search')}</span>
      </button>

      <TrustChips />
      <HomeCarousel firstOrderFree={freeShipping.data?.first_order_free ?? false} freeFromUzs={freeShipping.data?.from_uzs ?? null} />

      {categories.isPending ? (
        <Loading variant="chips" />
      ) : categories.isError ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <section className="section">
          <div className="section-head">
            <h2>{t('home.byNeed')}</h2>
          </div>
          <div className="need-list scroll-x">
            {categories.data.need.map((c) => (
              <CategoryLink key={c.id} c={c} className="need-card" />
            ))}
          </div>
        </section>
      )}

      <ProductStrip
        title={t('home.popular')}
        products={popular.data?.pages[0].items.slice(0, 10) ?? []}
        more={<Link to="/catalog/products?sort=popular" className="link">{t('home.all')}</Link>}
      />
      {popular.isPending && <Loading variant="strip" />}

      {categories.data && (
        <section className="section">
          <div className="section-head">
            <h2>{t('home.byType')}</h2>
            <Link to="/catalog" className="link">
              {t('home.all')}
            </Link>
          </div>
          <div className="type-grid">
            {categories.data.product_type.map((c) => (
              <CategoryLink key={c.id} c={c} className="type-card" />
            ))}
          </div>
        </section>
      )}

      <ProductStrip
        title={t('home.new')}
        products={fresh.data?.pages[0].items.slice(0, 10) ?? []}
        more={<Link to="/catalog/products?sort=new" className="link">{t('home.all')}</Link>}
      />

      <HelpButton />
      {/* «Как заказать» is the last block of the page */}
      {shop.data?.home_content && <HowToOrder content={shop.data.home_content} />}
    </div>
  );
}
