import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './components/GlobalSearch';

function Where() {
  const l = useLocation();
  return <p>{`at ${l.pathname}${l.search}`}</p>;
}

describe('global search (аудит 2.10)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('Ctrl+K opens it; hits are grouped; Enter opens the first one', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify({ orders: [{ id: 'o1', title: 'VT-1001', subtitle: 'Mini App · Ана', to: '/orders/o1' }], products: [{ id: 'p1', title: 'Омега', subtitle: 'OZN-A022', to: '/products/p1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/']}>
          <GlobalSearch hotkey />
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByLabelText('Что искать');
    fireEvent.change(input, { target: { value: 'OZN' } });
    expect(await screen.findByText('Омега')).toBeTruthy();
    expect(screen.getByText('Заказы')).toBeTruthy();
    expect(screen.getByText('Товары')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/staff/search?q=OZN');
    await act(async () => {
      fireEvent.submit(input.closest('form')!);
    });
    expect(screen.getByText('at /orders/o1')).toBeTruthy();
    expect(screen.queryByLabelText('Что искать')).toBeNull();
  });
});
