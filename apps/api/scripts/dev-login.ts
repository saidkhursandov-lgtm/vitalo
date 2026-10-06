/**
 * Local dev helper: pretends to be Telegram. Signs initData for a fake user with TELEGRAM_BOT_TOKEN
 * from .env, logs in against the running API and prints the session token.
 * Usage: npm run start:dev (in one terminal), then
 *   npm run dev:login              -> customer "Тест Витало"
 *   npm run dev:login -- --staff   -> seeded manager (Telegram id 222222222)
 */
import 'dotenv/config';
import { signInitData } from '../src/auth/sign-init-data';
import { assertDevOrTestDatabase } from '../src/common/db-target';

export const API = `http://localhost:${process.env.PORT ?? 3000}/api`;

export function devInitData(user: Record<string, unknown>): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is empty in .env');
  return signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) }, botToken);
}

export const DEV_CUSTOMER = { id: 111_111_111, first_name: 'Тест', last_name: 'Витало', username: 'vitalo_tester', language_code: 'ru' };
export const DEV_MANAGER = { id: 222_222_222, first_name: 'Менеджер' };

async function main() {
  // The API it talks to uses the same .env: only a *_dev / *_test database, never production.
  assertDevOrTestDatabase('npm run dev:login');
  const staff = process.argv.includes('--staff');
  const initData = devInitData(staff ? DEV_MANAGER : DEV_CUSTOMER);
  const path = staff ? '/staff/auth/telegram' : '/auth/telegram';

  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  console.log(`\nPOST ${path} -> ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
  console.log('\nВ Swagger (http://localhost:3000/api/docs) нажмите Authorize и вставьте token из ответа выше.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof TypeError ? `API is not reachable (is npm run start:dev running?): ${e.message}` : e);
    process.exitCode = 1;
  });
}
