import type { BrandCard, BrandPage, CategoryTrees, Lang, Page, ProductCard, ProductListItem, ShopBanner, ShopBundle } from './types';

/** On the server the site asks the API directly (127.0.0.1); the browser goes through /api. */
const API = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

export class NotFound extends Error {}

/**
 * GET from the public catalog API. Pages are rebuilt at most every `revalidate` seconds, so a price change shows within
 * a minute and the API is not asked on every visit.
 */
export async function apiGet<T>(path: string, revalidate = 60): Promise<T> {
  const res = await fetch(`${API}/api${path}`, { next: { revalidate }, headers: { accept: 'application/json' } });
  if (res.status === 404 || res.status === 400) throw new NotFound(path);
  if (!res.ok) throw new Error(`API ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The same as apiGet, but null instead of an error (a block of the home page must not break the page). */
export async function apiTry<T>(path: string, revalidate = 60): Promise<T | null> {
  try {
    return await apiGet<T>(path, revalidate);
  } catch {
    return null;
  }
}

export type Sort = 'popular' | 'price_asc' | 'price_desc' | 'new';
export interface CatalogQuery {
  category?: string;
  brand?: string[];
  form?: string[];
  price_min?: number;
  price_max?: number;
  in_stock?: boolean;
  sort?: Sort;
  page?: number;
}

export function qs(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) u.set(k, v.join(','));
    } else u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const catalog = {
  home: () => apiTry<{ popular: ProductListItem[]; fresh: ProductListItem[] }>('/catalog/home'),
  categories: () => apiGet<CategoryTrees>('/catalog/categories', 300),
  brands: () => apiTry<BrandCard[]>('/catalog/brands/showcase', 300),
  brand: (slug: string) => apiGet<BrandPage>(`/catalog/brands/${encodeURIComponent(slug)}`, 300),
  banners: (lang: Lang) => apiTry<ShopBanner[]>(`/catalog/banners?lang=${lang}`),
  bundles: () => apiTry<ShopBundle[]>('/catalog/bundles'),
  bundle: (slug: string) => apiGet<ShopBundle>(`/catalog/bundles/${encodeURIComponent(slug)}`),
  forms: () => apiTry<{ form: string }[]>('/catalog/forms', 300),
  products: (q: CatalogQuery) => apiGet<Page<ProductListItem>>(`/catalog/products${qs({ ...q })}`),
  search: (q: string, page = 1) => apiGet<Page<ProductListItem>>(`/catalog/search${qs({ q, page })}`, 30),
  product: (slug: string) => apiGet<ProductCard>(`/catalog/products/${encodeURIComponent(slug)}`),
};
