/**
 * Light favicon / home-screen icons (32, 180, 192, 512 px PNG) from the square brand icon in
 * apps/miniapp/public/brand/ (icon-square.svg/png, else icon-square-temp.png). Run again after replacing it:
 *   npm run brand:icons
 */
import { readdirSync } from 'fs';
import { join, resolve } from 'path';
import sharp from 'sharp';

const BRAND_DIR = resolve(__dirname, '..', '..', 'miniapp', 'public', 'brand');
export const ICON_SIZES = [32, 180, 192, 512] as const;

async function main() {
  const files = new Map(readdirSync(BRAND_DIR).map((f) => [f.toLowerCase(), f]));
  const source = ['icon-square.svg', 'icon-square.png', 'icon-square.webp', 'icon-square-temp.svg', 'icon-square-temp.png'].map((f) => files.get(f)).find(Boolean);
  if (!source) throw new Error(`No icon-square.* in ${BRAND_DIR}`);
  for (const size of ICON_SIZES) {
    const out = join(BRAND_DIR, `icon-${size}.png`);
    const info = await sharp(join(BRAND_DIR, source), { density: 300 })
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toFile(out);
    console.log(`${out}: ${info.width}x${info.height}, ${Math.round(info.size / 1024)} КБ`);
  }
  console.log(`Источник: ${source}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
