import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { SearchIcon } from './Icons';
import { ErrorBox, Modal } from './ui';

interface Hit {
  id: string;
  title: string;
  subtitle?: string;
  to: string;
}
type Group = 'orders' | 'products' | 'customers' | 'units';
const GROUPS: [Group, string][] = [
  ['orders', 'Заказы'],
  ['products', 'Товары'],
  ['customers', 'Клиенты'],
  ['units', 'Банки'],
];

/** Wait until the typing stops, so that every letter is not a request. */
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Аудит админки 2.10: one search for the whole admin panel — «Поиск» in the menu and Ctrl+K (⌘K) anywhere.
 * Orders of both channels, products, customers, jars by Physical ID; each group only with its permission (the API
 * decides). Enter opens the first hit.
 */
export function GlobalSearch({ className, hotkey }: { className?: string; hotkey?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);
  return (
    <>
      <button type="button" className={`btn btn-ghost search-open ${className ?? ''}`} onClick={() => setOpen(true)} aria-label="Поиск (Ctrl+K)">
        <SearchIcon size={18} /> <span>Поиск</span> {hotkey && <kbd className="muted small">Ctrl K</kbd>}
      </button>
      {open && <SearchDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const res = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<Partial<Record<Group, Hit[]>>>(`/staff/search${qs({ q })}`),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
  const groups = GROUPS.map(([g, label]) => [label, res.data?.[g] ?? []] as const).filter(([, hits]) => hits.length > 0);
  const first = groups[0]?.[1][0];
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  return (
    <Modal title="Поиск" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (first) go(first.to);
        }}
      >
        <input
          ref={input}
          type="search"
          className="input search-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Номер заказа, артикул, телефон, Physical ID"
          aria-label="Что искать"
        />
      </form>
      {q.length < 2 ? (
        <p className="muted small">Введите хотя бы 2 символа. Enter открывает первый результат.</p>
      ) : res.isError ? (
        <ErrorBox error={res.error} />
      ) : res.isPending ? (
        <p className="muted small">Ищем…</p>
      ) : groups.length === 0 ? (
        <p className="muted">Ничего не нашлось</p>
      ) : (
        <div className="search-results">
          {groups.map(([label, hits]) => (
            <section key={label}>
              <h3 className="muted small">{label}</h3>
              <ul>
                {hits.map((h) => (
                  <li key={h.id}>
                    <button type="button" className={`search-hit ${h === first ? 'is-first' : ''}`} onClick={() => go(h.to)}>
                      <strong>{h.title}</strong>
                      {h.subtitle && <span className="muted small">{h.subtitle}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
