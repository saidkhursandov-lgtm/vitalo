import type { ReactNode } from 'react';

/**
 * Small, safe Markdown for legal texts: paragraphs, line breaks, headings (#), bullet and numbered lists,
 * **bold**, *italic* and backslash escapes (\[ \_). No HTML is ever injected — everything becomes React text.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return <div className="markdown">{blocks.map((b, i) => renderBlock(b.trim(), i))}</div>;
}

const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

function renderBlock(block: string, key: number): ReactNode {
  if (!block) return null;
  const lines = block.split('\n');
  const heading = block.match(/^(#{1,6})\s+(.*)$/);
  if (heading && lines.length === 1) return <h3 key={key}>{inline(heading[2])}</h3>;
  if (lines.every((l) => BULLET.test(l))) return <ul key={key}>{lines.map((l, i) => <li key={i}>{inline(l.replace(BULLET, ''))}</li>)}</ul>;
  if (lines.every((l) => NUMBERED.test(l))) return <ol key={key}>{lines.map((l, i) => <li key={i}>{inline(l.replace(NUMBERED, ''))}</li>)}</ol>;
  return (
    <p key={key}>
      {lines.map((l, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {inline(l)}
        </span>
      ))}
    </p>
  );
}

/** **bold**, *italic* / _italic_, \x escapes. */
export function inline(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let bold = false;
  let italic = false;
  const flush = () => {
    if (!buf) return;
    let node: ReactNode = buf;
    if (italic) node = <em key={`i${out.length}`}>{node}</em>;
    if (bold) node = <strong key={`b${out.length}`}>{node}</strong>;
    out.push(node);
    buf = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(src[i + 1])) {
      buf += src[++i];
    } else if (c === '*' && src[i + 1] === '*') {
      flush();
      bold = !bold;
      i++;
    } else if ((c === '*' || c === '_') && (italic || /\S/.test(src[i + 1] ?? ''))) {
      // a lone * or _ toggles italic only when it opens before text or closes an open italic
      flush();
      italic = !italic;
    } else buf += c;
  }
  flush();
  return out;
}
