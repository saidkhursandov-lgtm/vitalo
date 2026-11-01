/**
 * 3.6: «Адрес на Яндекс Карте». Pure helpers: read the answer of Yandex Geocoder (HTTP API 1.x) and find our region and
 * district for it. Nothing from the answer is stored by the shop: the customer confirms or edits the street, and the
 * region / district are picked from OUR list (Yandex terms, п. 5.1.6).
 */

export interface GeoComponent {
  kind: string; // country | province | area | locality | district | street | house | …
  name: string;
}

export interface GeocodeResult {
  /** «улица Бунёдкор, 12» — what goes into the street field; '' when Yandex knows no street there */
  street_line: string;
  /** the whole address without the country, shown under the map */
  full_text: string;
  components: GeoComponent[];
}

interface YandexGeoObject {
  name?: string;
  metaDataProperty?: { GeocoderMetaData?: { text?: string; Address?: { formatted?: string; Components?: GeoComponent[] } } };
}

/** The first object of a geocoder answer, or null when Yandex found nothing at this point. */
export function parseGeocoder(json: unknown): GeocodeResult | null {
  const members = (json as { response?: { GeoObjectCollection?: { featureMember?: { GeoObject?: YandexGeoObject }[] } } })?.response?.GeoObjectCollection
    ?.featureMember;
  const geo = members?.[0]?.GeoObject;
  const address = geo?.metaDataProperty?.GeocoderMetaData?.Address;
  if (!geo || !address) return null;
  const components = (address.Components ?? []).filter((c) => c && typeof c.kind === 'string' && typeof c.name === 'string');
  // No street (much of Tashkent is «махалля + дом»): the most precise place below the city — the mahalla, a district
  const big = new Set(components.filter((c) => c.kind === 'province' || c.kind === 'area').map((c) => c.name));
  const street =
    components.filter((c) => c.kind === 'street').at(-1)?.name ??
    components.filter((c) => (c.kind === 'district' || c.kind === 'locality') && !big.has(c.name)).at(-1)?.name;
  const house = components.find((c) => c.kind === 'house')?.name;
  const street_line = street ? (house ? `${street}, ${house}` : street) : '';
  const full_text = components
    .filter((c) => c.kind !== 'country')
    .map((c) => c.name)
    .filter((n, i, all) => all.indexOf(n) === i) // «Ташкент» comes as the province and as the locality
    .join(', ');
  return { street_line, full_text: full_text || address.formatted || geo.name || '', components };
}

export interface PlaceRegion {
  id: string;
  name_ru: string;
  name_uz: string | null;
  cities: { id: string; name_ru: string; name_uz: string | null }[];
}

export interface PlaceMatch {
  region_id: string | null;
  city_id: string | null;
}

type RegionType = 'oblast' | 'republic' | 'city';

const APOSTROPHES = /[‘’ʻʼ'`´]/g;

function clean(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(APOSTROPHES, '').replace(/[-–—.,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

const OBLAST_WORDS = ['область', 'viloyati', 'viloyat'];
const REPUBLIC_WORDS = ['республика', 'respublikasi', 'respublika'];
const CITY_WORDS = ['г', 'город', 'shahri', 'shahar', 'sh'];
/** Words that do not tell one district from another. */
const DISTRICT_WORDS = ['район', 'tumani', 'tuman', 'массив', 'mavzesi', 'mavze', 'город', 'г', 'shahri', 'shahar', 'посёлок', 'поселок', 'кишлак', 'qishlogi', 'микрорайон', 'mahallasi'];

/** «Ташкентская область» → oblast «ташкентская»; «г. Ташкент» / «Toshkent shahri» / «Toshkent» → city «ташкент». */
export function regionKey(name: string): { type: RegionType; base: string } {
  const words = clean(name).split(' ');
  const has = (list: string[]) => words.some((w) => list.includes(w));
  const type: RegionType = has(OBLAST_WORDS) ? 'oblast' : has(REPUBLIC_WORDS) ? 'republic' : 'city';
  const base = words.filter((w) => ![...OBLAST_WORDS, ...REPUBLIC_WORDS, ...CITY_WORDS].includes(w)).join(' ');
  return { type, base };
}

export function districtBase(name: string): string {
  return clean(name)
    .split(' ')
    .filter((w) => !DISTRICT_WORDS.includes(w))
    .join(' ');
}

/** Same word, or one is the beginning of the other (Russian endings: «ургутский» ~ «ургут»), at least 4 letters. */
export function sameStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function regionMatches(component: string, region: PlaceRegion): boolean {
  const c = regionKey(component);
  return [region.name_ru, region.name_uz].some((n) => {
    if (!n) return false;
    const r = regionKey(n);
    return r.type === c.type && sameStem(r.base, c.base);
  });
}

/** «Андижанский район» / «Andijon tumani» — a district; «Андижан» — a city. */
function isDistrictName(name: string): boolean {
  return /(^|\s)(район|tumani|tuman)(\s|$)/i.test(name);
}

/** Most precise first: «Чиланзарский район» before the city «Ташкент». */
const DISTRICT_KINDS = ['district', 'area', 'locality'];

/**
 * Our region and district for the geocoder components. The region comes from the «province» component (Tashkent city is
 * a province of its own in Yandex); the district from district / area / locality inside that region, in both languages.
 * A district we do not have (a village, a district not in our list) gives city_id = null: the customer picks it by hand.
 */
export function matchPlace(components: GeoComponent[], regions: PlaceRegion[]): PlaceMatch {
  const provinces = components.filter((c) => c.kind === 'province').map((c) => c.name);
  // Yandex may give two provinces («Ташкентская область» and the district's own one); the most precise is the last
  const region = [...provinces].reverse().map((p) => regions.find((r) => regionMatches(p, r))).find(Boolean);
  if (!region) return { region_id: null, city_id: null };
  // the full SOATO list has a city and a district of one name («Андижан» and «Андижанский район»): the exact name wins
  // over a similar one, in all components, before any similar name is tried
  for (const same of [(a: string, b: string) => a === b, sameStem]) {
    for (const kind of DISTRICT_KINDS) {
      for (const c of components.filter((x) => x.kind === kind)) {
        const base = districtBase(c.name);
        const found = region.cities.filter((city) => [city.name_ru, city.name_uz].some((n) => n && same(districtBase(n), base)));
        // «Andijon» and «Andijon tumani» are equal without the word «tumani»: the component's own word decides (Yandex
        // gives a city as «area: Andijon» and a district as «area: Andijon tumani»)
        const wantDistrict = isDistrictName(c.name);
        const city = found.find((x) => isDistrictName(x.name_ru) === wantDistrict) ?? found[0];
        if (city) return { region_id: region.id, city_id: city.id };
      }
    }
  }
  return { region_id: region.id, city_id: null };
}

/** Rough box around Uzbekistan: outside it the shop does not deliver, so the geocoder is not asked at all. */
export function insideUzbekistan(lat: number, lon: number): boolean {
  return lat >= 37 && lat <= 46 && lon >= 55.9 && lon <= 73.2;
}

/** «Открыть в Яндекс Картах» for the staff: a pin at the point the customer chose. */
export function yandexMapsLink(lat: number, lon: number): string {
  const p = `${lon.toFixed(6)},${lat.toFixed(6)}`;
  return `https://yandex.uz/maps/?pt=${p}&z=17&l=map`;
}
