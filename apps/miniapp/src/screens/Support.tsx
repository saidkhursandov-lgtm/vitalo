import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SupportIcon } from '../components/Icons';
import { useSheets } from '../components/Sheets';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useSupportThread, useSupportThreads } from '../lib/queries';
import type { SupportThread } from '../lib/types';
import { SUPPORT_TEXT_MAX } from '../components/AskSheet';
import { useSupportUrl } from '../components/Support';
import { openSupport } from '../lib/shop';

/** 6а-Д: «Мои вопросы специалисту» — every question with its topic, the last message and the new replies. */
export function SupportList() {
  const { t, lang } = useI18n();
  const list = useSupportThreads();
  const { openAsk } = useSheets();
  const telegramUrl = useSupportUrl();
  return (
    <div className="page">
      <h1>{t('support.listTitle')}</h1>
      {list.isPending ? (
        <Loading variant="list" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={SupportIcon} title={t('support.emptyTitle')} text={t('support.empty')} />
      ) : (
        <ul className="card list centre-list">
          {list.data.map((th) => {
            const last = th.messages[th.messages.length - 1];
            return (
              <li key={th.id}>
                <Link to={`/support/${th.id}`} className={`centre-item${th.unread ? ' is-unread' : ''}`}>
                  <span className="centre-icon centre-icon-personal" aria-hidden>
                    <SupportIcon width={20} height={20} />
                  </span>
                  <span className="centre-text">
                    <strong>{t(`ask.topic.${th.topic}`)}</strong>
                    {th.product && <span className="hint small">{th.product.name}</span>}
                    <span>{last?.text}</span>
                    <span className="hint small">
                      {t(`support.status.${th.status}`)} · {dateTime(th.last_message_at, lang)}
                    </span>
                  </span>
                  {!!th.unread && <span className="centre-dot" aria-label={t('notifications.unread')} />}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="btn btn-secondary btn-block" onClick={() => openAsk({ source: 'support_list' })}>
        <SupportIcon width={20} height={20} /> {t('support.newQuestion')}
      </button>
      {/* 6б-А: the Telegram account stays only as the last resort */}
      <button type="button" className="link support-telegram" onClick={() => openSupport(telegramUrl)}>
        {t('support.telegram')}
      </button>
    </div>
  );
}

/** 6а-Д: one conversation — the customer's messages on the right, the shop's on the left; a reply box at the bottom. */
export function SupportThreadScreen() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const client = useQueryClient();
  const thread = useSupportThread(id);
  const [text, setText] = useState('');
  // opening marks the replies read: the bell and «Личные» are counted again
  useEffect(() => {
    if (thread.data) void client.invalidateQueries({ queryKey: ['notifications'] });
  }, [thread.data, client]);
  const send = useMutation({
    mutationFn: () => api<SupportThread>(`/support/threads/${id}/messages`, { method: 'POST', body: { text: text.trim() } }),
    onSuccess: (th) => {
      client.setQueryData(['support', id], th);
      void client.invalidateQueries({ queryKey: ['support'], exact: true });
      setText('');
    },
  });

  if (thread.isPending) return <div className="page"><Loading /></div>;
  if (thread.isError) return <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />;
  const th = thread.data;
  return (
    <div className="page support-thread">
      <Link to="/support" className="link back-to-cart">
        ‹ {t('support.listTitle')}
      </Link>
      <h1>{t(`ask.topic.${th.topic}`)}</h1>
      {th.product && (
        <Link to={`/product/${th.product.id}`} className="ask-product">
          {th.product.name}
        </Link>
      )}
      <ol className="chat">
        {th.messages.map((m) => (
          <li key={m.id} className={`chat-msg is-${m.author}`}>
            {m.author === 'staff' && <span className="chat-who">{t('support.specialist')}</span>}
            <p>{m.text}</p>
            <time className="hint small">{dateTime(m.created_at, lang)}</time>
          </li>
        ))}
      </ol>
      {th.status !== 'answered' && th.status !== 'closed' && <p className="hint small">{t('support.waiting')}</p>}
      <div className="card chat-reply">
        <label className="field">
          <span>{t('support.reply')}</span>
          <textarea rows={3} maxLength={SUPPORT_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {send.isError && <p className="error-text" role="alert">{errorText(lang, send.error instanceof ApiError ? send.error.code : undefined)}</p>}
        <button type="button" className="btn btn-block" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? t('common.loading') : t('ask.send')}
        </button>
      </div>
    </div>
  );
}
