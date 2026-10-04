import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, isNetworkError, onNetworkChange, REQUEST_TIMEOUT_MS } from './lib/api';
import { errorText } from './lib/i18n';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requests never hang (D1)', () => {
  it('no answer for 15 s -> NETWORK_TIMEOUT, the "no connection" banner is told', async () => {
    vi.useFakeTimers();
    // A server that never answers; the request is aborted by our timer.
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const events: boolean[] = [];
    const off = onNetworkChange((offline) => events.push(offline));
    const p = api('/catalog/products').catch((e) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    const err = (await p) as ApiError;
    off();
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_TIMEOUT' });
    expect(isNetworkError(err)).toBe(true);
    expect(events).toEqual([true]);
    expect(errorText('uz', err.code)).toContain('15 soniya');
  });

  it('connection lost -> NETWORK_ERROR; any answer hides the banner again', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const events: boolean[] = [];
    const off = onNetworkChange((offline) => events.push(offline));
    await expect(api('/orders', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(api('/catalog/texts')).resolves.toEqual({ ok: true });
    off();
    expect(events).toEqual([true, false]);
  });

  it('4xx answers stay normal errors (not "no connection")', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ code: 'OUT_OF_STOCK' }), { status: 409 })));
    const err = await api('/orders', { method: 'POST', body: {} }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'OUT_OF_STOCK' });
    expect(isNetworkError(err)).toBe(false);
  });
});
