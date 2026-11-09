import { autoPrice, roundNearest, roundUp } from './auto-price';
import { parseWishlist } from './wishlist-parser';
import { reminderSlot } from './iherb-prices';

/** A wishlist page like a saved iHerb page: cards with a picture link, a title link, prices, badges. */
const card = (id: number, slug: string, title: string, price: string, extra = '') => `
  <div class="wishlist-item">
    <a href="https://uz.iherb.com/pr/${slug}/${id}" class="image-link"><img src="x.jpg" alt=""></a>
    <div class="product-info">
      <a href="/pr/${slug}/${id}?rcode=ABC" title="${title}">${title}</a>
      ${extra}
      <div class="price-block"><span class="price">${price}</span></div>
      <button>Добавить в корзину</button>
    </div>
  </div>`;

const page = (cards: string) => `<!DOCTYPE html><html><head><style>.price{color:red}</style><script>var p="999 999 сум";</script></head>
<body><header>Бесплатная доставка от 300 000 сум</header><main>${cards}</main></body></html>`;

describe('iHerb wishlist: saved page (D-57, источник «Б»)', () => {
  it('takes number, title, price, old price, stock, bestseller and weight of every product', () => {
    const r = parseWishlist(
      page(
        card(62118, 'california-gold-nutrition-omega-3', 'California Gold Nutrition, Omega-3, 100 мягких капсул', '245&nbsp;000 сум') +
          card(
            2902,
            'now-foods-zinc-50-mg',
            'NOW Foods, Цинк, 50 мг, 250 таблеток',
            '<del class="old">150 000 сум</del> 120 500,00 сум',
            '<span class="badge">Бестселлер</span><span>Вес: 0,25 kg</span><span class="save">Экономия 29 500 сум</span>',
          ) +
          card(103250, 'nordic-naturals-ultimate-omega', 'Nordic Naturals, Ultimate Omega', 'UZS 512,300', '<span class="stock">Нет в наличии</span>'),
      ),
    );
    expect(r.format).toBe('html');
    expect(r.problems).toEqual([]);
    expect(r.items).toEqual([
      { iherb_product_id: '62118', title: 'California Gold Nutrition, Omega-3, 100 мягких капсул', price_uzs: 245_000, list_price_uzs: null, in_stock: true, bestseller: false, bestseller_rank: null, weight_kg: null },
      { iherb_product_id: '2902', title: 'NOW Foods, Цинк, 50 мг, 250 таблеток', price_uzs: 120_500, list_price_uzs: 150_000, in_stock: true, bestseller: true, bestseller_rank: null, weight_kg: 0.25 },
      { iherb_product_id: '103250', title: 'Nordic Naturals, Ultimate Omega', price_uzs: 512_300, list_price_uzs: null, in_stock: false, bestseller: false, bestseller_rank: null, weight_kg: null },
    ]);
  });

  it('a product without a sum price is reported, never guessed; prices in dollars ask to switch the currency', () => {
    const r = parseWishlist(page(card(111, 'a', 'Товар А', '245 000 сум') + card(222, 'b', 'Товар Б', 'скоро')));
    expect(r.items.map((i) => i.iherb_product_id)).toEqual(['111']);
    expect(r.problems).toEqual(['Товар Б (iHerb 222): цена в сумах не найдена']);

    const usd = parseWishlist(page(card(111, 'a', 'Товар А', '$12.34') + card(222, 'b', 'Товар Б', '$5.00')));
    expect(usd).toMatchObject({ items: [], wrong_currency: true });
  });

  it('the same product twice keeps the first; a weight in pounds is turned into kilograms', () => {
    const r = parseWishlist(page(card(111, 'a', 'Товар А', '200 000 сум', '<span>0.5 lb</span>') + card(222, 'b', 'Б', '90 000 сум') + card(111, 'a', 'Товар А', '1 000 сум')));
    expect(r.items.map((i) => [i.iherb_product_id, i.price_uzs])).toEqual([
      ['111', 200_000],
      ['222', 90_000],
    ]);
    expect(r.items[0].weight_kg).toBe(0.227);
  });
});

describe('iHerb wishlist: a table pasted by hand', () => {
  it('link or number + price; «нет» = out of stock; header lines and junk are reported', () => {
    const r = parseWishlist(
      [
        'Ссылка;Цена;Наличие',
        'https://uz.iherb.com/pr/california-gold-nutrition-omega-3/62118?rcode=X;245 000 сум',
        '2902\t120500\tнет',
        '#103250 512 300 бестселлер',
        'просто строка 50000',
        '555;без цены',
      ].join('\n'),
    );
    expect(r.format).toBe('table');
    expect(r.items).toEqual([
      { iherb_product_id: '62118', title: null, price_uzs: 245_000, list_price_uzs: null, in_stock: true, bestseller: false, bestseller_rank: null, weight_kg: null },
      { iherb_product_id: '2902', title: null, price_uzs: 120_500, list_price_uzs: null, in_stock: false, bestseller: false, bestseller_rank: null, weight_kg: null },
      { iherb_product_id: '103250', title: null, price_uzs: 512_300, list_price_uzs: null, in_stock: true, bestseller: true, bestseller_rank: null, weight_kg: null },
    ]);
    expect(r.problems).toEqual(['«просто строка 50000»: нет ссылки или номера товара iHerb', 'iHerb 555: нет цены в сумах']);
  });
});

describe('iHerb wishlist: best-seller place', () => {
  it('the page: «#3 Best Seller» / «Бестселлер №12»; a table: «#3», «место 7»', () => {
    const r = parseWishlist(page(card(62118, 'omega', 'Omega-3', '245 000 сум', '<span>#3 Best Seller</span>') + card(2902, 'zinc', 'Zinc', '120 500 сум', '<span>Бестселлер № 12 в категории</span>')));
    expect(r.items.map((i) => [i.bestseller, i.bestseller_rank])).toEqual([[true, 3], [true, 12]]);
    const t = parseWishlist(['62118 245 000 #3', '2902;120500;место 7;нет', '103250 512300'].join(String.fromCharCode(10)));
    expect(t.items.map((i) => [i.price_uzs, i.bestseller_rank, i.in_stock])).toEqual([[245_000, 3, true], [120_500, 7, false], [512_300, null, true]]);
  });
});

describe('auto price (D-57)', () => {
  const base = {
    iherb_price_uzs: 100_000,
    iherb_in_stock: true,
    markup_percent: 80,
    price_round_to: 1000,
    stock_price_mode: 'freeze',
    available: 0,
    current_price_uzs: 170_000,
    cost_uzs: null,
    min_markup_pct: 10,
  };

  it('iHerb × (1 + markup), rounded to the thousand', () => {
    expect(roundUp(180_001, 1000)).toBe(181_000);
    expect(autoPrice({ ...base, iherb_price_uzs: 100_300 })).toEqual({ target_uzs: 181_000, apply: true, skip_reason: null, floor_applied: false, big_jump: false });
  });

  it('6а-В: the retail price goes to the nearest thousand (270 254 → 270 000, 386 773 → 387 000)', () => {
    expect(roundNearest(270_254, 1000)).toBe(270_000);
    expect(roundNearest(386_773, 1000)).toBe(387_000);
    expect(roundNearest(270_500, 1000)).toBe(271_000);
    expect(autoPrice({ ...base, iherb_price_uzs: 150_141 }).target_uzs).toBe(270_000); // 270 253.8
    expect(autoPrice({ ...base, iherb_price_uzs: 214_874 }).target_uzs).toBe(387_000); // 386 773.2
  });

  it('never below the cost + minimum markup', () => {
    expect(autoPrice({ ...base, cost_uzs: 200_000 })).toMatchObject({ target_uzs: 220_000, apply: true, floor_applied: true });
  });

  it('a jump over 20% is applied at once and flagged', () => {
    expect(autoPrice({ ...base, current_price_uzs: 140_000 })).toMatchObject({ target_uzs: 180_000, apply: true, big_jump: true });
  });

  it('on the shelf: «freeze» keeps the price, «dynamic» follows iHerb', () => {
    expect(autoPrice({ ...base, available: 3 })).toMatchObject({ apply: false, skip_reason: 'in_stock_freeze', target_uzs: 180_000 });
    expect(autoPrice({ ...base, available: 3, stock_price_mode: 'dynamic' })).toMatchObject({ apply: true });
  });

  it('iHerb out of stock or the same price: nothing changes', () => {
    expect(autoPrice({ ...base, iherb_in_stock: false })).toMatchObject({ apply: false, skip_reason: 'iherb_out_of_stock' });
    expect(autoPrice({ ...base, current_price_uzs: 180_000 })).toMatchObject({ apply: false, skip_reason: 'no_change' });
  });
});

describe('reminder slots 09:00 / 15:00 / 21:00 Tashkent', () => {
  it('belongs to the last slot within 2 hours, otherwise none', () => {
    // 15:30 Tashkent = 10:30 UTC
    expect(reminderSlot(new Date('2026-11-15T10:30:00Z'))?.toISOString()).toBe('2026-11-15T10:00:00.000Z');
    // 09:00 sharp
    expect(reminderSlot(new Date('2026-11-15T04:00:00Z'))?.toISOString()).toBe('2026-11-15T04:00:00.000Z');
    // 12:00 Tashkent — 3 hours after 09:00
    expect(reminderSlot(new Date('2026-11-15T07:00:00Z'))).toBeNull();
    // 22:59 Tashkent
    expect(reminderSlot(new Date('2026-11-15T17:59:00Z'))?.toISOString()).toBe('2026-11-15T16:00:00.000Z');
  });
});
