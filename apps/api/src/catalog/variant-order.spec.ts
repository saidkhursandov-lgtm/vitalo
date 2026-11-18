import { variantOrder } from './catalog.service';

describe('D-79: the order of the pack size buttons', () => {
  const v = (sku: string, label: string | null, pack: number, price: number) => ({ sku, variant_label_ru: label, pack_count: pack, price_uzs: price });

  it('by dose, then by count, then by price — not by price alone', () => {
    const rows = [
      v('VTL-H005-5', '2000 МЕ · 180 шт', 180, 157000),
      v('VTL-H005-2', '5000 МЕ · 180 шт', 180, 163000),
      v('VTL-H005-4', '1000 МЕ · 180 шт', 180, 165000),
      v('VTL-H005-3', '5000 МЕ · 720 шт', 720, 512000),
      v('VTL-H005-1', '5000 МЕ · 360 шт', 360, 274000),
    ];
    expect(rows.sort(variantOrder).map((r) => r.variant_label_ru)).toEqual([
      '1000 МЕ · 180 шт',
      '2000 МЕ · 180 шт',
      '5000 МЕ · 180 шт',
      '5000 МЕ · 360 шт',
      '5000 МЕ · 720 шт',
    ]);
  });

  it('a label without a dose sorts by count; no label at all — by count too', () => {
    expect([v('A', '120 шт', 120, 509000), v('B', '60 шт', 60, 301000)].sort(variantOrder).map((r) => r.sku)).toEqual(['B', 'A']);
    expect([v('A', null, 120, 1), v('B', null, 60, 2)].sort(variantOrder).map((r) => r.sku)).toEqual(['B', 'A']);
  });
});
