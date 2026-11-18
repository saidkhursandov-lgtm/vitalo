import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IherbDraft } from './components/IherbDraftPanel';
import { StaffAuthProvider, type Permission } from './lib/auth';
import { setToken } from './lib/api';
import { IherbAdd } from './pages/IherbAdd';
import { formFromDraft, ProductEdit } from './pages/ProductEdit';

const DRAFT: IherbDraft = {
  duplicate: null,
  draft: {
    sku: 'VTL-H018',
    status: 'hidden',
    name_ru: 'NOW Foods, Магний цитрат, 200 мг, 100 таблеток',
    name_uz: 'NOW Foods, Magniy sitrat, 200 mg, 100 tabletka',
    brand: 'NOW Foods',
    manufacturer: 'NOW Foods',
    brand_id: null,
    composition_ru: 'Магний (цитрат) — 200 мг',
    directions_uz: 'Kuniga 1 tabletka.',
    pack_count: 100,
    servings_per_day: 1,
    shipping_weight_g: 250,
    shipping_length_mm: 64,
    price_uzs: 278000,
    category_ids: ['cat-1'],
    iherb_url: 'https://uz.iherb.com/pr/now/69359',
    auto_pricing_enabled: true,
    markup_percent: 80,
    price_round_to: 1000,
    dose_amount: 200,
    dose_unit: 'mg',
    dose_per: 'tablet',
    substances: [{ id: 'sub-mgc' }],
    audience: 'adult',
    goals: ['sleep'],
    ai_filled: true,
  },
  photos: ['https://cloudinary.images-iherb.com/images/now/now01282/l/50.jpg', 'https://cloudinary.images-iherb.com/images/now/now01282/l/12.jpg'],
  iherb: { product_id: '69359', url: 'https://uz.iherb.com/pr/now/69359', price_uzs: 154210, price_source: 'page', in_stock: true, title: null, iherb_code: 'NOW-01282', upc: null },
  enrichment: { substances: [{ id: 'sub-mgc', kind: 'form', name_ru: 'Магний цитрат', name_uz: 'Magniy sitrat', parent_name: 'Магний', in_label: true, dose_amount: 200, dose_unit: 'mg' }], note: '' },
  unknown: [{ name: 'Таурин', dose: '100 мг', name_uz: 'Taurin', synonyms: ['Taurine'] }],
  similar: [{ id: 'p-old', sku: 'OZN-A050', name_ru: 'NOW Магний цитрат 60 таб.', brand: 'NOW Foods', status: 'active', iherb_product_id: null }],
  problems: ['Нет веса для доставки'],
  note: 'Доза указана на 2 таблетки.',
  cost_usd: 0.093,
};

let sent: { url: string; method: string; body: unknown }[];
function mock(permissions: Permission[], draftAnswer: unknown = DRAFT) {
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/staff/auth/me')) return json({ staff: { id: 's1', name: 'Мадина', role: 'admin' }, permissions });
    if (init.method === 'POST' || init.method === 'PATCH') {
      const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body ? JSON.parse(init.body as string) : null;
      sent.push({ url, method: init.method, body });
      if (url.endsWith('/staff/products/iherb/draft')) return json(draftAnswer);
      if (url.endsWith('/staff/products')) return json({ id: 'new-id', sku: 'VTL-H018', media: [], stock: [], category_ids: [], supplier_ids: [], substances: [], price_uzs: 278000, status: 'hidden' }, 201);
      if (url.includes('/photos/iherb')) return json({ added: 2, failed: [], product: { id: 'new-id', sku: 'VTL-H018', media: [], stock: [], category_ids: [], supplier_ids: [], substances: [], price_uzs: 278000, status: 'hidden' } });
      if (url.endsWith('/staff/compat/substances')) return json([{ id: 'sub-taurine', kind: 'substance', name_ru: 'Таурин', name_uz: 'Taurin' }]);
      if (url.includes('/suggest-rules')) return json({ created: 2, cost_usd: 0.01 });
    }
    if (url.includes('/catalog/categories')) return json({ need: [{ id: 'cat-1', name_ru: 'Сон', children: [] }], product_type: [] });
    return json([]);
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setToken(null);
});
function show(node: ReactNode, state?: unknown) {
  setToken('t');
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffAuthProvider>
        <MemoryRouter initialEntries={[{ pathname: '/products/new', state }]}>{node}</MemoryRouter>
      </StaffAuthProvider>
    </QueryClientProvider>,
  );
}

describe('D-78 «Добавить из iHerb»: the first screen', () => {
  it('needs an iHerb product link and the page; sends both; a known product is shown, not drafted again', async () => {
    mock(['products.view', 'products.edit'], { duplicate: { id: 'p9', sku: 'VTL-H003', name_ru: 'NOW Магний', status: 'hidden' } });
    show(<IherbAdd />);
    const go = await screen.findByRole('button', { name: 'Подготовить черновик' });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    const link = screen.getByLabelText('Ссылка на товар iHerb');
    fireEvent.change(link, { target: { value: 'https://example.com/x' } });
    fireEvent.change(screen.getByLabelText('…или текст страницы'), { target: { value: 'NOW Foods Magnesium Citrate 200 mg Supplement Facts and so on, long enough' } });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Нужна ссылка на страницу товара/)).toBeTruthy();
    fireEvent.change(link, { target: { value: 'https://uz.iherb.com/pr/now-foods-magnesium/69359' } });
    fireEvent.click(go);
    await waitFor(() => expect(sent[0]).toMatchObject({ url: '/api/staff/products/iherb/draft', body: { url: 'https://uz.iherb.com/pr/now-foods-magnesium/69359' } }));
    expect((sent[0].body as { text: string }).text).toContain('Supplement Facts');
    expect((await screen.findByRole('link', { name: 'VTL-H003 — NOW Магний' })).getAttribute('href')).toBe('/products/p9');
    expect(screen.getByRole('alert').textContent).toContain('(скрыт)');
  });
});

describe('D-78: the draft in the product editor', () => {
  it('formFromDraft: the draft fields, the Payme defaults of a new product, «Где берём» left to the server', () => {
    const f = formFromDraft(DRAFT.draft!);
    expect(f).toMatchObject({ sku: 'VTL-H018', status: 'hidden', price_uzs: '278000', pack_count: '100', shipping_weight_g: '250', auto_pricing_enabled: '1', dose_unit: 'mg', ikpu_code: '02106999028000000', supply_touched: '', min_stock: '0' });
    expect(formFromDraft({ ...DRAFT.draft!, auto_pricing_enabled: undefined }).auto_pricing_enabled).toBe('');
  });

  it('shows what to check; «Создать товар» saves it hidden with the AI data, then downloads the chosen photos', async () => {
    mock(['products.view', 'products.edit', 'costs.view', 'compat.view', 'compat.answer']);
    show(<ProductEdit />, { iherbDraft: DRAFT });
    expect(await screen.findByRole('heading', { name: 'Новый товар из iHerb' })).toBeTruthy();
    expect(screen.getByText('Нет веса для доставки')).toBeTruthy();
    expect(screen.getByText(/Доза указана на 2 таблетки/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OZN-A050 — NOW Магний цитрат 60 таб.' })).toBeTruthy();
    expect(screen.getByText(/по автоцене/).textContent).toMatch(/154.210.*278.000/);
    // the second photo is not wanted
    fireEvent.click(screen.getByRole('checkbox', { name: 'Фото 2' }));
    // an unknown substance is added to the dictionary and to the composition; AI proposes its rules
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в справочник' }));
    await waitFor(() => expect(sent.find((x) => x.url === '/api/staff/compat/substances')?.body).toEqual({ name_ru: 'Таурин', name_uz: 'Taurin', synonyms: ['Taurine'], kind: 'substance' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Предложить правила совместимости' }));
    expect(await screen.findByText(/AI предложил правил: 2/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Создать товар (скрытым)' }));
    await waitFor(() => expect(sent.some((x) => x.url.includes('/photos/iherb'))).toBe(true));
    const create = sent.find((x) => x.url === '/api/staff/products')!.body as Record<string, unknown>;
    expect(create).toMatchObject({
      sku: 'VTL-H018',
      status: 'hidden',
      price_uzs: 278000,
      ai_filled: true,
      iherb_url: 'https://uz.iherb.com/pr/now/69359',
      auto_pricing_enabled: true,
      shipping_weight_g: 250,
      shipping_length_mm: 64,
      category_ids: ['cat-1'],
      audience: 'adult',
      goals: ['sleep'],
      substances: [
        { id: 'sub-mgc', in_label: true, dose_amount: 200, dose_unit: 'mg' },
        { id: 'sub-taurine', in_label: false, dose_amount: null, dose_unit: null },
      ],
    });
    expect(create.supplier_ids).toBeUndefined();
    expect(sent.find((x) => x.url.includes('/photos/iherb'))).toEqual({ url: '/api/staff/products/new-id/photos/iherb', method: 'POST', body: { urls: [DRAFT.photos![0]] } });
  });
});
