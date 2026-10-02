import { useEffect, type ReactNode } from 'react';
import { errorText } from '../lib/api';
import { ORDER_STATUS, PAYMENT_STATUS } from '../lib/format';

export const Loading = () => <div className="muted pad">Загрузка…</div>;

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      {errorText(error)}
      {onRetry && (
        <button className="btn btn-sm btn-ghost" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = {
  new: 'warn',
  awaiting_payment: 'warn',
  paid: 'info',
  picking: 'info',
  handed_to_delivery: 'info',
  in_transit: 'info',
  delivered: 'ok',
  cancelled: 'bad',
  return: 'bad',
};

export const OrderStatus = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status]}>{ORDER_STATUS[status] ?? status}</Badge>;

export const PaymentStatus = ({ status }: { status: string }) => (
  <Badge tone={status === 'payment_success' ? 'ok' : status === 'payment_pending' ? 'warn' : 'bad'}>{PAYMENT_STATUS[status] ?? status}</Badge>
);

export function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <button className="btn btn-sm btn-ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Назад
      </button>
      <span className="muted">
        Страница {page} из {totalPages}
      </span>
      <button className="btn btn-sm btn-ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Вперёд →
      </button>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-sm btn-ghost" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <div className="page-actions">{children}</div>
    </div>
  );
}

export const NoAccess = () => (
  <div className="pad">
    <h1>Нет доступа</h1>
    <p className="muted">У вашей роли нет прав на этот раздел.</p>
  </div>
);

/** Integer input that keeps "" while typing; returns undefined for empty. */
export const toInt = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v.replace(/\s/g, '')));
