import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import { useShopTexts } from '../lib/queries';
import type { LocalizedText } from '../lib/types';
import { ChevronIcon, CloseIcon, ShieldIcon, SparkIcon, SupportIcon } from './Icons';
import { useAskSpecialist } from './Support';

type ManifestSource = 'home' | 'ai_sheet';

interface Sheets {
  openManifest: (source: ManifestSource) => void;
  openAi: () => void;
}

const Ctx = createContext<Sheets>({ openManifest: () => undefined, openAi: () => undefined });
export const useSheets = () => useContext(Ctx);

/**
 * 2.4: bottom sheets that several screens open — «Как VITALO отбирает добавки» (Home entry, «Подбор» sheet) and the
 * «Подбор» sheet of the centre menu button. One at a time: opening the manifest from «Подбор» replaces it.
 */
export function SheetsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<'manifest' | 'ai' | null>(null);
  const openManifest = useCallback((source: ManifestSource) => {
    track('manifest_open', { source });
    setOpen('manifest');
  }, []);
  const openAi = useCallback(() => {
    track('ai_tab_click');
    setOpen('ai');
  }, []);
  const value = useMemo(() => ({ openManifest, openAi }), [openManifest, openAi]);
  const close = () => setOpen(null);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open === 'manifest' && <ManifestSheet onClose={close} />}
      {open === 'ai' && <AiSheet onClose={close} onManifest={() => openManifest('ai_sheet')} />}
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
  const ask = useAskSpecialist();
  return (
    <button type="button" className={className} onClick={() => ask(t('ask.text'))}>
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
        <p className="manifest-intro">{tx(manifest.intro)}</p>
        <ol className="manifest-points">
          {manifest.points.map((p, i) => (
            <li key={i}>
              <span className="manifest-num" aria-hidden>
                {i + 1}
              </span>
              <span>
                <strong>{tx(p.title)}</strong>
                <span>{tx(p.text)}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="manifest-outro">{tx(manifest.outro)}</p>
      </div>
      <div className="sheet-actions sheet-actions-one">
        <AskButton />
      </div>
    </SheetFrame>
  );
}

/** «Подбор» until AI-подбор (release 5): what is coming and two ways to get help now. */
function AiSheet({ onClose, onManifest }: { onClose: () => void; onManifest: () => void }) {
  const { t, lang } = useI18n();
  const manifest = useShopTexts().data?.manifest;
  return (
    <SheetFrame label={t('nav.ai')} onClose={onClose} className="ai-sheet">
      <div className="sheet-body ai-sheet-body">
        <span className="ai-sheet-mark" aria-hidden>
          <SparkIcon width={28} height={28} />
        </span>
        <h2>{t('ai.title')}</h2>
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
