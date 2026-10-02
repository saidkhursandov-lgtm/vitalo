import { useState } from 'react';
import { errorText } from '../lib/api';
import { ROLE } from '../lib/format';

/** Seeded test employees (prisma/seed.ts), one per role. */
const TEST_STAFF = [
  { id: 222222221, name: 'Админ (тест)', role: 'admin' },
  { id: 222222222, name: 'Менеджер (тест)', role: 'manager' },
  { id: 222222223, name: 'Склад (тест)', role: 'warehouse' },
  { id: 222222224, name: 'Маркетолог (тест)', role: 'marketer' },
];

/** DEV ONLY: sign in as a test employee without Telegram; the Vite dev server signs the initData. */
export function DevLogin({ onLogin }: { onLogin: (initData: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loginAs(s: (typeof TEST_STAFF)[number]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/__dev/init-data?id=${s.id}&first_name=${encodeURIComponent(s.name)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      await onLogin(body.initData);
    } catch (e) {
      setError(e instanceof Error && !('status' in e) ? e.message : errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="login-card">
        <span className="badge badge-warn">DEV</span>
        <h1>Вход в админ-панель</h1>
        <p className="muted">
          Режим разработки: Telegram не нужен. Выберите тестового сотрудника — меню и права будут как у его роли.
        </p>
        {TEST_STAFF.map((s) => (
          <button key={s.id} className="btn btn-block" disabled={busy} onClick={() => void loginAs(s)}>
            {ROLE[s.role]} — {s.name}
          </button>
        ))}
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </div>
  );
}
