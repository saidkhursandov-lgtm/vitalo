import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SUPPORT_TEXT_MAX } from '../components/AskSheet';
import { BackIcon, CheckIcon, SendIcon, StarIcon, SupportIcon } from '../components/Icons';
import { useSheets } from '../components/Sheets';
import { useSupportUrl } from '../components/Support';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, orderNo } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useSupportThread, useSupportThreads } from '../lib/queries';
import { openSupport } from '../lib/shop';
import { haptic } from '../lib/telegram';
import type { SupportThread } from '../lib/types';

/**
 * 6б-Б (D-63): the customer's requests — the number, the topic, the order or the product, the last message, the status
 * and the new replies. Used in «Поддержка» (/support) and in «Уведомления → Личные».
 */
export function SupportThreadsList({ source }: { source: string }) {
  const { t, lang } = useI18n();
  const list = useSupportThreads();
  const { openAsk } = useSheets();
  const newButton = (
    <button type="button" className="btn btn-block support-new" onClick={() => openAsk({ source })}>
      <SupportIcon width={20} height={20} /> {t('support.newRequest')}
    </button>
  );
  if (list.isPending) return <Loading variant="list" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.length === 0) {
    return (
      <>
        <EmptyState icon={SupportIcon} title={t('support.emptyTitle')} text={t('support.empty')} />
        {newButton}
      </>
    );
  }
  return (
    <>
      {newButton}
      <ul className="card list centre-list support-list">
        {list.data.map((th) => {
          const last = th.messages[th.messages.length - 1];
          const about = th.order ? t('orders.number', { n: orderNo(th.order.number) }) : th.product?.name;
          return (
            <li key={th.id}>
              <Link to={`/support/${th.id}`} className={`centre-item${th.unread ? ' is-unread' : ''}`}>
                <span className="centre-icon centre-icon-personal" aria-hidden>
                  <SupportIcon width={20} height={20} />
                </span>
                <span className="centre-text">
                  <span className="support-row-head">
                    <strong>{t('support.no', { n: th.number })}</strong>
                    <span className={`support-status is-${th.status}`}>{t(`support.status.${th.status}`)}</span>
                  </span>
                  <span className="hint small">
                    {t(`ask.topic.${th.topic}`)}
                    {about ? ` · ${about}` : ''}
                  </span>
                  <span className="support-last">
                    {last?.author === 'customer' && <span className="hint">{t('support.you')}: </span>}
                    {last?.text}
                  </span>
                  <span className="hint small">{dateTime(th.last_message_at, lang)}</span>
                </span>
                {!!th.unread && <span className="centre-dot" aria-label={t('notifications.unread')} />}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** «Поддержка» from the profile: all requests; Telegram stays only as the last line. */
export function SupportList() {
  const { t } = useI18n();
  const telegramUrl = useSupportUrl();
  return (
    <div className="page">
      <h1>{t('support.listTitle')}</h1>
      <SupportThreadsList source="support_list" />
      {/* 6б-А: the Telegram account stays only as the last resort */}
      <button type="button" className="link support-telegram" onClick={() => openSupport(telegramUrl)}>
        {t('support.telegram')}
      </button>
    </div>
  );
}

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
// browsers write Uzbek dates differently (some as «M11 7»), so the month names are our own
const MONTHS = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
};
const dayLabel = (iso: string, lang: 'ru' | 'uz') => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[lang][d.getMonth()]}`;
};
const timeLabel = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 6б-Б (D-63): one request as a messenger chat — a header with the number and the status, the bubbles (the customer's on
 * the right, the shop's on the left), and a narrow input bar fixed at the bottom that grows with the text. A closed
 * request: the rating and «Новое обращение» instead of the input.
 */
export function SupportThreadScreen() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const thread = useSupportThread(id);
  const { openAsk } = useSheets();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const count = thread.data?.messages.length ?? 0;

  // opening marks the replies read: the bell and «Личные» are counted again
  useEffect(() => {
    if (thread.data) void client.invalidateQueries({ queryKey: ['notifications'] });
  }, [thread.data, client]);
  // the newest message is at the bottom, as in any messenger (after the layout's own scroll to the top)
  useEffect(() => {
    if (!count) return;
    const timer = setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight }), 0);
    return () => clearTimeout(timer);
  }, [count]);
  // the input grows with the text up to 5 lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const update = (th: SupportThread) => {
    client.setQueryData(['support', id], th);
    void client.invalidateQueries({ queryKey: ['support'], exact: true });
  };
  const send = useMutation({
    mutationFn: () => api<SupportThread>(`/support/threads/${id}/messages`, { method: 'POST', body: { text: text.trim() } }),
    onSuccess: (th) => {
      update(th);
      setText('');
    },
    onError: () => haptic('error'),
  });
  const rate = useMutation({
    mutationFn: (rating: number) => api<SupportThread>(`/support/threads/${id}/rating`, { method: 'POST', body: { rating } }),
    // the server counts the rating itself (analytics «support_rated»)
    onSuccess: (th) => {
      haptic('success');
      update(th);
    },
  });

  if (thread.isPending) return <div className="page"><Loading /></div>;
  if (thread.isError) return <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />;
  const th = thread.data;
  const closed = th.status === 'closed';
  const about = th.order ? t('orders.number', { n: orderNo(th.order.number) }) : th.product?.name;
  const aboutPath = th.order ? `/orders/${th.order.id}` : th.product ? `/product/${th.product.id}` : null;

  return (
    <div className={`chat-screen${closed ? ' is-closed' : ''}`}>
      <div className="chat-head">
        <button type="button" className="icon-btn" aria-label={t('common.back')} onClick={() => navigate('/support')}>
          <BackIcon />
        </button>
        <div className="chat-head-text">
          <h1>{t('support.no', { n: th.number })}</h1>
          <span className="hint small">
            {t(`ask.topic.${th.topic}`)} · <span className={`support-status is-${th.status}`}>{t(`support.status.${th.status}`)}</span>
          </span>
        </div>
      </div>
      {about && aboutPath && (
        <Link to={aboutPath} className="chat-about">
          {about}
        </Link>
      )}
      <ol className="chat">
        {th.messages.map((m, i) => (
          <li key={m.id} className="chat-row">
            {(i === 0 || !sameDay(th.messages[i - 1].created_at, m.created_at)) && (
              <span className="chat-day">{dayLabel(m.created_at, lang)}</span>
            )}
            <div className={`chat-msg is-${m.author}`}>
              {m.author === 'staff' && <span className="chat-who">{t('support.specialist')}</span>}
              <p>{m.text}</p>
              <time className="chat-time">{timeLabel(m.created_at)}</time>
            </div>
          </li>
        ))}
      </ol>
      {th.status === 'open' && <p className="chat-note hint small">{t('support.waiting')}</p>}

      {closed ? (
        <div className="chat-closed">
          <strong>{t('support.closedTitle', { n: th.number })}</strong>
          <span className="hint">{th.rating ? t('support.rated') : t('support.rate')}</span>
          <div className="chat-stars" role="radiogroup" aria-label={t('support.rate')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={th.rating === n}
                aria-label={t('support.stars', { n })}
                className={(th.rating ?? 0) >= n ? 'is-on' : ''}
                disabled={rate.isPending}
                onClick={() => rate.mutate(n)}
              >
                <StarIcon width={28} height={28} filled={(th.rating ?? 0) >= n} />
              </button>
            ))}
          </div>
          {th.rating && (
            <span className="chat-rated hint small">
              <CheckIcon width={16} height={16} /> {t('support.ratedNote')}
            </span>
          )}
          <button type="button" className="btn btn-block" onClick={() => openAsk({ source: 'closed_thread', order: th.order, product: th.product })}>
            {t('support.newRequest')}
          </button>
        </div>
      ) : (
        <form
          className="chat-bar"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !send.isPending) send.mutate();
          }}
        >
          {send.isError && (
            <p className="error-text chat-error" role="alert">
              {errorText(lang, send.error instanceof ApiError ? send.error.code : undefined)}
            </p>
          )}
          <textarea
            ref={box}
            rows={1}
            maxLength={SUPPORT_TEXT_MAX}
            value={text}
            placeholder={t('support.placeholder')}
            aria-label={t('support.reply')}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="chat-send" aria-label={t('ask.send')} disabled={!text.trim() || send.isPending}>
            <SendIcon width={20} height={20} />
          </button>
        </form>
      )}
    </div>
  );
}
