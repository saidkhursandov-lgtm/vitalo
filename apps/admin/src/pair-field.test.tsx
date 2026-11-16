import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { PairField, pairOf } from './components/PairField';

describe('4.1 «Идеальная пара» в карточке товара админки', () => {
  it('режим из товара: выключено, вручную, сама', () => {
    expect(pairOf({ pair_off: true, pair_product: { id: 'x', sku: 'S', name_ru: 'N' } })).toEqual({ mode: 'off', product: null });
    expect(pairOf({ pair_product: { id: 'x', sku: 'S', name_ru: 'N' } })).toEqual({ mode: 'manual', product: { id: 'x', sku: 'S', name_ru: 'N' } });
    expect(pairOf(null)).toEqual({ mode: 'auto', product: null });
  });

  it('выбор «Не показывать» и показ выбранного товара', () => {
    const onChange = vi.fn();
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PairField productId="p1" value={{ mode: 'auto', product: null }} disabled={false} onChange={onChange} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Идеальная пара'), { target: { value: 'off' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'off', product: null });
    rerender(
      <QueryClientProvider client={qc}>
        <PairField productId="p1" value={{ mode: 'manual', product: { id: 'p2', sku: 'OZN-A028', name_ru: 'Vitamin C' } }} disabled={false} onChange={onChange} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/OZN-A028 · Vitamin C/)).toBeTruthy();
  });
});
