import { checkRulesAnswer } from '../compat/rule-suggest';
import { onlyCountDiffers, priceFromIherb, swapCount, unknownSuggestions } from './iherb-add.service';
import { checkCardAnswer, type CardLists } from './iherb-card';
import { htmlToText, nextIherbSku, packSizeSku, productPhotos, readIherbPage, readVariants, variantLabel } from './iherb-page';

const IMG = 'https://cloudinary.images-iherb.com/image/upload/f_auto,q_auto:eco/images/now/now01282';
const page = (ld: object, extra = '') => `<!doctype html><html><head><title>NOW Foods</title>
<link rel="canonical" href="https://uz.iherb.com/pr/now-foods-magnesium-citrate-200-mg-100-tablets/69359">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script>var junk = "ignore me";</script></head>
<body><h1>NOW Foods, Magnesium Citrate, 200 mg, 100 Tablets</h1>
<div class="gallery"><img src="${IMG}/s/12.jpg"><img src="${IMG}/s/13.jpg"><img src="${IMG}/l/12.jpg"></div>
<ul><li>Shipping Weight: 0.25 kg</li><li>Product code: NOW-01282</li></ul>
<div>Supplement Facts</div><p>Magnesium (from Magnesium Citrate) 200 mg &amp; more</p>
<div class="recommended"><a href="/pr/other/12345"><img src="https://cloudinary.images-iherb.com/image/upload/images/cgn/cgn01065/s/4.jpg"></a></div>
${extra}</body></html>`;
const LD = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'NOW Foods, Magnesium Citrate, 200 mg, 100 Tablets',
  brand: { '@type': 'Brand', name: 'NOW Foods' },
  sku: 'NOW-01282',
  gtin12: '733739012821',
  image: `${IMG}/l/50.jpg`,
  offers: { '@type': 'Offer', price: '154210.00', priceCurrency: 'UZS', availability: 'https://schema.org/InStock' },
};

describe('D-78 «Добавить из iHerb»: reading the saved page', () => {
  it('takes the name, brand, price in sum, stock and this product’s photos from the data block', () => {
    const p = readIherbPage(page(LD), '69359');
    expect(p).toMatchObject({ format: 'html', title: LD.name, brand: 'NOW Foods', price_uzs: 154210, in_stock: true, wrong_currency: false, iherb_code: 'NOW-01282', upc: '733739012821', same_product: true });
    // main first, small gallery pictures as large ones, one per file, the recommended product’s picture left out
    expect(p.photos).toEqual([`${IMG}/l/50.jpg`, `${IMG}/l/12.jpg`, `${IMG}/l/13.jpg`]);
    expect(p.text).toContain('Shipping Weight: 0.25 kg');
    expect(p.text).toContain('Magnesium (from Magnesium Citrate) 200 mg & more');
    expect(p.text).not.toContain('ignore me');
  });

  it('dollars are reported, not converted; out of stock is read; another product’s page is caught', () => {
    const usd = readIherbPage(page({ ...LD, offers: { price: '12.50', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' } }), '69359');
    expect(usd).toMatchObject({ price_uzs: null, wrong_currency: true, in_stock: false });
    expect(readIherbPage(page(LD), '11111').same_product).toBe(false);
  });

  it('copied text: no data block, no photos, the product cannot be told', () => {
    const p = readIherbPage('NOW Foods, Magnesium Citrate\nЦена 154 210 сум\nSupplement Facts\nMagnesium 200 mg', '69359');
    expect(p).toMatchObject({ format: 'text', price_uzs: null, photos: [], same_product: null, wrong_currency: false });
    expect(readIherbPage('NOW Foods\nPrice $12.50\nSupplement Facts', '69359').wrong_currency).toBe(true);
  });

  it('og:image is the fallback for photos; text keeps blocks on their own lines', () => {
    const html = `<html><head><meta property="og:image" content="${IMG}/l/7.jpg"></head><body><p>a</p><p>a</p><div>b <b>c</b></div></body></html>`;
    expect(readIherbPage(html, '69359').photos).toEqual([`${IMG}/l/7.jpg`]);
    expect(htmlToText(html)).toBe('a\nb c');
    expect(productPhotos('<img src="https://example.com/x/y/l/1.jpg">', [])).toEqual([]);
  });

  it('«Веб-страница, один файл» (.mhtml, quoted-printable) is read like the HTML', () => {
    const qp = (s: string) =>
      [...Buffer.from(s, 'utf8')]
        .map((b) => (b === 61 || b > 126 ? `=${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b)))
        .join('')
        .replace(/(.{70})/g, '$1=\r\n');
    const html = page(LD, '<p>Магний — 200 мг</p>');
    const mhtml = `From: <Saved by Blink>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="----MultipartBoundary--abc"\r\n\r\n------MultipartBoundary--abc\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp(html)}\r\n------MultipartBoundary--abc--\r\n`;
    const p = readIherbPage(mhtml, '69359');
    expect(p).toMatchObject({ format: 'html', price_uzs: 154210, same_product: true });
    expect(p.text).toContain('Магний — 200 мг');
  });

  it('the next free iHerb SKU', () => {
    expect(nextIherbSku([])).toBe('VTL-H001');
    expect(nextIherbSku(['VTL-H001', 'VTL-H017', 'VTL-HG001', 'VTL-GH020', 'OZN-A001'])).toBe('VTL-H018');
    // pack sizes count as their number; a product with pack sizes on iHerb starts its own family
    expect(nextIherbSku(['VTL-H001', 'VTL-H020-2'], true)).toBe('VTL-H021-1');
  });

  it('D-79: a new pack size gets the number of its product with the next «-N»; a SKU never repeats', () => {
    expect(packSizeSku(['VTL-H001'], ['VTL-H001'])).toBe('VTL-H001-2');
    expect(packSizeSku(['VTL-H007-1', 'VTL-H007-2'], [])).toBe('VTL-H007-3');
    // an old SKU (alias) of another product is taken too
    expect(packSizeSku(['VTL-H007-1'], ['VTL-H007-2'])).toBe('VTL-H007-3');
    expect(packSizeSku(['OZN-A001'], [])).toBeNull();
  });

  it('VITALO price by the auto pricing rule: iHerb × 1.8, to the nearest 1 000', () => {
    expect(priceFromIherb(154_210)).toBe(278_000);
    expect(priceFromIherb(100_000, 50, 5000)).toBe(150_000);
  });
});

const LISTS: CardLists = {
  categories: [
    { key: 'c1', id: 'cat-sleep', name_ru: 'Сон', tree: 'need' },
    { key: 'c2', id: 'cat-min', name_ru: 'Минералы', tree: 'product_type' },
    { key: 'c3', id: 'cat-vit', name_ru: 'Витамины', tree: 'product_type' },
  ],
  brands: ['NOW Foods'],
  countries: ['США'],
  forms: ['Таблетки'],
};
const ANSWER = {
  name_ru: 'NOW Foods, Магний цитрат, 200 мг, 100 таблеток',
  name_uz: 'NOW Foods, Magniy sitrat, 200 mg, 100 tabletka',
  short_name_ru: 'Магний цитрат 200 мг, 100 таб.',
  short_name_uz: 'Magniy sitrat 200 mg',
  brand: 'now foods',
  manufacturer: 'NOW Foods',
  country: 'сша',
  form: 'таблетки',
  short_description_ru: 'Магний в форме цитрата.',
  short_description_uz: 'Sitrat shaklidagi magniy.',
  composition_ru: 'Размер порции: 1 таблетка\nМагний (цитрат) — 200 мг',
  composition_uz: 'Porsiya: 1 tabletka\nMagniy (sitrat) — 200 mg',
  directions_ru: 'По 1 таблетке в день.',
  directions_uz: 'Kuniga 1 tabletka.',
  warnings_ru: '',
  warnings_uz: 'Болалардан узоқда сақланг',
  match_form: 'Цитрат',
  shell_ru: null,
  shell_uz: null,
  search_keywords: 'magnesium, магний',
  pack_count: 100,
  servings_per_day: 1,
  shipping_weight_g: 250,
  shipping_length_mm: 64,
  shipping_width_mm: 64,
  shipping_height_mm: 122,
  price_uzs: 154210,
  dose_per: 'tablet',
  in_stock: true,
  category_keys: ['c2', 'c9', 'c2', 'c3', 'c1'],
  actives: [{ name_ru: 'Магний (цитрат)', name_uz: 'Magniy (sitrat)', name_en: 'Magnesium Citrate' }],
  note: '',
};

describe('D-78: the card answer of the model', () => {
  it('cleans the answer: names from the lists, known categories only, empty texts null, Cyrillic in Uzbek flagged', () => {
    const r = checkCardAnswer(ANSWER, LISTS);
    if (!r.ok) throw new Error(r.error);
    expect(r.card).toMatchObject({ brand: 'NOW Foods', country: 'США', form: 'Таблетки', match_form: 'цитрат', warnings_ru: null, category_ids: ['cat-min', 'cat-sleep'], pack_count: 100, dose_per: 'tablet' });
    expect(r.problems).toEqual(['«warnings_uz»: в узбекском тексте есть кириллица — проверьте']);
  });

  it('no name or brand → nothing to show; missing course data is reported', () => {
    expect(checkCardAnswer({ ...ANSWER, brand: ' ' }, LISTS)).toEqual({ ok: false, error: 'empty' });
    const r = checkCardAnswer({ ...ANSWER, pack_count: 0, servings_per_day: null, warnings_uz: '', category_keys: [] }, LISTS);
    if (!r.ok) throw new Error(r.error);
    expect(r.problems).toEqual([
      'Не указано количество в банке — без него не работает напоминание о конце курса',
      'Не указано порций в день — без него не работает напоминание о конце курса',
      'AI не подобрал категорию — выберите вручную',
    ]);
  });

  it('an unknown substance gets the model’s Uzbek and English names', () => {
    expect(unknownSuggestions([{ name: 'Магний', dose: '200 мг' }, { name: 'Таурин', dose: null }], ANSWER.actives)).toEqual([
      { name: 'Магний', dose: '200 мг', name_uz: 'Magniy (sitrat)', synonyms: ['Magnesium Citrate'] },
      { name: 'Таурин', dose: null, name_uz: '', synonyms: [] },
    ]);
  });
});

describe('D-78: suggested compatibility rules', () => {
  const dict = [
    { id: 'k2', code: 'k2', name_ru: 'Витамин K2', synonyms: [], enabled: true, kind: 'substance' },
    { id: 'd3', code: 'd3', name_ru: 'Витамин D3', synonyms: [], enabled: true, kind: 'substance' },
    { id: 'ca', code: 'ca', name_ru: 'Кальций', synonyms: [], enabled: true, kind: 'substance' },
    { id: 'fe', code: 'fe', name_ru: 'Железо', synonyms: [], enabled: true, kind: 'substance' },
    { id: 'warf', code: 'warf', name_ru: 'Варфарин', synonyms: [], enabled: true, kind: 'drug_group' },
  ];
  const rule = (code: string, kind: string, extra: object = {}) => ({ code, kind, interval_hours: null, time_a: null, meal_a: 'with_fat', time_b: null, meal_b: null, text_ru: 'Лучше вместе.', text_uz: 'Birga yaxshiroq.', source: null, ...extra });

  it('keeps known pairs once, skips itself, drug groups, existing pairs and Cyrillic Uzbek; spread gets an interval', () => {
    const r = checkRulesAnswer(
      { rules: [rule('d3', 'synergy'), rule('d3', 'synergy'), rule('k2', 'synergy'), rule('warf', 'avoid'), rule('ca', 'spread'), rule('fe', 'spread', { text_uz: 'Бирга' }), rule('nope', 'synergy')] },
      dict[0],
      dict,
      new Set(['ca']),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual([expect.objectContaining({ substance_b_id: 'd3', kind: 'synergy', interval_hours: null, meal_a: 'with_fat', when_a: 'with_food' })]);
    const s = checkRulesAnswer({ rules: [rule('fe', 'spread')] }, dict[2], dict, new Set());
    expect(s.ok && s.value[0]).toMatchObject({ substance_b_id: 'fe', kind: 'spread', interval_hours: 2 });
    expect(checkRulesAnswer({}, dict[0], dict, new Set())).toEqual({ ok: false, error: 'shape' });
  });
});

describe('D-79 «Фасовки» on the iHerb page', () => {
  const tile = (val: string, pid: string, selected: boolean, price = '') =>
    `<div class="attribute-tile combo-shaded stock-onsale  " data-val="${val}" data-pid="${pid}" data-url="https://uz.iherb.com/pr/x/${pid}" role="option" aria-selected="${selected}" tabindex="0">
      <div class="item-details"><div class="attribute-name" data-val="${val}">${val}</div>${price ? `<div class="price-container"><span>${price}</span></div>` : ''}
      </div></div>`;
  // iHerb renders the buttons of the pack size shown first (here 180), whatever the link is
  const html = `<html><body><div class="attribute-tile-group">${tile('1000 IU', '17137', false)}${tile('5000 IU', '21367', true)}</div>
    <div class="attribute-tile-group">${tile('180 count', '21367', true, '90&nbsp;466,19 сум')}${tile('360 count', '36580', false, '152&nbsp;454,79 сум')}${tile('720 count', '56653', false, '284&nbsp;419,01 сум')}</div>
    <div id="modelProperties" data-product-id="21367" data-shipping-weight-kg="0.06 kg"></div></body></html>`;

  it('the link’s own pack size and the others, with their iHerb prices; the dose button is the dose alone', () => {
    expect(readVariants(html, '36580')).toEqual({
      label: '5000 IU · 360 count',
      price_uzs: 152454,
      variants: [
        { product_id: '21367', label: '5000 IU · 180 count', price_uzs: 90466, url: 'https://uz.iherb.com/pr/x/21367' },
        { product_id: '56653', label: '5000 IU · 720 count', price_uzs: 284419, url: 'https://uz.iherb.com/pr/x/56653' },
        { product_id: '17137', label: '1000 IU', price_uzs: null, url: 'https://uz.iherb.com/pr/x/17137' },
      ],
    });
    expect(readIherbPage(html.replace('<body>', '<body><a href="/pr/x/36580">x</a>'), '36580').sizes_of_other_variant).toBe(true);
    expect(readVariants('<html></html>', '1')).toEqual({ variants: [], label: null, price_uzs: null });
  });

  it('labels in the shop’s words; names get the other pack size; only a pack size difference is copied', () => {
    expect(variantLabel('5000 IU · 360 count', 'ru')).toBe('5000 МЕ · 360 шт');
    expect(variantLabel('5000 IU · 360 count', 'uz')).toBe('5000 XB · 360 dona');
    expect(swapCount('Life Extension, Мультивитамины Two-Per-Day, 120 капсул', 120, 60)).toBe('Life Extension, Мультивитамины Two-Per-Day, 60 капсул');
    expect(swapCount('Two-Per-Day multivitaminlari, 120 kapsula; 1200 mg', 120, 60)).toBe('Two-Per-Day multivitaminlari, 60 kapsula; 1200 mg');
    expect(swapCount('Two-Per-Day, 120 кап.', 120, 60)).toBe('Two-Per-Day, 60 кап.');
    expect(onlyCountDiffers('5000 IU · 180 count', '5000 IU · 360 count')).toBe(true);
    expect(onlyCountDiffers('1000 IU · 180 count', '5000 IU · 180 count')).toBe(false);
    expect(onlyCountDiffers('60 count', '120 count')).toBe(true);
  });
});
