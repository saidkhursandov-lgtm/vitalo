import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DevLogin } from '../screens/DevLogin';
import { api, ApiError, hasToken, setToken, setUnauthorizedHandler } from './api';
import { I18nProvider, translate } from './i18n';
import { telegram } from './telegram';
import type { Lang, UserProfile } from './types';

type State =
  | { status: 'loading' }
  | { status: 'ready'; user: UserProfile }
  | { status: 'dev-login' }
  | { status: 'outside' }
  | { status: 'error' };

const UserContext = createContext<UserProfile | null>(null);

export function useUser(): UserProfile {
  const user = useContext(UserContext);
  if (!user) throw new Error('useUser outside a signed-in app');
  return user;
}

function initialLang(): Lang {
  const code = telegram()?.initDataUnsafe.user?.language_code ?? navigator.language;
  return code?.toLowerCase().startsWith('uz') ? 'uz' : 'ru';
}

/**
 * Signs the customer in before anything else renders:
 * - inside Telegram: sends Telegram.WebApp.initData to the API (validated on the server);
 * - in a normal browser in dev mode: shows <DevLogin>, which gets a test initData from the Vite dev server;
 * - in a normal browser in production: asks to open the shop from the bot.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [lang, setLangState] = useState<Lang>(initialLang);
  const ready = useRef(false);

  const signedIn = useCallback((user: UserProfile) => {
    setLangState(user.language);
    ready.current = true;
    setState({ status: 'ready', user });
  }, []);

  const login = useCallback(
    async (initData: string) => {
      const res = await api<{ token: string; user: UserProfile }>('/auth/telegram', { method: 'POST', body: { initData } });
      setToken(res.token);
      signedIn(res.user);
    },
    [signedIn],
  );

  const start = useCallback(async () => {
    ready.current = false;
    setState({ status: 'loading' });
    try {
      const tg = telegram();
      if (tg) return await login(tg.initData);
      if (hasToken()) {
        try {
          return signedIn(await api<UserProfile>('/auth/me'));
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) throw e;
          setToken(null);
        }
      }
      setState({ status: import.meta.env.DEV ? 'dev-login' : 'outside' });
    } catch {
      setState({ status: 'error' });
    }
  }, [login, signedIn]);

  useEffect(() => {
    // Session expired or revoked while using the app: sign in again from scratch.
    setUnauthorizedHandler(() => {
      if (!ready.current) return;
      queryClient.clear();
      void start();
    });
    void start();
  }, [start, queryClient]);

  const setLang = useCallback(
    (next: Lang) => {
      setLangState(next);
      if (state.status === 'ready') {
        void api<UserProfile>('/auth/me', { method: 'PATCH', body: { language: next } }).then(signedIn).catch(() => undefined);
      }
    },
    [state.status, signedIn],
  );

  let content: ReactNode;
  if (state.status === 'ready') content = <UserContext.Provider value={state.user}>{children}</UserContext.Provider>;
  else if (state.status === 'dev-login') content = <DevLogin onLogin={login} />;
  else if (state.status === 'outside') content = <div className="screen-center">{translate(lang, 'auth.outside')}</div>;
  else if (state.status === 'error')
    content = (
      <div className="screen-center">
        <p>{translate(lang, 'auth.loginFailed')}</p>
        <button className="btn" onClick={() => void start()}>
          {translate(lang, 'common.retry')}
        </button>
      </div>
    );
  else content = <div className="screen-center hint">{translate(lang, 'common.loading')}</div>;

  return (
    <I18nProvider lang={lang} setLang={setLang}>
      {content}
    </I18nProvider>
  );
}
