// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { DEV_LOGIN_PATH, devTelegramLogin, isLocalRequest } from '../dev-login-plugin';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Build exactly like the server does: vitest runs with NODE_ENV=test, which would keep import.meta.env.DEV on. */
export async function productionBuild(root: string, outDir: string) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ root, mode: 'production', logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    process.env.NODE_ENV = prev;
  }
}

export function bundleText(outDir: string): string {
  const files = readdirSync(join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
  return files.map((f) => readFileSync(join(outDir, 'assets', f), 'utf8')).join('\n');
}

describe('DEV login is absent from the production build', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'vitalo-miniapp-build-'));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('the built JavaScript has no dev endpoint and no test users', async () => {
    await productionBuild(ROOT, outDir);
    const js = bundleText(outDir);
    expect(js.length).toBeGreaterThan(10_000); // the app itself is there
    expect(js).not.toContain(DEV_LOGIN_PATH);
    expect(js).not.toContain('vitalo_tester'); // username of the dev test customer
    expect(js).not.toContain('111111111');
  }, 120_000);
});

describe('DEV login endpoint rules', () => {
  const fakeServer = () => {
    const used: string[] = [];
    return { used, server: { middlewares: { use: (path: string) => used.push(path) } } };
  };
  const register = (env: NodeJS.ProcessEnv) => {
    const { used, server } = fakeServer();
    const plugin = devTelegramLogin(env);
    (plugin.configureServer as (s: unknown) => void)(server);
    return { used, plugin };
  };

  it('exists only for the dev server (never in vite build)', () => {
    expect(devTelegramLogin({ NODE_ENV: 'development' }).apply).toBe('serve');
  });

  it('is registered only when NODE_ENV=development', () => {
    expect(register({ NODE_ENV: 'development' }).used).toEqual([DEV_LOGIN_PATH]);
    expect(register({ NODE_ENV: 'production' }).used).toEqual([]);
    expect(register({ NODE_ENV: 'test' }).used).toEqual([]);
    expect(register({}).used).toEqual([]);
  });

  it('answers only requests made on this computer, never through a tunnel/proxy', () => {
    expect(isLocalRequest({ headers: { host: 'localhost:5173' } })).toBe(true);
    expect(isLocalRequest({ headers: { host: '127.0.0.1:5174' } })).toBe(true);
    expect(isLocalRequest({ headers: { host: 'quiet-river.trycloudflare.com' } })).toBe(false);
    // cloudflared connects from localhost but forwards these headers
    expect(isLocalRequest({ headers: { host: 'localhost:5173', 'cf-connecting-ip': '1.2.3.4' } })).toBe(false);
    expect(isLocalRequest({ headers: { host: 'localhost:5173', 'x-forwarded-for': '1.2.3.4' } })).toBe(false);
    expect(isLocalRequest({ headers: {} })).toBe(false);
  });
});

describe('architecture (ТЗ v3, раздел 2)', () => {
  it('only the adapter lib/telegram.ts touches window.Telegram', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const offenders = walk(join(ROOT, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.split(/[\\/]/).join('/').endsWith('lib/telegram.ts'))
      // code only: comments may mention Telegram.WebApp
      .filter((f) => /window\.Telegram|Telegram\.WebApp/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
  });
});
