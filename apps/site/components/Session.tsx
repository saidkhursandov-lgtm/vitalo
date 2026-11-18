'use client';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { t as translate, LANG_COOKIE, type Key } from '@/lib/i18n';
import type { CartCount, Lang, UserProfile } from '@/lib/types';
import {
  addToGuestCart,
  api,
  ApiError,
  getToken,
  mergeGuestCart,
  readGuestCart,
  setGuestQty,
  setToken,
  setUnauthorizedHandler,
  writeGuestCart,
  type GuestLine,
  type WebSession,
} from '@/lib/client';

interface SessionValue {
  lang: Lang;
  t: (key: Key, params?: Record<string, string | number>) => string;
  setLang: (lang: Lang) => void;
  /** undefined while the saved token is being checked; null — a guest. */
  user: UserProfile | null | undefined;
  signIn: (s: WebSession) => Promise<void>;
  signOut: () => Promise<void>;
  cartCount: number;
  guestCart: GuestLine[];
  /** Adds to the account cart (signed in) or to the browser cart (guest). */
  addToCart: (productId: string, qty?: number) => Promise<void>;
  setGuestLine: (productId: string, qty: number) => void;
  refreshCart: () => Promise<void>;
  favorites: Set<string>;
  toggleFavorite: (productId: string) => Promise<boolean>;
  /** A short message at the bottom of the screen («Добавлено в корзину»). */
  toast: string | null;
  showToast: (text: string) => void;
  botUsername: string;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

export function SessionProvider({ lang, botUsername, children }: { lang: Lang; botUsername: string; children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null | undefined>(undefined);
  const [cartCount, setCartCount] = useState(0);
  const [guestCart, setGuestCart] = useState<GuestLine[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const t = useCallback((key: Key, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 2600);
  }, []);

  const refreshCart = useCallback(async () => {
    if (!getToken()) return;
    try {
      setCartCount((await api<CartCount>('/cart/count')).items_count);
    } catch {
      /* the badge simply stays */
    }
  }, []);

  const loadAccount = useCallback(async () => {
    const [count, favs] = await Promise.all([
      api<CartCount>('/cart/count').catch(() => null),
      api<string[]>('/favorites/ids').catch(() => [] as string[]),
    ]);
    if (count) setCartCount(count.items_count);
    setFavorites(new Set(favs));
  }, []);

  const dropSession = useCallback(() => {
    setToken(null);
    setUser(null);
    setCartCount(0);
    setFavorites(new Set());
  }, []);

  useEffect(() => {
    setGuestCart(readGuestCart());
    setUnauthorizedHandler(dropSession);
    if (!getToken()) {
      setUser(null);
      return;
    }
    // Only «not signed in» (401/403) ends the session; if the server is unreachable for a moment, the sign-in is kept
    // and checked again in 5 s — otherwise a short API restart would log every customer out.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const restore = () =>
      api<UserProfile>('/auth/me')
        .then((me) => {
          setUser(me);
          return loadAccount();
        })
        .catch((e) => {
          if (stopped) return;
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) dropSession();
          else timer = setTimeout(() => void restore(), 5_000);
        });
    void restore();
    return () => {
      stopped = true;
      clearTimeout(timer);
      setUnauthorizedHandler(null);
    };
  }, [dropSession, loadAccount]);

  const signIn = useCallback(
    async (s: WebSession) => {
      setToken(s.token);
      setUser(s.user);
      const moved = await mergeGuestCart();
      setGuestCart([]);
      await loadAccount();
      if (moved) router.refresh();
    },
    [loadAccount, router],
  );

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => null);
    dropSession();
    router.refresh();
  }, [dropSession, router]);

  const addToCart = useCallback(
    async (productId: string, qty = 1) => {
      if (getToken()) {
        await api('/cart/items', { method: 'POST', body: { product_id: productId, qty } });
        await refreshCart();
      } else {
        setGuestCart((cur) => {
          const next = addToGuestCart(cur, productId, qty);
          writeGuestCart(next);
          return next;
        });
      }
      showToast(translate(lang, 'tile.inCart'));
    },
    [lang, refreshCart, showToast],
  );

  const setGuestLine = useCallback((productId: string, qty: number) => {
    setGuestCart((cur) => {
      const next = setGuestQty(cur, productId, qty);
      writeGuestCart(next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback(
    async (productId: string) => {
      const on = !favorites.has(productId);
      setFavorites((cur) => {
        const n = new Set(cur);
        if (on) n.add(productId);
        else n.delete(productId);
        return n;
      });
      try {
        await api(`/favorites/${productId}`, { method: on ? 'PUT' : 'DELETE' });
      } catch {
        setFavorites((cur) => {
          const n = new Set(cur);
          if (on) n.delete(productId);
          else n.add(productId);
          return n;
        });
      }
      return on;
    },
    [favorites],
  );

  const setLang = useCallback(
    (next: Lang) => {
      document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    },
    [router],
  );

  const guestCount = guestCart.reduce((s, l) => s + l.qty, 0);

  const value = useMemo<SessionValue>(
    () => ({
      lang,
      t,
      setLang,
      user,
      signIn,
      signOut,
      cartCount: user ? cartCount : guestCount,
      guestCart,
      addToCart,
      setGuestLine,
      refreshCart,
      favorites,
      toggleFavorite,
      toast,
      showToast,
      botUsername,
    }),
    [lang, t, setLang, user, signIn, signOut, cartCount, guestCount, guestCart, addToCart, setGuestLine, refreshCart, favorites, toggleFavorite, toast, showToast, botUsername],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className={`toast${toast ? ' is-on' : ''}`} role="status" aria-live="polite">
        {toast}
      </div>
    </Ctx.Provider>
  );
}
