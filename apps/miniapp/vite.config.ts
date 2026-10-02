import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const API_DIR = fileURLToPath(new URL('../api', import.meta.url));

/** Same algorithm as Telegram (and apps/api/src/auth/sign-init-data.ts). */
function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/**
 * DEV ONLY (`vite` dev server, never in `vite build`): lets the app run in a normal browser.
 * GET /__dev/init-data?id=..&first_name=..&language_code=.. returns initData signed with
 * TELEGRAM_BOT_TOKEN from apps/api/.env. The token stays in this Node process; the browser only
 * receives the signed string, exactly what Telegram itself would give the app.
 */
function devTelegramLogin(): Plugin {
  return {
    name: 'vitalo-dev-telegram-login',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/init-data', (req, res) => {
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
        const initData = signInitData(
          { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) },
          token,
        );
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ initData }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devTelegramLogin()],
  server: {
    port: 5173,
    // Same origin for the browser: /api goes to the NestJS API (npm run start:dev in apps/api).
    proxy: { '/api': 'http://localhost:3000', '/uploads': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
  },
});
