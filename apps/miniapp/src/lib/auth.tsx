import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, hasToken, setToken, setUnauthorizedHandler } from './api';
import { I18nProvider, translate } from './i18n';
import { startParam, telegram } from './telegram';
import type { Lang, UserProfile } from './types';
import { Logo } from '../components/Logo';

type State = { status: 'loading' } | { status: 'ready'; user: UserProfile } | { status: 'guest' } | { status: 'error' };

/** What a sign-in from the website gives (POST /auth/web/poll, /auth/web/phone/verify). */
export interface WebSession {
  token: string;
  user: UserProfile;
}

interface Session {
  user: UserProfile | null;
  /** Inside Telegram (initData) — the Mini App; outside — the website vitalo.uz (release 6). */
  inTelegram: boolean;
  signIn: (s: WebSession) => void;
  loginWithInitData: (initData: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** A guest pressed something that needs an account: the login screen, then back here. */
  requireLogin: () => void;
}

const SessionContext = createContext<Session | null>(null);
const RefreshUserContext = createContext<() => Promise<void>>(async () => undefined);

/** Reloads the profile (e.g. after the welcome screen changed marketing_opt_in). */
export const useRefreshUser = () => useContext(RefreshUserContext);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside <AuthProvider>');
  return s;
}

/**
 * True when there is a signed-in customer. Screens rendered without <AuthProvider> (unit tests) count as signed in:
 * the queries that need a session run as before.
 */
export function useAuthed(): boolean {
  const s = useContext(SessionContext);
  return s ? s.user !== null : true;
}

/** «Выйти» on the website; null inside Telegram (Telegram signs in by itself) and without <AuthProvider>. */
export function useSignOut(): (() => Promise<void>) | null {
  const s = useContext(SessionContext);
  return s && !s.inTelegram && s.user ? s.signOut : null;
}

export function useUser(): UserProfile {
  const user = useContext(SessionContext)?.user;
  if (!user) throw new Error('useUser outside a signed-in app');
  return user;
}

const noop = () => undefined;
/** Sends a guest to the login screen and back here afterwards (does nothing without <AuthProvider>, e.g. in unit tests). */
export function useLoginGate(): () => void {
  return useContext(SessionContext)?.requireLogin ?? noop;
}

export const loginPath = (next: string) => (next && next !== '/' && !next.startsWith('/login') ? `/login?next=${encodeURIComponent(next)}` : '/login');

const LANG_KEY = 'vitalo.lang';

function initialLang(): Lang {
  let code: string | null | undefined = telegram()?.initDataUnsafe.user?.language_code;
  if (!code) {
    try {
      code = localStorage.getItem(LANG_KEY);
    } catch {
      /* storage blocked */
    }
  }
  code ??= navigator.language;
  return code?.toLowerCase().startsWith('uz') ? 'uz' : 'ru';
}

/**
 * Signs the customer in before anything else renders:
 * - inside Telegram: sends Telegram.WebApp.initData to the API (validated on the server);
 * - in a normal browser (the website, release 6): a saved session if there is one, else a guest. Guests browse the
 *   catalog; the cart, checkout, orders and the profile ask to sign in (<RequireLogin>, screen «Вход»).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [lang, setLangState] = useState<Lang>(initialLang);
  const mode = useRef<'loading' | 'ready' | 'guest'>('loading');
  const here = useRef('/');
  here.current = location.pathname + location.search;
  // useNavigate() changes with every page in <BrowserRouter>: a ref keeps start() from running again on navigation
  const nav = useRef(navigate);
  nav.current = navigate;
  const inTelegram = telegram() !== null;

  const signedIn = useCallback((user: UserProfile) => {
    setLangState(user.language);
    mode.current = 'ready';
    setState({ status: 'ready', user });
  }, []);

  const toGuest = useCallback(() => {
    mode.current = 'guest';
    setState({ status: 'guest' });
  }, []);

  const loginWithInitData = useCallback(
    async (initData: string) => {
      const res = await api<{ token: string; user: UserProfile }>('/auth/telegram', { method: 'POST', body: { initData, start_param: startParam() } });
      setToken(res.token);
      signedIn(res.user);
    },
    [signedIn],
  );

  const signIn = useCallback(
    (s: WebSession) => {
      setToken(s.token, true);
      signedIn(s.user);
      // what a guest saw (catalog) stays; everything personal loads now
      void queryClient.invalidateQueries();
    },
    [signedIn, queryClient],
  );

  const start = useCallback(async () => {
    mode.current = 'loading';
    setState({ status: 'loading' });
    try {
      const tg = telegram();
      if (tg) return await loginWithInitData(tg.initData);
      if (hasToken()) {
        try {
          return signedIn(await api<UserProfile>('/auth/me'));
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) throw e;
          setToken(null);
        }
      }
      toGuest();
    } catch {
      setState({ status: 'error' });
    }
  }, [loginWithInitData, signedIn, toGuest]);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    setToken(null);
    queryClient.clear();
    toGuest();
    nav.current('/', { replace: true });
  }, [queryClient, toGuest]);

  const requireLogin = useCallback(() => {
    if (!here.current.startsWith('/login')) nav.current(loginPath(here.current));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Session expired or revoked while using the app: sign in again from scratch.
      if (mode.current === 'ready') {
        queryClient.clear();
        void start();
      } else if (mode.current === 'guest') {
        // a guest pressed something that needs an account (add to cart, favourites…)
        requireLogin();
      }
    });
    void start();
  }, [start, queryClient, requireLogin]);

  const refreshUser = useCallback(async () => {
    signedIn(await api<UserProfile>('/auth/me'));
  }, [signedIn]);

  const setLang = useCallback(
    (next: Lang) => {
      setLangState(next);
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        /* storage blocked */
      }
      if (state.status === 'ready') {
        void api<UserProfile>('/auth/me', { method: 'PATCH', body: { language: next } }).then(signedIn).catch(() => undefined);
      }
    },
    [state.status, signedIn],
  );

  const user = state.status === 'ready' ? state.user : null;
  const session = useMemo<Session>(() => ({ user, inTelegram, signIn, loginWithInitData, signOut, requireLogin }), [user, inTelegram, signIn, loginWithInitData, signOut, requireLogin]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  let content: ReactNode;
  if (state.status === 'ready' || state.status === 'guest')
    content = (
      <SessionContext.Provider value={session}>
        <RefreshUserContext.Provider value={refreshUser}>{children}</RefreshUserContext.Provider>
      </SessionContext.Provider>
    );
  else if (state.status === 'error')
    content = (
      <div className="screen-center">
        <Logo size="lg" />
        <p>{translate(lang, 'auth.loginFailed')}</p>
        <button className="btn" onClick={() => void start()}>
          {translate(lang, 'common.retry')}
        </button>
      </div>
    );
  else
    content = (
      <div className="screen-center" role="status" aria-busy="true" aria-label={translate(lang, 'common.loading')}>
        <Logo size="lg" />
        <span className="skel" style={{ width: 120, height: 6, borderRadius: 3 }} />
      </div>
    );

  return (
    <I18nProvider lang={lang} setLang={setLang}>
      {content}
    </I18nProvider>
  );
}
