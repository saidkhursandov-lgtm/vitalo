import { useState } from 'react';
import { Logo } from '../components/Logo';
import { useI18n } from '../lib/i18n';

/** Test customers for the dev login (fake Telegram ids). */
const TEST_USERS = [
  { id: 111111111, first_name: 'Тест', last_name: 'Витало', username: 'vitalo_tester', language_code: 'ru' },
  { id: 111111112, first_name: 'Dilnoza', last_name: 'Test', username: 'vitalo_uz', language_code: 'uz' },
];

/** DEV ONLY: shown in a normal browser instead of Telegram. The Vite dev server signs initData for us. */
export function DevLogin({ onLogin }: { onLogin: (initData: string) => Promise<void> }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loginAs(user: (typeof TEST_USERS)[number]) {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams(Object.entries(user).map(([k, v]) => [k, String(v)]));
      const res = await fetch(`/__dev/init-data?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      await onLogin(body.initData);
    } catch (e) {
      setError(`${t('auth.loginFailed')}: ${(e as Error).message}. API запущен? (apps/api: npm run start:dev)`);
      setBusy(false);
    }
  }

  return (
    <div className="screen-center dev-login">
      <Logo size="lg" />
      <div className="dev-badge">DEV</div>
      <h1>{t('auth.devTitle')}</h1>
      <p className="hint">{t('auth.devHint')}</p>
      {TEST_USERS.map((u) => (
        <button key={u.id} className="btn btn-block" disabled={busy} onClick={() => void loginAs(u)}>
          {t('auth.devAs', { name: `${u.first_name} ${u.last_name}` })} · {u.language_code.toUpperCase()}
        </button>
      ))}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
