import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';

/**
 * DEV LOGIN without Telegram (Mini App and admin panel). Security rules:
 * 1. exists only in the Vite DEV server (`apply: 'serve'`) — never in `vite build`;
 * 2. registered only when NODE_ENV=development;
 * 3. answers only requests made on this computer (Host localhost/127.0.0.1, no proxy headers).
 *    Rule 3 matters once a public tunnel points at the dev server: through the tunnel the endpoint is a 404,
 *    otherwise anyone could mint a login for any Telegram id (including an admin's).
 * The bot token is read from apps/api/.env inside this Node process and never sent to the browser.
 */
export const DEV_LOGIN_PATH = '/__dev/init-data';

const API_DIR = fileURLToPath(new URL('../api', import.meta.url));
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip'];

/** Same algorithm as Telegram (and apps/api/src/auth/sign-init-data.ts). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** True only for a request typed into a browser on this machine (not one that came through a tunnel/proxy). */
export function isLocalRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const host = req.headers.host ?? '';
  return LOCAL_HOST.test(host) && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

export function devTelegramLogin(env: NodeJS.ProcessEnv = process.env): Plugin {
  return {
    name: 'vitalo-dev-telegram-login',
    apply: 'serve',
    configureServer(server) {
      if (env.NODE_ENV !== 'development') return; // rule 2
      server.middlewares.use(DEV_LOGIN_PATH, (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (!isLocalRequest(req)) {
          res.statusCode = 404; // rule 3: look like nothing is here
          res.end('{}');
          return;
        }
        const token = loadEnv('development', API_DIR, 'TELEGRAM_').TELEGRAM_BOT_TOKEN;
        if (!token) {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: 'TELEGRAM_BOT_TOKEN is empty in apps/api/.env' }));
          return;
        }
        const q = new URL(req.url ?? '', 'http://localhost').searchParams;
        const user = {
          id: Number(q.get('id') ?? 111111111),
          first_name: q.get('first_name') ?? 'Тест',
          last_name: q.get('last_name') ?? undefined,
          username: q.get('username') ?? undefined,
          language_code: q.get('language_code') ?? 'ru',
        };
        const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) }, token);
        res.end(JSON.stringify({ initData }));
      });
    },
  };
}

/** Lets the dev server be reached through a Cloudflare quick tunnel (https://*.trycloudflare.com). */
export const TUNNEL_HOSTS = ['.trycloudflare.com'];
