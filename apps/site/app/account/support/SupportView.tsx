'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, LifeBuoy, Send, Star } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { dateTime, orderNo } from '@/lib/format';
import { errorText } from '@/lib/i18n';
import type { SupportThread, SupportTopic } from '@/lib/types';
import { useSession } from '@/components/Session';
import { AccountShell } from '@/components/AccountShell';

const TOPICS: SupportTopic[] = ['product', 'medical', 'order', 'promo', 'tech'];
export const SUPPORT_TEXT_MAX = 2000;

/** Requests to the shop (D-63): the same threads the Mini App and the admin panel show; replies come here and to the bot. */
export function SupportView() {
  const { t } = useSession();
  return (
    <AccountShell section="support" title={t('support.listTitle')}>
      <SupportList />
    </AccountShell>
  );
}

function SupportList() {
  const { t, lang, botUsername } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const orderId = params.get('order');
  const orderNumber = params.get('n');
  const [threads, setThreads] = useState<SupportThread[] | null>(null);
  const [writing, setWriting] = useState(!!orderId);
  const [topic, setTopic] = useState<SupportTopic>(orderId ? 'order' : 'medical');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<SupportThread[]>('/support/threads').then(setThreads, () => setThreads([]));
  }, []);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const th = await api<SupportThread>('/support/threads', {
        method: 'POST',
        body: { topic, text: text.trim(), order_id: topic === 'order' && orderId ? orderId : undefined },
      });
      router.push(`/account/support/${th.id}`);
    } catch (err) {
      setError(errorText(lang, err instanceof ApiError ? err.code : undefined));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {writing ? (
        <form className="card ck-section" onSubmit={(e) => void send(e)}>
          <h2>{t('acc.newRequestTitle')}</h2>
          <label className="field">
            <span>{t('ask.topic')}</span>
            <select className="select input" value={topic} onChange={(e) => setTopic(e.target.value as SupportTopic)}>
              {TOPICS.map((k) => (
                <option key={k} value={k}>
                  {t(`ask.topic.${k}`)}
                </option>
              ))}
            </select>
          </label>
          {topic === 'order' && orderId && orderNumber ? <p className="hint">{t('acc.aboutOrder', { n: orderNo(orderNumber) })}</p> : null}
          <label className="field">
            <span>{t('ask.question')}</span>
            <textarea className="input" rows={5} maxLength={SUPPORT_TEXT_MAX} placeholder={t('ask.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <p className="hint">{topic === 'medical' ? t('ask.medicalNote') : t('ask.whereAnswer')}</p>
          {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
          <div className="row-actions">
            <button type="submit" className="btn" disabled={!text.trim() || busy}>
              <Send size={18} strokeWidth={1.8} /> {t('ask.send')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setWriting(false)}>
              {t('acc.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => setWriting(true)}>
            <LifeBuoy size={18} strokeWidth={1.8} /> {t('support.newRequest')}
          </button>
          <a className="btn btn-ghost" href={`https://t.me/${botUsername}`} target="_blank" rel="noopener noreferrer">
            <Send size={18} strokeWidth={1.8} /> {t('acc.inTelegram')}
          </a>
        </div>
      )}

      {threads === null ? (
        <div className="wait">
          <span className="spinner" aria-label={t('common.loading')} />
        </div>
      ) : threads.length === 0 ? (
        !writing ? (
          <div className="empty">
            <span className="empty-ic">
              <LifeBuoy size={40} strokeWidth={1.6} />
            </span>
            <h2>{t('support.emptyTitle')}</h2>
            <p>{t('support.empty')}</p>
          </div>
        ) : null
      ) : (
        <ul className="card centre-list">
          {threads.map((th) => {
            const last = th.messages[th.messages.length - 1];
            const about = th.order ? t('orders.number', { n: orderNo(th.order.number) }) : th.product?.name;
            return (
              <li key={th.id}>
                <Link href={`/account/support/${th.id}`} className={`centre-item${th.unread ? ' is-unread' : ''}`}>
                  <span className="centre-icon">
                    <LifeBuoy size={20} strokeWidth={1.8} />
                  </span>
                  <span className="centre-text">
                    <b>{t('support.no', { n: th.number })}</b>
                    <span className="hint">
                      {t(`ask.topic.${th.topic}`)}
                      {about ? ` · ${about}` : ''}
                    </span>
                    <span className="clamp">
                      {last?.author === 'customer' ? <span className="hint">{t('support.you')}: </span> : null}
                      {last?.text}
                    </span>
                    <span className="hint">
                      <span className={`support-status is-${th.status}`}>{t(`support.status.${th.status}`)}</span> · {dateTime(th.last_message_at, lang)}
                    </span>
                  </span>
                  {th.unread ? <span className="dot" aria-label={t('notifications.unread')} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One request as a chat; while it is open the page asks for new replies every 15 s. */
export function SupportThreadView({ id }: { id: string }) {
  return (
    <AccountShell section="support">
      <Thread id={id} />
    </AccountShell>
  );
}

function Thread({ id }: { id: string }) {
  const { t, lang } = useSession();
  const [th, setTh] = useState<SupportThread | null>(null);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () =>
      api<SupportThread>(`/support/threads/${id}`).then(setTh, (e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setMissing(true);
      });
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [id]);

  const count = th?.messages.length ?? 0;
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: 'nearest' });
  }, [count]);

  async function act(fn: () => Promise<SupportThread>) {
    setBusy(true);
    setError(null);
    try {
      setTh(await fn());
      return true;
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <div className="notice notice-error">{t('common.error')}</div>;
  if (!th) {
    return (
      <div className="wait">
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }
  const closed = th.status === 'closed';
  const answered = !closed && th.messages.some((m) => m.author === 'staff');
  const about = th.order ? t('orders.number', { n: orderNo(th.order.number) }) : th.product?.name;
  const aboutHref = th.order ? `/order/${th.order.id}` : th.product ? `/product/${th.product.id}` : null;

  return (
    <div className="card chat-card">
      <div className="chat-head">
        <Link href="/account/support" className="icon-link" aria-label={t('common.back')}>
          <ChevronLeft size={22} strokeWidth={1.8} />
        </Link>
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title" style={{ margin: 0, fontSize: 20 }}>
            {t('support.no', { n: th.number })}
          </h1>
          <span className="hint">
            {t(`ask.topic.${th.topic}`)} · <span className={`support-status is-${th.status}`}>{t(`support.status.${th.status}`)}</span>
            {about && aboutHref ? (
              <>
                {' · '}
                <Link href={aboutHref} className="link">
                  {about}
                </Link>
              </>
            ) : null}
          </span>
        </div>
      </div>

      <ol className="chat">
        {th.messages.map((m) => (
          <li key={m.id} className={`chat-msg is-${m.author}`}>
            {m.author === 'staff' ? <span className="chat-who">{t('support.specialist')}</span> : null}
            <p>{m.text}</p>
            <time>{dateTime(m.created_at, lang)}</time>
          </li>
        ))}
      </ol>
      <div ref={end} />
      {th.status === 'open' ? <p className="hint">{t('support.waiting')}</p> : null}

      {closed ? (
        <div className="chat-closed">
          <b>{t('support.closedTitle', { n: th.number })}</b>
          <span className="hint">{th.rating ? t('support.rated') : t('support.rate')}</span>
          <div className="stars" role="radiogroup" aria-label={t('support.rate')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={th.rating === n}
                aria-label={t('support.stars', { n })}
                className={(th.rating ?? 0) >= n ? 'is-on' : ''}
                disabled={busy}
                onClick={() => void act(() => api<SupportThread>(`/support/threads/${id}/rating`, { method: 'POST', body: { rating: n } }))}
              >
                <Star size={28} strokeWidth={1.8} fill={(th.rating ?? 0) >= n ? 'currentColor' : 'none'} />
              </button>
            ))}
          </div>
          {th.rating ? (
            <span className="hint">
              <Check size={16} strokeWidth={1.8} /> {t('support.ratedNote')}
            </span>
          ) : null}
          <Link href="/account/support" className="btn btn-secondary">
            {t('support.backToList')}
          </Link>
        </div>
      ) : (
        <>
          {answered ? (
            <div className="chat-resolve">
              <span>{t('support.resolvedQ')}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('support.closeConfirm'))) void act(() => api<SupportThread>(`/support/threads/${id}/close`, { method: 'POST' }));
                }}
              >
                <Check size={16} strokeWidth={1.8} /> {t('support.closeMine')}
              </button>
            </div>
          ) : null}
          <form
            className="chat-bar"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim() || busy) return;
              void act(() => api<SupportThread>(`/support/threads/${id}/messages`, { method: 'POST', body: { text: text.trim() } })).then((ok) => ok && setText(''));
            }}
          >
            <textarea className="input" rows={2} maxLength={SUPPORT_TEXT_MAX} value={text} placeholder={t('support.placeholder')} aria-label={t('support.reply')} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn" aria-label={t('ask.send')} disabled={!text.trim() || busy}>
              <Send size={18} strokeWidth={1.8} />
            </button>
          </form>
        </>
      )}
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    </div>
  );
}
