import { readFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import type { FileStorage } from './file-storage';
import { storeProductImage } from './image-processing';

/** D2: product photos uploaded before optimization (no thumbnail yet) -> WebP/JPEG versions, original removed. */
export interface PhotoPlanRow {
  media_id: string;
  product_id: string;
  sku: string;
  url: string;
  action: 'optimize' | 'skip';
  reason?: string;
  bytes?: number;
}

/** `/uploads/products/…` -> file on disk; anything else (external links) is skipped. */
function localPath(url: string, uploadDir: string, publicBase = '/uploads'): string | null {
  return url.startsWith(`${publicBase}/`) ? join(uploadDir, url.slice(publicBase.length + 1)) : null;
}

export async function planPhotoOptimization(prisma: PrismaService, uploadDir: string): Promise<PhotoPlanRow[]> {
  const media = await prisma.product_media.findMany({
    where: { media_type: 'image', thumb_url: null },
    include: { product: { select: { sku: true } } },
    orderBy: [{ product_id: 'asc' }, { sort_order: 'asc' }],
  });
  const rows: PhotoPlanRow[] = [];
  for (const m of media) {
    const base = { media_id: m.id, product_id: m.product_id, sku: m.product.sku, url: m.url };
    const path = localPath(m.url, uploadDir);
    if (!path) {
      rows.push({ ...base, action: 'skip', reason: 'внешняя ссылка (не в папке uploads)' });
      continue;
    }
    try {
      const buf = await readFile(path);
      rows.push({ ...base, action: 'optimize', bytes: buf.length });
    } catch {
      rows.push({ ...base, action: 'skip', reason: 'файл не найден на диске' });
    }
  }
  return rows;
}

export async function applyPhotoOptimization(prisma: PrismaService, storage: FileStorage, uploadDir: string, plan: PhotoPlanRow[]) {
  const done: { sku: string; before: number; after: number }[] = [];
  const failed: { sku: string; url: string; error: string }[] = [];
  for (const row of plan.filter((r) => r.action === 'optimize')) {
    try {
      const original = await readFile(localPath(row.url, uploadDir)!);
      const stored = await storeProductImage(storage, row.product_id, original);
      // Only a row still without versions is updated (safe to run twice or in parallel).
      const res = await prisma.product_media.updateMany({ where: { id: row.media_id, thumb_url: null }, data: stored });
      if (res.count) {
        await storage.remove(row.url); // the original is not kept
        const after = (await Promise.all([stored.url, stored.thumb_url].map((u) => readFile(localPath(u, uploadDir)!)))).reduce((n, b) => n + b.length, 0);
        done.push({ sku: row.sku, before: original.length, after });
      } else {
        for (const u of [stored.url, stored.url_jpeg, stored.thumb_url, stored.thumb_url_jpeg]) await storage.remove(u);
      }
    } catch (e) {
      failed.push({ sku: row.sku, url: row.url, error: (e as Error).message });
    }
  }
  return { done, failed };
}
