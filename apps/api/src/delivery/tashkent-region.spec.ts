import { isTashkentRegionName } from './delivery.service';

// «Оплата при получении» works only in the city of Tashkent — not in the Tashkent region (D-05).
describe('isTashkentRegionName', () => {
  it.each(['г. Ташкент', 'г.Ташкент', 'Г. ТАШКЕНТ', '  г. Ташкент  ', 'г Ташкент'])('%j is the city of Tashkent', (name) => {
    expect(isTashkentRegionName(name)).toBe(true);
  });

  it.each(['Ташкентская область', 'Toshkent viloyati', 'Ташкентский район', 'Самаркандская область', 'г. Самарканд', '', 'Ташкент область'])(
    '%j is not the city of Tashkent',
    (name) => {
      expect(isTashkentRegionName(name)).toBe(false);
    },
  );
});
