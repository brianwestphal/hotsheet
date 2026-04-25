import { execFile } from 'child_process';
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
 * - Windows: `wmic` / PowerShell `Get-Process`. Out of scope for v1
 *   implementation; falls back to the safe-default (assume non-exempt) so the
 *   prompt still fires.
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
 * Parse the output of `ps -o pid,ppid,comm -A` into a list of {pid, ppid,
 * comm} rows. Skips the header line + any malformed rows. The macOS / Linux
 * variants of `ps` both produce three space-separated columns; comm is the
 * basename (no path) for either.
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
    // Split on whitespace, respecting that comm may contain spaces in pathological
    // cases — but `ps -o comm` outputs the basename only, so 3 columns is safe.
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    // Comm may be the rest of the line (in case `ps` decides to include
    // spaces); join from index 2 to end.
    const comm = parts.slice(2).join(' ').trim();
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
 * - If the chain has length >1 AND the root is a shell → use the deepest
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
 * Lookup failures (process exited / ps unavailable / Windows unsupported in
 * v1) return the safe-default-prompt info `{ command: '?', isShell: false,
 * isExempt: false }`.
 */
export async function inspectForegroundProcess(
  rootPid: number,
  exemptProcesses: readonly string[] = DEFAULT_EXEMPT_PROCESSES,
): Promise<ForegroundProcessInfo> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return { command: '?', isShell: false, isExempt: false, error: 'invalid pid' };
  }
  if (process.platform === 'win32') {
    // Windows path is out of scope for v1 (HS-7596 explicitly notes Windows
    // uses Get-Process / WMI as a follow-up). Safe-default for now so the
    // prompt fires conservatively.
    return { command: '?', isShell: false, isExempt: false, error: 'windows unsupported in v1' };
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
