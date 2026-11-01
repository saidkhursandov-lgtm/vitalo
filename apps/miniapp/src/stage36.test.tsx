import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressFields, type AddressValue } from './components/AddressFields';
import { ConfirmProvider } from './components/Confirm';
import { composeAddress, EMPTY_DETAILS } from './lib/address';
import { I18nProvider } from './lib/i18n';
import type { Lang, Region } from './lib/types';

// The map script is replaced by a fake: the test moves the "map" by calling the listener Yandex would call.
const ymaps = vi.hoisted(() => ({
  load: vi.fn(),
  listener: null as null | ((e: { location: { center: [number, number]; zoom: number }; mapInAction: boolean }) => void),
  created: [] as { center: [number, number]; zoom: number }[],
  updates: [] as unknown[],
}));
vi.mock('./lib/yandex-maps', () => ({ loadYmaps: ymaps.load }));
function fakeYmaps() {
  return {
    ready: Promise.resolve(),
    YMap: class {
      center: [number, number];
      constructor(_el: HTMLElement, props: { location: { center: [number, number]; zoom: number } }) {
        this.center = props.location.center;
        ymaps.created.push(props.location);
      }
      addChild() {
        return this;
      }
      update(p: unknown) {
        ymaps.updates.push(p);
      }
      destroy() {}
    },
    YMapDefaultSchemeLayer: class {},
    YMapDefaultFeaturesLayer: class {},
    YMapListener: class {
      constructor(p: { onUpdate: typeof ymaps.listener }) {
        ymaps.listener = p.onUpdate;
      }
    },
  };
}

// Telegram (and the browser location) only through the adapter
const loc = vi.hoisted(() => ({ result: { status: 'denied' } as { status: string; lat?: number; lon?: number } }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, getLocation: () => Promise.resolve(loc.result), haptic: () => undefined };
});

const REGIONS: Region[] = [
  { id: 'tash', name_ru: 'г. Ташкент', name_uz: 'Toshkent shahri', cities: [{ id: 'yunus', name_ru: 'Юнусабадский район', name_uz: 'Yunusobod tumani' }, { id: 'chil', name_ru: 'Чиланзарский район', name_uz: 'Chilonzor tumani' }] },
  { id: 'sam', name_ru: 'Самаркандская область', name_uz: 'Samarqand viloyati', cities: [{ id: 'samc', name_ru: 'Самарканд', name_uz: 'Samarqand' }] },
] as Region[];

let routes: Record<string, () => unknown>;
let calls: { url: string; body: unknown }[];
beforeEach(() => {
  ymaps.load.mockReset().mockResolvedValue(fakeYmaps());
  ymaps.listener = null;
  ymaps.created = [];
  ymaps.updates = [];
  loc.result = { status: 'denied' };
  calls = [];
  routes = {
    '/maps/config': () => ({ available: true, reason: null, js_api_key: 'js-key' }),
    '/maps/geocode': () => ({ found: true, outside: false, street_line: 'улица Амира Темура, 107', full_text: 'Ташкент, Юнусабадский район, улица Амира Темура, 107', region_id: 'tash', city_id: 'yunus' }),
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return new Response(JSON.stringify(hit ? routes[hit]() : {}), { status: 200 });
  });
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const START: AddressValue = { region_id: '', city_id: '', address_text: '', details: EMPTY_DETAILS, point: null };
let last: AddressValue = START;
function Host({ initial = START }: { initial?: AddressValue }) {
  const [v, setV] = useState(initial);
  last = v;
  return <AddressFields regions={REGIONS} value={v} place="checkout" onChange={(x) => setV(x)} />;
}
function show(lang: Lang, initial?: AddressValue) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider lang={lang} setLang={() => undefined}>
        <ConfirmProvider>
          <Host initial={initial} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const events = () => calls.filter((c) => c.url.includes('/analytics/events')).map((c) => c.body as { event: string; props: Record<string, unknown> });
const geocodes = () => calls.filter((c) => c.url.includes('/maps/geocode'));

describe('3.6 address on the Yandex map', () => {
  it('composes one line for the order: street + apartment / entrance / floor + landmark (RU / UZ); old addresses stay as they are', () => {
    const d = { apartment: '5', entrance: '2', floor: '3', landmark: 'напротив школы №5' };
    expect(composeAddress('улица Амира Темура, 107', d, 'ru')).toBe('улица Амира Темура, 107, кв. 5, подъезд 2, этаж 3. Ориентир: напротив школы №5');
    expect(composeAddress('Amir Temur koʻchasi, 107', { ...d, landmark: '' }, 'uz')).toBe('Amir Temur koʻchasi, 107, xonadon 5, podyezd 2, qavat 3');
    expect(composeAddress('ул. Старая, 1', null, 'ru')).toBe('ул. Старая, 1');
    expect(composeAddress('ул. Старая, 1', { apartment: null, entrance: null, floor: null, landmark: null }, 'ru')).toBe('ул. Старая, 1');
  });

  it('no key / switched off / limit: no button, a clear text instead; manual fields still work (RU / UZ)', async () => {
    routes['/maps/config'] = () => ({ available: false, reason: 'no_key', js_api_key: null });
    show('ru');
    expect(await screen.findByText('Карта временно недоступна, введите адрес вручную')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Выбрать на карте/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Улица и дом'), { target: { value: 'ул. Ручная, 5' } });
    expect(last.address_text).toBe('ул. Ручная, 5');
    cleanup();
    show('uz');
    expect(await screen.findByText('Xarita vaqtincha ishlamayapti, manzilni qo‘lda kiriting')).toBeTruthy();
    expect(ymaps.load).not.toHaveBeenCalled();
  });

  it('the map script is loaded only when the map is opened; the start is the centre of Tashkent', async () => {
    show('ru');
    const btn = await screen.findByRole('button', { name: 'Выбрать на карте' });
    expect(ymaps.load).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(ymaps.load).toHaveBeenCalledWith('js-key', 'ru'));
    await waitFor(() => expect(ymaps.created).toHaveLength(1));
    expect(ymaps.created[0].center).toEqual([69.2797, 41.3111]);
    expect(events().map((e) => e.event)).toContain('map_open');
  });

  it('a saved point is the start of the map', async () => {
    show('ru', { ...START, region_id: 'tash', city_id: 'chil', address_text: 'x', point: { lat: 41.28, lon: 69.2 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить точку на карте' }));
    await waitFor(() => expect(ymaps.created).toHaveLength(1));
    expect(ymaps.created[0]).toEqual({ center: [69.2, 41.28], zoom: 17 });
  });

  it('move the map → «Определяем адрес…» → the address; confirm fills the street, region and district by itself', async () => {
    show('ru');
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать на карте' }));
    expect(await screen.findByText('Ташкент, Юнусабадский район, улица Амира Темура, 107')).toBeTruthy();
    // the customer moves the map: the old address is gone while moving, asked again after the stop
    ymaps.listener!({ location: { center: [69.25, 41.32], zoom: 16 }, mapInAction: true });
    expect(await screen.findByText('Двигайте карту — метка остаётся в центре')).toBeTruthy();
    ymaps.listener!({ location: { center: [69.25, 41.32], zoom: 16 }, mapInAction: false });
    await waitFor(() => expect(geocodes()).toHaveLength(2));
    expect(geocodes()[1].url).toContain('lat=41.320000&lon=69.250000&lang=ru');
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить адрес' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(last).toMatchObject({ region_id: 'tash', city_id: 'yunus', address_text: 'улица Амира Темура, 107', point: { lat: 41.32, lon: 69.25 } });
    expect(screen.getByText('Район определён по карте')).toBeTruthy();
    expect(events()).toEqual(
      expect.arrayContaining([
        { event: 'map_confirm', props: { place: 'checkout' } },
        { event: 'map_district_auto', props: { matched: true } },
      ]),
    );
    // apartment and landmark are typed by hand
    fireEvent.change(screen.getByLabelText('Квартира'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Ориентир'), { target: { value: 'школа' } });
    expect(last.details).toEqual({ apartment: '12', entrance: '', floor: '', landmark: 'школа' });
  });

  it('the district is not in our list: the region is set, the district is chosen by hand (UZ)', async () => {
    routes['/maps/geocode'] = () => ({ found: true, outside: false, street_line: '', full_text: 'Samarqand viloyati, Pastdarg‘om tumani', region_id: 'sam', city_id: null });
    show('uz', { ...START, address_text: 'ko‘cha 1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Xaritadan tanlash' }));
    await screen.findByText('Samarqand viloyati, Pastdarg‘om tumani');
    fireEvent.click(screen.getByRole('button', { name: 'Manzilni tasdiqlash' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(last).toMatchObject({ region_id: 'sam', city_id: '', address_text: 'ko‘cha 1' }); // no street from the map: the typed one stays
    expect(screen.getByText('Tuman xaritadan aniqlanmadi — ro‘yxatdan tanlang')).toBeTruthy();
    expect(events()).toEqual(expect.arrayContaining([{ event: 'map_district_auto', props: { matched: false } }]));
  });

  it('«Моё местоположение»: a clear word first; a refusal is explained, the map stays usable', async () => {
    show('ru');
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать на карте' }));
    await screen.findByText('Ташкент, Юнусабадский район, улица Амира Темура, 107');
    fireEvent.click(screen.getByRole('button', { name: /Моё местоположение/ }));
    expect(await screen.findByText(/только чтобы поставить метку доставки/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
    expect(await screen.findByText(/Нет доступа к местоположению/)).toBeTruthy();
    expect(events()).toEqual(expect.arrayContaining([{ event: 'map_locate_me', props: { result: 'denied' } }]));
    expect((screen.getByRole('button', { name: 'Подтвердить адрес' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('«Моё местоположение» found: the map flies there (the explanation is not repeated)', async () => {
    localStorage.setItem('vitalo.locate-explained', '1');
    loc.result = { status: 'ok', lat: 41.35, lon: 69.3 };
    show('ru');
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать на карте' }));
    await screen.findByText('Ташкент, Юнусабадский район, улица Амира Темура, 107');
    fireEvent.click(screen.getByRole('button', { name: /Моё местоположение/ }));
    await waitFor(() => expect(ymaps.updates).toEqual([{ location: { center: [69.3, 41.35], zoom: 17, duration: 300 } }]));
    expect(screen.queryByText(/только чтобы поставить метку/)).toBeNull();
  });

  it('the map does not load (network, key): the map closes, «Карта временно недоступна…», manual entry stays', async () => {
    ymaps.load.mockRejectedValue(new Error('load'));
    show('ru');
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать на карте' }));
    expect(await screen.findByText('Карта временно недоступна, введите адрес вручную')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Улица и дом')).toBeTruthy();
  });

  it('the address cannot be found (Yandex limit): the point can still be confirmed, the street is typed by hand', async () => {
    routes['/maps/geocode'] = () => {
      throw new Error('x');
    };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
      if (url.includes('/maps/geocode')) return new Response(JSON.stringify({ code: 'MAP_UNAVAILABLE', reason: 'limit' }), { status: 503 });
      return new Response(JSON.stringify(url.includes('/maps/config') ? { available: true, reason: null, js_api_key: 'js-key' } : {}));
    });
    show('ru');
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать на карте' }));
    expect(await screen.findByText(/Не удалось определить адрес/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить адрес' }));
    await waitFor(() => expect(last.point).toEqual({ lat: 41.3111, lon: 69.2797 }));
    expect(screen.getByText('Район по карте не определился — выберите его из списка')).toBeTruthy();
  });
});
