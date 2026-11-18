'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Phone, Send } from 'lucide-react';
import { api, ApiError, type WebSession } from '@/lib/client';
import { errorText } from '@/lib/i18n';
import { useSession } from '@/components/Session';

interface LoginStart {
  request_id: string;
  poll_token: string;
  bot_url?: string;
  expires_at: string;
}
type Poll = { status: 'pending' | 'expired' } | ({ status: 'approved' } & WebSession);

const POLL_MS = 2000;

/** Only a path on this site: `next` comes from the address bar. */
export function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login') ? raw : '/account';
}

/** "+998 90 123 45 67" while typing; the API accepts any spacing. */
export function formatUzPhone(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('998')) d = d.slice(3);
  d = d.slice(0, 9);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return `+998${parts.length ? ' ' : ''}${parts.join(' ')}`;
}

/** D-80: sign in through the bot (one tap in Telegram) or by phone with a code that the bot sends. */
export function LoginForm() {
  const { t, user, signIn } = useSession();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [tab, setTab] = useState<'telegram' | 'phone'>('telegram');

  useEffect(() => {
    if (user) router.replace(next);
  }, [user, next, router]);

  const done = async (s: WebSession) => {
    await signIn(s);
    router.replace(next);
  };

  return (
    <div className="auth-card">
      <h1>{t('login.title')}</h1>
      <p className="hint">{t('login.lead')}</p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'telegram'} className={tab === 'telegram' ? 'is-on' : ''} onClick={() => setTab('telegram')}>
          <Send size={17} strokeWidth={1.8} /> Telegram
        </button>
        <button type="button" role="tab" aria-selected={tab === 'phone'} className={tab === 'phone' ? 'is-on' : ''} onClick={() => setTab('phone')}>
          <Phone size={17} strokeWidth={1.8} /> {t('login.phoneTab')}
        </button>
      </div>
      {tab === 'telegram' ? <TelegramLogin onDone={done} /> : <PhoneLogin onDone={done} />}
      <p className="hint" style={{ fontSize: 13 }}>
        {t('login.first')}
      </p>
    </div>
  );
}

function TelegramLogin({ onDone }: { onDone: (s: WebSession) => Promise<void> }) {
  const { t, lang } = useSession();
  const [req, setReq] = useState<LoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!req) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api<Poll>('/auth/web/poll', { method: 'POST', body: { request_id: req.request_id, poll_token: req.poll_token }, auth: false });
        if (stop) return;
        if (r.status === 'approved') return void doneRef.current(r);
        if (r.status === 'expired') {
          setReq(null);
          return setError(t('login.expired'));
        }
      } catch {
        /* a lost connection: keep asking until the request expires */
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
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
      const r = await api<LoginStart>('/auth/web/telegram/start', { method: 'POST', body: {}, auth: false });
      setReq(r);
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
      <div className="wait" role="status">
        <span className="spinner" aria-hidden="true" />
        <b>{t('login.wait')}</b>
        <p className="hint">{t('login.telegramHint')}</p>
        <a className="btn btn-secondary btn-block" href={req.bot_url} target="_blank" rel="noopener noreferrer">
          <Send size={18} strokeWidth={1.8} /> {t('login.open')}
        </a>
      </div>
    );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <button type="button" className="btn btn-lg btn-block" disabled={busy} onClick={() => void start()}>
        <Send size={20} strokeWidth={1.8} /> {t('login.telegram')}
      </button>
      <p className="hint">{t('login.telegramHint')}</p>
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}

function PhoneLogin({ onDone }: { onDone: (s: WebSession) => Promise<void> }) {
  const { t, lang } = useSession();
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
      setReq(await api<LoginStart>('/auth/web/phone/start', { method: 'POST', body: { phone }, auth: false }));
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
      await onDone(await api<WebSession>('/auth/web/phone/verify', { method: 'POST', body: { request_id: req.request_id, poll_token: req.poll_token, code }, auth: false }));
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  if (!req)
    return (
      <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => void send(e)}>
        <label className="field">
          <span>{t('login.phone')}</span>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(formatUzPhone(e.target.value))} />
        </label>
        <button type="submit" className="btn btn-lg btn-block" disabled={busy || phone.replace(/\D/g, '').length !== 12}>
          {t('login.sendCode')}
        </button>
        <p className="hint">{t('login.phoneHint')}</p>
        {error ? <p className="error-text">{error}</p> : null}
      </form>
    );

  return (
    <form style={{ display: 'grid', gap: 12 }} onSubmit={(e) => void verify(e)}>
      <p className="notice notice-info">{t('login.codeSent', { phone })}</p>
      <label className="field">
        <span>{t('login.code')}</span>
        <input
          className="input code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
        />
      </label>
      <button type="submit" className="btn btn-lg btn-block" disabled={busy || code.length !== 6}>
        {t('login.verify')}
      </button>
      <button type="button" className="link" style={{ justifySelf: 'center' }} onClick={() => (setReq(null), setError(null))}>
        {t('login.changePhone')}
      </button>
      {error ? <p className="error-text">{error}</p> : null}
    </form>
  );
}
