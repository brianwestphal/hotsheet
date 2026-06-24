import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export function isHotsheetGitignored(repoRoot: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '.hotsheet'], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getGitRoot(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8' }).trim();
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
