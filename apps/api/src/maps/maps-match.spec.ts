import { districtBase, insideUzbekistan, matchPlace, parseGeocoder, regionKey, sameStem, yandexMapsLink, type GeoComponent, type PlaceRegion } from './maps-match';

const c = (kind: string, name: string): GeoComponent => ({ kind, name });

const REGIONS: PlaceRegion[] = [
  {
    id: 'tash-city',
    name_ru: 'г. Ташкент',
    name_uz: 'Toshkent shahri',
    cities: [
      { id: 'chilonzor', name_ru: 'Чиланзарский район', name_uz: 'Chilonzor tumani' },
      { id: 'mirzo', name_ru: 'Мирзо-Улугбекский район', name_uz: 'Mirzo Ulug‘bek tumani' },
      { id: 'yunusobod', name_ru: 'Юнусабадский район', name_uz: 'Yunusobod tumani' },
    ],
  },
  {
    id: 'tash-obl',
    name_ru: 'Ташкентская область',
    name_uz: 'Toshkent viloyati',
    cities: [
      { id: 'chirchiq', name_ru: 'Чирчик', name_uz: 'Chirchiq' },
      { id: 'yangiyol', name_ru: 'Янгиюль', name_uz: 'Yangiyo‘l' },
    ],
  },
  {
    id: 'samarqand',
    name_ru: 'Самаркандская область',
    name_uz: 'Samarqand viloyati',
    cities: [
      { id: 'sam', name_ru: 'Самарканд', name_uz: 'Samarqand' },
      { id: 'urgut', name_ru: 'Ургут', name_uz: 'Urgut' },
    ],
  },
  { id: 'kk', name_ru: 'Республика Каракалпакстан', name_uz: 'Qoraqalpog‘iston Respublikasi', cities: [{ id: 'nukus', name_ru: 'Нукус', name_uz: 'Nukus' }] },
];

describe('3.6 maps: region and district from the geocoder', () => {
  it('Tashkent city, Chilanzar — in Russian and in Uzbek', () => {
    const ru = [c('country', 'Узбекистан'), c('province', 'Ташкент'), c('locality', 'Ташкент'), c('district', 'Чиланзарский район'), c('district', 'махаллинский сход граждан Катартал'), c('house', '1Б')];
    const uz = [c('country', 'Oʻzbekiston'), c('province', 'Toshkent'), c('locality', 'Toshkent'), c('district', 'Chilonzor tumani'), c('district', 'Qatortol mahalla fuqarolar yigʻini'), c('house', '1Б')];
    expect(matchPlace(ru, REGIONS)).toEqual({ region_id: 'tash-city', city_id: 'chilonzor' });
    expect(matchPlace(uz, REGIONS)).toEqual({ region_id: 'tash-city', city_id: 'chilonzor' });
  });

  it('apostrophes and hyphens do not matter (Mirzo Ulugʻbek / Мирзо-Улугбекский)', () => {
    expect(matchPlace([c('province', 'Toshkent'), c('district', 'Mirzo Ulugʻbek tumani')], REGIONS).city_id).toBe('mirzo');
    expect(matchPlace([c('province', 'Ташкент'), c('district', 'Мирзо-Улугбекский район')], REGIONS).city_id).toBe('mirzo');
  });

  it('the city of Tashkent is not confused with Tashkent region', () => {
    expect(matchPlace([c('province', 'Ташкентская область'), c('locality', 'Чирчик')], REGIONS)).toEqual({ region_id: 'tash-obl', city_id: 'chirchiq' });
    expect(matchPlace([c('province', 'Toshkent viloyati'), c('locality', 'Chirchiq')], REGIONS)).toEqual({ region_id: 'tash-obl', city_id: 'chirchiq' });
    expect(matchPlace([c('province', 'Toshkent'), c('locality', 'Toshkent')], REGIONS)).toEqual({ region_id: 'tash-city', city_id: null });
  });

  it('a town of a region: by the locality or by «…ский район»', () => {
    expect(matchPlace([c('province', 'Самаркандская область'), c('area', 'Самарканд'), c('locality', 'Самарканд')], REGIONS).city_id).toBe('sam');
    expect(matchPlace([c('province', 'Самаркандская область'), c('area', 'Ургутский район'), c('locality', 'кишлак Кенгкуль')], REGIONS).city_id).toBe('urgut');
    expect(matchPlace([c('province', 'Республика Каракалпакстан'), c('locality', 'Нукус')], REGIONS)).toEqual({ region_id: 'kk', city_id: 'nukus' });
  });

  it('a district we do not have: region only — the customer picks the district by hand', () => {
    expect(matchPlace([c('province', 'Ташкентская область'), c('area', 'Кибрайский район'), c('locality', 'махаллинский сход граждан Маърифат')], REGIONS)).toEqual({ region_id: 'tash-obl', city_id: null });
  });

  it('nothing known: neither region nor district', () => {
    expect(matchPlace([c('country', 'Казахстан'), c('province', 'Туркестанская область')], REGIONS)).toEqual({ region_id: null, city_id: null });
    expect(matchPlace([], REGIONS)).toEqual({ region_id: null, city_id: null });
  });

  it('helpers', () => {
    expect(regionKey('г. Ташкент')).toEqual({ type: 'city', base: 'ташкент' });
    expect(regionKey('Toshkent viloyati')).toEqual({ type: 'oblast', base: 'toshkent' });
    expect(districtBase('Yangiyo‘l')).toBe('yangiyol');
    expect(sameStem('ургутский', 'ургут')).toBe(true);
    expect(sameStem('чуст', 'чустский')).toBe(true);
    expect(sameStem('янгиер', 'янгиюль')).toBe(false);
    expect(sameStem('абв', 'абвгд')).toBe(false); // too short to be sure
    expect(insideUzbekistan(41.3, 69.24)).toBe(true);
    expect(insideUzbekistan(55.75, 37.62)).toBe(false); // Moscow
    expect(yandexMapsLink(41.2995, 69.2401)).toBe('https://yandex.uz/maps/?pt=69.240100,41.299500&z=17&l=map');
  });
});

describe('3.6 maps: reading the geocoder answer', () => {
  const answer = (components: GeoComponent[]) => ({
    response: { GeoObjectCollection: { featureMember: [{ GeoObject: { name: 'x', metaDataProperty: { GeocoderMetaData: { Address: { formatted: 'f', Components: components } } } } }] } },
  });

  it('street and house', () => {
    const r = parseGeocoder(answer([c('country', 'Узбекистан'), c('province', 'Самаркандская область'), c('area', 'Самарканд'), c('locality', 'Самарканд'), c('street', 'улица Амира Темура'), c('house', '18А')]));
    expect(r?.street_line).toBe('улица Амира Темура, 18А');
    expect(r?.full_text).toBe('Самаркандская область, Самарканд, улица Амира Темура, 18А');
  });

  it('no street: the mahalla and the house; the city name is not repeated', () => {
    const r = parseGeocoder(answer([c('country', 'Узбекистан'), c('province', 'Ташкент'), c('locality', 'Ташкент'), c('district', 'Чиланзарский район'), c('district', 'махаллинский сход граждан Катартал'), c('house', '1Б')]));
    expect(r?.street_line).toBe('махаллинский сход граждан Катартал, 1Б');
    expect(r?.full_text).toBe('Ташкент, Чиланзарский район, махаллинский сход граждан Катартал, 1Б');
  });

  it('only the city: no street line', () => {
    expect(parseGeocoder(answer([c('country', 'Узбекистан'), c('province', 'Ташкент'), c('locality', 'Ташкент')]))?.street_line).toBe('');
  });

  it('empty or broken answer', () => {
    expect(parseGeocoder({ response: { GeoObjectCollection: { featureMember: [] } } })).toBeNull();
    expect(parseGeocoder(null)).toBeNull();
    expect(parseGeocoder({ statusCode: 403, message: 'Invalid api key' })).toBeNull();
  });
});
