import { priceCap, rankUpsell } from './upsell';

const p = (id: string, price_uzs: number) => ({ id, price_uzs });

describe('3.1 upsell ranking', () => {
  it('the cheapest product that closes the gap comes first, then the others that close it, then the ones below it', () => {
    const items = [p('below', 45_000), p('far', 90_000), p('exact', 50_000), p('near', 52_000)];
    expect(rankUpsell(items, 50_000).map((x) => x.id)).toEqual(['exact', 'near', 'far']);
    expect(rankUpsell(items, 50_000, 4).map((x) => x.id)).toEqual(['exact', 'near', 'far', 'below']);
  });

  it('never offers expensive products: up to the gap doubled, or the gap + 100 000 when the gap is small', () => {
    expect(priceCap(200_000)).toBe(400_000);
    expect(priceCap(10_000)).toBe(110_000);
    expect(rankUpsell([p('big', 500_000), p('ok', 30_000)], 10_000).map((x) => x.id)).toEqual(['ok']);
    expect(rankUpsell([p('free', 0)], 10_000)).toEqual([]);
  });
});
