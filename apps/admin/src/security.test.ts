// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('DEV login is absent from the admin production build', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'vitalo-admin-build-'));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('the built JavaScript has no dev endpoint and no test employees', async () => {
    // Build exactly like the server does (vitest itself runs with NODE_ENV=test).
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({ root: ROOT, mode: 'production', logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = prev;
    }
    const js = readdirSync(join(outDir, 'assets'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(outDir, 'assets', f), 'utf8'))
      .join('\n');
    expect(js.length).toBeGreaterThan(10_000);
    expect(js).not.toContain('/__dev/init-data');
    for (const id of ['222222221', '222222222', '222222223', '222222224']) expect(js).not.toContain(id);
  }, 120_000);
});
