/** Notification and bot links are Mini App addresses; on the site some pages live elsewhere. */
export function sitePath(path: string | null): string | null {
  if (!path) return null;
  const order = /^\/orders\/([0-9a-f-]{36})(?:\/(?:pay|payme))?$/.exec(path);
  if (order) return `/order/${order[1]}`;
  const ret = /^\/orders\/([0-9a-f-]{36})\/return$/.exec(path);
  if (ret) return `/order/${ret[1]}/return`;
  if (path === '/orders') return '/account/orders';
  if (path === '/bonus') return '/account/bonus';
  if (path === '/favorites') return '/account/favorites';
  if (path === '/notifications') return '/account/notifications';
  if (path === '/profile/addresses') return '/account/addresses';
  const support = /^\/support(?:\/([0-9a-f-]{36}))?$/.exec(path);
  if (support) return support[1] ? `/account/support/${support[1]}` : '/account/support';
  if (/^\/(product|review|set|brand)\/[^/]+$/.test(path) || path === '/cart' || path === '/catalog') return path;
  return '/';
}

/**
 * Release 6.6: vitalo.uz used to be the Mini App. Its old addresses (in bot messages, bookmarks, search engines) now
 * lead to the matching site page. Returns the new path with query, or null when the address is a site page already.
 */
export function legacyRedirect(pathname: string, search: URLSearchParams): string | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/catalog/products') {
    const category = search.get('category');
    const rest = new URLSearchParams(search);
    rest.delete('category');
    const q = rest.toString();
    return (category ? `/catalog/${encodeURIComponent(category)}` : '/catalog') + (q ? `?${q}` : '');
  }
  if (p === '/profile') return '/account';
  if (/^\/profile\/addresses(\/[^/]+)?$/.test(p)) return '/account/addresses';
  if (/^\/campaign\/[^/]+$/.test(p)) return '/';
  if (/^\/orders(\/|$)/.test(p) || /^\/support(\/|$)/.test(p) || ['/bonus', '/favorites', '/notifications'].includes(p)) {
    return sitePath(p);
  }
  return null;
}

/**
 * The reverse of sitePath: a site page opened inside Telegram (old «Магазин» buttons pointed at vitalo.uz) moves to the
 * same screen of the Mini App on app.vitalo.uz. Unknown pages -> the Mini App home.
 */
export function miniAppPath(pathname: string, search = ''): string {
  const p = pathname.replace(/\/+$/, '') || '/';
  const id = '([0-9a-f-]{36})';
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^/order/${id}(/return)?$`).exec(p))) return `/orders/${m[1]}${m[2] ?? ''}`;
  if ((m = new RegExp(`^/account/support/${id}$`).exec(p))) return `/support/${m[1]}`;
  const account: Record<string, string> = {
    '/account': '/profile',
    '/account/orders': '/orders',
    '/account/bonus': '/bonus',
    '/account/favorites': '/favorites',
    '/account/notifications': '/notifications',
    '/account/support': '/support',
    '/account/addresses': '/profile/addresses',
  };
  if (account[p]) return account[p];
  if ((m = /^\/catalog\/([^/]+)$/.exec(p))) return `/catalog/products?category=${m[1]}`;
  if (/^\/(product|review|set|brand)\/[^/]+$/.test(p) || ['/', '/cart', '/catalog', '/search', '/checkout'].includes(p)) return p + search;
  return '/';
}
