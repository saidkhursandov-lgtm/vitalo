import { useCallback, useEffect, useRef, useState } from 'react';
import { Logo } from '../components/Logo';
import { api, ApiError, errorText } from '../lib/api';
import type { Me } from '../lib/auth';

/** What the Telegram Login Widget hands to `data-onauth`. */
export type TelegramWidgetUser = { id: number; first_name: string; last_name?: string; username?: string; photo_url?: string; auth_date: number; hash: string };

type LoginAnswer = ({ status: 'approved' } & Me) | { status: 'pending'; request_id: string; poll_token: string; expires_at: string };
type PollAnswer = ({ status: 'approved' } & Me) | { status: 'pending' | 'denied' | 'expired' };

type Step =
  | { kind: 'widget' }
  | { kind: 'sending' }
  | { kind: 'waiting'; request_id: string; poll_token: string; until: number }
  | { kind: 'code' };

const POLL_MS = 2000;
const CALLBACK = 'onVitaloTelegramAuth';

declare global {
  interface Window {
    [CALLBACK]?: (user: TelegramWidgetUser) => void;
  }
}

/**
 * Генплан, этап 3 (D-56): the admin panel at admin.vitalo.uz in an ordinary browser.
 * 1) «Войти через Telegram» (the official Telegram Login Widget); 2) a browser seen for the first time waits for
 * «Подтвердить» in the VITALO bot; 3) a 30-day session in an HttpOnly cookie. The owner can enter with a backup code.
 */
export function WebLogin({ onLogin }: { onLogin: (me: Me) => void }) {
  const [bot, setBot] = useState<string | null | undefined>(undefined);
  const [step, setStep] = useState<Step>({ kind: 'widget' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<{ bot_username: string | null }>('/staff/auth/web/config', { anonymous: true })
      .then((c) => setBot(c.bot_username))
      .catch(() => setBot(null));
  }, []);

  const finish = useCallback((a: { staff: Me['staff']; permissions: Me['permissions'] }) => onLogin({ staff: a.staff, permissions: a.permissions }), [onLogin]);

  const submit = useCallback(
    async (user: TelegramWidgetUser) => {
      setError(null);
      setNotice(null);
      setStep({ kind: 'sending' });
      try {
        const a = await api<LoginAnswer>('/staff/auth/web/login', { method: 'POST', body: user, anonymous: true });
        if (a.status === 'approved') return finish(a);
        setStep({ kind: 'waiting', request_id: a.request_id, poll_token: a.poll_token, until: Date.parse(a.expires_at) || Date.now() + 180_000 });
      } catch (e) {
        setError(errorText(e));
        setStep({ kind: 'widget' });
      }
    },
    [finish],
  );

  useEffect(() => {
    window[CALLBACK] = (u) => void submit(u);
    return () => {
      delete window[CALLBACK];
    };
  }, [submit]);

  // waiting for «Подтвердить» in the bot
  useEffect(() => {
    if (step.kind !== 'waiting') return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const a = await api<PollAnswer>('/staff/auth/web/poll', { method: 'POST', body: { request_id: step.request_id, poll_token: step.poll_token }, anonymous: true });
        if (stop) return;
        if (a.status === 'approved') return finish(a);
        if (a.status === 'denied') {
          setError('Вход отклонён в боте («Это не я»).');
          return setStep({ kind: 'widget' });
        }
        if (a.status === 'expired' || Date.now() > step.until) {
          setNotice('Время подтверждения вышло (3 минуты). Войдите ещё раз.');
          return setStep({ kind: 'widget' });
        }
      } catch (e) {
        if (stop) return;
        if (!(e instanceof ApiError) || e.status >= 500) {
          // network hiccup: keep waiting
        } else {
          setError(errorText(e));
          return setStep({ kind: 'widget' });
        }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    let timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [step, finish]);

  return (
    <div className="center-screen">
      <div className="login-card">
        <Logo size="lg" />
        <h1>Вход в админ-панель</h1>
        {step.kind === 'waiting' ? (
          <>
            <p className="muted" role="status">
              Откройте бота VITALO в Telegram и нажмите «Подтвердить». Это нужно один раз для нового браузера.
            </p>
            <span className="skel" style={{ width: 120, height: 6, margin: '12px 0' }} />
            <button className="btn btn-ghost" onClick={() => setStep({ kind: 'widget' })}>
              Отмена
            </button>
          </>
        ) : step.kind === 'code' ? (
          <BackupCode onLogin={finish} onBack={() => setStep({ kind: 'widget' })} />
        ) : (
          <>
            <p className="muted">Войдите своим Telegram-аккаунтом сотрудника VITALO.</p>
            {bot === undefined || step.kind === 'sending' ? (
              <span className="skel" style={{ width: 220, height: 40, margin: '12px 0' }} role="status" aria-label="Загрузка" />
            ) : bot ? (
              <TelegramButton bot={bot} />
            ) : (
              <div className="alert alert-warn">Вход через Telegram сейчас недоступен. Владелец может войти по резервному коду.</div>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setStep({ kind: 'code' })}>
              Войти по резервному коду
            </button>
          </>
        )}
        {notice && <div className="alert alert-info">{notice}</div>}
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </div>
  );
}

/** The official widget script draws the «Log in with Telegram» button in an iframe. */
function TelegramButton({ bot }: { bot: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', bot);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '10');
    s.setAttribute('data-request-access', 'write');
    s.setAttribute('data-onauth', `${CALLBACK}(user)`);
    el.appendChild(s);
    return () => {
      el.innerHTML = '';
    };
  }, [bot]);
  return <div ref={box} className="tg-login" data-testid="telegram-login" />;
}

function BackupCode({ onLogin, onBack }: { onLogin: (me: Me) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api<Me>('/staff/auth/web/backup-code', { method: 'POST', body: { code }, anonymous: true }));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void send(e)} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="muted">Аварийный вход владельца, если Telegram или бот недоступны. Каждый код работает один раз; администраторы получат уведомление.</p>
      <label className="sr-only" htmlFor="backup-code">
        Резервный код
      </label>
      <input id="backup-code" className="input" placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="one-time-code" autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} />
      <button className="btn btn-block" disabled={busy || code.replace(/[^a-z0-9]/gi, '').length < 16}>
        Войти
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
        Назад
      </button>
      {error && <div className="alert alert-error">{error}</div>}
    </form>
  );
}
