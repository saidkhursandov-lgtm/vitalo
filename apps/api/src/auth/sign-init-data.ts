import { createHmac } from 'crypto';

/**
 * Dev/test helper: builds initData signed exactly the way Telegram signs it.
 * Used by e2e tests and scripts/dev-login.ts; never used by request handling code.
 */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
