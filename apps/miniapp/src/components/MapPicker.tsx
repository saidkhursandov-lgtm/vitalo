import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../lib/api';
import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import { useMapConfig, type MapConfig, type MapPick } from '../lib/queries';
import { getLocation, haptic } from '../lib/telegram';
import { loadYmaps, type LngLat, type YMapInstance } from '../lib/yandex-maps';
import { useConfirm } from './Confirm';
import { CloseIcon, LocateIcon, MapIcon, PinIcon } from './Icons';

export type MapPlace = 'checkout' | 'profile' | 'cart';

/** Amir Temur square: the map starts here when the customer has no saved point. */
export const TASHKENT_CENTER = { lat: 41.3111, lon: 69.2797 };
/** The address is asked once the map has stood still this long (fewer geocoder requests). */
const SETTLE_MS = 600;
const LOCATE_ASKED_KEY = 'vitalo.locate-explained';

interface GeocodeAnswer {
  found: boolean;
  outside: boolean;
  street_line: string;
  full_text: string;
  region_id: string | null;
  city_id: string | null;
}

/**
 * 3.6: «Выбрать на карте» / «Xaritadan tanlash». When the map cannot work (switched off, no key, the daily limit, the
 * script did not load) the button is replaced by «Карта временно недоступна, введите адрес вручную» — the manual
 * fields stay usable in every case.
 */
export function MapPickerButton({ place, start, chosen, onPick }: { place: MapPlace; start?: { lat: number; lon: number } | null; chosen?: boolean; onPick: (p: MapPick) => void }) {
  const { t } = useI18n();
  const config = useMapConfig();
  const client = useQueryClient();
  // the key of the map script comes with each opening: the server counts it against the 100 free loads a day
  const [key, setKey] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const off = () => client.setQueryData<MapConfig>(['map-config'], { available: false, reason: null });
  if (config.isPending) return null;
  if (!config.data?.available) return <p className="hint small map-off">{t('map.unavailable')}</p>;

  async function openMap() {
    setNotice(null);
    setOpening(true);
    try {
      const r = await api<{ js_api_key: string }>('/maps/open', { method: 'POST' });
      track('map_open', { place });
      setKey(r.js_api_key);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MAP_TOO_MANY') setNotice(t('map.tooManyOpens'));
      else off(); // limit, switched off, no key or no network: manual entry
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary btn-block map-btn" disabled={opening} onClick={() => void openMap()}>
        <MapIcon width={18} height={18} aria-hidden /> {chosen ? t('map.change') : t('map.choose')}
      </button>
      {notice && <p className="hint small map-off">{notice}</p>}
      {key && (
        <MapScreen
          apiKey={key}
          start={start ?? null}
          onClose={() => setKey(null)}
          onFail={() => {
            setKey(null);
            // the script did not load (network, key): no button until the config is asked again
            off();
          }}
          onConfirm={(p) => {
            setKey(null);
            track('map_confirm', { place });
            track('map_district_auto', { matched: !!p.city_id });
            onPick(p);
          }}
        />
      )}
    </>
  );
}

type AddressState = { kind: 'idle' } | { kind: 'moving' } | { kind: 'loading' } | { kind: 'done'; answer: GeocodeAnswer } | { kind: 'error' };

export function MapScreen({
  apiKey,
  start,
  onClose,
  onFail,
  onConfirm,
}: {
  apiKey: string;
  start: { lat: number; lon: number } | null;
  onClose: () => void;
  onFail: () => void;
  onConfirm: (p: MapPick) => void;
}) {
  const { t, lang } = useI18n();
  const confirm = useConfirm();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<YMapInstance | null>(null);
  const center = useRef<LngLat>([(start ?? TASHKENT_CENTER).lon, (start ?? TASHKENT_CENTER).lat]);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [ready, setReady] = useState(false);
  const [address, setAddress] = useState<AddressState>({ kind: 'idle' });
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function lookUp([lon, lat]: LngLat) {
    const my = ++seq.current;
    setAddress({ kind: 'loading' });
    try {
      const answer = await api<GeocodeAnswer>(`/maps/geocode?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&lang=${lang}`);
      if (my === seq.current) setAddress({ kind: 'done', answer });
    } catch (e) {
      if (my !== seq.current) return;
      setAddress({ kind: 'error' });
      if (e instanceof ApiError && e.code === 'MAP_TOO_MANY') setNotice(t('map.tooMany'));
    }
  }

  // the map is created once; every stop of the map asks the address of the point under the pin
  useEffect(() => {
    let alive = true;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    loadYmaps(apiKey, lang)
      .then((ymaps) => {
        if (!alive || !box.current) return;
        const m = new ymaps.YMap(box.current, { location: { center: center.current, zoom: start ? 17 : 13 } });
        m.addChild(new ymaps.YMapDefaultSchemeLayer());
        m.addChild(new ymaps.YMapDefaultFeaturesLayer());
        m.addChild(
          new ymaps.YMapListener({
            onUpdate: ({ location, mapInAction }) => {
              center.current = location.center;
              clearTimeout(timer.current);
              if (mapInAction) {
                seq.current++; // an answer for the old point is not shown any more
                setAddress({ kind: 'moving' });
                return;
              }
              timer.current = setTimeout(() => void lookUp(location.center), SETTLE_MS);
            },
          }),
        );
        map.current = m;
        setReady(true);
        void lookUp(center.current);
      })
      .catch(() => alive && onFail());
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      clearTimeout(timer.current);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      map.current?.destroy();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once for this opening
  }, []);

  async function locate() {
    setNotice(null);
    // a clear word before the system dialog: why the shop asks (once per phone)
    let explained = false;
    try {
      explained = localStorage.getItem(LOCATE_ASKED_KEY) === '1';
    } catch {
      // storage blocked: explain every time
    }
    if (!explained) {
      const ok = await confirm({ message: t('map.locateWhy'), ok: t('map.allow'), cancel: t('map.notNow') });
      if (!ok) return;
      try {
        localStorage.setItem(LOCATE_ASKED_KEY, '1');
      } catch {
        // ignore
      }
    }
    setLocating(true);
    const r = await getLocation();
    setLocating(false);
    track('map_locate_me', { result: r.status });
    if (r.status === 'ok') {
      center.current = [r.lon, r.lat];
      map.current?.update({ location: { center: [r.lon, r.lat], zoom: 17, duration: 300 } });
      return;
    }
    haptic('warning');
    setNotice(r.status === 'denied' ? t('map.locateDenied') : t('map.locateFailed'));
  }

  const answer = address.kind === 'done' ? address.answer : null;
  const line =
    address.kind === 'moving' || address.kind === 'idle'
      ? t('map.hint')
      : address.kind === 'loading'
        ? t('map.detecting')
        : address.kind === 'error'
          ? t('map.notFound')
          : answer!.outside
            ? t('map.outside')
            : answer!.found
              ? answer!.full_text
              : t('map.notFound');
  const canConfirm = ready && !locating && (address.kind === 'done' ? !address.answer.outside : address.kind === 'error');

  return createPortal(
    <div className="map-screen" role="dialog" aria-modal="true" aria-label={t('map.title')}>
      <div className="map-top">
        <h2>{t('map.title')}</h2>
        <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="map-canvas">
        <div ref={box} className="map-box" data-testid="map-box" />
        <div className={`map-pin ${address.kind === 'moving' ? 'is-moving' : ''}`} aria-hidden>
          <PinIcon width={40} height={40} />
        </div>
        {!ready && <div className="map-loading">{t('common.loading')}</div>}
        {/* on the map, top right: the Yandex logo and copyrights at the bottom stay visible */}
        <button type="button" className="map-locate" disabled={!ready || locating} onClick={() => void locate()}>
          <LocateIcon width={18} height={18} aria-hidden /> {locating ? t('map.locating') : t('map.locate')}
        </button>
      </div>
      <div className="map-panel">
        <p className={`map-address ${answer?.found ? '' : 'is-muted'}`} aria-live="polite">
          {line}
        </p>
        {notice && <p className="map-notice">{notice}</p>}
        <button
          type="button"
          className="btn btn-block"
          disabled={!canConfirm}
          onClick={() => {
            const [lon, lat] = center.current;
            onConfirm({ lat, lon, street_line: answer?.street_line ?? '', region_id: answer?.region_id ?? null, city_id: answer?.city_id ?? null });
          }}
        >
          {t('map.confirm')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
