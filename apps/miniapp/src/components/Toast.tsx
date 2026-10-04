import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

interface ToastState {
  id: number;
  message: string;
  action?: ReactNode;
}

const Ctx = createContext<(message: string, action?: ReactNode) => void>(() => undefined);

/**
 * One short message at the bottom. A new one replaces the old (they never pile up) and it hides by itself.
 * Never navigates anywhere on its own: the optional action (e.g. «Корзина») is a link the customer taps.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const show = useCallback((message: string, action?: ReactNode) => setToast((t) => ({ id: (t?.id ?? 0) + 1, message, action })), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.id} className="toast" role="status" aria-live="polite">
          <span>{toast.message}</span>
          {toast.action}
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
