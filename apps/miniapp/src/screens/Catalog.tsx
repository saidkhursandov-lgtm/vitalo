import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronIcon, CloseIcon, FilterIcon } from '../components/Icons';
import { EmptyState, ErrorState, Loading, ProductGrid } from '../components/ui';
import { nameOf } from '../lib/format';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import { useBrands, useCategories, useForms, useProducts, useProductsCount, type ProductFilters, type Sort } from '../lib/queries';
import type { CategoryNode } from '../lib/types';

/** Catalog root: the two independent trees (need / product type), up to 3 levels. */
export function Catalog() {
  const { t } = useI18n();
  const categories = useCategories();
  const [tree, setTree] = useState<'need' | 'product_type'>('need');

  return (
    <div className="page">
      <h1>{t('catalog.title')}</h1>
      <div className="segmented">
        <button className={tree === 'need' ? 'is-on' : ''} onClick={() => setTree('need')}>
          {t('home.byNeed')}
        </button>
        <button className={tree === 'product_type' ? 'is-on' : ''} onClick={() => setTree('product_type')}>
          {t('home.byType')}
        </button>
      </div>
      <Link to="/catalog/products" className="list-row">
        <span>{t('catalog.allProducts')}</span>
        <ChevronIcon width={18} height={18} />
      </Link>
      {categories.isPending ? (
        <Loading variant="list" count={6} />
      ) : categories.isError ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <CategoryList nodes={categories.data[tree]} depth={0} />
      )}
    </div>
  );
}

function CategoryList({ nodes, depth }: { nodes: CategoryNode[]; depth: number }) {
  const { lang } = useI18n();
  return (
    <ul className="cat-list">
      {nodes.map((c) => (
        <li key={c.id}>
          <Link to={`/catalog/products?category=${c.slug}`} className="list-row" style={{ paddingLeft: 16 + depth * 16 }}>
            <span className={depth ? '' : 'strong'}>{nameOf(c, lang)}</span>
            <span className="row-end">
              <span className="hint small">{c.product_count}</span>
              <ChevronIcon width={18} height={18} />
            </span>
          </Link>
          {c.children.length > 0 && <CategoryList nodes={c.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
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
export function ProductList() {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const categories = useCategories();
  const [showFilters, setShowFilters] = useState(false);

  const filters: ProductFilters = useMemo(
    () => ({
      category: params.get('category') ?? undefined,
      brand: list(params.get('brand')),
      form: list(params.get('form')),
      price_min: num(params.get('price_min')),
      price_max: num(params.get('price_max')),
      in_stock: params.get('in_stock') === 'true' || undefined,
      sort: (SORTS.find((s) => s === params.get('sort')) ?? 'popular') as Sort,
    }),
    [params],
  );
  const products = useProducts(filters);

  const category = filters.category && categories.data ? findCategory([...categories.data.need, ...categories.data.product_type], filters.category) : null;
  const activeFilters = [filters.brand?.length, filters.form?.length, filters.price_min, filters.price_max, filters.in_stock].filter(Boolean).length;
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
      <h1>{category ? nameOf(category, lang) : t('catalog.allProducts')}</h1>
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
          onClose={() => setShowFilters(false)}
          onApply={(f) => {
            update({
              brand: f.brand?.join(',') || undefined,
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
function FilterSheet({ filters, onApply, onClose }: { filters: ProductFilters; onApply: (f: ProductFilters) => void; onClose: () => void }) {
  const { t } = useI18n();
  const brands = useBrands();
  const forms = useForms();
  const [draft, setDraft] = useState<ProductFilters>(filters);
  // Ask the server for the number a moment after the last change, not on every keystroke.
  const [counted, setCounted] = useState<ProductFilters>(filters);
  useEffect(() => {
    const id = setTimeout(() => setCounted(draft), 300);
    return () => clearTimeout(id);
  }, [draft]);
  const count = useProductsCount({ ...counted, category: filters.category });

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

          <h3>{t('catalog.brand')}</h3>
          {brands.data?.map(({ brand }) => (
            <label key={brand} className="check-row">
              <input type="checkbox" checked={draft.brand?.includes(brand) ?? false} onChange={() => toggle('brand', brand)} />
              {brand}
            </label>
          ))}

          <h3>{t('catalog.form')}</h3>
          {forms.data?.map(({ form }) => (
            <label key={form} className="check-row">
              <input type="checkbox" checked={draft.form?.includes(form) ?? false} onChange={() => toggle('form', form)} />
              {form}
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
