import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { track } from '../lib/analytics';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { shortNameOf } from '../lib/format';
import { useCart, useShopTexts } from '../lib/queries';
import type { LocalizedText } from '../lib/types';
import { AcceptIcon, ChevronIcon, CloseIcon, LockIcon, RejectIcon, ShieldIcon, SparkIcon, SupportIcon } from './Icons';
import { AskSheet, type AskOptions } from './AskSheet';
import { AiChatSheet } from './AiChat';

type ManifestSource = 'home' | 'ai_sheet';

interface Sheets {
  openManifest: (source: ManifestSource) => void;
  openAi: () => void;
  /** 6а-Д: «Спросить специалиста» inside the Mini App */
  openAsk: (options?: AskOptions) => void;
}

const Ctx = createContext<Sheets>({ openManifest: () => undefined, openAi: () => undefined, openAsk: () => undefined });
export const useSheets = () => useContext(Ctx);

/**
 * 2.4: bottom sheets that several screens open — «Как VITALO отбирает добавки» (Home entry, «Подбор» sheet) and the
 * «Подбор» sheet of the centre menu button. One at a time: opening the manifest from «Подбор» replaces it.
 */
export function SheetsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<'manifest' | 'ai' | 'ask' | 'chat' | null>(null);
  const [ask, setAsk] = useState<AskOptions>({});
  const openManifest = useCallback((source: ManifestSource) => {
    track('manifest_open', { source });
    setOpen('manifest');
  }, []);
  const openAi = useCallback(() => {
    track('ai_tab_click');
    setOpen('ai');
  }, []);
  const openAsk = useCallback((options: AskOptions = {}) => {
    setAsk(options);
    setOpen('ask');
  }, []);
  const value = useMemo(() => ({ openManifest, openAi, openAsk }), [openManifest, openAi, openAsk]);
  const close = () => setOpen(null);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open === 'manifest' && <ManifestSheet onClose={close} />}
      {open === 'ai' && <AiSheet onClose={close} onManifest={() => openManifest('ai_sheet')} onChat={() => setOpen('chat')} />}
      {open === 'chat' && <CartChat onClose={close} onAsk={() => openAsk()} />}
      {open === 'ask' && <AskSheet options={ask} onClose={close} />}
    </Ctx.Provider>
  );
}

function SheetFrame({ label, onClose, className = '', children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <span />
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AskButton({ className = 'btn btn-block' }: { className?: string }) {
  const { t } = useI18n();
  const { openAsk } = useSheets();
  return (
    <button type="button" className={className} onClick={() => openAsk({ topic: 'medical', source: 'sheet' })}>
      <SupportIcon width={20} height={20} />
      <span>{t('ask.button')}</span>
    </button>
  );
}

/** Entry on Home under «Популярное»: icon, title, one line, «›». Hidden when switched off in the admin panel. */
export function ManifestEntry() {
  const { lang } = useI18n();
  const manifest = useShopTexts().data?.manifest;
  const { openManifest } = useSheets();
  if (!manifest?.enabled) return null;
  const tx = (v: LocalizedText) => (lang === 'uz' ? v.uz : v.ru);
  return (
    <button type="button" className="manifest-entry" aria-haspopup="dialog" onClick={() => openManifest('home')}>
      <span className="manifest-icon" aria-hidden>
        <ShieldIcon width={22} height={22} />
      </span>
      <span className="manifest-entry-text">
        <strong>{tx(manifest.title)}</strong>
        <span>{tx(manifest.subtitle)}</span>
      </span>
      <ChevronIcon className="manifest-chevron" width={20} height={20} aria-hidden />
    </button>
  );
}

function ManifestSheet({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n();
  const manifest = useShopTexts().data?.manifest;
  if (!manifest) return null;
  const tx = (v: LocalizedText) => (lang === 'uz' ? v.uz : v.ru);
  return (
    <SheetFrame label={tx(manifest.title)} onClose={onClose} className="manifest-sheet">
      <div className="sheet-body">
        <h2 className="manifest-title">{tx(manifest.title)}</h2>
        <p className="manifest-lead">{tx(manifest.lead)}</p>
        {/* 2.4 patch: scannable cards — «Не берём» (muted red cross, hidden when empty) and «Стандарт VITALO» (green tick) */}
        <ol className="manifest-cards">
          {manifest.cards.map((c, i) => (
            <li key={i} className="manifest-card">
              <div className="manifest-card-head">
                <span className="manifest-num" aria-hidden>
                  {i + 1}
                </span>
                <strong>{tx(c.title)}</strong>
              </div>
              {tx(c.bad).trim() && (
                <p className="manifest-line is-bad">
                  <RejectIcon width={18} height={18} />
                  <span>{tx(c.bad)}</span>
                </p>
              )}
              <p className="manifest-line is-good">
                <AcceptIcon width={18} height={18} />
                <span>{tx(c.good)}</span>
              </p>
            </li>
          ))}
        </ol>
      </div>
      <div className="sheet-actions sheet-actions-one">
        <AskButton />
      </div>
    </SheetFrame>
  );
}

const AI_CHIPS = ['ai.chipGoals'] as const;

/** A «Скоро» preview chip: does nothing, only shakes a little (not with reduced motion). */
function SoonChip({ label }: { label: string }) {
  const { t } = useI18n();
  const [shake, setShake] = useState(0);
  return (
    <li>
      <button type="button" className={`ai-chip ${shake % 2 ? 'is-shake-a' : shake ? 'is-shake-b' : ''}`} aria-disabled="true" onClick={() => setShake((n) => n + 1)}>
        <LockIcon width={16} height={16} />
        <span className="ai-chip-text">{label}</span>
        <span className="ai-chip-soon">{t('ai.soon')}</span>
      </button>
    </li>
  );
}

/** The cart of the customer in short, for «Спросить VITALO AI» from the centre button (D-70). */
function useCartItems() {
  const { lang } = useI18n();
  const cart = useCart();
  const items = (cart.data?.items ?? []).map((l) => ({ product_id: l.product_id, name: shortNameOf(l, lang), image_url: l.image_url ?? null }));
  return { items, loaded: !!cart.data };
}

function CartChat({ onClose, onAsk }: { onClose: () => void; onAsk: () => void }) {
  const { items } = useCartItems();
  return <AiChatSheet items={items} onClose={onClose} onAsk={onAsk} />;
}

/**
 * The centre «VITALO AI» (D-70): «Спросить VITALO AI» (the conversation; with an empty cart it suggests products of the
 * catalogue) and «Проверить совместимость корзины» (2+ products → the cart, where the check is at the top; an empty cart
 * or one product — a plain warning and the way to the catalogue). «Подбор курса по целям» is still «Скоро» (D-37).
 */
function AiSheet({ onClose, onManifest, onChat }: { onClose: () => void; onManifest: () => void; onChat: () => void }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const manifest = useShopTexts().data?.manifest;
  const { items, loaded } = useCartItems();
  const [warn, setWarn] = useState<'empty' | 'one' | null>(null);
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const check = () => {
    if (!loaded) return;
    if (items.length >= 2) go('/cart');
    else setWarn(items.length === 0 ? 'empty' : 'one');
  };
  return (
    <SheetFrame label={t('nav.ai')} onClose={onClose} className="ai-sheet">
      <div className="sheet-body ai-sheet-body">
        <span className="ai-badge">
          <SparkIcon width={14} height={14} />
          {t('ai.badge')}
        </span>
        <h2>{t('ai.title')}</h2>
        <p className="ai-text">{t('ai.text')}</p>
        <div className="ai-actions">
          <button type="button" className="ai-action" onClick={onChat}>
            <SparkIcon width={20} height={20} aria-hidden />
            <span>
              <strong>{t('aisheet.ask')}</strong>
              <span>{t('aisheet.askSub')}</span>
            </span>
            <ChevronIcon width={18} height={18} aria-hidden />
          </button>
          <button type="button" className="ai-action" onClick={check}>
            <ShieldIcon width={20} height={20} aria-hidden />
            <span>
              <strong>{t('aisheet.check')}</strong>
              <span>{t('aisheet.checkSub')}</span>
            </span>
            <ChevronIcon width={18} height={18} aria-hidden />
          </button>
        </div>
        {warn && (
          <div className="ai-sheet-warn" role="alert">
            <p>{t(warn === 'empty' ? 'aisheet.empty' : 'aisheet.one')}</p>
            <div className="ai-sheet-warn-actions">
              <button type="button" className="btn btn-secondary" onClick={() => go('/catalog')}>
                <span>{t('aisheet.catalog')}</span>
              </button>
              {warn === 'empty' && (
                <button type="button" className="btn" onClick={onChat}>
                  <span>{t('aisheet.ask')}</span>
                </button>
              )}
            </div>
          </div>
        )}
        <ul className="ai-chips">
          {AI_CHIPS.map((k) => (
            <SoonChip key={k} label={t(k)} />
          ))}
        </ul>
      </div>
      <div className="sheet-actions sheet-actions-one">
        <AskButton />
        {manifest?.enabled && (
          <button type="button" className="btn btn-secondary btn-block" onClick={onManifest}>
            <ShieldIcon width={20} height={20} />
            <span>{lang === 'uz' ? manifest.title.uz : manifest.title.ru}</span>
          </button>
        )}
      </div>
    </SheetFrame>
  );
}
