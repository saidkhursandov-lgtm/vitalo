import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { PhoneIcon, SendIcon } from '../components/Icons';
import { api, ApiError } from '../lib/api';
import { useSession, type WebSession } from '../lib/auth';
import { errorText, useI18n } from '../lib/i18n';
import { isLocalDevHost } from '../lib/telegram';
import { DevLogin } from './DevLogin';

/** POST /auth/web/telegram/start and /auth/web/phone/start. */
interface LoginStart {
  request_id: string;
  poll_token: string;
  bot_url?: string;
  expires_at: string;
}
type Poll = { status: 'pending' | 'expired' } | ({ status: 'approved' } & WebSession);

export const POLL_MS = 2000;

/** Only a path on this site: `next` comes from the address bar. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login') ? raw : '/';
}

/** "+998 90 123 45 67" while typing; the API accepts any spacing. */
export function formatUzPhone(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('998')) d = d.slice(3);
  d = d.slice(0, 9);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return `+998${parts.length ? ' ' : ''}${parts.join(' ')}`;
}

/**
 * Release 6 «Сайт»: sign in outside Telegram. Both ways end in the same customer record (users.telegram_user_id + phone):
 * - «Войти через Telegram» opens the bot (t.me/<bot>?start=login_<id>); «Старт» there confirms, this page polls;
 * - «По номеру телефона»: the bot sends a 6-digit code to the customer who has this phone in VITALO.
 */
export function Login({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const { user, signIn, loginWithInitData } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [tab, setTab] = useState<'telegram' | 'phone'>('telegram');

  const done = (s: WebSession) => {
    signIn(s);
    if (!embedded) navigate(next, { replace: true });
  };

  if (user && !embedded) return <Navigate to={next} replace />;

  return (
    <div className="page login-page">
      <div className="login-card card">
        <Logo size="md" />
        <h1>{embedded ? t('login.required') : t('login.title')}</h1>
        <p className="hint">{t('login.lead')}</p>

        <div className="login-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'telegram'} className={tab === 'telegram' ? 'is-on' : ''} onClick={() => setTab('telegram')}>
            <SendIcon size={18} /> Telegram
          </button>
          <button type="button" role="tab" aria-selected={tab === 'phone'} className={tab === 'phone' ? 'is-on' : ''} onClick={() => setTab('phone')}>
            <PhoneIcon size={18} /> {t('login.phoneLabel')}
          </button>
        </div>

        {tab === 'telegram' ? <TelegramLogin onDone={done} /> : <PhoneLogin onDone={done} />}
      </div>
      {import.meta.env.DEV && isLocalDevHost() && (
        <DevLogin
          onLogin={async (initData) => {
            await loginWithInitData(initData);
            if (!embedded) navigate(next, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function TelegramLogin({ onDone }: { onDone: (s: WebSession) => void }) {
  const { t, lang } = useI18n();
  const [req, setReq] = useState<LoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!req) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api<Poll>('/auth/web/poll', { method: 'POST', body: { request_id: req.request_id, poll_token: req.poll_token } });
        if (stop) return;
        if (r.status === 'approved') return doneRef.current(r);
        if (r.status === 'expired') {
          setReq(null);
          return setError(t('login.expired'));
        }
      } catch {
        /* a lost connection: keep asking until the request expires */
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    let timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [req, t]);

  async function start() {
    setBusy(true);
    setError(null);
    // Opened before the request: browsers block windows opened after an await.
    const win = window.open('', '_blank');
    try {
      const r = await api<LoginStart>('/auth/web/telegram/start', { method: 'POST', body: {} });
      setReq(r);
      // A blocked window: this page stays (it waits for the bot) and shows «Открыть Telegram» instead.
      if (win && r.bot_url) win.location.href = r.bot_url;
    } catch (e) {
      win?.close();
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
    } finally {
      setBusy(false);
    }
  }

  if (req)
    return (
      <div className="login-wait" role="status">
        <span className="login-spinner" aria-hidden="true" />
        <p>{t('login.telegramWait')}</p>
        <p className="hint">{t('login.telegramHint')}</p>
        <a className="btn btn-secondary btn-block" href={req.bot_url} target="_blank" rel="noopener noreferrer">
          {t('login.telegramOpen')}
        </a>
      </div>
    );

  return (
    <div className="login-way">
      <button type="button" className="btn btn-block login-tg" disabled={busy} onClick={() => void start()}>
        <SendIcon size={20} /> {t('login.telegram')}
      </button>
      <p className="hint">{t('login.telegramHint')}</p>
      <p className="hint">{t('login.noTelegram')}</p>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function PhoneLogin({ onDone }: { onDone: (s: WebSession) => void }) {
  const { t, lang } = useI18n();
  const [phone, setPhone] = useState('+998 ');
  const [code, setCode] = useState('');
  const [req, setReq] = useState<LoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'BAD_CODE') return setError(t('login.badCode', { n: Number(e.body.attempts_left ?? 0) }));
    if (e instanceof ApiError && e.code === 'CODE_EXPIRED') setReq(null);
    setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
  };

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setReq(await api<LoginStart>('/auth/web/phone/start', { method: 'POST', body: { phone } }));
      setCode('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api<WebSession>('/auth/web/phone/verify', { method: 'POST', body: { request_id: req.request_id, poll_token: req.poll_token, code } }));
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  if (!req)
    return (
      <form className="login-way" onSubmit={(e) => void send(e)}>
        <label className="field">
          <span>{t('login.phoneLabel')}</span>
          <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(formatUzPhone(e.target.value))} />
        </label>
        <button type="submit" className="btn btn-block" disabled={busy || phone.replace(/\D/g, '').length !== 12}>
          {t('login.sendCode')}
        </button>
        <p className="hint">{t('login.phoneHint')}</p>
        <p className="hint">{t('login.noTelegram')}</p>
        {error && <p className="error-text">{error}</p>}
      </form>
    );

  return (
    <form className="login-way" onSubmit={(e) => void verify(e)}>
      <p className="notice notice-info">{t('login.codeSent', { phone })}</p>
      <label className="field">
        <span>{t('login.codeLabel')}</span>
        <input
          className="login-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
        />
      </label>
      <button type="submit" className="btn btn-block" disabled={busy || code.length !== 6}>
        {t('login.verify')}
      </button>
      <button type="button" className="link-btn" onClick={() => (setReq(null), setError(null))}>
        {t('login.changePhone')}
      </button>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
