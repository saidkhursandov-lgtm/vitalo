import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductReviewsBlock, RatingLine, TileRating } from './components/Reviews';
import { I18nProvider } from './lib/i18n';
import type { Lang, ProductReviews, ReviewableItem } from './lib/types';
import { ReviewScreen } from './screens/Review';

const plain = (s: string | null | undefined) => (s ?? '').replace(/[  ]/g, ' ');

const item = (over: Partial<ReviewableItem> = {}): ReviewableItem => ({
  order_id: 'o1',
  order_number: 'VTL-20261110-0001',
  delivered_at: '2026-11-10T10:00:00.000Z',
  product_id: 'p1',
  name_ru: 'Магний B6',
  name_uz: 'Magniy B6',
  image: null,
  review_status: null,
  ...over,
});

const reviews: ProductReviews = {
  summary: { avg: 4.7, count: 3, stars: [2, 1, 0, 0, 0] },
  items: [
    {
      id: 'r1',
      rating: 5,
      tags: ['effect'],
      text: 'Сплю лучше уже через неделю.',
      author: 'Саидкомол Х.',
      lang: 'ru',
      verified: true,
      published_at: '2026-11-12T10:00:00.000Z',
      photos: [],
      reply: { text: 'Спасибо за отзыв!', at: null },
    },
  ],
  page: 1,
  pages: 1,
};

let pending: ReviewableItem[] = [item()];
let posted: FormData | null = null;

beforeEach(() => {
  pending = [item()];
  posted = null;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/reviews/pending')) return new Response(JSON.stringify(pending));
    if (url.includes('/reviews/form')) return new Response(JSON.stringify({ bonus: { plain_uzs: 3000, photo_uzs: 5000 }, author_name: 'Саидкомол Х.', anonymous_name: 'Покупатель VITALO' }));
    if (url.endsWith('/reviews') && init?.method === 'POST') {
      posted = init.body as FormData;
      pending = [item({ review_status: 'pending' })];
      return new Response(JSON.stringify({ id: 'r1', status: 'pending' }), { status: 201 });
    }
    if (url.includes('/reviews')) return new Response(JSON.stringify(reviews));
    return new Response(JSON.stringify({}));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <Routes>
            <Route path="/review/:orderId" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('3.10-Б «Проверенные отзывы» in the Mini App', () => {
  it('the form: stars, tags, text from 10 signs, the signature; sends multipart and shows «На проверке»', async () => {
    show('ru', <ReviewScreen />, '/review/o1');
    expect(plain((await screen.findByText(/За опубликованный отзыв/)).textContent)).toContain('3 000');
    const send = screen.getByRole('button', { name: 'Отправить отзыв' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '5 из 5' }));
    fireEvent.click(screen.getByRole('button', { name: /Есть эффект/ }));
    fireEvent.change(screen.getByLabelText('Расскажите о товаре'), { target: { value: 'коротко' } });
    expect(send.disabled).toBe(true); // fewer than 10 signs
    fireEvent.change(screen.getByLabelText('Расскажите о товаре'), { target: { value: 'Сплю лучше уже через неделю.' } });
    expect(await screen.findByRole('radio', { name: 'Саидкомол Х.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Покупатель VITALO' }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.get('rating')).toBe('5');
    expect(posted!.get('tags')).toBe('effect');
    expect(posted!.get('show_name')).toBe('false');
    expect(posted!.get('order_id')).toBe('o1');
    expect(await screen.findByText('На проверке')).toBeTruthy();
    expect(screen.getByText('Все товары этого заказа оценены. Спасибо!')).toBeTruthy();
  });

  it('an order not delivered yet: nothing to rate', async () => {
    pending = [];
    show('uz', <ReviewScreen />, '/review/o1');
    expect(await screen.findByText('Mahsulotlarni buyurtma olingandan keyin baholash mumkin.')).toBeTruthy();
  });

  it('product card: «4,7 (3 отзыва)», the summary, the verified plaque and the specialist answer', async () => {
    show('ru', <><RatingLine rating={{ avg: 4.7, count: 3 }} /><ProductReviewsBlock productId="p1" /></>);
    expect(screen.getByRole('link', { name: 'Оценка 4,7 из 5, 3 отзыва' })).toBeTruthy();
    expect(await screen.findByText('Отзывы покупателей')).toBeTruthy();
    expect(screen.getByText('Покупка подтверждена VITALO')).toBeTruthy();
    expect(screen.getByText('Ответ специалиста VITALO')).toBeTruthy();
    expect(screen.getByText('Есть эффект')).toBeTruthy();
  });

  it('tiles: stars only from 3 reviews', () => {
    const { container, rerender } = show('ru', <TileRating rating={{ avg: 5, count: 2 }} />);
    expect(container.querySelector('.tile-rating')).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <I18nProvider lang="ru" setLang={() => undefined}>
            <TileRating rating={{ avg: 4.8, count: 18 }} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector('.tile-rating')?.textContent).toBe('4,8 (18)');
  });
});
