import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { tashkentDateString } from '../common/tashkent';
import { insideUzbekistan, matchPlace, parseGeocoder } from './maps-match';

/**
 * 3.6: «Адрес на Яндекс Карте». The free Yandex plan allows 1000 geocoder requests a day; going over it again and again
 * blocks the key for good. So the shop counts every request (Tashkent day) and hides the map button itself at
 * HIDE_AT; the admin is warned from WARN_AT (Настройки → Доставка). Manual address entry always works.
 */
export const GEOCODER_DAILY_LIMIT = 1000;
export const MAP_WARN_AT = 800;
export const MAP_HIDE_AT = 900;
/** Requests already started when the button hides still get an answer, up to here; nothing goes over the limit. */
const HARD_STOP = 950;
/** One customer moving the map: at most this many geocoder answers in 10 minutes. */
const PER_USER_10_MIN = 40;
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

  /** Geocoder requests made today (Tashkent). */
  async usedToday(now = new Date()): Promise<number> {
    const row = await this.settings.get<{ date: string; geocoder: number }>(SETTING_KEYS.mapsUsage);
    return row?.date === tashkentDateString(now) ? Number(row.geocoder) || 0 : 0;
  }

  /** +1 request for today in one statement (parallel customers cannot lose a count); returns the new number. */
  private async countRequest(now = new Date()): Promise<number> {
    const day = tashkentDateString(now);
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${SETTING_KEYS.mapsUsage}, jsonb_build_object('date', ${day}::text, 'geocoder', 1), now())
      ON CONFLICT (key) DO UPDATE SET
        value = CASE WHEN settings.value->>'date' = ${day}::text
          THEN jsonb_build_object('date', ${day}::text, 'geocoder', COALESCE((settings.value->>'geocoder')::int, 0) + 1)
          ELSE jsonb_build_object('date', ${day}::text, 'geocoder', 1) END,
        updated_at = now()
      RETURNING (value->>'geocoder')::int AS n`;
    return Number(rows[0]?.n ?? 0);
  }

  /** Why the map is not offered right now, or null when it is. */
  async unavailableReason(now = new Date()): Promise<MapUnavailableReason | null> {
    if (!(await this.setting()).enabled) return 'off';
    const k = this.keys();
    if (!k.js || !k.geocoder) return 'no_key';
    if ((await this.usedToday(now)) >= MAP_HIDE_AT) return 'limit';
    return null;
  }

  /** For the Mini App: may it show «Выбрать на карте», and the key of the map script (that key is public by design). */
  async clientConfig() {
    const reason = await this.unavailableReason();
    return { available: reason === null, reason, js_api_key: reason === null ? this.keys().js : null };
  }

  /** For «Настройки → Доставка»: the switch, the keys (only whether they exist) and today's counters. */
  async status(now = new Date()) {
    const k = this.keys();
    const day = tashkentDateString(now);
    const from = new Date(`${day}T00:00:00+05:00`);
    const [setting, geocoder, opens, reason] = await Promise.all([
      this.setting(),
      this.usedToday(now),
      this.prisma.analytics_events.count({ where: { event: 'map_open', created_at: { gte: from } } }),
      this.unavailableReason(now),
    ]);
    return {
      enabled: setting.enabled,
      has_js_key: !!k.js,
      has_geocoder_key: !!k.geocoder,
      available: reason === null,
      reason,
      today: { date: day, geocoder_requests: geocoder, map_opens: opens },
      limit: GEOCODER_DAILY_LIMIT,
      warn_at: MAP_WARN_AT,
      hide_at: MAP_HIDE_AT,
    };
  }

  private tooMany(userId: string): boolean {
    const now = Date.now();
    const times = (this.recent.get(userId) ?? []).filter((t) => now - t < 600_000);
    if (times.length >= PER_USER_10_MIN) return true;
    times.push(now);
    this.recent.set(userId, times);
    if (this.recent.size > 10_000) this.recent.clear(); // memory guard
    return false;
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
    if ((await this.usedToday()) >= HARD_STOP) throw new ServiceUnavailableException({ code: 'MAP_UNAVAILABLE', reason: 'limit' });

    await this.countRequest();
    const url =
      `https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(this.keys().geocoder!)}` +
      `&geocode=${lon.toFixed(6)},${lat.toFixed(6)}&format=json&results=1&lang=${lang === 'uz' ? 'uz_UZ' : 'ru_RU'}`;
    let json: unknown;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        // the key is never logged: only the status
        this.log.warn(`Yandex geocoder answered ${res.status}`);
        throw new Error(`status ${res.status}`);
      }
      json = await res.json();
    } catch {
      throw new ServiceUnavailableException({ code: 'MAP_UNAVAILABLE', reason: 'geocoder' });
    }
    const parsed = parseGeocoder(json);
    const regions = await this.prisma.regions.findMany({
      where: { status: 'active' },
      select: { id: true, name_ru: true, name_uz: true, cities: { where: { status: 'active' }, select: { id: true, name_ru: true, name_uz: true } } },
    });
    const place = parsed ? matchPlace(parsed.components, regions) : { region_id: null, city_id: null };
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
