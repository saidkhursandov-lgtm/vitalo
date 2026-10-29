import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from './api';
import type { Lang } from './types';
import { applyCart, rememberWarnings } from './cart-cache';
import type { Address, BankTransfer, Cart, CartCount, CategoryTrees, CheckoutDefaults, DeliveryEta, FreeShipping, LegalDocument, LegalStatus, Order, OrderListItem, Page, ProductCard, ProductListItem, Region, ShopBanner, ShopInfo } from './types';

export type Sort = 'popular' | 'price_asc' | 'price_desc' | 'new';

export interface ProductFilters {
  category?: string;
  brand?: string[];
  form?: string[];
  price_min?: number;
  price_max?: number;
  in_stock?: boolean;
  sort?: Sort;
}

export interface CityRef {
  region_id: string;
  city_id: string;
}

const nextPage = <T,>(last: Page<T>) => (last.page < last.total_pages ? last.page + 1 : undefined);

// ---------- catalog (public) ----------

export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api<CategoryTrees>('/catalog/categories'), staleTime: 300_000 });
export const useBrands = () => useQuery({ queryKey: ['brands'], queryFn: () => api<{ brand: string }[]>('/catalog/brands'), staleTime: 300_000 });
export const useForms = () => useQuery({ queryKey: ['forms'], queryFn: () => api<{ form: string }[]>('/catalog/forms'), staleTime: 300_000 });
export const useRegions = () => useQuery({ queryKey: ['regions'], queryFn: () => api<Region[]>('/delivery/regions'), staleTime: 300_000 });

export function useProducts(filters: ProductFilters) {
  return useInfiniteQuery({
    queryKey: ['products', filters],
    queryFn: ({ pageParam }) => api<Page<ProductListItem>>(`/catalog/products${qs({ ...filters, page: pageParam })}`),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export function useSearch(q: string) {
  return useInfiniteQuery({
    queryKey: ['search', q],
    queryFn: ({ pageParam }) => api<Page<ProductListItem>>(`/catalog/search${qs({ q, page: pageParam })}`),
    initialPageParam: 1,
    getNextPageParam: nextPage,
    enabled: q.trim().length >= 2,
  });
}

/** How many products match the filters (live number on the "Показать N товаров" button). */
export function useProductsCount(filters: ProductFilters) {
  return useQuery({
    queryKey: ['products-count', filters],
    queryFn: async () => (await api<{ total: number }>(`/catalog/products/count${qs({ ...filters, sort: undefined })}`)).total,
    placeholderData: (prev) => prev,
  });
}

/** Texts edited in the admin panel (product disclaimer). */
export const useShopTexts = () => useQuery({ queryKey: ['shop-texts'], queryFn: () => api<ShopInfo>('/catalog/texts'), staleTime: 300_000 });

/** Delivery term for one city (null when there is no tariff). */
export const useDeliveryEta = (city: CityRef | null) =>
  useQuery({
    queryKey: ['eta', city],
    queryFn: () => api<DeliveryEta | null>(`/delivery/eta?region_id=${city!.region_id}&city_id=${city!.city_id}`),
    enabled: !!city,
    staleTime: 300_000,
  });

export const useLegalStatus = () => useQuery({ queryKey: ['legal-status'], queryFn: () => api<LegalStatus>('/legal/status'), staleTime: Infinity });
export const useLegalDocuments = () => useQuery({ queryKey: ['legal-docs'], queryFn: () => api<LegalDocument[]>('/legal/documents'), staleTime: 600_000 });

export const useProduct = (id: string) => useQuery({ queryKey: ['product', id], queryFn: () => api<ProductCard>(`/catalog/products/${id}`) });

// ---------- cart ----------

export function useCart(city?: CityRef | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['cart', city ?? null],
    queryFn: async () => {
      const cart = await api<Cart>(`/cart${qs({ ...city })}`);
      rememberWarnings(client, cart.warnings); // shown on the cart screen even if another screen loaded the cart first
      return cart;
    },
  });
}

/** Home slide: the free-delivery threshold (from the tariff) and the first-order offer for this customer. */
export const useFreeShipping = () => useQuery({ queryKey: ['free-shipping'], queryFn: () => api<FreeShipping>('/delivery/free-shipping'), staleTime: 60_000 });
/** Banners in the admin order; an empty list = no banner block on the home screen. */
export const useBanners = (lang: Lang) =>
  useQuery({ queryKey: ['banners', lang], queryFn: () => api<ShopBanner[]>(`/catalog/banners?lang=${lang}`), staleTime: 60_000 });

/** Badge in the top bar and the floating cart bar. Uses the read-only counter so it never "eats" the cart warnings. */
export function useCartCount() {
  return useQuery({ queryKey: ['cart', 'count'], queryFn: () => api<CartCount>('/cart/count') });
}

/** Every cart mutation returns the fresh cart; we store it and refresh views that depend on a city. */
export function useCartActions() {
  const client = useQueryClient();
  const done = (cart: Cart) => applyCart(client, cart);
  return {
    add: useMutation({
      mutationFn: (v: { product_id: string; qty: number }) => api<Cart>('/cart/items', { method: 'POST', body: v }),
      onSuccess: done,
    }),
    setQty: useMutation({
      mutationFn: (v: { product_id: string; qty: number }) => api<Cart>(`/cart/items/${v.product_id}`, { method: 'PATCH', body: { qty: v.qty } }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (productId: string) => api<Cart>(`/cart/items/${productId}`, { method: 'DELETE' }),
      onSuccess: done,
    }),
  };
}

// ---------- favorites ----------

export function useFavoriteIds() {
  return useQuery({ queryKey: ['favorites', 'ids'], queryFn: async () => new Set(await api<string[]>('/favorites/ids')) });
}

export const useFavorites = () => useQuery({ queryKey: ['favorites', 'list'], queryFn: () => api<ProductListItem[]>('/favorites') });

/** Optimistic heart toggle: the icon flips at once and rolls back if the request fails. */
export function useToggleFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api<void>(`/favorites/${id}`, { method: on ? 'PUT' : 'DELETE' }),
    onMutate: async ({ id, on }) => {
      await client.cancelQueries({ queryKey: ['favorites', 'ids'] });
      const prev = client.getQueryData<Set<string>>(['favorites', 'ids']);
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      client.setQueryData(['favorites', 'ids'], next);
      return { prev };
    },
    onError: (_e, _v, ctx) => client.setQueryData(['favorites', 'ids'], ctx?.prev),
    onSettled: () => client.invalidateQueries({ queryKey: ['favorites'] }),
  });
}

// ---------- addresses ----------

export const useAddresses = () => useQuery({ queryKey: ['addresses'], queryFn: () => api<Address[]>('/addresses') });

export interface AddressInput extends CityRef {
  label?: string;
  address_text: string;
  is_primary?: boolean;
}

export function useAddressActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['addresses'] });
  return {
    create: useMutation({ mutationFn: (v: AddressInput) => api<Address>('/addresses', { method: 'POST', body: v }), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, ...v }: AddressInput & { id: string }) => api<Address>(`/addresses/${id}`, { method: 'PATCH', body: v }),
      onSuccess: refresh,
    }),
    makePrimary: useMutation({ mutationFn: (id: string) => api<Address[]>(`/addresses/${id}/primary`, { method: 'POST' }), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api<Address[]>(`/addresses/${id}`, { method: 'DELETE' }), onSuccess: refresh }),
  };
}

// ---------- orders ----------

export const useCheckoutDefaults = () =>
  useQuery({ queryKey: ['checkout-defaults'], queryFn: () => api<CheckoutDefaults | null>('/orders/checkout-defaults') });

export function useOrders() {
  return useInfiniteQuery({
    queryKey: ['orders'],
    queryFn: ({ pageParam }) => api<Page<OrderListItem>>(`/orders${qs({ page: pageParam })}`),
    initialPageParam: 1,
    getNextPageParam: nextPage,
  });
}

export const useOrder = (id: string) => useQuery({ queryKey: ['order', id], queryFn: () => api<Order>(`/orders/${id}`) });

export const useBankTransfer = (id: string) =>
  useQuery({ queryKey: ['order', id, 'bank-transfer'], queryFn: () => api<BankTransfer>(`/orders/${id}/payment/bank-transfer`) });
