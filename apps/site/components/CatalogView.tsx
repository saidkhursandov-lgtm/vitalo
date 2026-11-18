import Link from 'next/link';
import { ChevronRight as Sep, SearchX, SlidersHorizontal } from 'lucide-react';
import { catalog, type CatalogQuery, type Sort } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { formLabel, nameOf } from '@/lib/format';
import type { CategoryNode, Lang } from '@/lib/types';
import { ProductTile } from './ProductTile';
import { FilterToggle, SortSelect } from './SortSelect';
import { Pager } from './Pager';

export type Params = Record<string, string | string[] | undefined>;

const SORTS: Sort[] = ['popular', 'price_asc', 'price_desc', 'new'];
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(',') : []).map((s) => s.trim()).filter(Boolean);
const num = (v: string | string[] | undefined) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

export function parseQuery(sp: Params, category?: string): CatalogQuery {
  const sort = (Array.isArray(sp.sort) ? sp.sort[0] : sp.sort) as Sort | undefined;
  return {
    category,
    brand: list(sp.brand),
    form: list(sp.form),
    price_min: num(sp.price_min),
    price_max: num(sp.price_max),
    in_stock: sp.in_stock === '1' || sp.in_stock === 'true' || undefined,
    sort: sort && SORTS.includes(sort) ? sort : undefined,
    page: num(sp.page),
  };
}

/** A link to the same list with some parameters changed (page, sort). */
export function hrefWith(base: string, q: CatalogQuery, change: Partial<CatalogQuery>): string {
  const m = { ...q, ...change, category: undefined };
  const u = new URLSearchParams();
  for (const b of m.brand ?? []) u.append('brand', b);
  for (const f of m.form ?? []) u.append('form', f);
  if (m.price_min) u.set('price_min', String(m.price_min));
  if (m.price_max) u.set('price_max', String(m.price_max));
  if (m.in_stock) u.set('in_stock', '1');
  if (m.sort && m.sort !== 'popular') u.set('sort', m.sort);
  if (m.page && m.page > 1) u.set('page', String(m.page));
  const s = u.toString();
  return s ? `${base}?${s}` : base;
}

function findPath(nodes: CategoryNode[], slug: string, trail: CategoryNode[] = []): CategoryNode[] | null {
  for (const n of nodes) {
    if (n.slug === slug) return [...trail, n];
    const deeper = findPath(n.children, slug, [...trail, n]);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * The catalog list for /catalog and /catalog/<category>: filters on the left (a plain form — it works before the page
 * scripts load), sorting, pages with their own addresses (Google sees every page).
 */
export async function CatalogView({ lang, slug, sp }: { lang: Lang; slug?: string; sp: Params }) {
  const q = parseQuery(sp, slug);
  const base = slug ? `/catalog/${slug}` : '/catalog';
  const [cats, brands, forms, page] = await Promise.all([catalog.categories().catch(() => null), catalog.brands(), catalog.forms(), catalog.products(q)]);
  const trees = [...(cats?.need ?? []), ...(cats?.product_type ?? [])];
  const path = slug ? findPath(trees, slug) : null;
  const current = path?.[path.length - 1];
  const title = current ? nameOf(current, lang) : t(lang, 'catalog.title');
  const tree = current ? (cats?.need.some((n) => n.id === path![0].id) ? cats.need : (cats?.product_type ?? [])) : (cats?.product_type ?? []);
  const children = current?.children.length ? current.children : (path && path.length > 1 ? path[path.length - 2].children : []);
  const activeFilters = (q.brand?.length ?? 0) + (q.form?.length ?? 0) + (q.price_min ? 1 : 0) + (q.price_max ? 1 : 0) + (q.in_stock ? 1 : 0);

  const filters = (
    <form className="filters" action={base} method="get">
      <div className="filter-group">
        <h3>{current ? t(lang, 'nav.catalog') : t(lang, 'catalog.types')}</h3>
        <ul className="cat-links">
          {!current ? (
            <li>
              <Link href="/catalog" className="is-on">
                {t(lang, 'catalog.allProducts')}
              </Link>
            </li>
          ) : null}
          {tree.map((c) => (
            <li key={c.id}>
              <Link href={`/catalog/${c.slug}`} className={path?.some((p) => p.id === c.id) ? 'is-on' : ''}>
                {nameOf(c, lang)} <em>{c.product_count}</em>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="filter-group">
        <h3>{t(lang, 'catalog.price')}</h3>
        <div className="range">
          <input className="input" type="number" name="price_min" min={0} step={1000} inputMode="numeric" placeholder={t(lang, 'catalog.from')} defaultValue={q.price_min} aria-label={`${t(lang, 'catalog.price')} ${t(lang, 'catalog.from')}`} />
          <input className="input" type="number" name="price_max" min={0} step={1000} inputMode="numeric" placeholder={t(lang, 'catalog.to')} defaultValue={q.price_max} aria-label={`${t(lang, 'catalog.price')} ${t(lang, 'catalog.to')}`} />
        </div>
      </div>
      <div className="filter-group">
        <label className="check">
          <input type="checkbox" name="in_stock" value="1" defaultChecked={!!q.in_stock} /> {t(lang, 'catalog.inStock')}
        </label>
      </div>
      {brands?.length ? (
        <div className="filter-group">
          <h3>{t(lang, 'catalog.brand')}</h3>
          <div className="check-list">
            {brands.map((b) => (
              <label key={b.id} className="check">
                <input type="checkbox" name="brand" value={b.name} defaultChecked={q.brand?.includes(b.name)} /> {b.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {forms?.length ? (
        <div className="filter-group">
          <h3>{t(lang, 'catalog.form')}</h3>
          <div className="check-list">
            {forms.map(({ form }) => (
              <label key={form} className="check">
                <input type="checkbox" name="form" value={form} defaultChecked={q.form?.includes(form)} /> {formLabel(form, lang)}
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {q.sort && q.sort !== 'popular' ? <input type="hidden" name="sort" value={q.sort} /> : null}
      <div className="filter-actions">
        <button type="submit" className="btn">
          {t(lang, 'catalog.apply')}
        </button>
        {activeFilters ? (
          <Link href={base} className="btn btn-secondary">
            {t(lang, 'catalog.reset')}
          </Link>
        ) : null}
      </div>
    </form>
  );

  return (
    <div className="page">
      <div className="container">
        <nav className="crumbs" aria-label="breadcrumbs">
          <Link href="/">{t(lang, 'nav.home')}</Link>
          <Sep size={14} />
          {path ? (
            <>
              <Link href="/catalog">{t(lang, 'nav.catalog')}</Link>
              {path.slice(0, -1).map((p) => (
                <span key={p.id} style={{ display: 'contents' }}>
                  <Sep size={14} />
                  <Link href={`/catalog/${p.slug}`}>{nameOf(p, lang)}</Link>
                </span>
              ))}
            </>
          ) : (
            <span>{t(lang, 'nav.catalog')}</span>
          )}
        </nav>
        <h1 className="page-title">{title}</h1>
        {children.length ? (
          <div className="sub-chips">
            {children.map((c) => (
              <Link key={c.id} href={`/catalog/${c.slug}`} className={`chip${c.slug === slug ? ' is-on' : ''}`}>
                {nameOf(c, lang)}
              </Link>
            ))}
          </div>
        ) : null}

        <div className="catalog-layout">
          <aside>
            <FilterToggle lang={lang} count={activeFilters}>
              {filters}
            </FilterToggle>
          </aside>
          <div>
            <div className="toolbar">
              <span className="count">
                <SlidersHorizontal size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                {t(lang, 'catalog.found', { n: page.total })}
              </span>
              <SortSelect lang={lang} value={q.sort ?? 'popular'} />
            </div>
            {page.items.length ? (
              <div className="grid">
                {page.items.map((p) => (
                  <ProductTile key={p.id} p={p} />
                ))}
              </div>
            ) : (
              <div className="empty">
                <span className="empty-ic">
                  <SearchX size={40} strokeWidth={1.6} />
                </span>
                <h2>{t(lang, 'catalog.empty')}</h2>
                <p>{t(lang, 'catalog.emptyHint')}</p>
                <Link href={base} className="btn btn-secondary">
                  {t(lang, 'catalog.reset')}
                </Link>
              </div>
            )}
            <Pager page={page.page} totalPages={page.total_pages} href={(n) => hrefWith(base, q, { page: n })} />
          </div>
        </div>
      </div>
    </div>
  );
}
