import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';

/**
 * HS-8486 / HS-8491 — `PATH` probe for an executable file. Used by:
 *
 * - `src/skills.ts::ensureSkillsForDir` to install AI-tool skill files
 *   when the corresponding CLI is on PATH (so the user's first launch
 *   of the tool finds the Hot Sheet skill already in scope).
 * - `src/projects.ts::seedClaudeTerminalIfNew` to auto-seed a `claude`
 *   configured terminal on first-run when the binary is installed.
 * - `src/terminals/resolveCommand.ts::defaultClaudeDetector` to pick
 *   between `claude` and the user's default shell when launching a
 *   terminal with the `{{claudeCommand}}` template.
 *
 * Pre-fix the same logic lived as a private helper in each of those
 * three modules. Extracted here so the contract has one home; callers
 * import from this module rather than re-implement the probe.
 *
 * HS-8785 — a GUI-launched macOS app gets the minimal launchd PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so a CLI installed by Homebrew, npm-global,
 * or the official installer is invisible to a bare `process.env.PATH` probe —
 * which is why a friend's 0.19.0 desktop launch didn't auto-seed the Claude
 * terminal (`claude` was installed but not on the GUI PATH). Same root cause as
 * the HS-8786 Glassbox bug. We ALSO search the common install locations
 * (`extraSearchDirs`).
 *
 * HS-8801 — the dynamic/exotic case (`nvm` `~/.nvm/versions/node/vX/bin`, `asdf`,
 * `volta`, a custom npm prefix) is covered NOT here but upstream: `process.env.PATH`
 * is ENRICHED at startup by `enrichProcessPath()` (`src/enrich-path.ts`), which
 * spawns `$SHELL -ilc 'printf %s "$PATH"'` once and merges the user's real
 * login-shell PATH — populated by their rc files (which init nvm/asdf/volta) —
 * before any code (including this probe) reads PATH. So by the time
 * `isExecutableOnPath` runs, dynamic install dirs are already in `process.env.PATH`.
 * `extraSearchDirs` is the belt-and-suspenders static fallback for when that
 * login-shell probe failed (Windows, no `$SHELL`, a shell that errors/times out)
 * or for dirs the login shell happens to omit (e.g. the official installer's
 * `~/.claude/local`).
 */

/** Common executable dirs missing from the GUI launchd PATH (unix only —
 *  Windows GUI apps inherit the user PATH). Exported for testing. */
export function extraSearchDirs(): string[] {
  if (process.platform === 'win32') return [];
  const home = homedir();
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'), // official Claude Code installer
  ];
}

/**
 * Pure search: is `name` an executable in any of `dirs`? Injectable `fileExists`
 * + `win` so the augmented-dir behavior is unit-testable without the real
 * filesystem / a specific OS. Exported for testing.
 */
export function findExecutable(
  name: string,
  dirs: readonly string[],
  opts: { win?: boolean; fileExists?: (p: string) => boolean } = {},
): boolean {
  const win = opts.win ?? process.platform === 'win32';
  const fileExists = opts.fileExists ?? existsSync;
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (dir === '') continue;
    for (const ext of exts) {
      if (fileExists(join(dir, name + ext))) return true;
    }
  }
  return false;
}

export function isExecutableOnPath(name: string): boolean {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extraSearchDirs()];
  return findExecutable(name, dirs);
}
