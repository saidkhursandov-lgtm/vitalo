import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION } from './lib/format';

/**
 * Аудит админки 10.11, п. 1.12: every action the API writes to the audit log and every funnel event has a Russian
 * label in the admin — so the pages never show raw keys like `banner.deleted` or `support_ask_sent`.
 */
const API_SRC = join(__dirname, '../../api/src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

/** Keys written as `action: '…'` (also both sides of a ternary on that line) plus the template ones expanded. */
function apiActions(): string[] {
  const keys = new Set<string>();
  for (const f of files(API_SRC)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!/\baction:/.test(line)) continue;
      for (const m of line.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) keys.add(m[1]);
    }
  }
  // template keys: `compat.ai_${review}` and `compat.rule_${status}`
  for (const r of ['new', 'approved', 'fixed', 'hidden']) keys.add(`compat.ai_${r}`);
  for (const s of ['draft', 'approved', 'off']) keys.add(`compat.rule_${s}`);
  for (const s of ['draft', 'approved', 'off']) keys.add(`compat.goal_${s}`);
  return [...keys].sort();
}

function listConst(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe('labels for audit actions and funnel events', () => {
  it('every audit action written by the API has a label in AUDIT_ACTION', () => {
    const actions = apiActions();
    expect(actions.length).toBeGreaterThan(100);
    expect(actions.filter((a) => !AUDIT_ACTION[a])).toEqual([]);
  });

  it('every extra funnel event has a label on the «Воронка» page', () => {
    const module = readFileSync(join(API_SRC, 'analytics/analytics.module.ts'), 'utf8');
    const events = [...listConst(module, 'APP_EXTRA_EVENTS'), ...listConst(module, 'SERVER_EXTRA_EVENTS')];
    const funnel = readFileSync(join(__dirname, 'pages/Funnel.tsx'), 'utf8');
    const block = funnel.slice(funnel.indexOf('const EXTRA_NAMES'), funnel.indexOf('};', funnel.indexOf('const EXTRA_NAMES')));
    const labelled = new Set([...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]));
    expect(events.filter((e) => !labelled.has(e))).toEqual([]);
  });
});
