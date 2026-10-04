import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Brand files (logo and icons) for BOTH apps — the only place that knows their names.
 *
 * Files live in apps/miniapp/public/brand/. For each kind the first existing file wins:
 *   logo:        logo.svg, logo.png, logo.webp, logo-temp.svg, logo-temp.png, logo-temp.webp
 *   icon:        icon.svg … icon-temp.webp                 (V mark)
 *   icon-square: icon-square.svg … icon-square-temp.webp   (V in a square: favicon, home-screen icon)
 * So replacing the temporary PNGs with the original SVGs = put logo.svg (etc.) in the folder and restart.
 * No file at all -> the apps fall back to the text logo "VITALO" and /favicon.svg.
 *
 * Favicon and home-screen icons are the light icon-32/180/192/512.png made by `npm run brand:icons` (apps/api)
 * from icon-square; the big source file itself is never linked from the pages.
 *
 * The plugin exposes the chosen URLs to the code as __BRAND__, adds the favicon links to index.html and,
 * for the admin panel (which has its own public folder), serves and copies /brand/* from here.
 */
export const BRAND_DIR = fileURLToPath(new URL('./public/brand', import.meta.url));
const KINDS = { logo: 'logo', icon: 'icon', iconSquare: 'icon-square' } as const;
const EXTS = ['svg', 'png', 'webp'];

export type BrandUrls = Record<keyof typeof KINDS, string | null>;

function files(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Chosen file name per kind (null if missing). Name match ignores case. */
export function pickBrandFiles(dir = BRAND_DIR): Record<keyof typeof KINDS, string | null> {
  const present = new Map(files(dir).map((f) => [f.toLowerCase(), f]));
  const pick = (base: string) => {
    for (const suffix of ['', '-temp']) for (const ext of EXTS) {
      const f = present.get(`${base}${suffix}.${ext}`);
      if (f) return f;
    }
    return null;
  };
  return { logo: pick(KINDS.logo), icon: pick(KINDS.icon), iconSquare: pick(KINDS.iconSquare) };
}

/** Public URLs with a version from the file time, so a replaced file is not stuck in the browser cache. */
export function brandUrls(dir = BRAND_DIR): BrandUrls {
  const chosen = pickBrandFiles(dir);
  const url = (f: string | null) => (f ? `/brand/${encodeURIComponent(f)}?v=${Math.round(statSync(join(dir, f)).mtimeMs)}` : null);
  return { logo: url(chosen.logo), icon: url(chosen.icon), iconSquare: url(chosen.iconSquare) };
}

/** Generated light icons (npm run brand:icons): size -> file name, only those that exist. */
export function generatedIcons(dir = BRAND_DIR): Record<number, string> {
  const present = new Set(files(dir));
  return Object.fromEntries([32, 180, 192, 512].filter((s) => present.has(`icon-${s}.png`)).map((s) => [s, `icon-${s}.png`]));
}

const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', webmanifest: 'application/manifest+json' };
const mimeOf = (f: string) => MIME[f.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

export function brand({ shareFiles = false }: { shareFiles?: boolean } = {}): Plugin {
  const urls = brandUrls();
  const icons = generatedIcons();
  const iconUrl = (size: number) => (icons[size] ? `/brand/${icons[size]}?v=${Math.round(statSync(join(BRAND_DIR, icons[size])).mtimeMs)}` : null);
  const manifest = JSON.stringify({
    name: 'VITALO',
    short_name: 'VITALO',
    display: 'standalone',
    background_color: '#f3f5f4',
    theme_color: '#ffffff',
    icons: [192, 512].filter((s) => icons[s]).map((s) => ({ src: iconUrl(s), sizes: `${s}x${s}`, type: 'image/png' })),
  });
  return {
    name: 'vitalo-brand',
    config: () => ({ define: { __BRAND__: JSON.stringify(urls) } }),
    transformIndexHtml(html) {
      const favicon = iconUrl(32);
      if (!favicon) return html; // run `npm run brand:icons` in apps/api; until then /favicon.svg stays
      const links = [
        `<link rel="icon" href="${favicon}" type="image/png" sizes="32x32" />`,
        iconUrl(180) && `<link rel="apple-touch-icon" href="${iconUrl(180)}" sizes="180x180" />`,
        icons[192] && '<link rel="manifest" href="/brand/manifest.webmanifest" />',
      ].filter(Boolean);
      return html.replace(/<link rel="icon"[^>]*>/, links.join('\n    '));
    },
    // Admin panel only: /brand/* comes from the Mini App folder, in dev and in the build.
    configureServer(server) {
      server.middlewares.use('/brand/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', MIME.webmanifest);
        res.end(manifest);
      });
      if (!shareFiles) return;
      server.middlewares.use('/brand/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!files(BRAND_DIR).includes(name)) return next();
        res.setHeader('Content-Type', mimeOf(name));
        res.end(readFileSync(join(BRAND_DIR, name)));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'brand/manifest.webmanifest', source: manifest });
      if (!shareFiles) return;
      // The admin panel needs the logo and the light icons, not the big square source.
      const { logo, icon } = pickBrandFiles();
      for (const f of [logo, icon, ...Object.values(icons)]) {
        if (f) this.emitFile({ type: 'asset', fileName: `brand/${f}`, source: readFileSync(join(BRAND_DIR, f)) });
      }
    },
  };
}
