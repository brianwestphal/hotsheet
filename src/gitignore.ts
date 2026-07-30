import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** How long any one `git` probe here may take. These are all local, index-free
 *  queries that finish in milliseconds; the bound exists for the pathological
 *  cases below, not the normal ones. */
const GIT_TIMEOUT_MS = 5000;

/**
 * Run a read-only `git` probe, bounded so it cannot wedge the process.
 *
 * HS-9510, following HS-9391. Every call here is on a STARTUP path
 * (`ensureGitignored`), and `execFileSync` blocks the whole thread in native
 * code — so a `git` that never returns is a server that never finishes booting.
 * `git` does hang in real conditions: waiting on credentials for a repo with a
 * remote helper, contending an `index.lock`, or living on an unresponsive
 * network mount.
 *
 * Three defenses, each closing a different door:
 * - `timeout` — there was none at all before, so nothing bounded these.
 * - `killSignal: 'SIGKILL'` — HS-9391 proved the SIGTERM default is not enough:
 *   a child that ignores it leaves `execFileSync` blocked forever anyway. `git`
 *   is better behaved than the interactive shell that caused HS-9391, but SIGKILL
 *   costs nothing and removes the question.
 * - `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0` — fail fast instead of
 *   waiting on a credential prompt or a contended lock, so the timeout is the
 *   backstop rather than the mechanism.
 *
 * Callers only care whether it threw (non-zero exit) or what it printed, which
 * is why one helper covers all three probes.
 */
function runGitProbe(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

export function isHotsheetGitignored(repoRoot: string): boolean {
  try {
    runGitProbe(['check-ignore', '-q', '.hotsheet'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    runGitProbe(['rev-parse', '--is-inside-work-tree'], dir);
    return true;
  } catch {
    return false;
  }
}

export function getGitRoot(dir: string): string | null {
  try {
    return runGitProbe(['rev-parse', '--show-toplevel'], dir).trim();
  } catch {
    return null;
  }
}

/**
 * HS-8989 — the canonical `.hotsheet` rules: ignore everything in `.hotsheet/`
 * EXCEPT `settings.json` (shareable project config — the secret + DB stay
 * ignored; HS-8999 moved the secret into the always-ignored `secret.json`).
 */
export const HOTSHEET_GITIGNORE_RULES = ['/.hotsheet/*', '!/.hotsheet/settings.json'];

/** Matches any `.hotsheet`-ignore line (uncommented), so we can replace older /
 *  hand-written variants (`.hotsheet`, `/.hotsheet/`, `/.hotsheet/*`,
 *  `!/.hotsheet/settings.json`, …). */
const HOTSHEET_LINE_RE = /^!?\/?\.hotsheet(\/(\*|settings\.json)?)?$/;

function isHotsheetRuleText(text: string): boolean {
  return HOTSHEET_LINE_RE.test(text.trim());
}

/**
 * Pure core (testable): given the current `.gitignore` content (or null when the
 * file doesn't exist), return the new content — or null when no change is needed.
 *
 * - **Opt-out:** if a COMMENTED line matches our rules (e.g. `# /.hotsheet/*`),
 *   the user has explicitly taken over management — leave the file untouched.
 * - Otherwise replace any existing uncommented `.hotsheet` lines with the
 *   canonical block (or append it). Returns null when the rules are already
 *   exactly present (so we don't rewrite on every launch).
 */
export function computeHotsheetGitignore(content: string | null): string | null {
  const lines = content === null ? [] : content.split('\n');

  // Explicit opt-out: a commented-out hotsheet rule means "don't manage this".
  const optedOut = lines.some((l) => {
    const t = l.trim();
    return t.startsWith('#') && isHotsheetRuleText(t.replace(/^#+\s*/, ''));
  });
  if (optedOut) return null;

  const existing = lines.filter((l) => isHotsheetRuleText(l)).map((l) => l.trim());
  // Already exactly our rules (in order, nothing extra) → nothing to do.
  if (existing.length === HOTSHEET_GITIGNORE_RULES.length
    && existing.every((l, i) => l === HOTSHEET_GITIGNORE_RULES[i])) {
    return null;
  }

  // Drop existing (uncommented) hotsheet lines; append the canonical block.
  const kept = lines.filter((l) => !isHotsheetRuleText(l));
  // Trim a trailing run of blank lines so the block sits cleanly at the end.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const body = kept.length > 0 ? kept.join('\n') + '\n' : '';
  return `${body}${HOTSHEET_GITIGNORE_RULES.join('\n')}\n`;
}

export function ensureGitignore(cwd: string): void {
  if (!isGitRepo(cwd)) return;
  const gitRoot = getGitRoot(cwd);
  if (gitRoot === null) return;
  const gitignorePath = join(gitRoot, '.gitignore');
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : null;
  const next = computeHotsheetGitignore(current);
  if (next === null) return;
  writeFileSync(gitignorePath, next, 'utf-8');
  console.log('  Updated .gitignore for .hotsheet/ (settings.json tracked)');
}
