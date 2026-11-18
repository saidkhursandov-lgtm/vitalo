import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { setToken } from './lib/api';
import { AuthProvider } from './lib/auth';
import { productPath } from './lib/format';
import { formatUzPhone } from './screens/Login';

const user = { id: 'u1', telegram_user_id: 1, first_name: 'Азиз', last_name: null, username: null, phone: '+998901112233', language: 'ru', marketing_opt_in: false };

let calls: { url: string; method: string; body: unknown }[];
function mockApi(over: Record<string, (body: unknown) => Response> = {}) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method: init.method ?? 'GET', body });
    const path = new URL(url, 'http://x').pathname.replace(/^\/api/, '');
    if (over[path]) return over[path](body);
    if (path === '/legal/status') return Response.json({ accepted: false, documents: [] });
    if (path.startsWith('/catalog/products')) return Response.json({ items: [], total: 0, page: 1, page_size: 20 });
    if (path.startsWith('/catalog/categories')) return Response.json({ trees: [] });
    if (path === '/cart' || path.startsWith('/cart/') || path.startsWith('/favorites') || path === '/auth/me') return new Response('{}', { status: 401 });
    return Response.json([]);
  });
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  setToken(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('release 6: the website (the Mini App in a browser)', () => {
  it('formats the phone as it is typed and links products by slug', () => {
    expect(formatUzPhone('901112233')).toBe('+998 90 111 22 33');
    expect(formatUzPhone('+998 (90) 111-22-33 44')).toBe('+998 90 111 22 33');
    expect(productPath({ id: 'a1', slug: 'magniy-b6' })).toBe('/product/magniy-b6');
    expect(productPath({ id: 'a1', slug: null })).toBe('/product/a1');
  });

  it('a guest opens the shop without signing in; the cart shows the login form instead', async () => {
    mockApi();
    renderAt('/cart');
    expect(await screen.findByRole('heading', { name: 'Чтобы продолжить, войдите в VITALO' })).toBeTruthy();
    // nothing personal was asked for a guest
    expect(calls.some((c) => c.url.includes('/cart') || c.url.includes('/favorites') || c.url.includes('/legal/status'))).toBe(false);
  });

  it('signs in by phone with the code from the bot and keeps the session for the next visit', async () => {
    mockApi({
      '/auth/web/phone/start': () => Response.json({ request_id: 'r1', poll_token: 'p1', expires_at: new Date(Date.now() + 300_000).toISOString() }),
      '/auth/web/phone/verify': (b) =>
        (b as { code: string }).code === '123456'
          ? Response.json({ token: 'tok-1', expires_at: '2027-01-01T00:00:00Z', user })
          : Response.json({ code: 'BAD_CODE', attempts_left: 4 }, { status: 400 }),
    });
    renderAt('/login');
    fireEvent.click(await screen.findByRole('tab', { name: /Номер телефона/ }));
    fireEvent.change(screen.getByLabelText('Номер телефона'), { target: { value: '90 111 22 33' } });
    fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    expect(calls.find((c) => c.url.endsWith('/auth/web/phone/start'))?.body).toEqual({ phone: '+998 90 111 22 33' });

    const code = await screen.findByLabelText('Код из Telegram');
    fireEvent.change(code, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Неверный код. Осталось попыток: 4')).toBeTruthy();

    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(localStorage.getItem('vitalo.token')).toBe('tok-1'));
    // signed in: the documents step comes next (as in Telegram)
    await waitFor(() => expect(calls.some((c) => c.url.includes('/legal/status'))).toBe(true));
  });

  it('«Войти через Telegram» opens the bot and signs in once the bot confirms', async () => {
    let approved = false;
    const win = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    mockApi({
      '/auth/web/telegram/start': () =>
        Response.json({ request_id: 'r2', poll_token: 'p2', bot_url: 'https://t.me/vitalo_store_bot?start=login_' + 'a'.repeat(32), expires_at: new Date(Date.now() + 300_000).toISOString() }),
      '/auth/web/poll': () => Response.json(approved ? { status: 'approved', token: 'tok-2', expires_at: '2027-01-01T00:00:00Z', user } : { status: 'pending' }),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt('/login');
      fireEvent.click(await screen.findByRole('button', { name: 'Войти через Telegram' }));
      expect(await screen.findByText('Ждём подтверждения в Telegram…')).toBeTruthy();
      expect(win.location.href).toMatch(/^https:\/\/t\.me\/vitalo_store_bot\?start=login_/);
      await vi.advanceTimersByTimeAsync(2100);
      expect(calls.filter((c) => c.url.endsWith('/auth/web/poll'))).toHaveLength(1);
      approved = true;
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() => expect(localStorage.getItem('vitalo.token')).toBe('tok-2'));
    } finally {
      vi.useRealTimers();
    }
  });
});
