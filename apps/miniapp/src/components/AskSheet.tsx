import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { track } from '../lib/analytics';
import { orderNo } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { haptic } from '../lib/telegram';
import type { SupportThread, SupportTopic } from '../lib/types';
import { CheckIcon, ChevronDownIcon, CloseIcon, OrdersIcon, PillIcon } from './Icons';

export const SUPPORT_TOPICS: SupportTopic[] = ['product', 'medical', 'order', 'promo', 'tech'];
export const SUPPORT_TEXT_MAX = 2000;

/** What the sheet opens with: the product of the card or the order (attached by themselves) and the topic. */
export interface AskOptions {
  product?: { id: string; name: string } | null;
  order?: { id: string; number: string } | null;
  topic?: SupportTopic;
  source?: string;
}

/**
 * 6а-Д (D-62), 6б-Б (D-63): «Спросить специалиста» inside the Mini App. The topic is one row «Тема · … ›» (set by
 * itself from a product card or an order; a tap opens a short list), the product or the order is attached, then the
 * question. The answer comes to «Уведомления → Личные» and as a bot message; the conversation goes on in the Mini App.
 */
export function AskSheet({ options, onClose }: { options: AskOptions; onClose: () => void }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [topic, setTopic] = useState<SupportTopic>(options.topic ?? (options.order ? 'order' : options.product ? 'product' : 'medical'));
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState('');
  // owner, 10.11: the product goes only with «Вопрос о товаре», the order only with «По заказу» — another topic drops it
  const product = topic === 'product' ? options.product : null;
  const order = topic === 'order' ? options.order : null;
  const send = useMutation({
    mutationFn: () =>
      api<SupportThread>('/support/threads', { method: 'POST', body: { topic, text: text.trim(), product_id: product?.id, order_id: order?.id } }),
    onSuccess: () => {
      haptic('success');
      track('support_ask_sent', { topic, source: options.source ?? 'other', product: !!product, order: !!order });
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
              <span className="hint">{t('support.no', { n: done.number })}</span>
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
              {/* 6б-Б: one row instead of five big chips; the list opens only on a tap */}
              <button type="button" className="ask-topic-row" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
                <span className="hint">{t('ask.topic')}</span>
                <strong>{t(`ask.topic.${topic}`)}</strong>
                <ChevronDownIcon width={18} height={18} />
              </button>
              {picking && (
                <ul className="ask-topic-list" role="radiogroup" aria-label={t('ask.topic')}>
                  {SUPPORT_TOPICS.map((k) => (
                    <li key={k}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={k === topic}
                        className={k === topic ? 'is-on' : ''}
                        onClick={() => {
                          setTopic(k);
                          setPicking(false);
                        }}
                      >
                        <span>{t(`ask.topic.${k}`)}</span>
                        {k === topic && <CheckIcon width={18} height={18} />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {product && (
                <div className="ask-product">
                  <PillIcon width={18} height={18} aria-hidden />
                  <span>{product.name}</span>
                </div>
              )}
              {order && (
                <div className="ask-product">
                  <OrdersIcon width={18} height={18} aria-hidden />
                  <span>{t('orders.number', { n: orderNo(order.number) })}</span>
                </div>
              )}
              <label className="field">
                <span className="visually-hidden">{t('ask.question')}</span>
                <textarea rows={4} maxLength={SUPPORT_TEXT_MAX} value={text} placeholder={t('ask.placeholder')} aria-label={t('ask.question')} onChange={(e) => setText(e.target.value)} />
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
