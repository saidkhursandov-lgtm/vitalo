import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebLogin, type TelegramWidgetUser } from './pages/WebLogin';

const me = { staff: { id: 's1', name: 'Саид', role: 'admin' }, permissions: ['staff.manage'] };
const USER: TelegramWidgetUser = { id: 7, first_name: 'Саид', auth_date: 1, hash: 'a'.repeat(64) };

type Reply = { status?: number; body: unknown };
let replies: Record<string, Reply[]>;
let calls: { url: string; init: RequestInit }[];

beforeEach(() => {
  calls = [];
  replies = { '/api/staff/auth/web/config': [{ body: { bot_username: 'vitalo_uz_bot' } }] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const list = replies[url] ?? [];
      const r = list.length > 1 ? list.shift()! : list[0];
      if (!r) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const show = (onLogin = vi.fn()) => {
  render(<WebLogin onLogin={onLogin} />);
  return onLogin;
};

describe('browser login (генплан, этап 3)', () => {
  it('draws the official Telegram widget for the bot from the server', async () => {
    show();
    await waitFor(() => expect(screen.getByTestId('telegram-login').querySelector('script')).toBeTruthy());
    const s = screen.getByTestId('telegram-login').querySelector('script')!;
    expect(s.getAttribute('src')).toBe('https://telegram.org/js/telegram-widget.js?22');
    expect(s.getAttribute('data-telegram-login')).toBe('vitalo_uz_bot');
    expect(s.getAttribute('data-onauth')).toBe('onVitaloTelegramAuth(user)');
  });

  it('known browser: signed in at once, with the admin header', async () => {
    replies['/api/staff/auth/web/login'] = [{ body: { status: 'approved', ...me } }];
    const onLogin = show();
    await waitFor(() => expect(window.onVitaloTelegramAuth).toBeTypeOf('function'));
    await act(async () => window.onVitaloTelegramAuth!(USER));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(me));
    const login = calls.find((c) => c.url === '/api/staff/auth/web/login')!;
    expect((login.init.headers as Record<string, string>)['x-vitalo-admin']).toBe('1');
    expect(JSON.parse(login.init.body as string)).toEqual(USER);
  });

  it('new browser: asks to confirm in the bot, waits, then signs in', async () => {
    replies['/api/staff/auth/web/login'] = [{ body: { status: 'pending', request_id: 'r1', poll_token: 'p1', expires_at: new Date(Date.now() + 180_000).toISOString() } }];
    replies['/api/staff/auth/web/poll'] = [{ body: { status: 'pending' } }, { body: { status: 'approved', ...me } }];
    const onLogin = show();
    await waitFor(() => expect(window.onVitaloTelegramAuth).toBeTypeOf('function'));
    await act(async () => window.onVitaloTelegramAuth!(USER));
    expect(await screen.findByText(/нажмите «Подтвердить»/)).toBeTruthy();
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(me), { timeout: 6000 });
    expect(calls.filter((c) => c.url === '/api/staff/auth/web/poll')).toHaveLength(2);
  }, 10_000);

  it('«Это не я» in the bot: back to the start with a message', async () => {
    replies['/api/staff/auth/web/login'] = [{ body: { status: 'pending', request_id: 'r1', poll_token: 'p1', expires_at: new Date(Date.now() + 180_000).toISOString() } }];
    replies['/api/staff/auth/web/poll'] = [{ body: { status: 'denied' } }];
    show();
    await waitFor(() => expect(window.onVitaloTelegramAuth).toBeTypeOf('function'));
    await act(async () => window.onVitaloTelegramAuth!(USER));
    expect(await screen.findByText(/Вход отклонён/, undefined, { timeout: 4000 })).toBeTruthy();
  });

  it('not an employee: a clear message', async () => {
    replies['/api/staff/auth/web/login'] = [{ status: 403, body: { code: 'NOT_STAFF' } }];
    show();
    await waitFor(() => expect(window.onVitaloTelegramAuth).toBeTypeOf('function'));
    await act(async () => window.onVitaloTelegramAuth!(USER));
    expect(await screen.findByText(/не сотрудник VITALO/)).toBeTruthy();
  });

  it('backup code: the owner enters without Telegram', async () => {
    replies['/api/staff/auth/web/backup-code'] = [{ body: me }];
    const onLogin = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Войти по резервному коду' }));
    const input = screen.getByLabelText('Резервный код');
    const enter = screen.getByRole('button', { name: 'Войти' }) as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'abcd-efgh-jkmn-pqrs' } });
    fireEvent.click(enter);
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(me));
  });
});

vi.mock('./lib/auth', async (orig) => ({
  ...(await orig<typeof import('./lib/auth')>()),
  useSession: () => ({ ...me, can: (p: string) => me.permissions.includes(p), logout: async () => undefined }),
}));
import { Devices } from './pages/Devices';

describe('«Мои устройства» (генплан, этап 3)', () => {
  it('lists sessions, marks this one, shows the backup codes once', async () => {
    replies['/api/staff/auth/sessions'] = [
      {
        body: [
          { id: 'a', kind: 'web', device_name: 'Chrome, Windows', ip: '1.2.3.4', created_at: '2026-11-08T10:00:00Z', last_seen_at: null, expires_at: '2026-12-08T10:00:00Z', current: true },
          { id: 'b', kind: 'telegram', device_name: 'Telegram', ip: null, created_at: '2026-11-07T10:00:00Z', last_seen_at: null, expires_at: '2026-11-07T22:00:00Z', current: false },
        ],
      },
    ];
    replies['/api/staff/auth/backup-codes'] = [{ body: { total: 0, left: 0, created_at: null } }, { body: { codes: ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'] } }, { body: { total: 2, left: 2 } }];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Devices />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Chrome, Windows')).toBeTruthy();
    expect(screen.getByText('Это устройство')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Выйти' })).toHaveLength(2);
    fireEvent.click(await screen.findByRole('button', { name: 'Создать коды' }));
    expect(await screen.findByText('AAAA-BBBB-CCCC-DDDD')).toBeTruthy();
    expect(screen.getByText(/больше они не покажутся/)).toBeTruthy();
  });
});
