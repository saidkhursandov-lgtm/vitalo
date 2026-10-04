import { randomUUID } from 'crypto';
import sharp from 'sharp';
import type { FileStorage } from './file-storage';

// No file cache: on Windows a cached handle keeps the file locked (deleting a photo would fail).
sharp.cache({ files: 0 });

/** D2: what is stored for a product photo (the original is never kept). */
export const IMAGE_MAIN_PX = 1200;
export const IMAGE_THUMB_PX = 400;
const WEBP_QUALITY = 80;
const JPEG_QUALITY = 82;

export interface ImageVersion {
  webp: Buffer;
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface ProcessedImage {
  main: ImageVersion;
  thumb: ImageVersion;
}

/** Fits inside size×size (never enlarged), EXIF rotation applied, metadata dropped; WebP + JPEG on white. */
async function version(input: Buffer, size: number): Promise<ImageVersion> {
  const base = sharp(input, { failOn: 'error' }).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
  const { data: webp, info } = await base.clone().webp({ quality: WEBP_QUALITY }).toBuffer({ resolveWithObject: true });
  const jpeg = await base.clone().flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
  return { webp, jpeg, width: info.width, height: info.height };
}

export async function processProductImage(input: Buffer): Promise<ProcessedImage> {
  return { main: await version(input, IMAGE_MAIN_PX), thumb: await version(input, IMAGE_THUMB_PX) };
}

export interface StoredImage {
  url: string;
  url_jpeg: string;
  thumb_url: string;
  thumb_url_jpeg: string;
  width: number;
  height: number;
}

/** Saves the four files under products/<productId>/<uuid>[ -400].webp|.jpg and returns their URLs. */
export async function storeProductImage(storage: FileStorage, productId: string, input: Buffer): Promise<StoredImage> {
  const img = await processProductImage(input);
  const base = `products/${productId}/${randomUUID()}`;
  return {
    url: await storage.save(`${base}.webp`, img.main.webp, 'image/webp'),
    url_jpeg: await storage.save(`${base}.jpg`, img.main.jpeg, 'image/jpeg'),
    thumb_url: await storage.save(`${base}-${IMAGE_THUMB_PX}.webp`, img.thumb.webp, 'image/webp'),
    thumb_url_jpeg: await storage.save(`${base}-${IMAGE_THUMB_PX}.jpg`, img.thumb.jpeg, 'image/jpeg'),
    width: img.main.width,
    height: img.main.height,
  };
}

/** Every file of one photo (old photos have only `url`). */
export const imageFiles = (m: { url: string; url_jpeg?: string | null; thumb_url?: string | null; thumb_url_jpeg?: string | null }) =>
  [m.url, m.url_jpeg, m.thumb_url, m.thumb_url_jpeg].filter((u): u is string => !!u);

/** Thumbnail size from the main size (both fit inside 400 px the same way). */
export function thumbSize(width: number | null | undefined, height: number | null | undefined): { width: number; height: number } | null {
  if (!width || !height) return null;
  const k = Math.min(1, IMAGE_THUMB_PX / Math.max(width, height));
  return { width: Math.round(width * k), height: Math.round(height * k) };
}
