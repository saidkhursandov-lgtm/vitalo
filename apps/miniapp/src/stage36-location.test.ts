import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocation } from './lib/telegram';

/** 3.6: «Моё местоположение» goes through the platform adapter: Telegram's LocationManager inside Telegram, else the browser. */
function inTelegram(lm: object, version = '8.0') {
  vi.stubGlobal('Telegram', { WebApp: { initData: 'x', isVersionAtLeast: (v: string) => Number(v) <= Number(version), LocationManager: lm } });
  (window as unknown as { Telegram: unknown }).Telegram = (globalThis as unknown as { Telegram: unknown }).Telegram;
}
function browser(impl: ((ok: PositionCallback, fail: PositionErrorCallback) => void) | null) {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: impl ? { getCurrentPosition: impl } : undefined });
  if (!impl) delete (navigator as unknown as { geolocation?: unknown }).geolocation;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
  browser(null);
});

describe('3.6 location through the adapter', () => {
  it('Telegram 8.0+: its LocationManager (init first), the point comes back', async () => {
    const lm = { isInited: false, isLocationAvailable: true, isAccessRequested: false, isAccessGranted: false, init: vi.fn((cb: () => void) => cb()), getLocation: vi.fn((cb: (d: unknown) => void) => cb({ latitude: 41.3, longitude: 69.2 })) };
    inTelegram(lm);
    expect(await getLocation()).toEqual({ status: 'ok', lat: 41.3, lon: 69.2 });
    expect(lm.init).toHaveBeenCalled();
  });

  it('Telegram: refused before or now → denied; no location on the device → unavailable', async () => {
    inTelegram({ isInited: true, isLocationAvailable: true, isAccessRequested: true, isAccessGranted: false, init: vi.fn(), getLocation: vi.fn() });
    expect(await getLocation()).toEqual({ status: 'denied' });
    inTelegram({ isInited: true, isLocationAvailable: true, isAccessRequested: false, isAccessGranted: false, init: vi.fn(), getLocation: (cb: (d: null) => void) => cb(null) });
    expect(await getLocation()).toEqual({ status: 'denied' });
    inTelegram({ isInited: true, isLocationAvailable: false, isAccessRequested: false, isAccessGranted: false, init: vi.fn(), getLocation: vi.fn() });
    expect(await getLocation()).toEqual({ status: 'unavailable' });
  });

  it('outside Telegram: the browser; a refusal is denied, other errors are unavailable', async () => {
    browser((ok) => ok({ coords: { latitude: 40.1, longitude: 65.4 } } as GeolocationPosition));
    expect(await getLocation()).toEqual({ status: 'ok', lat: 40.1, lon: 65.4 });
    browser((_ok, fail) => fail!({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError));
    expect(await getLocation()).toEqual({ status: 'denied' });
    browser((_ok, fail) => fail!({ code: 3, PERMISSION_DENIED: 1 } as GeolocationPositionError));
    expect(await getLocation()).toEqual({ status: 'unavailable' });
    browser(null);
    expect(await getLocation()).toEqual({ status: 'unavailable' });
  });
});

describe('3.8 fix: a quick point first, the precise one later', () => {
  type Impl = (ok: PositionCallback, fail: PositionErrorCallback | null | undefined, o?: PositionOptions) => void;
  const pos = (lat: number, lon: number) => ({ coords: { latitude: lat, longitude: lon } }) as GeolocationPosition;

  it('the rough point comes at once (3 s, a minute-old one is fine); a precise one far enough away moves the map', async () => {
    const asked: PositionOptions[] = [];
    browser(((ok, _f, o) => {
      asked.push(o!);
      ok(o!.enableHighAccuracy ? pos(41.3105, 69.2797) : pos(41.31, 69.28));
    }) as Impl);
    const refined = vi.fn();
    expect(await getLocation(refined)).toEqual({ status: 'ok', lat: 41.31, lon: 69.28 });
    expect(asked[0]).toMatchObject({ enableHighAccuracy: false, timeout: 3000, maximumAge: 60_000 });
    expect(asked[1]).toMatchObject({ enableHighAccuracy: true });
    await vi.waitFor(() => expect(refined).toHaveBeenCalledWith({ lat: 41.3105, lon: 69.2797 }));
  });

  it('a precise point a few metres away does not move the map', async () => {
    browser(((ok, _f, o) => ok(o!.enableHighAccuracy ? pos(41.31001, 69.28001) : pos(41.31, 69.28))) as Impl);
    const refined = vi.fn();
    await getLocation(refined);
    await new Promise((r) => setTimeout(r, 10));
    expect(refined).not.toHaveBeenCalled();
  });

  it('no quick point (timeout): the precise one is waited for; a refusal stops at once', async () => {
    browser(((ok, fail, o) => (o!.enableHighAccuracy ? ok(pos(40.1, 65.4)) : fail!({ code: 3, PERMISSION_DENIED: 1 } as GeolocationPositionError))) as Impl);
    expect(await getLocation()).toEqual({ status: 'ok', lat: 40.1, lon: 65.4 });
    let calls = 0;
    browser(((_ok, fail) => {
      calls++;
      fail!({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    }) as Impl);
    expect(await getLocation()).toEqual({ status: 'denied' });
    expect(calls).toBe(1);
  });
});
