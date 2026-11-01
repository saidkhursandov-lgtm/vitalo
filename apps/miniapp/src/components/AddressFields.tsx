import { useState } from 'react';
import type { AddressDetails } from '../lib/address';
import { useI18n } from '../lib/i18n';
import type { MapPick } from '../lib/queries';
import type { Region } from '../lib/types';
import { MapPickerButton, type MapPlace } from './MapPicker';
import { RegionCitySelect } from './PlacePicker';

export interface AddressValue {
  region_id: string;
  city_id: string;
  address_text: string;
  details: AddressDetails;
  /** the point chosen on the map; null = typed by hand */
  point: { lat: number; lon: number } | null;
}

/**
 * 3.6: one address form for the checkout («Новый адрес») and Профиль → Адреса: «Выбрать на карте», region and district,
 * street and house, apartment / entrance / floor and landmark. After the map the district is taken from the map when
 * it is in our list; otherwise the customer picks it, as before. Manual entry works without the map.
 */
export function AddressFields({
  regions,
  value,
  onChange,
  errors = {},
  place,
}: {
  regions: Region[];
  value: AddressValue;
  onChange: (v: AddressValue, why: 'map' | 'city' | 'text') => void;
  errors?: { city_id?: string; address_text?: string };
  place: MapPlace;
}) {
  const { t } = useI18n();
  const [mapNote, setMapNote] = useState<'auto' | 'manual' | null>(null);
  const setDetail = (k: keyof AddressDetails, v: string) => onChange({ ...value, details: { ...value.details, [k]: v } }, 'text');

  function picked(p: MapPick) {
    const matched = !!(p.region_id && p.city_id);
    setMapNote(matched ? 'auto' : 'manual');
    onChange(
      {
        ...value,
        point: { lat: p.lat, lon: p.lon },
        address_text: p.street_line || value.address_text,
        // a matched district replaces the old one; only the region known: the district is picked by hand
        ...(matched ? { region_id: p.region_id!, city_id: p.city_id! } : p.region_id ? { region_id: p.region_id, city_id: p.region_id === value.region_id ? value.city_id : '' } : {}),
      },
      'map',
    );
  }

  return (
    <>
      <MapPickerButton place={place} start={value.point} chosen={!!value.point} onPick={picked} />
      {mapNote && <p className={`hint small map-note ${mapNote === 'auto' ? 'is-ok' : ''}`}>{mapNote === 'auto' ? t('map.districtAuto') : t('map.districtManual')}</p>}
      <RegionCitySelect
        regions={regions}
        regionId={value.region_id}
        cityId={value.city_id}
        onChange={(v) => {
          if (mapNote === 'manual' && v.city_id) setMapNote(null);
          onChange({ ...value, ...v }, 'city');
        }}
      />
      {errors.city_id && <small className="error-text">{errors.city_id}</small>}
      <label className="field">
        <span>{t('address.street')}</span>
        <input autoComplete="street-address" maxLength={300} value={value.address_text} onChange={(e) => onChange({ ...value, address_text: e.target.value }, 'text')} aria-invalid={!!errors.address_text} />
        {errors.address_text && <small className="error-text">{errors.address_text}</small>}
      </label>
      <div className="addr-details">
        <label className="field">
          <span>{t('address.apartment')}</span>
          <input maxLength={20} value={value.details.apartment} onChange={(e) => setDetail('apartment', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('address.entrance')}</span>
          <input maxLength={20} value={value.details.entrance} onChange={(e) => setDetail('entrance', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('address.floor')}</span>
          <input maxLength={20} value={value.details.floor} onChange={(e) => setDetail('floor', e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>{t('address.landmark')}</span>
        <input maxLength={200} placeholder={t('address.landmarkHint')} value={value.details.landmark} onChange={(e) => setDetail('landmark', e.target.value)} />
      </label>
    </>
  );
}
