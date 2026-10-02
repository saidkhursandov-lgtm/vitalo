import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DevLogin } from '../pages/DevLogin';
import { api, ApiError, errorText, hasToken, setToken, setUnauthorizedHandler } from './api';

export type Permission =
  | 'dashboard.view'
  | 'orders.view'
  | 'orders.payment'
  | 'orders.fulfil'
  | 'orders.deliver'
  | 'orders.cancel'
  | 'orders.edit'
  | 'products.view'
  | 'products.edit'
  | 'inventory.view'
  | 'inventory.edit'
  | 'customers.view'
  | 'customers.block'
  | 'settings.manage'
  | 'staff.manage'
  | 'audit.view';

export interface Me {
  staff: { id: string; name: string; role: 'admin' | 'manager' | 'warehouse' | 'marketer' };
  permissions: Permission[];
}

interface Session extends Me {
  can: (p: Permission) => boolean;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside StaffAuthProvider');
  return s;
}

type State = { status: 'loading' } | { status: 'ready'; me: Me } | { status: 'dev-login' } | { status: 'outside' } | { status: 'error'; message: string };

const telegramInitData = () => window.Telegram?.WebApp?.initData || '';

/**
 * Staff sign-in: Telegram initData of the same bot (validated on the server) + the Telegram id must be an
 * active employee in staff_users. In a normal browser in dev mode a test employee can be chosen.
 */
export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [state, setState] = useState<State>({ status: 'loading' });
  const ready = useRef(false);

  const signIn = useCallback(async (initData: string) => {
    const res = await api<{ token: string } & Me>('/staff/auth/telegram', { method: 'POST', body: { initData } });
    setToken(res.token);
    ready.current = true;
    setState({ status: 'ready', me: { staff: res.staff, permissions: res.permissions } });
  }, []);

  const start = useCallback(async () => {
    ready.current = false;
    setState({ status: 'loading' });
    try {
      const initData = telegramInitData();
      if (initData) return await signIn(initData);
      if (hasToken()) {
        try {
          const me = await api<Me>('/staff/auth/me');
          ready.current = true;
          return setState({ status: 'ready', me });
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) throw e;
        }
      }
      setState({ status: import.meta.env.DEV ? 'dev-login' : 'outside' });
    } catch (e) {
      setState({ status: 'error', message: errorText(e) });
    }
  }, [signIn]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!ready.current) return;
      client.clear();
      void start();
    });
    void start();
  }, [start, client]);

  const logout = useCallback(async () => {
    await api('/staff/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null);
    client.clear();
    ready.current = false;
    setState({ status: import.meta.env.DEV ? 'dev-login' : 'outside' });
  }, [client]);

  if (state.status === 'ready') {
    const value: Session = { ...state.me, can: (p) => state.me.permissions.includes(p), logout };
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }
  if (state.status === 'dev-login') return <DevLogin onLogin={signIn} />;
  if (state.status === 'outside') return <div className="center-screen">Откройте админ-панель через Telegram-бота VITALO.</div>;
  if (state.status === 'error')
    return (
      <div className="center-screen">
        <p>{state.message}</p>
        <button className="btn" onClick={() => void start()}>
          Повторить
        </button>
      </div>
    );
  return <div className="center-screen muted">Загрузка…</div>;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready(): void; expand(): void } };
  }
}
