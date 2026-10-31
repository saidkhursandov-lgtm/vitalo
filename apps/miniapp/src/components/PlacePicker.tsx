import { useEffect, useId, useState } from 'react';
import { nameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { rankPlaces } from '../lib/place-search';
import type { Region } from '../lib/types';
import { CheckIcon, CloseIcon, SearchIcon } from './Icons';

type Place = { id: string; name_ru: string; name_uz: string | null };
type Choice = { region_id: string; city_id: string };

/**
 * 3.1: region and district are picked in a bottom sheet with a search field on top (RU and UZ, any case, part of a
 * word: «чилан» → Чиланзарский район). Long names wrap instead of being cut. Choosing a region opens its districts
 * straight away; the region search also finds districts, so «чилан» picks both at once.
 */
export function RegionCitySelect({ regions, regionId, cityId, onChange }: { regions: Region[]; regionId: string; cityId: string; onChange: (v: Choice) => void }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState<'region' | 'city' | null>(null);
  const ids = useId();
  const region = regions.find((r) => r.id === regionId);
  const city = region?.cities.find((c) => c.id === cityId);
  return (
    <div className="field-row region-city">
      <div className="field">
        <span id={`${ids}-r`}>{t('checkout.region')}</span>
        <button type="button" className={`picker-btn ${region ? '' : 'is-empty'}`} aria-haspopup="dialog" aria-labelledby={`${ids}-r ${ids}-rv`} onClick={() => setOpen('region')}>
          <span id={`${ids}-rv`}>{region ? nameOf(region, lang) : t('checkout.choose')}</span>
        </button>
      </div>
      <div className="field">
        <span id={`${ids}-c`}>{t('checkout.city')}</span>
        <button type="button" className={`picker-btn ${city ? '' : 'is-empty'}`} disabled={!region} aria-haspopup="dialog" aria-labelledby={`${ids}-c ${ids}-cv`} onClick={() => setOpen('city')}>
          <span id={`${ids}-cv`}>{city ? nameOf(city, lang) : t('checkout.choose')}</span>
        </button>
      </div>
      {open === 'region' && (
        <PlaceSheet
          title={t('place.regionTitle')}
          items={regions}
          selected={[regionId, `${regionId}/${cityId}`]}
          extra={(q) =>
            q.trim().length >= 2
              ? regions.flatMap((r) => rankPlaces(r.cities, q, (c) => nameOf(c, lang), lang).map((c) => ({ ...c, id: `${r.id}/${c.id}`, hint: nameOf(r, lang) })))
              : []
          }
          onClose={() => setOpen(null)}
          onPick={(id) => {
            if (id.includes('/')) {
              const [region_id, city_id] = id.split('/');
              onChange({ region_id, city_id });
              return setOpen(null);
            }
            const picked = regions.find((r) => r.id === id);
            // a region with one district: take it without asking
            if (picked?.cities.length === 1) {
              onChange({ region_id: id, city_id: picked.cities[0].id });
              return setOpen(null);
            }
            if (id !== regionId) onChange({ region_id: id, city_id: '' });
            setOpen('city');
          }}
        />
      )}
      {open === 'city' && region && (
        <PlaceSheet
          title={nameOf(region, lang)}
          items={region.cities}
          selected={[cityId]}
          onClose={() => setOpen(null)}
          onPick={(id) => {
            onChange({ region_id: region.id, city_id: id });
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

function PlaceSheet({
  title,
  items,
  selected,
  extra,
  onPick,
  onClose,
}: {
  title: string;
  items: Place[];
  selected: string[];
  extra?: (query: string) => (Place & { hint: string })[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState('');
  const list = rankPlaces(items, query, (x) => nameOf(x, lang), lang);
  const more = extra?.(query) ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = (p: Place, hint?: string) => {
    const on = selected.includes(p.id);
    return (
    <li key={p.id}>
      <button type="button" className={`place-row ${on ? 'is-on' : ''}`} aria-current={on || undefined} onClick={() => onPick(p.id)}>
        <span>
          {nameOf(p, lang)}
          {hint && <span className="hint small block">{hint}</span>}
        </span>
        {on && <CheckIcon width={20} height={20} />}
      </button>
    </li>
    );
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet place-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <label className="place-search">
          <SearchIcon width={18} height={18} aria-hidden />
          <input className="place-input" type="search" enterKeyHint="search" autoComplete="off" placeholder={t('place.search')} aria-label={t('place.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <ul className="sheet-body place-list">
          {list.map((p) => row(p))}
          {more.length > 0 && <li className="place-group hint small">{t('place.districts')}</li>}
          {more.map((p) => row(p, p.hint))}
          {list.length === 0 && more.length === 0 && <li className="hint place-empty">{t('place.nothing')}</li>}
        </ul>
      </div>
    </div>
  );
}
