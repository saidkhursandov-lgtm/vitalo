import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalChips, SignalList } from './components/PurchaseSignals';
import { groupsFor } from './lib/nav';
import { AiAnalyst, AnswerText } from './pages/AiAnalyst';

const status = { settings: { enabled: true, model: 'claude-opus-5-5', monthly_budget_usd: 20 }, key_set: false, spent_month_usd: 1.5, models: [{ id: 'claude-opus-5-5', input: 4, output: 20 }] };
const base = { platform: 'other', title: null, observed_on: '2026-11-09', brand: 'NOW Foods', match_form: 'бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90, orders_count: null, bestseller_rank: null, note: null };
const product = { id: 'p1', sku: 'VTL-H001', name_ru: 'Магний' };
const preview = {
  id: 'f1',
  cost_usd: 0.012,
  unclear: ['цена в долларах: $12'],
  rows: [
    { ...base, index: 0, kind: 'competitor_price', sku: 'VTL-H001', seller: 'Fitvibe', price_uzs: 199_000, orders_count: 350, product, match: { status: 'match', reasons: [] }, problem: null },
    { ...base, index: 1, kind: 'competitor_price', sku: 'VTL-H001', seller: 'Другой', price_uzs: 150_000, pack_count: 60, product, match: { status: 'mismatch', reasons: ['в банке: 90 / 60'] }, problem: null },
    { ...base, index: 2, kind: 'orders', sku: null, platform: 'uzum', seller: 'Fitvibe', price_uzs: null, orders_count: 1200, product: null, match: null, problem: null },
    { ...base, index: 3, kind: 'competitor_price', sku: 'NOPE', seller: 'X', price_uzs: 100_000, product: null, match: null, problem: 'товар с артикулом NOPE не найден' },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«AI-аналитик» (D-57, узел 5)', () => {
  it('only the admin sees the menu item', () => {
    expect(groupsFor(['ai_analyst.use']).flatMap((g) => g.items.map((i) => i.label))).toEqual(['AI-аналитик']);
    expect(groupsFor(['settings.manage']).flatMap((g) => g.items.map((i) => i.label))).not.toContain('AI-аналитик');
  });

  it('no key: says where to put it; «Проверить» → preview with «1-в-1»; only good rows are ticked; «Сохранить» sends them', async () => {
    let saved: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/status')) return new Response(JSON.stringify(status), { status: 200 });
        if (url.endsWith('/feed') && init?.method === 'POST') return new Response(JSON.stringify(preview), { status: 200 });
        if (url.endsWith('/feed/f1/save')) {
          saved = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ id: 'f1', competitor_prices: 1, facts: 1 }), { status: 200 });
        }
        if (url.endsWith('/requests')) return new Response(JSON.stringify({ month: { requests: 0, cost_usd: 0 }, items: [] }), { status: 200 });
        return new Response('[]', { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AiAnalyst />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(/Нет ключа/);
    expect(screen.getByText(/Потрачено в этом месяце: \$1\.50 из \$20\.00/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Текст или таблица'), { target: { value: 'Fitvibe 199 000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await screen.findByText('Что понял Claude');
    expect(screen.getByText('цена в долларах: $12')).toBeTruthy();
    expect(screen.getByText('не тот товар')).toBeTruthy();
    expect(screen.getByText('товар с артикулом NOPE не найден')).toBeTruthy();
    const box = (i: number) => screen.getByLabelText(`Сохранить строку ${i}`) as HTMLInputElement;
    expect([box(1).checked, box(2).checked, box(3).checked, box(4).checked]).toEqual([true, false, true, false]);
    expect(box(4).disabled).toBe(true);
    fireEvent.click(box(2)); // the owner keeps «не тот товар» too
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить отмеченные (3)' }));
    await waitFor(() => expect(saved).not.toBeNull());
    expect((saved as { indexes: number[] }).indexes.sort()).toEqual([0, 1, 2]);
    await screen.findByText(/Сохранено: цен конкурентов 1, фактов в память 1/);
  });

  it('chat answer: **bold** becomes bold, HTML stays text', () => {
    const { container } = render(<AnswerText text={'**Сейчас** ничего. <b>x</b>'} />);
    expect(container.querySelector('strong')?.textContent).toBe('Сейчас');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('Сейчас ничего. <b>x</b>');
  });

  it('purchase signals: chips with titles and full sentences, no emoji', () => {
    const signals = [
      { kind: 'iherb_strong' as const, pct: 15.8, text: 'Сильная просадка на iHerb: −15.8% от средней за 30 дней (237 500 сум)' },
      { kind: 'local_urgent' as const, pct: -0.5, text: 'Срочно брать в Ташкенте: Fitvibe (Другое) — 199 000 сум, дешевле закупки на iHerb (200 000 сум)' },
    ];
    const { container } = render(
      <>
        <SignalChips signals={signals} />
        <SignalList signals={signals} />
      </>,
    );
    expect(screen.getByText('Сильная просадка на iHerb')).toBeTruthy();
    expect(screen.getByText(/дешевле закупки на iHerb/)).toBeTruthy();
    expect(container.querySelectorAll('svg.signal-icon')).toHaveLength(4);
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
