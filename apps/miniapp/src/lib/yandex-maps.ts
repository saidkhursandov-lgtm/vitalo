/**
 * 3.6: Yandex Maps JavaScript API 3.0, loaded only when the customer opens the map (the home screen never loads it).
 * Only the few parts we use are typed. The logo, the copyrights and «Открыть в Картах» of Yandex stay on the map
 * as the terms require — nothing here hides them.
 */
export type LngLat = [number, number];

export interface YMapLocation {
  center: LngLat;
  zoom: number;
}

export interface YMapInstance {
  readonly center: LngLat;
  addChild(child: unknown): YMapInstance;
  update(props: { location?: Partial<YMapLocation> & { duration?: number } }): void;
  destroy(): void;
}

export interface Ymaps3 {
  ready: Promise<void>;
  YMap: new (el: HTMLElement, props: { location: YMapLocation; showScaleInCopyrights?: boolean }) => YMapInstance;
  YMapDefaultSchemeLayer: new (props?: object) => unknown;
  YMapDefaultFeaturesLayer: new (props?: object) => unknown;
  YMapListener: new (props: { onUpdate?: (e: { location: YMapLocation; mapInAction: boolean }) => void; onActionStart?: () => void; onActionEnd?: () => void }) => unknown;
}

declare global {
  interface Window {
    ymaps3?: Ymaps3;
  }
}

const LOAD_TIMEOUT_MS = 15_000;
let loading: Promise<Ymaps3> | null = null;
let loadedLang: string | null = null;

function inject(key: string, lang: string): Promise<Ymaps3> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=${lang}`;
    script.async = true;
    script.dataset.ymaps = lang;
    const timer = setTimeout(() => fail(new Error('timeout')), LOAD_TIMEOUT_MS);
    function fail(e: Error) {
      clearTimeout(timer);
      script.remove();
      reject(e);
    }
    script.onerror = () => fail(new Error('load'));
    script.onload = () => {
      const api = window.ymaps3;
      if (!api) return fail(new Error('no ymaps3')); // e.g. Yandex answered «Invalid api key» instead of the script
      api.ready.then(() => {
        clearTimeout(timer);
        resolve(api);
      }, fail);
    };
    document.head.appendChild(script);
  });
}

/**
 * The map API in the shop language. Uzbek map labels when Yandex gives them (uz_UZ), otherwise Russian ones —
 * our own buttons and texts are in the shop language anyway. Rejects when the map cannot be loaded at all.
 */
export function loadYmaps(key: string, lang: 'ru' | 'uz'): Promise<Ymaps3> {
  const wanted = lang === 'uz' ? 'uz_UZ' : 'ru_RU';
  if (loading && (loadedLang === wanted || window.ymaps3)) return loading; // the script is loaded once per page
  loadedLang = wanted;
  loading = inject(key, wanted).catch((e) => {
    if (wanted === 'ru_RU') throw e;
    loadedLang = 'ru_RU';
    return inject(key, 'ru_RU');
  });
  loading.catch(() => {
    loading = null; // a later opening tries again (the network may be back)
    loadedLang = null;
  });
  return loading;
}

/** For tests. */
export function resetYmapsLoader() {
  loading = null;
  loadedLang = null;
}
