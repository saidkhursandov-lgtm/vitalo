import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BrandLogo, BrandStrip, CategoryLink } from '../components/CatalogLayers';
import { ChevronIcon, CloseIcon, FilterIcon } from '../components/Icons';
import { ClampText } from '../components/ClampText';
import { EmptyState, ErrorState, Loading, ProductGrid } from '../components/ui';
import { formLabel, nameOf } from '../lib/format';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import { useBrandPage, useBrands, useCategories, useForms, useProducts, useProductsCount, type ProductFilters, type Sort } from '../lib/queries';
import type { CategoryNode } from '../lib/types';

/**
 * Catalog root (ТЗ v3 §4.1, подэтап 2.2): three layers on one screen — «По потребности», «По типу», «Проверенные
 * бренды». One level: every card opens its product list in one tap.
 */
export function Catalog() {
  const { t } = useI18n();
  const categories = useCategories();

  return (
    <div className="page catalog-root">
      <h1>{t('catalog.title')}</h1>
      <Link to="/catalog/products" className="list-row">
        <span>{t('catalog.allProducts')}</span>
        <ChevronIcon width={18} height={18} />
      </Link>
      {categories.isPending ? (
        <Loading variant="list" count={6} />
      ) : categories.isError ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        (['need', 'product_type'] as const).map(
          (tree) =>
            categories.data[tree].length > 0 && (
              <section key={tree} className="section">
                <div className="section-head">
                  <h2>{t(tree === 'need' ? 'home.byNeed' : 'home.byType')}</h2>
                </div>
                <div className="type-grid">
                  {categories.data[tree].map((c) => (
                    <CategoryLink key={c.id} c={c} className="type-card" />
                  ))}
                </div>
              </section>
            ),
        )
      )}
      <BrandStrip />
    </div>
  );
}

/** Brand page (2.2): logo, name, country, «Почему [бренд] в VITALO» when filled in, then the brand's products. */
export function BrandScreen() {
  const { t, lang } = useI18n();
  const { slug = '' } = useParams();
  const brand = useBrandPage(slug);

  if (brand.isPending) return <div className="page"><Loading variant="list" count={2} /></div>;
  if (brand.isError) {
    return (
      <div className="page">
        {(brand.error as { status?: number }).status === 404 ? <EmptyState title={t('brand.notFound')} /> : <ErrorState error={brand.error} onRetry={() => void brand.refetch()} />}
      </div>
    );
  }
  const b = brand.data;
  const country = (lang === 'uz' && b.country_uz) || b.country_ru;
  const why = (lang === 'uz' && b.why_vitalo_uz) || b.why_vitalo_ru;
  return (
    <ProductList
      brand={b.name}
      header={
        <>
          <div className="brand-head">
            <BrandLogo brand={b} size={72} />
            <div className="brand-head-text">
              <h1>{b.name}</h1>
              {country && <span className="hint">{country}</span>}
            </div>
          </div>
          {why && (
            <section className="card brand-why">
              <h2>{t('brand.why', { brand: b.name })}</h2>
              <ClampText text={why} />
            </section>
          )}
          <h2 className="brand-products-title">{t('brand.products')}</h2>
        </>
      }
    />
  );
}

function findCategory(nodes: CategoryNode[], slug: string): CategoryNode | null {
  for (const n of nodes) {
    if (n.slug === slug) return n;
    const found = findCategory(n.children, slug);
    if (found) return found;
  }
  return null;
}

const SORTS: Sort[] = ['popular', 'price_asc', 'price_desc', 'new'];
const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : undefined);
const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** Product list with filters (price, brand, form, in stock) and sorting; state lives in the URL. */
export function ProductList({ brand, header }: { brand?: string; header?: ReactNode } = {}) {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const categories = useCategories();
  const [showFilters, setShowFilters] = useState(false);

  // The brand page (2.2) shows only that brand: its brand is fixed, not a filter.
  const filters: ProductFilters = useMemo(
    () => ({
      category: params.get('category') ?? undefined,
      brand: brand ? [brand] : list(params.get('brand')),
      form: list(params.get('form')),
      price_min: num(params.get('price_min')),
      price_max: num(params.get('price_max')),
      in_stock: params.get('in_stock') === 'true' || undefined,
      sort: (SORTS.find((s) => s === params.get('sort')) ?? 'popular') as Sort,
    }),
    [params, brand],
  );
  const products = useProducts(filters);

  const category = filters.category && categories.data ? findCategory([...categories.data.need, ...categories.data.product_type], filters.category) : null;
  const activeFilters = [!brand && filters.brand?.length, filters.form?.length, filters.price_min, filters.price_max, filters.in_stock].filter(Boolean).length;
  const items = products.data?.pages.flatMap((p) => p.items) ?? [];

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      {header ?? <h1>{category ? nameOf(category, lang) : t('catalog.allProducts')}</h1>}
      {category && category.children.length > 0 && (
        <div className="chips scroll-x">
          {category.children.map((c) => (
            <Link key={c.id} className="chip" to={`/catalog/products?category=${c.slug}`}>
              {nameOf(c, lang)} · {c.product_count}
            </Link>
          ))}
        </div>
      )}

      <div className="toolbar">
        <select aria-label={t('catalog.sort')} value={filters.sort} onChange={(e) => update({ sort: e.target.value })}>
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`catalog.sort.${s}` as MessageKey)}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowFilters(true)}>
          <FilterIcon width={18} height={18} /> {t('catalog.filters')}
          {activeFilters > 0 && <span className="badge-inline">{activeFilters}</span>}
        </button>
      </div>

      {products.isPending ? (
        <Loading variant="grid" />
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('catalog.empty')}
          action={
            <button className="btn btn-secondary" onClick={() => setParams(filters.category ? { category: filters.category } : {}, { replace: true })}>
              {t('common.reset')}
            </button>
          }
        />
      ) : (
        <>
          <p className="hint small">{t('catalog.found', { n: products.data.pages[0].total })}</p>
          <ProductGrid products={items} />
          {products.hasNextPage && (
            <button className="btn btn-secondary btn-block" disabled={products.isFetchingNextPage} onClick={() => void products.fetchNextPage()}>
              {products.isFetchingNextPage ? t('common.loading') : t('common.showMore')}
            </button>
          )}
        </>
      )}

      {showFilters && (
        <FilterSheet
          filters={filters}
          fixedBrand={!!brand}
          onClose={() => setShowFilters(false)}
          onApply={(f) => {
            update({
              brand: brand ? undefined : f.brand?.join(',') || undefined,
              form: f.form?.join(',') || undefined,
              price_min: f.price_min?.toString(),
              price_max: f.price_max?.toString(),
              in_stock: f.in_stock ? 'true' : undefined,
            });
            setShowFilters(false);
          }}
        />
      )}
    </div>
  );
}

/** Bottom sheet: price, brand, form, availability; the main button shows how many products will be shown. */
function FilterSheet({ filters, fixedBrand, onApply, onClose }: { filters: ProductFilters; fixedBrand: boolean; onApply: (f: ProductFilters) => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const brands = useBrands();
  const forms = useForms();
  const [draft, setDraft] = useState<ProductFilters>(filters);
  // Ask the server for the number a moment after the last change, not on every keystroke.
  const [counted, setCounted] = useState<ProductFilters>(filters);
  useEffect(() => {
    const id = setTimeout(() => setCounted(draft), 300);
    return () => clearTimeout(id);
  }, [draft]);
  const count = useProductsCount({ ...counted, category: filters.category, ...(fixedBrand && { brand: filters.brand }) });

  const toggle = (key: 'brand' | 'form', value: string) => {
    const current = new Set(draft[key] ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    setDraft({ ...draft, [key]: [...current] });
  };
  const price = (v: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const n = count.data;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={t('catalog.filters')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2>{t('catalog.filters')}</h2>
          <button className="icon-btn" aria-label={t('common.cancel')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="sheet-body">
          <h3>{t('catalog.price')}</h3>
          <div className="field-row">
            <label className="field">
              <span>{t('catalog.priceFrom')}</span>
              <input inputMode="numeric" placeholder="0" value={draft.price_min ?? ''} onChange={(e) => setDraft({ ...draft, price_min: price(e.target.value) })} />
            </label>
            <label className="field">
              <span>{t('catalog.priceTo')}</span>
              <input inputMode="numeric" placeholder="1 000 000" value={draft.price_max ?? ''} onChange={(e) => setDraft({ ...draft, price_max: price(e.target.value) })} />
            </label>
          </div>

          {!fixedBrand && <h3>{t('catalog.brand')}</h3>}
          {!fixedBrand && brands.data?.map(({ brand }) => (
            <label key={brand} className="check-row">
              <input type="checkbox" checked={draft.brand?.includes(brand) ?? false} onChange={() => toggle('brand', brand)} />
              {brand}
            </label>
          ))}

          <h3>{t('catalog.form')}</h3>
          {forms.data?.map(({ form }) => (
            <label key={form} className="check-row">
              <input type="checkbox" checked={draft.form?.includes(form) ?? false} onChange={() => toggle('form', form)} />
              {formLabel(form, lang)}
            </label>
          ))}

          <h3>{t('catalog.availability')}</h3>
          <label className="check-row">
            <input type="checkbox" checked={!!draft.in_stock} onChange={(e) => setDraft({ ...draft, in_stock: e.target.checked || undefined })} />
            {t('catalog.inStockOnly')}
          </label>
        </div>

        <div className="sheet-actions">
          <button className="btn btn-secondary" onClick={() => setDraft({ sort: filters.sort })}>
            {t('common.reset')}
          </button>
          <button className="btn" disabled={n === 0} onClick={() => onApply(draft)}>
            {n === undefined ? t('catalog.counting') : t(`catalog.show.${pluralForm(n)}` as MessageKey, { n })}
          </button>
        </div>
      </div>
    </div>
  );
}
