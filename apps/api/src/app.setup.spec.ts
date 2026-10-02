import { corsOrigins } from './app.setup';

const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as never;

describe('corsOrigins', () => {
  it('uses the CORS_ORIGINS list (trimmed, no trailing slash)', () => {
    expect(corsOrigins(cfg({ CORS_ORIGINS: 'https://shop.vitalo.uz/, https://admin.vitalo.uz' }))).toEqual(['https://shop.vitalo.uz', 'https://admin.vitalo.uz']);
  });

  it('defaults to the local dev servers outside production (also when the variable is empty)', () => {
    expect(corsOrigins(cfg({ NODE_ENV: 'development' }))).toContain('http://localhost:5173');
    expect(corsOrigins(cfg({ NODE_ENV: 'development', CORS_ORIGINS: '  ' }))).toContain('http://localhost:5174');
  });

  it('allows nobody in production unless configured', () => {
    expect(corsOrigins(cfg({ NODE_ENV: 'production' }))).toEqual([]);
    expect(corsOrigins(cfg({ NODE_ENV: 'production', CORS_ORIGINS: '' }))).toEqual([]);
  });
});
