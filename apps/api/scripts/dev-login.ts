/**
 * Local dev helper: pretends to be Telegram. Signs initData for a fake user with TELEGRAM_BOT_TOKEN
 * from .env, logs in against the running API and calls /auth/me with the received token.
 * Usage: npm run start:dev (in one terminal), then npm run dev:login
 */
import 'dotenv/config';
import { signInitData } from '../src/auth/sign-init-data';

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is empty in .env');
  const base = `http://localhost:${process.env.PORT ?? 3000}/api`;

  const user = { id: 111_111_111, first_name: 'Тест', last_name: 'Витало', username: 'vitalo_tester', language_code: 'ru' };
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) }, botToken);

  const loginRes = await fetch(`${base}/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  const login = await loginRes.json();
  console.log(`\n1) POST /auth/telegram -> ${loginRes.status}`);
  console.log(JSON.stringify(login, null, 2));
  if (!loginRes.ok) return;

  const meRes = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${login.token}` } });
  console.log(`\n2) GET /auth/me (with token) -> ${meRes.status}`);
  console.log(JSON.stringify(await meRes.json(), null, 2));

  console.log('\nFor Swagger (http://localhost:3000/api/docs): paste this initData into POST /auth/telegram:');
  console.log(initData);
}

main().catch((e) => {
  console.error(e instanceof TypeError ? `API is not reachable (is npm run start:dev running?): ${e.message}` : e);
  process.exitCode = 1;
});
