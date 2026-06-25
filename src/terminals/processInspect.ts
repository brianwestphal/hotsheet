import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

/**
 * Foreground-process inspection for the §37 quit-confirm flow (HS-7591 /
 * HS-7596). Given a PTY's root pid, find the most-recent child process and
 * decide whether it counts as "the user has work running here."
 *
 * The macOS Terminal.app model: a terminal session is "idle" if its only
 * running process is the configured login shell (`bash`, `zsh`, etc.). Any
 * non-shell descendant means there's something running that the user might
 * not want to silently kill — UNLESS that descendant is in the user-editable
 * exempt list (`screen`, `tmux`, `less`, etc. — programs the user can quit
 * trivially with q / Ctrl-C).
 *
 * "One level deeper" rule: when the PTY root IS itself a shell, look at the
 * shell's foreground child. If the PTY root is NOT a shell (e.g. command was
 * `claude` or `npm run dev`), evaluate that root process directly.
 *
 * Cross-platform:
 * - macOS / Linux: `ps -o pid,ppid,comm -A` parsed once into a parent → children
 *   adjacency map. Pick the most-recently-started descendant of the PTY's pid.
 * - Windows (HS-9027): PowerShell `Get-CimInstance Win32_Process` emits
 *   `ProcessId<TAB>ParentProcessId<TAB>Name` rows, parsed by
 *   `parseWin32ProcessOutput` into the SAME `{pid, ppid, comm}` shape so
 *   `descendantChain` / `pickForegroundProcess` are reused unchanged. `comm`
 *   runs through `normalizeComm`, which strips the `.exe` suffix so
 *   `powershell.exe` / `cmd.exe` match the shell list. (`wmic` is deprecated on
 *   modern Windows, hence `Get-CimInstance`.) The highest-pid "most recent
 *   child" heuristic is weaker on Windows — pid allocation isn't strictly
 *   monotonic — but it's a best-effort improvement over the old always-prompt.
 *
 * Lookup errors (process exited mid-check, OS quirks) → safe-default-prompt:
 * return `{ command: '?', isShell: false, isExempt: false }` so the prompt
 * fires. Users prefer one extra confirmation over a silent kill of unfinished
 * work.
 */

const execFileAsync = promisify(execFile);

/** Process names treated as "login shell" for the one-level-deeper rule. */
export const SHELL_BASENAMES: ReadonlySet<string> = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'ash', 'ksh', 'tcsh',
  'pwsh', 'powershell', 'cmd', 'cmd.exe',
]);

/** Default exempt list — matches macOS Terminal.app's defaults. */
export const DEFAULT_EXEMPT_PROCESSES: readonly string[] = [
  'screen', 'tmux', 'less', 'more', 'view', 'mandoc', 'tail', 'log', 'top', 'htop',
];

export interface ForegroundProcessInfo {
  /** Process basename (e.g. `claude`, `node`, `htop`). `?` when lookup failed
   *  AND the safe-default kicked in. */
  command: string;
  /** True if the foreground process IS itself a shell (i.e. the PTY's root
   *  was a shell and there are no non-shell descendants — an idle prompt). */
  isShell: boolean;
  /** True if `command` is in the caller-provided exempt list (case-insensitive
   *  basename match). */
  isExempt: boolean;
  /** Always-defined error indicator the caller can log; null on success.
   *  Routes can surface this via headers or response metadata if useful. */
  error: string | null;
}

/** ps row — exposed for unit tests + the parser helper. */
export interface PsRow {
  pid: number;
  ppid: number;
  comm: string;
}

/**
 * Normalize a `comm` value from ps to a plain basename. macOS `ps -o comm`
 * returns the executable's full path (e.g. `/bin/zsh`) — Linux varies — and
 * login shells get a leading `-` (e.g. `-zsh`). Strip both so downstream
 * shell-list / exempt-list comparisons see a stable token (HS-7790).
 */
export function normalizeComm(raw: string): string {
  let s = raw.trim();
  if (s === '') return s;
  // Strip directory prefix (handles both `/` and Windows `\`).
  const slashIdx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slashIdx >= 0) s = s.slice(slashIdx + 1);
  // Strip the leading dash that login shells get (e.g. `-zsh`).
  if (s.startsWith('-')) s = s.slice(1);
  // Strip Windows .exe extension so `cmd.exe` matches `cmd`.
  s = s.replace(/\.exe$/i, '');
  return s;
}

/**
 * Parse the output of `ps -o pid,ppid,comm -A` into a list of `{pid, ppid, comm}`
 * rows. Skips the header line + any malformed rows. macOS `ps -o comm`
 * emits the executable's full path while Linux emits the basename; the row's
 * `comm` is normalized to a plain basename via `normalizeComm` so downstream
 * shell / exempt-list checks compare apples to apples regardless of platform.
 */
export function parsePsOutput(stdout: string): PsRow[] {
  const lines = stdout.split('\n');
  const rows: PsRow[] = [];
  // First line is the header — skip if it starts with non-numeric content.
  let start = 0;
  if (lines.length > 0 && !/^\s*\d/.test(lines[0])) start = 1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    // Split on whitespace. `comm` may legitimately contain spaces in a path
    // (rare); join from index 2 to end so we don't drop those.
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const rawComm = parts.slice(2).join(' ').trim();
    if (rawComm === '') continue;
    const comm = normalizeComm(rawComm);
    if (comm === '') continue;
    rows.push({ pid, ppid, comm });
  }
  return rows;
}

/**
 * HS-9027 — the Windows process enumeration command. PowerShell
 * `Get-CimInstance Win32_Process` projected to one tab-delimited line per
 * process: `ProcessId<TAB>ParentProcessId<TAB>Name`. No header row (the
 * `ForEach-Object` emits only the formatted strings), so `parseWin32ProcessOutput`
 * doesn't skip one. `powershell.exe` (Windows PowerShell 5.1) ships on every
 * Windows 10/11; `-NoProfile -NonInteractive` keeps it fast + side-effect-free.
 * The script embeds PowerShell's backtick-t tab escape — passed literally here
 * because `execFile` runs the binary directly (no intermediate shell).
 */
export const WIN32_PROCESS_EXE = 'powershell.exe';
export const WIN32_PROCESS_ARGS: readonly string[] = [
  '-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }',
];

/**
 * HS-9027 — parse the tab-delimited `Get-CimInstance Win32_Process` output
 * (`ProcessId`, `ParentProcessId`, `Name` per line) into the same `PsRow` shape
 * `parsePsOutput` produces, so the platform-agnostic `descendantChain` /
 * `pickForegroundProcess` / `collectDescendantPids` work
 * unchanged. Tolerates CRLF line endings, blank lines, and a process whose
 * `Name` legitimately contains a tab is impossible (Windows process names can't),
 * so a plain tab split is safe. `Name` is normalized via `normalizeComm` (drops
 * the `.exe` suffix). Pure + platform-independent → unit-testable on any host
 * with captured sample output.
 */
export function parseWin32ProcessOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0].trim(), 10);
    const ppid = Number.parseInt(parts[1].trim(), 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    // Join any trailing parts back (defensive — a Name with a stray tab) and
    // normalize to a plain basename (strips path + `.exe`).
    const comm = normalizeComm(parts.slice(2).join('\t').trim());
    if (comm === '') continue;
    rows.push({ pid, ppid, comm });
  }
  return rows;
}

/**
 * Walk the parent → children map starting from `rootPid` and return the
 * deepest descendant chain as basenames in order [root, child, grandchild, ...].
 * Used by `pickForegroundProcess` to find the "current foreground" process.
 *
 * Returns an empty array when `rootPid` isn't in the map (process exited
 * mid-check). Caller should treat this as the safe-default-prompt case.
 */
export function descendantChain(rows: PsRow[], rootPid: number): string[] {
  const byPid = new Map<number, PsRow>();
  const childrenByPpid = new Map<number, PsRow[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const list = childrenByPpid.get(row.ppid);
    if (list === undefined) childrenByPpid.set(row.ppid, [row]);
    else list.push(row);
  }
  const root = byPid.get(rootPid);
  if (root === undefined) return [];
  const chain: string[] = [root.comm];
  let cursor = rootPid;
  // Walk children iteratively, picking the highest-pid (= most-recently-started
  // by convention) at each level. Capped at 10 levels to defend against
  // pathological cycles in malformed ps output.
  for (let depth = 0; depth < 10; depth++) {
    const kids = childrenByPpid.get(cursor) ?? [];
    if (kids.length === 0) break;
    // Pick the child with the highest pid — proxies "most recently started"
    // across the OSes Hot Sheet runs on (macOS / Linux pid allocation is
    // strictly monotonic within ranges; Windows isn't but Windows is out of
    // scope for v1 anyway).
    let best: PsRow = kids[0];
    for (const kid of kids) {
      if (kid.pid > best.pid) best = kid;
    }
    chain.push(best.comm);
    cursor = best.pid;
  }
  return chain;
}

/**
 * Decide the "foreground process" for a PTY rooted at `rootPid` given the
 * descendant chain + exempt list. Implements the §37.3 one-level-deeper rule:
 *
 * - If the chain is empty (root not found in ps output) → safe-default-prompt.
 * - If the chain has length 1 AND the root is a shell → idle login shell, no
 *   prompt needed (`isShell: true, isExempt: true`).
 * - If the chain has length \>1 AND the root is a shell → use the deepest
 *   non-shell descendant (or the chain's tail if every descendant is a shell)
 *   as the foreground process and check the exempt list.
 * - If the root is NOT a shell → use the chain's tail directly.
 *
 * `exemptProcesses` is a list of basenames; matches are case-insensitive on
 * the basename only (so a user adding `htop` to the exempt list matches
 * `/usr/bin/htop` and `htop` alike — `ps -o comm` outputs the basename so
 * the comparison is straightforward).
 */
export function pickForegroundProcess(
  chain: string[],
  exemptProcesses: readonly string[],
): ForegroundProcessInfo {
  if (chain.length === 0) {
    return { command: '?', isShell: false, isExempt: false, error: 'process not found' };
  }
  const exemptSet = new Set(exemptProcesses.map(s => s.toLowerCase()));
  const isShellName = (name: string): boolean => SHELL_BASENAMES.has(name.toLowerCase());

  const root = chain[0];
  if (chain.length === 1) {
    // No descendants — the root process is what's running. If it's a shell,
    // that's an idle login shell.
    const exempt = isShellName(root) || exemptSet.has(root.toLowerCase());
    return { command: root, isShell: isShellName(root), isExempt: exempt, error: null };
  }
  if (isShellName(root)) {
    // Walk the tail looking for the deepest non-shell descendant.
    let foreground = chain[chain.length - 1];
    for (let i = chain.length - 1; i >= 1; i--) {
      if (!isShellName(chain[i])) { foreground = chain[i]; break; }
    }
    const exempt = exemptSet.has(foreground.toLowerCase()) || isShellName(foreground);
    return { command: foreground, isShell: isShellName(foreground), isExempt: exempt, error: null };
  }
  // Root is a non-shell command (e.g. `claude`, `npm run dev`). Use the chain's
  // tail as the foreground process — typically that's a leaf of the same
  // process tree (e.g. `npm` → `node`).
  const foreground = chain[chain.length - 1];
  const exempt = exemptSet.has(foreground.toLowerCase());
  return { command: foreground, isShell: false, isExempt: exempt, error: null };
}

/**
 * Inspect the foreground process for a PTY rooted at `rootPid`. Spawns `ps`
 * once and returns the resulting ForegroundProcessInfo. Caller-provided
 * `exemptProcesses` lists which basenames count as "exempt" for the
 * quit-confirm decision.
 *
 * Lookup failures (process exited / ps or PowerShell unavailable) return the
 * safe-default-prompt info `{command: '?', isShell: false, isExempt: false}`.
 * HS-9027 — Windows now introspects via PowerShell `Get-CimInstance` instead of
 * returning the safe default unconditionally.
 */
export async function inspectForegroundProcess(
  rootPid: number,
  exemptProcesses: readonly string[] = DEFAULT_EXEMPT_PROCESSES,
): Promise<ForegroundProcessInfo> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return { command: '?', isShell: false, isExempt: false, error: 'invalid pid' };
  }
  if (process.platform === 'win32') {
    // HS-9027 — Windows adapter via PowerShell `Get-CimInstance Win32_Process`.
    let stdout = '';
    try {
      const result = await execFileAsync(WIN32_PROCESS_EXE, [...WIN32_PROCESS_ARGS], { encoding: 'utf8', windowsHide: true });
      stdout = result.stdout;
    } catch (err) {
      return {
        command: '?',
        isShell: false,
        isExempt: false,
        error: `Get-CimInstance execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const rows = parseWin32ProcessOutput(stdout);
    const chain = descendantChain(rows, rootPid);
    return pickForegroundProcess(chain, exemptProcesses);
  }
  let stdout = '';
  try {
    const result = await execFileAsync('ps', ['-o', 'pid,ppid,comm', '-A'], { encoding: 'utf8' });
    stdout = result.stdout;
  } catch (err) {
    return {
      command: '?',
      isShell: false,
      isExempt: false,
      error: `ps execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const rows = parsePsOutput(stdout);
  const chain = descendantChain(rows, rootPid);
  return pickForegroundProcess(chain, exemptProcesses);
}

/**
 * HS-8179 — return true when `candidatePid` is the same as `ancestorPid`
 * OR appears in the chain of ppid hops from `candidatePid` up to PID 1
 * (init). Used as the safety guard inside `killProcessTreeBestEffort`
 * to refuse signalling pids we don't own.
 *
 * Pure helper over the parsed `ps` table — no syscalls. Bounded by the
 * ps row count (cycle-safe via `seen` set even though Unix process trees
 * are acyclic by construction).
 */
export function isDescendantOrSelf(rows: readonly PsRow[], candidatePid: number, ancestorPid: number): boolean {
  if (candidatePid === ancestorPid) return true;
  const ppidByPid = new Map<number, number>();
  for (const row of rows) ppidByPid.set(row.pid, row.ppid);
  const seen = new Set<number>([candidatePid]);
  let cursor = candidatePid;
  // Bound the walk by the table size so a malformed input can't loop
  // forever even if the cycle break is bypassed somehow.
  for (let step = 0; step < rows.length + 1; step += 1) {
    const ppid = ppidByPid.get(cursor);
    if (ppid === undefined) return false; // pid not in table → unknown lineage, refuse
    if (ppid === ancestorPid) return true;
    if (ppid <= 1) return false;          // hit init / orphan boundary without finding ancestor
    if (seen.has(ppid)) return false;     // defensive cycle break
    seen.add(ppid);
    cursor = ppid;
  }
  return false;
}

/**
 * HS-8140 — collect every descendant pid of `rootPid` (BFS). Used by the
 * shutdown path to signal sub-processes that wouldn't otherwise receive the
 * shell's SIGHUP — `node-pty` only delivers the signal to the shell itself,
 * and shells don't reliably propagate SIGHUP to grandchildren (background
 * jobs disowned with `&`, processes that detached via `setsid`, programs
 * that trap SIGHUP). The root pid itself is NOT included; the caller
 * separately kills the PTY's shell via `pty.kill('SIGHUP')`.
 */
export function collectDescendantPids(rows: readonly PsRow[], rootPid: number): number[] {
  const childrenByPpid = new Map<number, PsRow[]>();
  for (const row of rows) {
    const list = childrenByPpid.get(row.ppid);
    if (list === undefined) childrenByPpid.set(row.ppid, [row]);
    else list.push(row);
  }
  const out: number[] = [];
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const cursor = queue.shift()!;
    const kids = childrenByPpid.get(cursor) ?? [];
    for (const kid of kids) {
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      out.push(kid.pid);
      queue.push(kid.pid);
    }
  }
  return out;
}

export interface KillTreeResult {
  /** Number of descendant pids the helper attempted to signal. */
  attempted: number;
  /** Pids that responded with ESRCH (already-dead — not an error). */
  alreadyDead: number;
  /** True when the helper bailed out (Windows, ps unavailable, invalid pid). */
  bailed: boolean;
  /** First error encountered while walking the tree, for logging. */
  error: string | null;
}

/**
 * HS-8140 — synchronous best-effort SIGTERM-the-tree before the shell's
 * SIGHUP. Runs in the shutdown hot path (called from `teardownPty`), so
 * uses `execFileSync` to enumerate the process table once + then iterates
 * `process.kill(pid, signal)` over the descendants. Errors are swallowed
 * per-pid (race window between `ps` and `kill` — descendant may have
 * already exited). The root pid itself is left for the caller's
 * `pty.kill()` so the shell still gets the SIGHUP it expects.
 *
 * Returns a result object purely for logging / test assertions. Never
 * throws — the worst case is `bailed: true` and the original SIGHUP-only
 * behavior stands. Cross-platform note (HS-9027): macOS / Linux enumerate via
 * `ps`, Windows via PowerShell `Get-CimInstance Win32_Process`; the POSIX path
 * is where node-pty's grandchild-survival problem is primarily observed, the
 * Windows path is defense-in-depth alongside its job-object teardown.
 */
export function killProcessTreeBestEffort(
  rootPid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  // HS-8200 — optional row provider so tests can supply fixture rows without
  // forking `ps` (which EPERMs under restricted sandboxes). Production callers
  // omit it and the helper enumerates the live process table itself.
  psRowsProvider?: () => readonly PsRow[],
): KillTreeResult {
  const empty: KillTreeResult = { attempted: 0, alreadyDead: 0, bailed: true, error: null };
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return { ...empty, error: 'invalid pid' };
  }
  let rows: readonly PsRow[];
  if (psRowsProvider !== undefined) {
    try {
      rows = psRowsProvider();
    } catch (err) {
      return { ...empty, error: `ps row provider failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else if (process.platform === 'win32') {
    // HS-9027 — Windows: enumerate via PowerShell `Get-CimInstance Win32_Process`.
    // The downstream `isDescendantOrSelf` ownership guard + `collectDescendantPids`
    // BFS + `process.kill` work identically on Windows (Node maps the signal to
    // TerminateProcess). Largely defense-in-depth — node-pty's job object usually
    // tears the tree down already — but mirrors the POSIX grandchild-reaping path.
    let stdout = '';
    try {
      stdout = execFileSync(WIN32_PROCESS_EXE, [...WIN32_PROCESS_ARGS], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    } catch (err) {
      return { ...empty, error: `Get-CimInstance execution failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    rows = parseWin32ProcessOutput(stdout);
  } else {
    let stdout = '';
    try {
      stdout = execFileSync('ps', ['-o', 'pid,ppid,comm', '-A'], { encoding: 'utf8', timeout: 2000 });
    } catch (err) {
      return { ...empty, error: `ps execution failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    rows = parsePsOutput(stdout);
  }
  // HS-8179 — verify rootPid is actually a descendant (or self) of this
  // Node process before signalling its descendants. Defends against a
  // caller passing a synthetic / random pid that happens to collide with
  // a real system process (e.g. test fakes whose `pid` is a `Math.random`
  // integer can otherwise SIGTERM `loginwindow`'s descendants and log the
  // user out of macOS). In production every rootPid is `node-pty`'s
  // direct child, so the ancestor walk lands on `process.pid` quickly.
  if (!isDescendantOrSelf(rows, rootPid, process.pid)) {
    return { ...empty, error: 'rootPid not owned by this process' };
  }
  const descendants = collectDescendantPids(rows, rootPid);
  let alreadyDead = 0;
  let firstError: string | null = null;
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') alreadyDead++;
      else if (firstError === null) firstError = `kill ${pid}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    attempted: descendants.length,
    alreadyDead,
    bailed: false,
    error: firstError,
  };
}
