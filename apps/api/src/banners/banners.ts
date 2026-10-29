import { randomUUID } from 'crypto';
import sharp from 'sharp';
import type { home_banners } from '@prisma/client';
import type { FileStorage } from '../storage/file-storage';

/**
 * Stage 2.1: banners of the home screen (Настройки → Главная → Баннеры).
 *  - doctor / delivery: the two navy slides the shop already had; the Mini App draws them itself
 *    (the delivery slide keeps its rule: a new customer sees «первый заказ бесплатно», everybody else the tariff threshold);
 *  - image: a picture uploaded in the admin panel, RU and/or UZ (one picture is shown in both languages).
 */
export const MAX_BANNERS = 5;
export const BANNER_KINDS = ['doctor', 'delivery', 'image'] as const;
export type BannerKind = (typeof BANNER_KINDS)[number];
export const BANNER_LINK_TYPES = ['product', 'category', 'brand'] as const;
export type BannerLinkType = (typeof BANNER_LINK_TYPES)[number];
export type BannerLang = 'ru' | 'uz';

/** Recommended size: 1200 × 400 (3:1). Bigger pictures are reduced, never enlarged; stored as WebP (+ JPEG fallback). */
export const BANNER_WIDTH = 1200;
export const BANNER_HEIGHT = 400;
const WEBP_QUALITY = 80;
const JPEG_QUALITY = 82;

export interface ShopBanner {
  id: string;
  kind: BannerKind;
  image_url: string | null;
  image_jpeg_url: string | null;
  link: { type: BannerLinkType; value: string } | null;
}

/** The picture for the language: its own, otherwise the other one (if only one was uploaded it is shown in both). */
export function bannerImage(b: Pick<home_banners, 'image_ru_url' | 'image_ru_jpeg' | 'image_uz_url' | 'image_uz_jpeg'>, lang: BannerLang) {
  const own = lang === 'uz' ? { url: b.image_uz_url, jpeg: b.image_uz_jpeg } : { url: b.image_ru_url, jpeg: b.image_ru_jpeg };
  const other = lang === 'uz' ? { url: b.image_ru_url, jpeg: b.image_ru_jpeg } : { url: b.image_uz_url, jpeg: b.image_uz_jpeg };
  return own.url ? own : other.url ? other : null;
}

/** Shown now: switched on, inside its dates, and a picture banner has at least one picture. */
export function isShown(b: home_banners, now: Date): boolean {
  if (!b.enabled) return false;
  if (b.starts_at && b.starts_at > now) return false;
  if (b.ends_at && b.ends_at < now) return false;
  return b.kind !== 'image' || !!(b.image_ru_url || b.image_uz_url);
}

export function toShopBanner(b: home_banners, lang: BannerLang): ShopBanner {
  const img = b.kind === 'image' ? bannerImage(b, lang) : null;
  return {
    id: b.id,
    kind: b.kind as BannerKind,
    image_url: img?.url ?? null,
    image_jpeg_url: img?.jpeg ?? null,
    link: b.link_type && b.link_value ? { type: b.link_type as BannerLinkType, value: b.link_value } : null,
  };
}

/** WebP + JPEG, up to 1200 × 400 (cut to 3:1 from the centre), EXIF rotation applied, metadata dropped. */
export async function storeBannerImage(storage: FileStorage, bannerId: string, lang: BannerLang, input: Buffer) {
  const base = sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: BANNER_WIDTH, height: BANNER_HEIGHT, fit: 'cover', position: 'centre', withoutEnlargement: true });
  const webp = await base.clone().webp({ quality: WEBP_QUALITY }).toBuffer();
  const jpeg = await base.clone().flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
  const key = `banners/${bannerId}/${randomUUID()}-${lang}`;
  return {
    url: await storage.save(`${key}.webp`, webp, 'image/webp'),
    jpeg: await storage.save(`${key}.jpg`, jpeg, 'image/jpeg'),
  };
}
