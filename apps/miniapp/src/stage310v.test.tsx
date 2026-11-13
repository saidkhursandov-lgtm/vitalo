import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './lib/i18n';
import type { Lang, OrderReturns } from './lib/types';
import { ReturnScreen } from './screens/Return';

const plain = (s: string | null | undefined) => (s ?? '').replace(/[  ]/g, ' ');

const base = (over: Partial<OrderReturns> = {}): OrderReturns => ({
  order_id: 'o1',
  order_number: 'VTL-20261110-0001',
  deadline: '2026-11-24T10:00:00.000Z',
  days: 14,
  can_request: true,
  blocked: null,
  reasons: ['damaged', 'wrong_item'],
  lines: [{ order_item_id: 'i1', name_ru: 'Магний B6', name_uz: 'Magniy B6', image: null, qty: 2, max_qty: 2, unit_paid_uzs: 100_000 }],
  returns: [],
  ...over,
});

let data = base();
let posted: FormData | null = null;
beforeEach(() => {
  data = base();
  posted = null;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/returns/order/')) return new Response(JSON.stringify(data));
    if (url.endsWith('/returns') && init?.method === 'POST') {
      posted = init.body as FormData;
      return new Response(JSON.stringify({ id: 'r1', status: 'requested' }), { status: 201 });
    }
    return new Response(JSON.stringify({}));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/orders/o1/return']}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <Routes>
            <Route path="/orders/:id/return" element={<ReturnScreen />} />
            <Route path="/orders/:id" element={<p>order page</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('3.10-В «Вернуть товар» in the Mini App', () => {
  it('the jars, only «повреждён» / «не тот товар», a photo required; sends multipart and goes back to the order', async () => {
    show('ru');
    const send = (await screen.findByRole('button', { name: 'Отправить заявку' })) as HTMLButtonElement;
    expect(screen.queryByText('Передумал')).toBeNull();
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Товар повреждён' }));
    expect(plain(screen.getByText(/К возврату около/).textContent)).toContain('200 000');
    expect(send.disabled).toBe(true); // no photo yet
    const file = new File(['x'], 'jar.jpg', { type: 'image/jpeg' });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:1', revokeObjectURL: () => undefined }));
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.get('reason')).toBe('damaged');
    expect(JSON.parse(String(posted!.get('items')))).toEqual([{ order_item_id: 'i1', qty: 2 }]);
    expect(posted!.getAll('photos')).toHaveLength(1);
    expect(await screen.findByText('order page')).toBeTruthy();
  });

  it('after 14 days: the reason instead of the form (UZ)', async () => {
    data = base({ can_request: false, blocked: 'RETURN_TOO_LATE' });
    show('uz');
    expect(await screen.findByText(/14 kun ichida yuborish mumkin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Arizani yuborish' })).toBeNull();
  });
});
