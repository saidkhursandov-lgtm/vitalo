import { quoteDelivery } from './delivery-quote';

const tariff = { tariff_uzs: 20_000, free_shipping_threshold_uzs: 300_000 };

describe('quoteDelivery', () => {
  it('charges the tariff below the threshold and says how much is missing', () => {
    const q = quoteDelivery(tariff, 250_000);
    expect(q).toMatchObject({ cost_uzs: 20_000, is_free: false, remaining_for_free_uzs: 50_000 });
    expect(q.message_ru).toBe('Добавьте ещё на 50 000 сум — доставка будет бесплатной');
  });

  it('is free exactly at the threshold', () => {
    const q = quoteDelivery(tariff, 300_000);
    expect(q).toMatchObject({ cost_uzs: 0, is_free: true, remaining_for_free_uzs: 0 });
    expect(q.message_ru).toBe('Вы достигли 300 000 сум — доставка бесплатна');
  });

  it('is free above the threshold', () => {
    expect(quoteDelivery(tariff, 1_000_000).cost_uzs).toBe(0);
  });

  it('a zero threshold means always free', () => {
    expect(quoteDelivery({ tariff_uzs: 20_000, free_shipping_threshold_uzs: 0 }, 1).is_free).toBe(true);
  });
});
