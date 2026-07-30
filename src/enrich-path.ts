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
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { userInfo } from 'os';

const SHELL_PATH_TIMEOUT_MS = 2000;

/** HS-9512 — delimiters bracketing the printed PATH so the shell's own startup
 *  chatter can be discarded. Deliberately ugly and unlikely to occur in a banner. */
const PATH_BEGIN_MARKER = '__HOTSHEET_PATH_BEGIN__';
const PATH_END_MARKER = '__HOTSHEET_PATH_END__';

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
 *  duplicates are introduced. Empty / whitespace-only segments are dropped, as
 *  are non-absolute ones (HS-9512). */
export function mergePaths(currentPath: string, shellPath: string): string {
  const sep = ':';
  const existing = currentPath.split(sep).filter((s) => s !== '');
  const existingSet = new Set(existing);
  const additions: string[] = [];
  for (const dir of shellPath.split(sep)) {
    const trimmed = dir.trim();
    if (trimmed === '' || existingSet.has(trimmed)) continue;
    // HS-9512 — defense in depth: only ABSOLUTE directories are merged in. A
    // malformed probe should degrade to "no enrichment", never to "PATH with
    // garbage in it". This filters only what the SHELL contributed; entries
    // already in `currentPath` keep their position untouched, so a caller's
    // unusual relative entry is preserved.
    if (!trimmed.startsWith('/')) continue;
    existingSet.add(trimmed);
    additions.push(trimmed);
  }
  if (additions.length === 0) return currentPath;
  return [...additions, ...existing].join(sep);
}

/**
 * HS-9512 — pull the PATH out of a shell's stdout, ignoring everything else it said.
 *
 * The probe runs an INTERACTIVE shell, and interactive shells print startup chatter
 * to stdout: macOS Terminal's `Restored session: <date>` banner, motd, version
 * notices, `nvm` messages, a `date` someone put in their `.zshrc`. Treating the whole
 * stream as the PATH (what this did before) produced, on the dev machine:
 *
 *   "Restored session: Thu Jul 30 16:21:23 PST 2026" + newline +
 *   "/Users/westphal/.local/bin:..."
 *
 * which splits on `:` into three junk entries PLUS a first real entry fused with the
 * banner text — so `~/.local/bin` silently stopped resolving. That is the very
 * "cannot find `claude`" failure HS-8946 added this feature to fix.
 *
 * So don't trust the stream: bracket the value with markers and take only what is
 * between them. Same approach as VS Code's shell-path resolution.
 */
export function extractMarkedPath(stdout: string): string | null {
  const begin = stdout.lastIndexOf(PATH_BEGIN_MARKER);
  if (begin === -1) return null;
  const from = begin + PATH_BEGIN_MARKER.length;
  const end = stdout.indexOf(PATH_END_MARKER, from);
  if (end === -1) return null;
  return stdout.slice(from, end);
}

/**
 * SIGKILL the whole process GROUP led by `pid`, ignoring "already gone".
 *
 * HS-9509. The probe below runs an INTERACTIVE shell, and an interactive zsh forks
 * a subshell — so killing the direct child leaves the fork alive, reparented to
 * init, forever. Measured 2026-07-30: 17 stuck `/bin/zsh -ilc printf %s "$PATH"`
 * processes on the dev machine, the oldest alive 4 days 18 hours, and killing one's
 * parent demonstrably did not take the child with it.
 *
 * The probe therefore spawns `detached`, which makes the child a process-group
 * leader, so its forks inherit that group and one negative-pid signal reaps the
 * whole tree. (`spawnSync` honours `detached` even though the option is documented
 * only for `spawn` — verified directly: child pid == its own pgid, and the
 * grandchild survives spawnSync's own timeout kill but not the group kill.)
 *
 * The `pid > 1` guard is load-bearing, not defensive noise: `process.kill(-0)`
 * signals OUR OWN process group and `-1` signals EVERY process we may signal.
 * Either would turn a leaked-shell cleanup into killing the app, or the session.
 */
function reapProcessGroup(pid: number | undefined): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* ESRCH — the group already exited, which is the normal case */
  }
}

/** Ask `shell` to print its post-rc PATH. Tries an interactive login shell
 *  (`-ilc` — where `.zshrc` / `.bashrc` set PATH for most setups), then falls
 *  back to a non-interactive login shell (`-lc`) for shells whose `-i` errors
 *  without a tty. Returns null when every attempt fails / times out / is empty.
 *  Sync because this must run before any PATH-consuming startup code. */
function readLoginShellPath(shell: string, spawnOverride?: typeof spawnSync): string | null {
  const run = spawnOverride ?? spawnSync;
  for (const flag of ['-ilc', '-lc']) {
    // HS-9512 — bracketed with markers so `extractMarkedPath` can discard whatever
    // the interactive rc files printed before it. Single-quoted format string so the
    // shell expands only `$PATH`, via printf's `%s`, and never the markers.
    const script = `printf '${PATH_BEGIN_MARKER}%s${PATH_END_MARKER}' "$PATH"`;
    const result = run(shell, [flag, script], {
      encoding: 'utf8',
      timeout: SHELL_PATH_TIMEOUT_MS,
      // HS-9391: SIGKILL, not the SIGTERM default. An INTERACTIVE shell (`-i`)
      // ignores SIGTERM — that is what interactive means — so the `timeout` above
      // fired, sent a signal the shell discarded, and the call then blocked FOREVER
      // waiting for a child that would never exit. Because the block is in native
      // code (`SyncProcessRunner::Spawn` → `uv_run`), the calling thread stops dead:
      // in a vitest worker that means every test has already passed but no reporter,
      // summary or `hanging-process` dump can ever run, which is the whole "suite
      // wedges at exit with all ✓ and no summary" signature. Measured 2026-07-30:
      // the stuck `/bin/zsh -ilc` survived SIGTERM and died on SIGKILL, at which
      // point the held-up run printed its summary immediately.
      killSignal: 'SIGKILL',
      // HS-9509 — own process group, so `reapProcessGroup` can take the shell's
      // forks with it rather than orphaning them to init.
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      // `detached` IS honoured by spawnSync at runtime but is absent from
      // @types/node's `SpawnSyncOptions` (it is documented only for `spawn`), so
      // this cast is the type layer catching up with measured reality rather than
      // an assertion about a value's shape. Verified directly: the child's pgid
      // equals its own pid, and its fork survives spawnSync's own timeout kill but
      // not the group kill. `enrichPathGroupReap.test.ts` pins that end to end, so
      // if a future Node stops honouring it we get a red test, not silent orphans.
    } as SpawnSyncOptionsWithStringEncoding);
    // Unconditionally, including on success: a shell that printed PATH and exited
    // can still have left a fork behind, and reaping a group that is already gone
    // is a no-op.
    reapProcessGroup(result.pid);
    if (result.error !== undefined || result.status !== 0) continue; // try the next flag
    // `stdout` is typed non-null and the error/non-zero cases already `continue`.
    const marked = extractMarkedPath(result.stdout);
    // HS-9512 — no markers means some shell did not run our printf as written. Rather
    // than trust the whole stream (the old behavior, i.e. the bug) or refuse outright
    // (which would silently switch enrichment off for that shell), accept the stream
    // only when it CANNOT be carrying chatter: a real PATH has no whitespace, and
    // every observed corruption came in as a banner line plus a newline.
    const candidate = marked ?? (/\s/.test(result.stdout.trim()) ? null : result.stdout);
    if (candidate === null) continue;
    const trimmed = candidate.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** Run at startup on macOS / Linux. Mutates `process.env.PATH` in place.
 *  No-op on Windows (PATH inheritance there has no GUI-strip problem). The
 *  shell is resolved robustly (HS-8946) so a Dock/Finder launch with no
 *  `$SHELL` still enriches. `shell` / `passwdShell` are injectable for tests. */
export function enrichProcessPath(opts?: { spawn?: typeof spawnSync; shell?: string | null; passwdShell?: string | null }): void {
  if (process.platform === 'win32') return;
  const shell = opts?.shell !== undefined ? opts.shell : resolveLoginShell({ passwdShell: opts?.passwdShell });
  if (shell === null || shell === '') return;
  const shellPath = readLoginShellPath(shell, opts?.spawn);
  if (shellPath === null) return;
  const current = process.env.PATH ?? '';
  const merged = mergePaths(current, shellPath);
  if (merged !== current) {
    process.env.PATH = merged;
  }
}
