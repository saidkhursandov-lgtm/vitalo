import { useEffect } from 'react';

const DEFAULT_TITLE = 'VITALO — витамины и БАДы с доставкой по Узбекистану';

function setDescription(text: string | null) {
  const el = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!el) return null;
  const prev = el.content;
  if (text) el.content = text;
  return prev;
}

/**
 * Release 6 «Сайт»: the tab title and the search snippet of a page («Магний B6 — VITALO»). Google reads them after the
 * page has rendered; inside Telegram they are simply not visible. The previous values come back when the page closes.
 */
export function usePageMeta(title: string | null | undefined, description?: string | null) {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} — VITALO`;
    const prev = setDescription(description ? description.replace(/\s+/g, ' ').trim().slice(0, 160) : null);
    return () => {
      document.title = DEFAULT_TITLE;
      if (prev !== null) setDescription(prev);
    };
  }, [title, description]);
}
