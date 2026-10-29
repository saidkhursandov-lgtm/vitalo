import type { QueryClient } from '@tanstack/react-query';
import type { Cart, CartCount, CartWarning } from './types';

/**
 * The API reports cart warnings (price changed, less in stock…) once. Whichever screen loads the cart
 * first, the warnings are kept here until the customer has seen them on the cart screen.
 */
export function rememberWarnings(client: QueryClient, warnings: CartWarning[], skip?: (w: CartWarning) => boolean) {
  const fresh = warnings.filter((w) => !skip?.(w));
  if (!fresh.length) return;
  client.setQueryData<CartWarning[]>(['cart-warnings'], (prev = []) => [
    ...prev.filter((p) => !fresh.some((f) => f.code === p.code && f.product_id === p.product_id)),
    ...fresh,
  ]);
}

/** A fresh cart from any mutation: store it, update the badge, refresh carts that carry a delivery city. */
export function applyCart(client: QueryClient, cart: Cart, skipWarning?: (w: CartWarning) => boolean) {
  rememberWarnings(client, cart.warnings, skipWarning);
  client.setQueryData(['cart', null], cart);
  client.setQueryData<CartCount>(['cart', 'count'], { items_count: cart.items_count, goods_total_uzs: cart.goods_total_uzs });
  void client.invalidateQueries({ queryKey: ['cart'], predicate: (q) => q.queryKey[1] !== null && q.queryKey[1] !== 'count' });
}
