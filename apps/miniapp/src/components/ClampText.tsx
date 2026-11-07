import { useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { ChevronDownIcon } from './Icons';

/** Longer than this (or more than four lines) — the text shows four lines and «Читать полностью» (owner, 06.11.2026). */
export const CLAMP_CHARS = 240;
const CLAMP_LINES = 4;

export const isLongText = (text: string) => text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES;

/**
 * A long text («Вердикт врача», «Почему бренд в VITALO»): four lines with «…» and a button that opens the whole text
 * smoothly («Свернуть» folds it back). A short text is shown as it is, without the button.
 */
export function ClampText({ text, className = '' }: { text: string; className?: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<number | null>(null);
  const long = isLongText(text);

  // the height of the whole text, for the opening animation (max-height can be animated, line-clamp cannot)
  useLayoutEffect(() => {
    if (open && ref.current) setFull(ref.current.scrollHeight);
  }, [open, text]);

  if (!long) return <p className={className}>{text}</p>;
  return (
    <>
      <p
        ref={ref}
        className={`${className} clamp-text${open ? ' is-open' : ''}`}
        style={open && full ? { maxHeight: `${full}px` } : undefined}
      >
        {text}
      </p>
      <button type="button" className="clamp-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t(open ? 'text.less' : 'text.more')}
        <ChevronDownIcon width={16} height={16} aria-hidden />
      </button>
    </>
  );
}
