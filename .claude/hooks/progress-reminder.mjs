// Stop hook: a light reminder to update docs/PROGRESS.md.
// Fires only when commits that touch code (apps/, deploy/, scripts/) were made after the last commit of
// docs/PROGRESS.md, and the journal is not being edited right now. Reminds once per commit (HEAD), never loops,
// and stays silent on any error. Costs nothing when the journal is up to date.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (input.stop_hook_active) process.exit(0);
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  const last = git(dir, 'log', '-1', '--format=%H', '--', 'docs/PROGRESS.md');
  if (!last) process.exit(0);
  const behind = git(dir, 'log', '--format=%h', `${last}..HEAD`, '--', 'apps', 'deploy', 'scripts');
  if (!behind) process.exit(0);
  if (git(dir, 'status', '--porcelain', '--', 'docs/PROGRESS.md')) process.exit(0);

  const head = git(dir, 'rev-parse', 'HEAD');
  const stamp = git(dir, 'rev-parse', '--git-path', 'vitalo-progress-reminded');
  const stampPath = stamp.match(/^([A-Za-z]:|\/)/) ? stamp : `${dir}/${stamp}`;
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === head) process.exit(0);
  writeFileSync(stampPath, head);

  const n = behind.split('\n').length;
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `Код менялся (${n} коммит(ов) после последнего обновления docs/PROGRESS.md), а журнал нет. Если задача завершена — вызови субагента progress-keeper; если нет — коротко скажи об этом и остановись.`,
      systemMessage: 'Напоминание: журнал docs/PROGRESS.md отстаёт от кода.',
    }),
  );
} catch {
  process.exit(0);
}
