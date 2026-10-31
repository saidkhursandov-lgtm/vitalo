import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from './api';
import type { Lang } from './types';
import { applyCart, rememberWarnings } from './cart-cache';
import type { Address, BankTransfer, BrandCard, BrandPage, Cart, CartCount, CartUpsell, CategoryTrees, CheckoutDefaults, DeliveryEta, FreeShipping, CentreList, ActiveOrder, LegalDocument, LegalStatus, Order, OrderListItem, Page, ProductCard, ProductListItem, Region, ShopBanner, ShopInfo } from './types';

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
/** 2.2: «Проверенные бренды» — only brands with products in stock (the server decides). */
export const useBrandShowcase = () => useQuery({ queryKey: ['brands', 'showcase'], queryFn: () => api<BrandCard[]>('/catalog/brands/showcase'), staleTime: 300_000 });
export const useBrandPage = (slug: string) =>
  useQuery({ queryKey: ['brands', 'page', slug], queryFn: () => api<BrandPage>(`/catalog/brands/${encodeURIComponent(slug)}`), staleTime: 300_000 });
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

/**
 * 3.1: 2–3 products under «Добавьте ещё X сум — доставка бесплатна». Asked again when the cart total or the district
 * changes; an empty list = no strip (block off, threshold reached, free first order, not enough products).
 */
export const useUpsell = (city: CityRef | null, goodsTotal: number) =>
  useQuery({
    queryKey: ['upsell', city, goodsTotal],
    queryFn: () => api<CartUpsell>(`/cart/upsell${qs({ ...city })}`),
    enabled: !!city && goodsTotal > 0,
    placeholderData: (prev) => prev,
  });

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

/** 2.4: products the customer waits for («Сообщить о поступлении»). */
export function useWaitlistIds() {
  return useQuery({ queryKey: ['waitlist', 'ids'], queryFn: async () => new Set(await api<string[]>('/waitlist/ids')) });
}

/** Subscribes once; the button turns into «Вы в списке ожидания» right after the server answered. */
export function useSubscribeWaitlist() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ status: 'subscribed' | 'already' }>(`/waitlist/${id}`, { method: 'PUT' }),
    onSuccess: (_r, id) => client.setQueryData<Set<string>>(['waitlist', 'ids'], (prev) => new Set(prev).add(id)),
  });
}

/** 2.4 patch: the bell is a switch — the server marks the row «отменена», the bell goes back to empty. */
export function useUnsubscribeWaitlist() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ status: 'cancelled' | 'not_waiting' }>(`/waitlist/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) =>
      client.setQueryData<Set<string>>(['waitlist', 'ids'], (prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
  });
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

/** 3.2: the newest unfinished order for the plaque on the home screen. */
export const useActiveOrder = () => useQuery({ queryKey: ['orders', 'active'], queryFn: () => api<ActiveOrder>('/orders/active') });

/** 3.2: unread counter on the bell; refreshed every minute and when the app comes back to the screen. */
export const useUnreadCount = () =>
  useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api<{ unread: number }>('/notifications/unread'), refetchInterval: 60_000 });

/** 3.2: the notification centre in the current language (titles and lines come ready from the server). */
export const useNotifications = (lang: Lang) => useQuery({ queryKey: ['notifications', 'list', lang], queryFn: () => api<CentreList>(`/notifications${qs({ lang })}`) });

export function useNotificationActions() {
  const client = useQueryClient();
  const refresh = (r: { unread: number }) => {
    client.setQueryData(['notifications', 'unread'], { unread: r.unread });
    void client.invalidateQueries({ queryKey: ['notifications', 'list'] });
  };
  return {
    read: useMutation({ mutationFn: (id: string) => api<{ unread: number }>(`/notifications/${id}/read`, { method: 'POST', body: {} }), onSuccess: refresh }),
    readAll: useMutation({ mutationFn: () => api<{ marked: number; unread: number }>('/notifications/read-all', { method: 'POST', body: {} }), onSuccess: refresh }),
  };
}

export const useBankTransfer = (id: string) =>
  useQuery({ queryKey: ['order', id, 'bank-transfer'], queryFn: () => api<BankTransfer>(`/orders/${id}/payment/bank-transfer`) });

/**
 * 3.1: the delivery city chosen in the cart or at checkout, shared by both screens (and kept while the Mini App is
 * open), so the district picked in the cart is the one checkout uses. Starts as the primary saved address.
 */
export function useDeliveryCity(): [CityRef | null, (c: CityRef | null) => void] {
  const client = useQueryClient();
  const primary = useAddresses().data?.find((a) => a.is_primary);
  const chosen = useQuery({ queryKey: ['delivery-city'], queryFn: () => null as CityRef | null, enabled: false, initialData: null as CityRef | null, staleTime: Infinity, gcTime: Infinity }).data;
  const city = chosen ?? (primary ? { region_id: primary.region.id, city_id: primary.city.id } : null);
  return [city, (c) => client.setQueryData(['delivery-city'], c)];
}
