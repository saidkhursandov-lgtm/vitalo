import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ErrorBox } from './ui';

/**
 * «Перевести на узбекский» next to a UZ field of the knowledge base: VITALO AI translates the Russian text (Latin script,
 * «siz»); the person checks it and saves. Counts in the monthly AI budget.
 */
export function TranslateButton({ ru, onDone, disabled }: { ru: string; onDone: (uz: string) => void; disabled?: boolean }) {
  const m = useMutation({
    mutationFn: () => api<{ text: string }>('/staff/compat/translate', { method: 'POST', body: { text: ru, to: 'uz' } }),
    onSuccess: (r) => onDone(r.text),
  });
  return (
    <span className="translate-button">
      <button type="button" className="btn btn-sm btn-ghost" disabled={disabled || m.isPending || ru.trim().length < 2} onClick={() => m.mutate()}>
        {m.isPending ? 'Перевожу…' : 'Перевести с русского (AI)'}
      </button>
      {m.error && <ErrorBox error={m.error} />}
    </span>
  );
}
