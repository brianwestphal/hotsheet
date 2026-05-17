/**
 * Augment `process.env.PATH` with the user's login-shell PATH.
 *
 * When Hot Sheet's Tauri app is launched from the Dock / Spotlight (rather
 * than from a terminal), macOS gives the process a minimal PATH like
 * `/usr/bin:/bin:/usr/sbin:/sbin` — user-installed tools (`claude`,
 * `bun`, Homebrew binaries, `~/.local/bin`, asdf/mise shims) are invisible.
 *
 * That breaks `resolveCommand.ts`'s `isExecutableOnPath('claude')` probe,
 * which then falls through to `defaultShell()` and the configured terminal
 * launches a bare shell instead of `claude`. Same cliff hits every other
 * PATH lookup the sidecar does.
 *
 * Fix mirrors the well-known shell-path / fix-path pattern (VS Code, many
 * Electron + Tauri apps): spawn the user's login shell once at startup and
 * ask it to print its post-rc PATH. Any directories the shell PATH has
 * that ours does not are prepended.
 */
import { execFileSync } from 'child_process';

const SHELL_PATH_TIMEOUT_MS = 2000;

/** Pure helper: merge `shellPath` into `currentPath`, prepending new entries
 *  in their original shell order. Existing entries keep their position; no
 *  duplicates are introduced. Empty / whitespace-only segments are dropped. */
export function mergePaths(currentPath: string, shellPath: string): string {
  const sep = ':';
  const existing = currentPath.split(sep).filter((s) => s !== '');
  const existingSet = new Set(existing);
  const additions: string[] = [];
  for (const dir of shellPath.split(sep)) {
    const trimmed = dir.trim();
    if (trimmed === '' || existingSet.has(trimmed)) continue;
    existingSet.add(trimmed);
    additions.push(trimmed);
  }
  if (additions.length === 0) return currentPath;
  return [...additions, ...existing].join(sep);
}

/** Spawn `$SHELL -ilc 'printf %s "$PATH"'` and return the resulting PATH.
 *  Returns null when the shell is unknown, the spawn fails, the call times
 *  out, or the output is empty. Sync because this needs to run before any
 *  PATH-consuming code in the sidecar startup path. */
function readLoginShellPath(execOverride?: typeof execFileSync): string | null {
  const shell = process.env.SHELL;
  if (typeof shell !== 'string' || shell === '') return null;
  const exec = execOverride ?? execFileSync;
  try {
    const out = exec(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: SHELL_PATH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/** Run at startup on macOS / Linux. Mutates `process.env.PATH` in place.
 *  No-op on Windows (PATH inheritance there does not have the GUI-strip
 *  problem) and when `$SHELL` is missing. */
export function enrichProcessPath(opts?: { exec?: typeof execFileSync }): void {
  if (process.platform === 'win32') return;
  const shellPath = readLoginShellPath(opts?.exec);
  if (shellPath === null) return;
  const current = process.env.PATH ?? '';
  const merged = mergePaths(current, shellPath);
  if (merged !== current) {
    process.env.PATH = merged;
  }
}
