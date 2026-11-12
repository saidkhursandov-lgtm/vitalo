import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Аудит админки 2.9: the page tab from `?tab=`. The default tab has no `?tab=` (one address per tab); an unknown or
 * forbidden tab is replaced by the canonical address instead of silently showing the first tab under a wrong URL.
 */
export function useTab<T extends string>(valid: readonly T[], fallback: T): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const known = raw !== null && (valid as readonly string[]).includes(raw);
  const tab = known ? (raw as T) : fallback;
  // another tab starts clean: filters of the previous tab do not leak into it
  const set = (t: T) => setParams(t === fallback ? {} : { tab: t }, { replace: true });
  useEffect(() => {
    if (raw !== null && (!known || raw === fallback)) {
      const next = new URLSearchParams(params);
      next.delete('tab');
      setParams(next, { replace: true });
    }
  }, [raw, known, fallback, params, setParams]);
  return [tab, set];
}
