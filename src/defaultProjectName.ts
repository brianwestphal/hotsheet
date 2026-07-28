/**
 * HS-9459 — the project name used when `appName` is unset.
 *
 * A project's display name is `appName` from settings, or — when that is empty —
 * the project DIRECTORY's basename (`~/Documents/hotsheet` → `hotsheet`). The
 * Settings → Project name field said `placeholder="Hot Sheet"`, a hardcoded
 * string that was simply wrong for every project: leaving the field empty gives
 * you the directory name, never "Hot Sheet". The placeholder is supposed to show
 * what you'd get by leaving it blank, so it was actively misleading.
 *
 * The underlying problem was duplication — the derivation lived inline at two
 * call sites in `projects.ts` and the placeholder was a third, hand-written
 * guess at what they produce. This is now the single definition all three share.
 *
 * Handles BOTH path separators. The original inline version used `/` only
 * (`.replace(/\/\.hotsheet\/?$/, '').split('/')`), so on Windows —
 * `C:\Users\x\proj\.hotsheet` — it stripped nothing and split nothing, and the
 * whole path became the project name.
 *
 * Pure: string in, string out. No filesystem access (the directory need not
 * exist), which is also what makes it safe to call from the client.
 */

/** The trailing `.hotsheet` data-dir segment, with either separator, optionally
 *  followed by a trailing slash. */
const HOTSHEET_SUFFIX = /[/\\]\.hotsheet[/\\]?$/;

/**
 * The default display name for a project rooted at `dataDir` (which may be
 * either the project directory or its `.hotsheet/` data dir). Returns the input
 * unchanged when there's no separator to split on, matching the previous
 * `?? absDataDir` fallback.
 */
export function defaultProjectName(dataDir: string): string {
  const projectDir = dataDir.replace(HOTSHEET_SUFFIX, '');
  // Ignore any trailing separator so `/a/b/` yields `b`, not ''.
  const trimmed = projectDir.replace(/[/\\]+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
  return base === '' ? dataDir : base;
}
