import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';

interface ConfirmOptions {
  message: string;
  ok?: string;
  cancel?: string;
  danger?: boolean;
}

const Ctx = createContext<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));

/**
 * Confirmation as our own bottom sheet, always in the shop language (the Telegram and browser
 * dialogs show "OK / Отмена" in the phone's language, not the one chosen in the shop).
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false);
    setOpen(o);
    return new Promise<boolean>((resolve) => (resolver.current = resolve));
  }, []);
  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpen(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {open && (
        <div className="sheet-backdrop confirm-backdrop" onClick={() => close(false)}>
          <div className="sheet confirm-sheet" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" aria-hidden />
            <p className="confirm-text">{open.message}</p>
            <div className="sheet-actions confirm-actions">
              <button className="btn btn-secondary" onClick={() => close(false)}>
                {open.cancel ?? t('common.cancel')}
              </button>
              <button className={`btn ${open.danger ? 'btn-danger-solid' : ''}`} onClick={() => close(true)} autoFocus>
                {open.ok ?? t('common.yes')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useConfirm = () => useContext(Ctx);
