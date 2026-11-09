import { Link, useNavigate } from 'react-router-dom';
import { SearchIcon } from '../components/Icons';
import { ErrorState, Loading, ProductStrip } from '../components/ui';
import { useI18n } from '../lib/i18n';
import { useBanners, useCategories, useFreeShipping, useHomeStrips, useShopTexts } from '../lib/queries';
import { HelpButton, HomeCarousel, HowToOrder } from '../components/HomeBlocks';
import { BrandStrip, CategoryLink } from '../components/CatalogLayers';
import { ManifestEntry } from '../components/Sheets';
import { ActiveOrderBar } from '../components/OrderNotices';

/**
 * Home (Flow §3, ТЗ 2.1 and 2.2; 6а-Б: no trust line under the search): search, the navy banner, needs, then «Популярное» already on the
 * first screen, «Как VITALO отбирает добавки» (2.4), product types, «Проверенные бренды», new arrivals.
 */
export function Home() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const categories = useCategories();
  // 6а-Б: «Популярное» — in stock in Tashkent; «Новинки» — newest, «под заказ» included, without repeats
  const strips = useHomeStrips();
  const shop = useShopTexts();
  const freeShipping = useFreeShipping();
  const banners = useBanners(lang);

  return (
    <div className="page home">
      {/* Search is the main element: a big field that opens the search screen with the keyboard up. */}
      <button type="button" className="search-hero" onClick={() => navigate('/search')}>
        <SearchIcon width={22} height={22} />
        <span>{t('home.search')}</span>
      </button>
      {/* 3.2: the newest unfinished order right under the search */}
      <ActiveOrderBar />

      <HomeCarousel firstOrderFree={freeShipping.data?.first_order_free ?? false} freeFromUzs={freeShipping.data?.from_uzs ?? null} banners={banners.data} />

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
        products={strips.data?.popular ?? []}
        more={<Link to="/catalog/products?sort=popular" className="link">{t('home.all')}</Link>}
      />
      {strips.isPending && <Loading variant="strip" />}
      {/* 2.4: «Как VITALO отбирает добавки» right under «Популярное» */}
      <ManifestEntry />

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

      <BrandStrip />

      <ProductStrip
        title={t('home.new')}
        products={strips.data?.fresh ?? []}
        more={<Link to="/catalog/products?sort=new" className="link">{t('home.all')}</Link>}
      />

      <HelpButton />
      {/* «Как заказать» is the last block of the page */}
      {shop.data?.home_content && <HowToOrder content={shop.data.home_content} />}
    </div>
  );
}
