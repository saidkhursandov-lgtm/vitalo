import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useCartActions } from '../lib/queries';
import type { AiChatMessage, AiChatState, AiChatTopic, AiGoalFit, Lang } from '../lib/types';
import type { AiCartItem } from './AiCompat';
import { useConfirm } from './Confirm';
import { CloseIcon, InfoIcon, SendIcon, ShieldIcon, SparkIcon } from './Icons';

const FIT_TONE: Record<AiGoalFit, 'green' | 'yellow' | 'grey'> = { helps: 'green', maybe: 'yellow', unlikely: 'grey', no_data: 'grey' };
type Goal = Exclude<AiChatTopic, 'compat' | 'other'>;

/** Questions in the customer's voice (D-70). The concerns go in the order of the cart's goals (`state.topics`). */
const CONCERN: Record<Lang, Record<Goal, string>> = {
  ru: {
    sleep: 'Мне трудно заснуть',
    stress: 'Слишком много стресса',
    energy: 'Постоянно нет сил',
    joints: 'Болят и хрустят суставы',
    immunity: 'Часто простываю',
    sport: 'Занимаюсь спортом, хочу быстрее восстанавливаться',
  },
  uz: {
    sleep: 'Uxlab qolishim qiyin',
    stress: 'Stress juda koʻp',
    energy: 'Doim holsizman',
    joints: 'Boʻgʻimlarim ogʻriydi va qisirlaydi',
    immunity: 'Tez-tez shamollayman',
    sport: 'Sport bilan shugʻullanaman, tezroq tiklanmoqchiman',
  },
};
const CONCERN_TAIL: Record<Lang, { cart: string; one: string; empty: string }> = {
  ru: { cart: ' — что из этого поможет?', one: ' — поможет ли этот товар?', empty: ' — что выбрать?' },
  uz: { cart: ' — bulardan qaysi biri yordam beradi?', one: ' — bu mahsulot yordam beradimi?', empty: ' — nimani tanlash kerak?' },
};
const ABOUT_CART: Record<Lang, string[]> = {
  ru: ['Можно ли принимать их вместе?', 'Как распределить приём в течение дня?', 'Нет ли здесь лишнего или повторов?'],
  uz: ['Ularni birga qabul qilsa boʻladimi?', 'Kun davomida qabulni qanday taqsimlash kerak?', 'Bu yerda ortiqcha yoki takror yoʻqmi?'],
};
const ABOUT_ONE: Record<Lang, string[]> = {
  ru: ['Для чего обычно берут этот товар?', 'Утром или вечером его лучше принимать?'],
  uz: ['Bu mahsulot odatda nima uchun olinadi?', 'Uni ertalab yoki kechqurun ichgan maʼqulmi?'],
};

export function chatSuggestions(lang: Lang, count: number, topics: Goal[]): { cart: string[]; concerns: string[] } {
  const tail = CONCERN_TAIL[lang][count === 0 ? 'empty' : count === 1 ? 'one' : 'cart'];
  return {
    cart: count === 0 ? [] : count === 1 ? ABOUT_ONE[lang] : ABOUT_CART[lang],
    concerns: topics.map((g) => CONCERN[lang][g] + tail),
  };
}

type Failure = 'limit' | 'failed' | 'full' | 'too_long';

/**
 * D-70: «Спросить VITALO AI о корзине» — a conversation in a bottom sheet. On top — the cart in short; then suggested
 * questions (about the cart, then «Что беспокоит» — the goals of the cart first) and a text field (up to `max_chars`);
 * up to `max_turns` questions in a conversation. Every answer: labels from our base, tips, the doctor line, «Спросить
 * специалиста», follow-up questions. At the bottom — the beta line. The conversation is kept 12 months and the customer
 * may delete it here.
 */
export function AiChatSheet({ items, onClose, onAsk }: { items: AiCartItem[]; onClose: () => void; onAsk?: () => void }) {
  const { t, lang } = useI18n();
  const client = useQueryClient();
  const confirm = useConfirm();
  const { add } = useCartActions();
  const state = useQuery({ queryKey: ['ai-chat', lang], queryFn: () => api<AiChatState>('/compat/ai/chat') });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [fresh, setFresh] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const end = useRef<HTMLDivElement>(null);
  const s = state.data;
  const chat = fresh ? null : (s?.chat ?? null);
  const messages = chat?.messages ?? [];
  const full = !!chat && !!s && chat.questions >= s.max_turns;
  const n = items.length;

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, pending]);

  const setState = (next: AiChatState) => client.setQueryData(['ai-chat', lang], next);
  const send = async (raw: string, suggestion?: string) => {
    const q = raw.trim();
    if (!q || busy || !s) return;
    if (q.length > s.max_chars) return setFailure('too_long');
    setBusy(true);
    setPending(q);
    setFailure(null);
    setText('');
    try {
      const res = await api<{ chat: AiChatState['chat']; left_today: number }>('/compat/ai/chat/message', {
        method: 'POST',
        body: { text: q, ...(chat && { chat_id: chat.id }), ...(suggestion && { suggestion }) },
      });
      setFresh(false);
      setState({ ...s, chat: res.chat, left_today: res.left_today });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      setFailure(code === 'AI_DAILY_LIMIT' ? 'limit' : code === 'CHAT_FULL' ? 'full' : code === 'TOO_LONG' ? 'too_long' : 'failed');
      setText(q);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };
  const agree = async () => {
    setBusy(true);
    try {
      setState(await api<AiChatState>('/compat/ai/chat/consent', { method: 'POST' }));
    } catch {
      setFailure('failed');
    } finally {
      setBusy(false);
    }
  };
  const restart = () => {
    setFresh(true);
    setFailure(null);
  };
  const remove = async () => {
    if (!chat || !s) return;
    if (!(await confirm({ message: t('aichat.deleteAsk'), ok: t('aichat.delete'), danger: true }))) return;
    try {
      await api(`/compat/ai/chat/${chat.id}`, { method: 'DELETE' });
      setState({ ...s, chat: null });
      setFresh(false);
    } catch {
      setFailure('failed');
    }
  };
  const toCart = (productId: string) =>
    add.mutate({ product_id: productId, qty: 1 }, { onSuccess: () => setAdded((prev) => new Set(prev).add(productId)) });

  const title = n === 1 ? t('ai.chatOne') : n === 0 ? t('aichat.title') : t('ai.chat');
  const specialist = onAsk ? (
    <button type="button" className="link ai-ask" onClick={onAsk}>
      <ShieldIcon width={14} height={14} aria-hidden /> {t('ai.goal.specialist')}
    </button>
  ) : (
    <Link to="/support" className="link ai-ask">
      <ShieldIcon width={14} height={14} aria-hidden /> {t('ai.goal.specialist')}
    </Link>
  );
  const sugg = s ? chatSuggestions(lang, n, s.topics) : { cart: [], concerns: [] };
  const last = messages.at(-1);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet ai-chat-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2>
            <SparkIcon width={18} height={18} aria-hidden /> {title}
          </h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ai-chat-cart" aria-label={t('aichat.cart')}>
          {n === 0 ? (
            <span>{t('aichat.cartEmpty')}</span>
          ) : (
            <>
              <span className="ai-chat-thumbs" aria-hidden>
                {items.slice(0, 4).map((i) => (i.image_url ? <img key={i.product_id} src={i.image_url} alt="" /> : <span key={i.product_id} className="ai-chat-thumb-empty" />))}
              </span>
              <span className="ai-chat-cart-names">{items.map((i) => i.name).join(', ')}</span>
            </>
          )}
        </div>

        {!s ? (
          <div className="sheet-body">
            <p className="hint">{state.isError ? t('ai.goal.failed') : t('aichat.loading')}</p>
          </div>
        ) : !s.consent ? (
          <>
            <div className="sheet-body ai-consent">
              <p>{t('ai.consentBody')}</p>
              <p>
                <Link to="/legal/privacy" className="link">
                  {t('ai.consentPrivacy')}
                </Link>
              </p>
              {failure && (
                <p className="error-text small" role="alert">
                  {t('ai.failed')}
                </p>
              )}
            </div>
            <div className="sheet-actions sheet-actions-one">
              <button type="button" className="btn btn-block" disabled={busy} onClick={() => void agree()}>
                <span>{t('ai.agree')}</span>
              </button>
            </div>
          </>
        ) : !s.available ? (
          <div className="sheet-body">
            <div className="ai-note" role="status">
              <InfoIcon width={18} height={18} aria-hidden />
              <span>
                {t('ai.goal.failed')}
                {specialist}
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="sheet-body ai-chat-body" aria-live="polite">
              {chat && (
                <div className="ai-chat-tools">
                  <span className="ai-chat-number">{chat.number}</span>
                  <button type="button" className="link" onClick={restart}>
                    {t('aichat.new')}
                  </button>
                  <button type="button" className="link ai-chat-delete" onClick={() => void remove()}>
                    {t('aichat.delete')}
                  </button>
                </div>
              )}
              {messages.length === 0 && !pending && (
                <div className="ai-chat-start">
                  <p className="ai-chat-hello">{t(n === 0 ? 'aichat.helloEmpty' : 'aichat.hello')}</p>
                  {sugg.cart.length > 0 && (
                    <SuggestGroup title={t(n === 1 ? 'aichat.aboutOne' : 'aichat.aboutCart')} items={sugg.cart} onPick={(q) => void send(q, 'cart')} />
                  )}
                  <SuggestGroup title={t('aichat.concerns')} items={sugg.concerns} onPick={(q) => void send(q, 'concern')} />
                </div>
              )}
              {messages.map((m) => (
                <Message key={m.id} m={m} specialist={specialist} added={added} onAdd={toCart} />
              ))}
              {pending && (
                <>
                  <div className="ai-msg is-user">{pending}</div>
                  <div className="ai-msg is-ai ai-typing" role="status">
                    {t('aichat.typing')}
                  </div>
                </>
              )}
              {!busy && !full && last?.role === 'ai' && (
                <Chips items={last.kind === 'clarify' ? (last.options ?? []) : (last.followups ?? [])} onPick={(q) => void send(q, last.kind === 'clarify' ? 'clarify' : 'followup')} />
              )}
              {failure && (
                <div className="ai-note" role="status">
                  <InfoIcon width={18} height={18} aria-hidden />
                  <span>
                    {t(FAILURE_KEY[failure], { n: s.max_chars })}
                    {failure !== 'too_long' && specialist}
                  </span>
                </div>
              )}
              <div ref={end} />
            </div>
            <div className="ai-chat-foot">
              {full ? (
                <div className="ai-chat-full">
                  <span>{t('aichat.full')}</span>
                  <button type="button" className="btn btn-block" onClick={restart}>
                    <span>{t('aichat.new')}</span>
                  </button>
                </div>
              ) : (
                <form
                  className="ai-chat-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send(text);
                  }}
                >
                  <textarea
                    rows={1}
                    maxLength={s.max_chars}
                    value={text}
                    placeholder={t('aichat.placeholder')}
                    aria-label={t('aichat.placeholder')}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void send(text);
                      }
                    }}
                  />
                  <button type="submit" className="ai-chat-send" disabled={busy || !text.trim()} aria-label={t('aichat.send')}>
                    <SendIcon width={20} height={20} aria-hidden />
                  </button>
                </form>
              )}
              <div className="ai-chat-meta">
                {!full && text.length > s.max_chars - 50 && (
                  <span>
                    {text.length}/{s.max_chars}
                  </span>
                )}
                {chat && !full && <span>{t('aichat.left', { n: s.max_turns - chat.questions })}</span>}
              </div>
              <p className="ai-chat-beta">{t('aichat.beta')}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const FAILURE_KEY: Record<Failure, MessageKey> = { limit: 'ai.goal.limit', failed: 'ai.goal.failed', full: 'aichat.full', too_long: 'aichat.tooLong' };

function SuggestGroup({ title, items, onPick }: { title: string; items: string[]; onPick: (q: string) => void }) {
  return (
    <div className="ai-chat-group">
      <p className="ai-chat-group-title">{title}</p>
      <Chips items={items} onPick={onPick} />
    </div>
  );
}

function Chips({ items, onPick }: { items: string[]; onPick: (q: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="chips wrap ai-chat-chips">
      {items.map((q) => (
        <button key={q} type="button" className="chip" onClick={() => onPick(q)}>
          {q}
        </button>
      ))}
    </div>
  );
}

function Message({ m, specialist, added, onAdd }: { m: AiChatMessage; specialist: ReactNode; added: Set<string>; onAdd: (id: string) => void }) {
  const { t } = useI18n();
  if (m.role === 'user') return <div className="ai-msg is-user">{m.text}</div>;
  return (
    <div className={`ai-msg is-ai is-${m.kind}`}>
      <span className="ai-msg-tag">
        <SparkIcon width={12} height={12} aria-hidden /> VITALO AI
      </span>
      {m.text && <p className="ai-msg-text">{m.text}</p>}
      {!!m.products?.length && (
        <ul className="ai-goal-products">
          {m.products.map((p) => (
            <li key={p.product_id}>
              <div className="ai-goal-product-head">
                <span className="ai-goal-name">{p.name}</span>
                {p.fit && <span className={`ai-verdict is-${FIT_TONE[p.fit]}`}>{t(`ai.goal.fit.${p.fit}` as MessageKey)}</span>}
              </div>
              {p.level_text && <span className="ai-goal-level">{p.level_text}</span>}
              <p className="ai-goal-text">{p.text}</p>
              {!p.in_cart && (
                <button type="button" className="btn btn-sm ai-chat-add" disabled={added.has(p.product_id)} onClick={() => onAdd(p.product_id)}>
                  <span>{added.has(p.product_id) ? t('aichat.added') : t('aichat.toCart')}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!!m.steps?.length && (
        <>
          <h4 className="ai-sub">{t('ai.goal.steps')}</h4>
          <ul className="ai-goal-steps">
            {m.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {m.doctor && <p className="ai-goal-doctor">{m.doctor}</p>}
      {m.specialist && specialist}
    </div>
  );
}
