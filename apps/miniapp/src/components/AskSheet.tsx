import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { track } from '../lib/analytics';
import { errorText, useI18n } from '../lib/i18n';
import { haptic } from '../lib/telegram';
import type { SupportThread, SupportTopic } from '../lib/types';
import { CheckIcon, CloseIcon, PillIcon } from './Icons';

export const SUPPORT_TOPICS: SupportTopic[] = ['medical', 'order', 'promo', 'tech'];
export const SUPPORT_TEXT_MAX = 2000;

/** What the sheet opens with: the product of the card (attached by itself) and the first chosen topic. */
export interface AskOptions {
  product?: { id: string; name: string } | null;
  topic?: SupportTopic;
  source?: string;
}

/**
 * 6а-Д (D-62): «Спросить специалиста» inside the Mini App (product card, «Поможем с выбором», «Подбор», the intake
 * memo): a topic by chips, the question, the product attached by itself. The answer comes to «Уведомления → Личные»
 * and as a bot message; the conversation goes on in the Mini App.
 */
export function AskSheet({ options, onClose }: { options: AskOptions; onClose: () => void }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [topic, setTopic] = useState<SupportTopic>(options.topic ?? 'medical');
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => api<SupportThread>('/support/threads', { method: 'POST', body: { topic, text: text.trim(), product_id: options.product?.id } }),
    onSuccess: () => {
      haptic('success');
      track('support_ask_sent', { topic, source: options.source ?? 'other', product: !!options.product });
      void client.invalidateQueries({ queryKey: ['support'] });
    },
    onError: () => haptic('error'),
  });
  const done = send.data;
  const error = send.error ? errorText(lang, send.error instanceof ApiError ? send.error.code : undefined) : null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet ask-sheet" role="dialog" aria-modal="true" aria-labelledby="ask-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2 id="ask-title">{t('ask.button')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {done ? (
          <>
            <div className="sheet-body ask-done" role="status">
              <span className="ask-done-icon" aria-hidden>
                <CheckIcon width={28} height={28} />
              </span>
              <strong>{t('ask.sentTitle')}</strong>
              <p className="hint">{t('ask.sentText')}</p>
            </div>
            <div className="sheet-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('ask.ok')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  navigate(`/support/${done.id}`);
                }}
              >
                {t('ask.openThread')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sheet-body">
              <p className="ask-label">{t('ask.topic')}</p>
              <div className="chips ask-topics" role="radiogroup" aria-label={t('ask.topic')}>
                {SUPPORT_TOPICS.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={k === topic} className={`chip${k === topic ? ' is-on' : ''}`} onClick={() => setTopic(k)}>
                    {t(`ask.topic.${k}`)}
                  </button>
                ))}
              </div>
              {options.product && (
                <div className="ask-product">
                  <PillIcon width={18} height={18} aria-hidden />
                  <span>{options.product.name}</span>
                </div>
              )}
              <label className="field">
                <span>{t('ask.question')}</span>
                <textarea rows={4} maxLength={SUPPORT_TEXT_MAX} value={text} placeholder={t('ask.placeholder')} onChange={(e) => setText(e.target.value)} />
              </label>
              <p className="hint small">{topic === 'medical' ? t('ask.medicalNote') : t('ask.whereAnswer')}</p>
              {error && <p className="error-text" role="alert">{error}</p>}
            </div>
            <div className="sheet-actions sheet-actions-one">
              <button type="button" className="btn btn-block" disabled={text.trim().length < 2 || send.isPending} onClick={() => send.mutate()}>
                {send.isPending ? t('common.loading') : t('ask.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
