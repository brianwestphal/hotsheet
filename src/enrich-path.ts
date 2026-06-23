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
import { userInfo } from 'os';

const SHELL_PATH_TIMEOUT_MS = 2000;

/** Non-login "shells" that must never be used to probe PATH. */
const NON_SHELLS = new Set(['/usr/bin/false', '/bin/false', '/sbin/nologin', '/usr/sbin/nologin']);

function isUsableShell(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim() !== '' && !NON_SHELLS.has(s.trim());
}

/** The user's login shell from the passwd database (independent of `$SHELL`).
 *  Returns null on Windows / when it can't be read. */
function passwdShell(): string | null {
  try { return userInfo().shell; } catch { return null; }
}

/**
 * HS-8946 — resolve the login shell to probe for PATH, robust to a GUI launch
 * (Dock / Finder) that didn't inherit `$SHELL`. A Finder-launched macOS app
 * frequently has NO `$SHELL` in its environment, so the pre-fix code skipped
 * enrichment entirely and any tool outside the static `extraSearchDirs`
 * (nvm/asdf/volta/custom npm prefix, a friend's `glassbox`) stayed invisible.
 *
 * Resolution order: `$SHELL` → the passwd-DB shell (`os.userInfo().shell`) →
 * a platform default (`/bin/zsh` on macOS — the modern default — else
 * `/bin/bash`). Returns null only on Windows. Injectable for tests.
 */
export function resolveLoginShell(opts: { env?: NodeJS.ProcessEnv; passwdShell?: string | null } = {}): string | null {
  if (process.platform === 'win32') return null;
  const fromEnv = (opts.env ?? process.env).SHELL;
  if (isUsableShell(fromEnv)) return fromEnv.trim();
  const fromPasswd = opts.passwdShell !== undefined ? opts.passwdShell : passwdShell();
  if (isUsableShell(fromPasswd)) return fromPasswd.trim();
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

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

/** Ask `shell` to print its post-rc PATH. Tries an interactive login shell
 *  (`-ilc` — where `.zshrc` / `.bashrc` set PATH for most setups), then falls
 *  back to a non-interactive login shell (`-lc`) for shells whose `-i` errors
 *  without a tty. Returns null when every attempt fails / times out / is empty.
 *  Sync because this must run before any PATH-consuming startup code. */
function readLoginShellPath(shell: string, execOverride?: typeof execFileSync): string | null {
  const exec = execOverride ?? execFileSync;
  for (const flag of ['-ilc', '-lc']) {
    try {
      const out = exec(shell, [flag, 'printf %s "$PATH"'], {
        encoding: 'utf8',
        timeout: SHELL_PATH_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const trimmed = out.trim();
      if (trimmed !== '') return trimmed;
    } catch {
      /* try the next flag */
    }
  }
  return null;
}

/** Run at startup on macOS / Linux. Mutates `process.env.PATH` in place.
 *  No-op on Windows (PATH inheritance there has no GUI-strip problem). The
 *  shell is resolved robustly (HS-8946) so a Dock/Finder launch with no
 *  `$SHELL` still enriches. `shell` / `passwdShell` are injectable for tests. */
export function enrichProcessPath(opts?: { exec?: typeof execFileSync; shell?: string | null; passwdShell?: string | null }): void {
  if (process.platform === 'win32') return;
  const shell = opts?.shell !== undefined ? opts.shell : resolveLoginShell({ passwdShell: opts?.passwdShell });
  if (shell === null || shell === '') return;
  const shellPath = readLoginShellPath(shell, opts?.exec);
  if (shellPath === null) return;
  const current = process.env.PATH ?? '';
  const merged = mergePaths(current, shellPath);
  if (merged !== current) {
    process.env.PATH = merged;
  }
}
