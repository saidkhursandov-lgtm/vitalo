import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { tashkentDateString } from '../common/tashkent';
import { insideUzbekistan, matchPlace, parseGeocoder } from './maps-match';

/**
 * 3.6: «Адрес на Яндекс Карте». The free Yandex plan allows 1000 geocoder requests and 100 JavaScript API requests (map
 * loads) a day; going over them again and again blocks the key for good. So the shop counts both (Tashkent day) and hides
 * the map button itself at *_HIDE_AT; the admin is warned from *_WARN_AT (Настройки → Доставка). Manual entry always works.
 */
export const GEOCODER_DAILY_LIMIT = 1000;
export const MAP_WARN_AT = 800;
export const MAP_HIDE_AT = 900;
/** Requests already started when the button hides still get an answer, up to here; nothing goes over the limit. */
const HARD_STOP = 950;
/** JavaScript API: every opening of the map is counted as one load (a reopened map may reuse the script — we still count). */
export const JS_DAILY_LIMIT = 100;
export const JS_WARN_AT = 70;
export const JS_HIDE_AT = 90;
/** One customer moving the map: at most this many geocoder answers in 10 minutes. */
const PER_USER_10_MIN = 40;
/** One customer opening the map: at most this many openings in an hour (the map limit is small). */
const OPENS_PER_USER_HOUR = 6;

type Counter = 'geocoder' | 'js';
interface Usage {
  geocoder: number;
  js: number;
}
/** Temporary cache of answers (the terms allow up to 30 days); the same point ±10 m does not spend a request. */
const CACHE_MS = 3600_000;
const CACHE_MAX = 2000;
const TIMEOUT_MS = 5000;

export interface MapsSetting {
  enabled: boolean;
}
export const MAPS_DEFAULT: MapsSetting = { enabled: true };

export type MapUnavailableReason = 'off' | 'no_key' | 'limit';

export interface GeocodeAnswer {
  /** false: Yandex found nothing at this point (or it is outside Uzbekistan) */
  found: boolean;
  outside: boolean;
  street_line: string;
  full_text: string;
  region_id: string | null;
  city_id: string | null;
}

@Injectable()
export class MapsService {
  private readonly log = new Logger(MapsService.name);
  private readonly cache = new Map<string, { at: number; value: GeocodeAnswer }>();
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  private keys() {
    return { js: this.config.get<string>('YANDEX_MAPS_JS_API_KEY')?.trim() || null, geocoder: this.config.get<string>('YANDEX_GEOCODER_API_KEY')?.trim() || null };
  }

  async setting(): Promise<MapsSetting> {
    return { ...MAPS_DEFAULT, ...((await this.settings.get<MapsSetting>(SETTING_KEYS.maps)) ?? {}) };
  }

  /** Requests made today (Tashkent): geocoder and map loads. */
  async usage(now = new Date()): Promise<Usage> {
    const row = await this.settings.get<{ date: string; geocoder?: number; js?: number }>(SETTING_KEYS.mapsUsage);
    if (row?.date !== tashkentDateString(now)) return { geocoder: 0, js: 0 };
    return { geocoder: Number(row.geocoder) || 0, js: Number(row.js) || 0 };
  }

  /** +1 for today in one statement (parallel customers cannot lose a count); a new day starts both counters at 0. */
  private async count(kind: Counter, now = new Date()): Promise<number> {
    const day = tashkentDateString(now);
    const other: Counter = kind === 'geocoder' ? 'js' : 'geocoder';
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${SETTING_KEYS.mapsUsage}, jsonb_build_object('date', ${day}::text, ${kind}::text, 1, ${other}::text, 0), now())
      ON CONFLICT (key) DO UPDATE SET
        value = CASE WHEN settings.value->>'date' = ${day}::text
          THEN settings.value || jsonb_build_object(${kind}::text, COALESCE((settings.value->>${kind}::text)::int, 0) + 1)
          ELSE jsonb_build_object('date', ${day}::text, ${kind}::text, 1, ${other}::text, 0) END,
        updated_at = now()
      RETURNING (value->>${kind}::text)::int AS n`;
    return Number(rows[0]?.n ?? 0);
  }

  /** Why the map is not offered right now, or null when it is. */
  async unavailableReason(now = new Date()): Promise<MapUnavailableReason | null> {
    if (!(await this.setting()).enabled) return 'off';
    const k = this.keys();
    if (!k.js || !k.geocoder) return 'no_key';
    const used = await this.usage(now);
    if (used.geocoder >= MAP_HIDE_AT || used.js >= JS_HIDE_AT) return 'limit';
    return null;
  }

  /** For the Mini App: may it show «Выбрать на карте». The key comes only with an opening (open()), which is counted. */
  async clientConfig() {
    const reason = await this.unavailableReason();
    return { available: reason === null, reason };
  }

  /**
   * The customer opens the map: one JavaScript API load is counted and the key of the map script is given (that key is
   * public by design, it lives in the browser; Yandex limits it by the site address).
   */
  async open(userId: string) {
    if (this.tooOften(this.opens, userId, 3600_000, OPENS_PER_USER_HOUR)) throw new HttpException({ code: 'MAP_TOO_MANY', message: 'The map was opened too many times, wait a little' }, HttpStatus.TOO_MANY_REQUESTS);
    const reason = await this.unavailableReason();
    if (reason) throw new ServiceUnavailableException({ code: 'MAP_UNAVAILABLE', reason });
    await this.count('js');
    return { js_api_key: this.keys().js };
  }

  /** For «Настройки → Доставка»: the switch, the keys (only whether they exist) and today's counters. */
  async status(now = new Date()) {
    const k = this.keys();
    const day = tashkentDateString(now);
    const from = new Date(`${day}T00:00:00+05:00`);
    const [setting, used, confirms, reason] = await Promise.all([
      this.setting(),
      this.usage(now),
      this.prisma.analytics_events.count({ where: { event: 'map_confirm', created_at: { gte: from } } }),
      this.unavailableReason(now),
    ]);
    return {
      enabled: setting.enabled,
      has_js_key: !!k.js,
      has_geocoder_key: !!k.geocoder,
      available: reason === null,
      reason,
      today: { date: day, geocoder_requests: used.geocoder, map_loads: used.js, map_confirms: confirms },
      geocoder: { limit: GEOCODER_DAILY_LIMIT, warn_at: MAP_WARN_AT, hide_at: MAP_HIDE_AT },
      js: { limit: JS_DAILY_LIMIT, warn_at: JS_WARN_AT, hide_at: JS_HIDE_AT },
    };
  }

  private readonly opens = new Map<string, number[]>();

  /** At most `max` events per user within `windowMs` (kept in memory; a restart forgets, which is fine). */
  private tooOften(store: Map<string, number[]>, userId: string, windowMs: number, max: number): boolean {
    const now = Date.now();
    const times = (store.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (times.length >= max) return true;
    times.push(now);
    store.set(userId, times);
    if (store.size > 10_000) store.clear(); // memory guard
    return false;
  }

  private tooMany(userId: string): boolean {
    return this.tooOften(this.recent, userId, 600_000, PER_USER_10_MIN);
  }

  /** One counted request to the Yandex geocoder (kind=district: only the district at this point). */
  private async ask(lat: number, lon: number, lang: 'ru' | 'uz', kind?: 'district'): Promise<unknown> {
    await this.count('geocoder');
    const url =
      `https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(this.keys().geocoder!)}` +
      `&geocode=${lon.toFixed(6)},${lat.toFixed(6)}&format=json&results=1&lang=${lang === 'uz' ? 'uz_UZ' : 'ru_RU'}` +
      (kind ? `&kind=${kind}` : '');
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      // the key is never logged: only the status
      this.log.warn(`Yandex geocoder answered ${res.status}`);
      throw new Error(`status ${res.status}`);
    }
    return res.json();
  }

  /**
   * The address at the point under the map pin, with our region and district when they can be matched. Called only
   * from the map screen (the answer is shown under the Yandex map). Nothing of the answer is written to the database.
   */
  async geocode(userId: string, lat: number, lon: number, lang: 'ru' | 'uz'): Promise<GeocodeAnswer> {
    if (!insideUzbekistan(lat, lon)) return { found: false, outside: true, street_line: '', full_text: '', region_id: null, city_id: null };
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${lang}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    if (this.tooMany(userId)) throw new HttpException({ code: 'MAP_TOO_MANY', message: 'Too many address lookups, wait a little' }, HttpStatus.TOO_MANY_REQUESTS);
    const reason = await this.unavailableReason();
    // the button hides at MAP_HIDE_AT; a map already open may finish its lookups up to HARD_STOP
    if (reason && reason !== 'limit') throw new ServiceUnavailableException({ code: 'MAP_UNAVAILABLE', reason });
    if ((await this.usage()).geocoder >= HARD_STOP) throw new ServiceUnavailableException({ code: 'MAP_UNAVAILABLE', reason: 'limit' });

    let json: unknown;
    try {
      json = await this.ask(lat, lon, lang);
    } catch {
      throw new ServiceUnavailableException({ code: 'MAP_UNAVAILABLE', reason: 'geocoder' });
    }
    const parsed = parseGeocoder(json);
    const regions = await this.prisma.regions.findMany({
      where: { status: 'active' },
      select: { id: true, name_ru: true, name_uz: true, cities: { where: { status: 'active' }, select: { id: true, name_ru: true, name_uz: true } } },
    });
    const place = parsed ? matchPlace(parsed.components, regions) : { region_id: null, city_id: null };
    // a point on a street (not on a house) often comes without the district: ask Yandex for the district itself
    if (parsed && !place.city_id && (await this.usage()).geocoder < HARD_STOP) {
      try {
        const district = parseGeocoder(await this.ask(lat, lon, lang, 'district'));
        const more = district ? matchPlace(district.components, regions) : null;
        if (more?.city_id && (!place.region_id || place.region_id === more.region_id)) Object.assign(place, more);
        else if (more?.region_id && !place.region_id) place.region_id = more.region_id;
      } catch {
        // the street is known; the customer picks the district from the list
      }
    }
    const value: GeocodeAnswer = {
      found: !!parsed,
      outside: false,
      street_line: parsed?.street_line ?? '',
      full_text: parsed?.full_text ?? '',
      ...place,
    };
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}
