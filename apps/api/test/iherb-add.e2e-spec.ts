import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { AI_MODEL, type AiCompletion, type AiInput, type AiModel } from '../src/compat/ai-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginStaff, TEST_BRAND } from './helpers';

const ADMIN_TG = 222_222_221;

class FakeModel implements AiModel {
  calls: AiInput[] = [];
  card: unknown = {};
  enrich: unknown = {};
  rules: unknown = { rules: [] };
  ready() {
    return true;
  }
  async complete(input: AiInput): Promise<AiCompletion> {
    this.calls.push(input);
    const json = input.system.startsWith('Ты — редактор каталога') ? this.card : input.system.includes('правил совместимости') ? this.rules : this.enrich;
    return { json, inputTokens: 10_000, outputTokens: 3000, outcome: 'ok' };
  }
}

/** D-78 «Добавить из iHerb»: the saved page → an AI draft → «Создать товар» (hidden) → photos; rules for a new substance. */
describe('«Добавить из iHerb» (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeModel();
  const tokens: Record<string, string> = {};
  const run = Date.now().toString(36);
  const pid = String(700000 + (Date.now() % 99999));
  const url = `https://uz.iherb.com/pr/now-foods-magnesium-citrate/${pid}?rcode=ABC`;
  const http = () => request(app.getHttpServer());
  const s: Record<string, string> = {};
  const img = 'https://cloudinary.images-iherb.com/image/upload/images/now/now01282';
  const pageHtml = (id = pid) => `<html><head>
<link rel="canonical" href="https://uz.iherb.com/pr/now-foods-magnesium-citrate/${id}">
<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: `Magnesium Citrate ${run}`, brand: { name: TEST_BRAND }, sku: 'NOW-01282', image: `${img}/l/50.jpg`, offers: { price: '154210.00', priceCurrency: 'UZS', availability: 'https://schema.org/InStock' } })}</script>
</head><body><h1>Magnesium Citrate ${run}</h1>${[1, 2, 3, 4, 5].map((i) => `<p>Line ${i}. Supplement Facts: Magnesium (as magnesium citrate) 200 mg. Taurine 100 mg. Suggested use: 1 tablet daily.</p>`).join('')}</body></html>`;

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(AI_MODEL).useValue(fake));
    prisma = app.get(PrismaService);
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);
    s.mg = (await prisma.substances.create({ data: { code: `ih_mg_${run}`, name_ru: `Магний ${run}`, name_uz: `Magniy ${run}`, synonyms: [] } })).id;
    s.mgc = (await prisma.substances.create({ data: { code: `ih_mgc_${run}`, kind: 'form', parent_id: s.mg, name_ru: `Магний цитрат ${run}`, name_uz: `Magniy sitrat ${run}`, synonyms: [] } })).id;
    s.b6 = (await prisma.substances.create({ data: { code: `ih_b6_${run}`, name_ru: `B6 ${run}`, name_uz: `B6 ${run}`, synonyms: [] } })).id;
    fake.card = {
      name_ru: `${TEST_BRAND}, Магний цитрат ${run}, 200 мг, 100 таблеток`,
      name_uz: `${TEST_BRAND}, Magniy sitrat ${run}, 200 mg, 100 tabletka`,
      short_name_ru: 'Магний цитрат 200 мг',
      short_name_uz: 'Magniy sitrat 200 mg',
      brand: TEST_BRAND,
      manufacturer: 'NOW Foods',
      country: null,
      form: null,
      short_description_ru: 'Магний в форме цитрата.',
      short_description_uz: 'Sitrat shaklidagi magniy.',
      composition_ru: 'Размер порции: 1 таблетка\nМагний (цитрат) — 200 мг\nТаурин — 100 мг',
      composition_uz: 'Porsiya: 1 tabletka\nMagniy (sitrat) — 200 mg\nTaurin — 100 mg',
      directions_ru: 'По 1 таблетке в день.',
      directions_uz: 'Kuniga 1 tabletka.',
      warnings_ru: 'Хранить в недоступном для детей месте.',
      warnings_uz: 'Bolalardan uzoqda saqlang.',
      match_form: 'цитрат',
      shell_ru: null,
      shell_uz: null,
      search_keywords: 'magnesium',
      pack_count: 100,
      servings_per_day: 1,
      shipping_weight_g: 250,
      shipping_length_mm: 64,
      shipping_width_mm: 64,
      shipping_height_mm: 122,
      price_uzs: 999_000,
      dose_per: 'tablet',
      in_stock: true,
      category_keys: ['c1'],
      actives: [{ name_ru: `Таурин ${run}`, name_uz: `Taurin ${run}`, name_en: 'Taurine' }],
      note: '',
    };
    fake.enrich = {
      substances: [{ code: `ih_mgc_${run}`, dose_amount: 200, dose_unit: 'mg', in_label: true }],
      unknown: [{ name: `Таурин ${run}`, dose: '100 мг' }],
      audience: 'adult',
      goals: ['sleep'],
      note: '',
    };
  });

  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    await prisma.products.updateMany({ where: { iherb_product_id: pid }, data: { iherb_product_id: null, iherb_url: null } });
    await prisma.compat_rules.updateMany({ where: { OR: [{ substance_a_id: { in: Object.values(s) } }, { substance_b_id: { in: Object.values(s) } }] }, data: { status: 'off' } });
    await archiveTestProducts(prisma);
    jest.restoreAllMocks();
    await app.close();
  });

  it('only an admin; the link and the page are checked before any AI call', async () => {
    await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.manager)).send({ url, text: pageHtml() }).expect(403);
    const bad = await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.admin)).send({ url: 'https://example.com/pr/x/1', text: pageHtml() }).expect(400);
    expect(bad.body.code).toBe('BAD_IHERB_URL');
    const short = await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.admin)).send({ url, text: 'NOW Foods' }).expect(400);
    expect(short.body.code).toBe('PAGE_EMPTY');
    const wrong = await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.admin)).send({ url, text: pageHtml('123456') }).expect(400);
    expect(wrong.body.code).toBe('WRONG_PAGE');
    expect(fake.calls).toHaveLength(0);
  });

  it('the saved page → a full draft: card, price by auto pricing, substances, unknown ones, similar products; nothing saved', async () => {
    const twin = await createTestProduct(prisma, { price: 100_000, stock: 0, name: `${TEST_BRAND}, Магний цитрат ${run}, 200 мг, 60 таблеток` });
    const before = await prisma.products.count();
    const r = await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.admin)).field('url', url).attach('file', Buffer.from(pageHtml()), 'page.html').expect(200);
    expect(r.body.duplicate).toBeNull();
    expect(r.body.draft).toMatchObject({
      sku: expect.stringMatching(/^VTL-H\d{3,}$/),
      status: 'hidden',
      brand: TEST_BRAND,
      iherb_url: `https://uz.iherb.com/pr/now-foods-magnesium-citrate/${pid}`,
      // the page's own price, not the model's reading: 154 210 × 1.8 → 278 000
      price_uzs: 278_000,
      auto_pricing_enabled: true,
      markup_percent: 80,
      pack_count: 100,
      servings_per_day: 1,
      shipping_weight_g: 250,
      dose_amount: 200,
      dose_unit: 'mg',
      dose_per: 'tablet',
      substances: [{ id: s.mgc, in_label: true, dose_amount: 200, dose_unit: 'mg' }],
      audience: 'adult',
      goals: ['sleep'],
      ai_filled: true,
    });
    expect(r.body.iherb).toMatchObject({ product_id: pid, price_uzs: 154_210, price_source: 'page', in_stock: true });
    expect(r.body.photos).toEqual([`${img}/l/50.jpg`]);
    expect(r.body.unknown).toEqual([{ name: `Таурин ${run}`, dose: '100 мг', name_uz: `Taurin ${run}`, synonyms: ['Taurine'] }]);
    expect(r.body.similar.map((x: { id: string }) => x.id)).toContain(twin.id);
    expect(r.body.cost_usd).toBeGreaterThan(0);
    // the card on the card model, the substances on the main model; both in «Расход AI»
    expect(fake.calls.map((c) => c.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(fake.calls[0].data).toContain('Supplement Facts');
    expect(fake.calls[1].data).toContain(`Название: ${TEST_BRAND}, Магний цитрат ${run}`);
    const logs = await prisma.ai_requests.findMany({ where: { OR: [{ set_key: pid }, { set_key: `iherb:${pid}` }] } });
    expect(logs.map((l) => [l.scenario, l.status]).sort()).toEqual([
      ['enrich', 'ok'],
      ['iherb_card', 'ok'],
    ]);
    expect(await prisma.products.count()).toBe(before);

    // «Создать товар»: saved hidden with its VITALO AI data; no second AI draft is queued
    const { draft } = r.body;
    const created = await http()
      .post('/api/staff/products')
      .set(bearer(tokens.admin))
      .send({ ...draft, sku: `${draft.sku}-${run}`.slice(0, 50) })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'hidden', iherb_product_id: pid, shipping_weight_g: 250, shipping_height_mm: 122, auto_pricing_enabled: true, audience: 'adult' });
    expect(created.body.substances.map((x: { id: string; dose_amount: number }) => [x.id, x.dose_amount])).toEqual([[s.mgc, 200]]);
    expect(await prisma.product_enrichments.count({ where: { product_id: created.body.id } })).toBe(0);
    s.product = created.body.id;

    // the same link again: the product is shown, no AI is spent
    fake.calls = [];
    const again = await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.admin)).send({ url, text: pageHtml() }).expect(200);
    expect(again.body.duplicate).toMatchObject({ id: s.product, status: 'hidden' });
    expect(fake.calls).toHaveLength(0);
  });

  it('photos: only from the iHerb picture server, each file once', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 45, b: 98 } } }).png().toBuffer();
    const hosts: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const r = await http()
      .post(`/api/staff/products/${s.product}/photos/iherb`)
      .set(bearer(tokens.admin))
      .send({ urls: [`${img}/l/50.jpg`, `${img}/l/50.jpg`, 'https://evil.example.com/a.jpg', 'http://cloudinary.images-iherb.com/x/y/l/1.jpg'] })
      .expect(200);
    expect(r.body.added).toBe(1);
    expect(r.body.failed).toEqual(['https://evil.example.com/a.jpg', 'http://cloudinary.images-iherb.com/x/y/l/1.jpg']);
    expect(hosts).toEqual(['cloudinary.images-iherb.com']);
    expect(r.body.product.media).toHaveLength(1);
    expect(r.body.product.media[0]).toMatchObject({ is_main: true, title: 'iherb:now01282/l/50.jpg' });
    await http().post(`/api/staff/products/${s.product}/photos/iherb`).set(bearer(tokens.manager)).send({ urls: [`${img}/l/50.jpg`] }).expect(403);
  });

  it('a new substance: AI proposes rules as drafts (origin vitalo), never approved', async () => {
    fake.rules = {
      rules: [
        { code: `ih_b6_${run}`, kind: 'synergy', interval_hours: null, time_a: 'evening', meal_a: 'with_food', time_b: null, meal_b: null, text_ru: 'B6 помогает усвоению магния.', text_uz: 'B6 magniy so‘rilishiga yordam beradi.', source: 'обзор исследований' },
        { code: 'made_up', kind: 'avoid', interval_hours: null, time_a: null, meal_a: null, time_b: null, meal_b: null, text_ru: 'Нет.', text_uz: 'Yo‘q.', source: null },
      ],
    };
    await http().post(`/api/staff/compat/substances/${s.mg}/suggest-rules`).set(bearer(tokens.manager)).expect(403);
    const r = await http().post(`/api/staff/compat/substances/${s.mg}/suggest-rules`).set(bearer(tokens.admin)).expect(200);
    expect(r.body.created).toBe(1);
    const rule = await prisma.compat_rules.findFirstOrThrow({ where: { substance_a_id: s.mg, substance_b_id: s.b6 } });
    expect(rule).toMatchObject({ kind: 'synergy', status: 'draft', origin: 'vitalo', time_a: 'evening', meal_a: 'with_food', when_a: 'evening' });
    // asked again: the pair already has a rule, nothing doubled
    const again = await http().post(`/api/staff/compat/substances/${s.mg}/suggest-rules`).set(bearer(tokens.admin)).expect(200);
    expect(again.body.created).toBe(0);
  });
  it('D-79 «Фасовки»: another pack size of a product in the shop — the card is copied without AI and joins its pack sizes', async () => {
    const pid2 = String(Number(pid) + 1);
    const url2 = `https://uz.iherb.com/pr/now-foods-magnesium-citrate-200/${pid2}`;
    const tile = (val: string, id: string, sel: boolean, price: string) =>
      `<div class="attribute-tile combo-shaded" data-val="${val}" data-pid="${id}" data-url="https://uz.iherb.com/pr/x/${id}" aria-selected="${sel}"><div class="item-details"><div class="attribute-name">${val}</div><div class="price-container"><span>${price}</span></div></div></div>`;
    const page2 = pageHtml(pid2)
      .replace('154210.00', '250000.00')
      .replace('<body>', `<body><div class="attribute-group attribute-tile-group">${tile('100 count', pid, true, '154&nbsp;210,00 сум')}${tile('200 count', pid2, false, '250&nbsp;000,00 сум')}</div>`);
    await prisma.products.update({ where: { id: s.product }, data: { status: 'active', sku: `VTL-H9${pid.slice(-4)}` } });
    const draft0 = await prisma.products.findUniqueOrThrow({ where: { id: s.product }, select: { sku: true } });
    fake.calls = [];
    const r = await http().post('/api/staff/products/iherb/draft').set(bearer(tokens.admin)).send({ url: url2, text: page2 }).expect(200);
    expect(fake.calls).toHaveLength(0);
    expect(r.body).toMatchObject({ cost_usd: 0, copied_from: { id: s.product } });
    expect(r.body.variants).toEqual([expect.objectContaining({ product_id: pid, label: '100 count', label_ru: '100 шт', price_uzs: 154_210, ours: expect.objectContaining({ id: s.product }) })]);
    expect(r.body.draft).toMatchObject({
      name_ru: `${TEST_BRAND}, Магний цитрат ${run}, 200 мг, 200 таблеток`,
      name_uz: `${TEST_BRAND}, Magniy sitrat ${run}, 200 mg, 200 tabletka`,
      pack_count: 200,
      servings_per_day: 1,
      price_uzs: 450_000,
      iherb_url: url2,
      substances: [{ id: s.mgc, in_label: true, dose_amount: 200, dose_unit: 'mg' }],
      // the same number as the product in the shop, with «-2»
      sku: `${draft0.sku}-2`,
      variant_of: s.product,
      variant_label_ru: '200 шт',
      variant_label_uz: '200 dona',
      shipping_weight_g: null,
    });
    const created = await http()
      .post('/api/staff/products')
      .set(bearer(tokens.admin))
      .send({ ...r.body.draft, status: 'active' })
      .expect(201);
    expect(created.body.variants).toEqual([expect.objectContaining({ id: s.product })]);
    // the original gets a label too; the shop shows both as «Фасовка» buttons, the current one marked
    await http().patch(`/api/staff/products/${s.product}`).set(bearer(tokens.admin)).send({ variant_label_ru: '100 шт', variant_label_uz: '100 dona' }).expect(200);
    const card = (await http().get(`/api/catalog/products/${created.body.id}`).expect(200)).body;
    expect(card.variants).toEqual([
      expect.objectContaining({ id: s.product, label_ru: '100 шт', label_uz: '100 dona', current: false }),
      expect.objectContaining({ id: created.body.id, label_ru: '200 шт', current: true }),
    ]);
    // a hidden pack size is not a button; with one left there are none
    await http().patch(`/api/staff/products/${s.product}`).set(bearer(tokens.admin)).send({ status: 'hidden' }).expect(200);
    expect((await http().get(`/api/catalog/products/${created.body.id}`).expect(200)).body.variants).toEqual([]);
    // leaving the group: a group of one is cleared
    const left = await http().patch(`/api/staff/products/${created.body.id}`).set(bearer(tokens.admin)).send({ variant_of: null }).expect(200);
    expect(left.body.variants).toEqual([]);
    expect((await prisma.products.findUniqueOrThrow({ where: { id: s.product } })).variant_group_id).toBeNull();
    const self = await http().patch(`/api/staff/products/${s.product}`).set(bearer(tokens.admin)).send({ variant_of: s.product }).expect(400);
    expect(self.body.code).toBe('BAD_VARIANT');
    await prisma.products.update({ where: { id: created.body.id }, data: { iherb_product_id: null, iherb_url: null } });
  });
});
