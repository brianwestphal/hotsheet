import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

// HS-8522 — wire shapes inferred from the typed-API-layer schemas
// (`src/api/git.ts`), the single source of truth shared with the client.
import type { FetchResult, GitStatus, GitStatusFiles, PendingCommit } from '../api/git.js';
import { instrumentAsync } from '../diagnostics/freezeLogger.js';
import { getGitRoot, isGitRepo } from '../gitignore.js';

// HS-8723 (load resilience, docs/75 §75.6 Phase 1) — the whole git-status read
// path used to be `spawnSync`, which blocks the single shared Node event loop
// for the full duration of each `git` invocation (up to 5 serialized per
// status read). With many project tabs open, those synchronous blocks
// saturated the loop and froze tab-switching (HS-8721). Everything here now
// shells out asynchronously via `execFile` so a slow / contended `git` never
// stalls request handling — it just resolves late.
const execFileAsync = promisify(execFile);

/** execFile on a non-zero exit, timeout, or missing-binary REJECTS rather than
 *  returning a status code. Coerce whatever it carries (stdout/stderr may be a
 *  string or Buffer depending on the failure mode) into a plain string. */
function bufToStr(v: string | Buffer | undefined): string {
  if (typeof v === 'string') return v;
  if (v !== undefined) return v.toString();
  return '';
}

export type { FetchResult, GitStatus, GitStatusFiles };

/**
 * HS-7598 (design) / HS-7954 (Phase 1 implementation) — server-side git
 * status reader. Spawns `git` against the project's working tree, parses
 * the porcelain v1 output, and returns a structured `GitStatus | null`
 * (null when the project root isn't a git repo, so the client can hide the
 * sidebar chip).
 *
 * Phase 1 fields: branch / detached / staged / unstaged / untracked /
 * conflicted. The remote-tracking fields (`upstream`, `ahead`, `behind`,
 * `lastFetchedAt`) are stubbed as `null` / `0` so the JSON shape is stable
 * for HS-7955 (Phase 2 fills them in).
 *
 * See docs/48-git-status-tracker.md.
 */


const SPAWN_TIMEOUT_MS = 2_000;

/** Spawn options shared across every git invocation in this module. Async
 *  (HS-8723) — resolves with the captured stdout (+ optionally stderr) and the
 *  process exit status. Never rejects: a non-zero exit / timeout / missing
 *  binary resolves with `status: null` (or the numeric exit code) so callers
 *  keep their existing `status === 0` checks and conservative fallbacks. */
type GitInvoker = (args: string[], cwd: string) => Promise<{ stdout: string; status: number | null }>;

// `git status` output for a large dirty tree (or many untracked files) can run
// well past execFile's 1 MB default before the per-bucket 200-entry cap is
// applied during parsing. 32 MB is generous headroom without being unbounded.
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Build a `git` invoker. HS-8674 — single factory shared by the status reads
 * (short timeout, stdout only) and `git fetch` (long timeout, stdout+stderr
 * folded for UI surfacing). The env block is identical for both: HS-7954 —
 * never block the server on a credential prompt; never fight the user's
 * interactive terminal for `.git/index.lock`.
 *
 * HS-8723 — async via `execFile`. On a non-zero exit / timeout / missing
 * binary, `execFileAsync` rejects with an error that still carries `stdout` /
 * `stderr` (and a numeric `code` on a clean non-zero exit, or a string like
 * `'ENOENT'` when `git` isn't on PATH). We fold that back into the same
 * `{ stdout, status }` shape the synchronous version returned, so the callers
 * downstream are unchanged.
 */
function makeGitInvoker({ timeoutMs, includeStderr = false }: { timeoutMs: number; includeStderr?: boolean }): GitInvoker {
  return async (args, cwd) => {
    const opts = {
      cwd,
      encoding: 'utf-8' as const,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    };
    try {
      const { stdout, stderr } = await execFileAsync('git', args, opts);
      const out = bufToStr(stdout);
      const err = bufToStr(stderr);
      return { stdout: includeStderr ? out + err : out, status: 0 };
    } catch (e) {
      const errObj = e as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer };
      const out = bufToStr(errObj.stdout);
      const err = bufToStr(errObj.stderr);
      // A numeric `code` is the git exit status (e.g. 1 from `git status` is
      // normal); a string `code` (ENOENT / ETIMEDOUT) means git never ran or
      // was killed — surface that as `null`, matching the old spawnSync path.
      const status = typeof errObj.code === 'number' ? errObj.code : null;
      return { stdout: includeStderr ? out + err : out, status };
    }
  };
}

const defaultInvoker: GitInvoker = makeGitInvoker({ timeoutMs: SPAWN_TIMEOUT_MS });

/**
 * Read the project's git status. Returns `null` when the project root
 * isn't a git repo (so the client can hide the chip). Conservative on per-
 * call failure — a timed-out / errored sub-call yields the conservative
 * default for that field rather than propagating up.
 *
 * The `invoker` parameter is a test seam — production callers omit it and
 * get the real `spawnSync` shell-out.
 */
export async function getGitStatus(projectRoot: string, invoker: GitInvoker = defaultInvoker): Promise<GitStatus | null> {
  if (!isGitRepo(projectRoot)) return null;
  // HS-8362 / HS-8723 — instrument the (now async) git-invocation chain (up to
  // 5 serialized invocations). Switched from `instrumentSync` to
  // `instrumentAsync` because the chain no longer blocks the event loop; the
  // freeze.log entry now records wall-clock latency, not a loop stall. `dataDir`
  // is derived from `projectRoot` by the standard `<projectRoot>/.hotsheet`
  // convention; non-Hot-Sheet projectRoots silently no-op the freeze.log append
  // because `appendFreezeLog` catches the directory-missing error. Label stays
  // `git.getStatus` (projectRoot captured implicitly by the dataDir routing).
  return instrumentAsync(join(projectRoot, '.hotsheet'), 'git.getStatus', () => getGitStatusUnwrapped(projectRoot, invoker));
}

async function getGitStatusUnwrapped(projectRoot: string, invoker: GitInvoker): Promise<GitStatus | null> {
  const root = getGitRoot(projectRoot) ?? projectRoot;

  const branchRes = await invoker(['symbolic-ref', '--short', 'HEAD'], root);
  let branch: string;
  let detached = false;
  if (branchRes.status === 0 && branchRes.stdout.trim() !== '') {
    branch = branchRes.stdout.trim();
  } else {
    // Detached HEAD — use the short SHA. If even that fails (corrupt repo),
    // fall back to a literal '(detached)' so the chip still renders.
    detached = true;
    const sha = await invoker(['rev-parse', '--short', 'HEAD'], root);
    branch = sha.status === 0 && sha.stdout.trim() !== '' ? sha.stdout.trim() : '(detached)';
  }

  // HS-8895 — `--untracked-files=all` (default is `normal`, which collapses a
  // newly-added directory to a single `?? dir/` entry). Without it the chip's
  // dirty/untracked count under-reports: adding a directory of N files shows as
  // 1, and the popover lists `dir/` instead of its contents. `all` expands
  // untracked directories to individual files (gitignored files stay excluded).
  const porcelain = await invoker(['status', '--porcelain=v1', '--no-renames', '--untracked-files=all'], root);
  const counts = porcelain.status === 0
    ? bucketPorcelain(porcelain.stdout)
    : { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };

  // HS-7955 — upstream + ahead + behind. Silent failure → null / 0 (e.g.
  // a freshly-created branch with no upstream yet, or detached HEAD).
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  if (!detached) {
    const upRes = await invoker(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    if (upRes.status === 0 && upRes.stdout.trim() !== '') {
      upstream = upRes.stdout.trim();
      const aheadRes = await invoker(['rev-list', '--count', '@{u}..HEAD'], root);
      if (aheadRes.status === 0) {
        const n = Number.parseInt(aheadRes.stdout.trim(), 10);
        if (Number.isFinite(n)) ahead = n;
      }
      const behindRes = await invoker(['rev-list', '--count', 'HEAD..@{u}'], root);
      if (behindRes.status === 0) {
        const n = Number.parseInt(behindRes.stdout.trim(), 10);
        if (Number.isFinite(n)) behind = n;
      }
    }
  }

  return {
    branch,
    detached,
    upstream,
    ahead,
    behind,
    staged: counts.staged,
    unstaged: counts.unstaged,
    untracked: counts.untracked,
    conflicted: counts.conflicted,
    lastFetchedAt: getLastFetchedAt(projectRoot),
  };
}

// ---------------------------------------------------------------------------
// HS-7955 — fetch handling
// ---------------------------------------------------------------------------

/** Per-project last successful Hot-Sheet-initiated `git fetch` timestamp.
 *  Stays in memory across requests — process-lifetime is fine; the field
 *  isn't load-bearing if it resets on restart. */
const lastFetchedAt = new Map<string, number>();

function getLastFetchedAt(projectRoot: string): number | null {
  return lastFetchedAt.get(projectRoot) ?? null;
}

/** Run `git fetch --quiet --no-write-fetch-head` against the upstream of
 *  the current branch. Returns `ok: true` + the new timestamp on success;
 *  `ok: false` + the captured stderr on failure. 30s timeout. */
export async function runGitFetch(projectRoot: string, invoker: GitInvoker = makeGitInvoker({ timeoutMs: 30_000, includeStderr: true })): Promise<FetchResult> {
  if (!isGitRepo(projectRoot)) {
    return { ok: false, lastFetchedAt: null, error: 'Not a git repository' };
  }
  const root = getGitRoot(projectRoot) ?? projectRoot;
  // Check for an upstream first — `git fetch` against a branch with no
  // upstream is a no-op-ish (fetches every remote) which isn't what the
  // user clicked the button for. Surface a clear error instead.
  const upRes = await invoker(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  if (upRes.status !== 0 || upRes.stdout.trim() === '') {
    return { ok: false, lastFetchedAt: null, error: 'No upstream branch — set one with `git push -u <remote> <branch>`.' };
  }
  const fetchRes = await invoker(['fetch', '--quiet', '--no-write-fetch-head'], root);
  if (fetchRes.status === 0) {
    const now = Date.now();
    lastFetchedAt.set(projectRoot, now);
    return { ok: true, lastFetchedAt: now, error: '' };
  }
  return { ok: false, lastFetchedAt: getLastFetchedAt(projectRoot), error: fetchRes.stdout.trim() === '' ? 'fetch failed' : fetchRes.stdout.trim() };
}

/** Test-only — drop the lastFetchedAt cache so each test starts clean. */
export function _resetFetchStateForTests(): void {
  lastFetchedAt.clear();
}

/**
 * Pure: bucket `git status --porcelain=v1` output into the four counters
 * the chip displays. Format reminder:
 *
 *   XY <path>
 *
 * where X is the index column (staged) and Y is the worktree column
 * (unstaged). Special cases:
 *
 *   ??  → untracked
 *   UU / AA / DD / AU / UA / DU / UD → conflicted (unmerged)
 *
 * Otherwise count X != ' ' as staged, Y != ' ' as unstaged. A single file
 * can contribute to BOTH `staged` and `unstaged` (e.g. partial stage).
 *
 * Exported for unit testing — the spawn path's only behavioral surface is
 * this parser.
 */
export function bucketPorcelain(output: string): { staged: number; unstaged: number; untracked: number; conflicted: number } {
  const out = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const conflictedCodes = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  for (const line of output.split('\n')) {
    if (line.length < 2) continue;
    const xy = line.slice(0, 2);
    if (xy === '??') {
      out.untracked++;
      continue;
    }
    if (conflictedCodes.has(xy)) {
      out.conflicted++;
      continue;
    }
    if (xy[0] !== ' ') out.staged++;
    if (xy[1] !== ' ') out.unstaged++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HS-7956 — per-bucket file lists (Phase 3 popover)
// ---------------------------------------------------------------------------

const FILES_PER_BUCKET_CAP = 200;

/** Read the per-bucket file lists from `git status --porcelain=v1`. Caps
 *  each bucket at 200 entries — beyond that the popover gets unusable and
 *  the user is better off in `git status` directly. Returns `null` when not
 *  a git repo or git fails. */
export async function getGitStatusFiles(projectRoot: string, invoker: GitInvoker = defaultInvoker): Promise<GitStatusFiles | null> {
  if (!isGitRepo(projectRoot)) return null;
  // HS-8362 / HS-8723 — single (now async) git invocation, smaller surface than
  // `getGitStatus`'s 5-call chain. Still wrapped so freeze.log can show whether
  // the expanded-popover file-list endpoint contributes to any observed
  // latency. Triggered on demand by the gitStatusChip popover click.
  return instrumentAsync(join(projectRoot, '.hotsheet'), 'git.getStatusFiles', async () => {
    const root = getGitRoot(projectRoot) ?? projectRoot;
    // HS-8895 — `--untracked-files=all` so the popover lists every file in a
    // newly-added directory (matching the expanded count) instead of a single
    // `dir/` entry. See the rationale on the count invocation in `getGitStatusUnwrapped`.
    const res = await invoker(['status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all'], root);
    if (res.status !== 0) return null;
    return bucketPorcelainFiles(res.stdout);
  });
}

/** Pure: parse `git status --porcelain=v1 -z` output into per-bucket file
 *  lists. The `-z` flag separates entries with NUL bytes (instead of LF)
 *  and disables path quoting — handles paths with spaces, embedded
 *  newlines, and unicode reliably. Exported for tests. */
export function bucketPorcelainFiles(output: string): GitStatusFiles {
  const out: GitStatusFiles = {
    staged: [], unstaged: [], untracked: [], conflicted: [],
    truncated: { staged: false, unstaged: false, untracked: false, conflicted: false },
  };
  const conflictedCodes = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  // -z output is a sequence of `XY <path>\0` records.
  const records = output.split('\0').filter(r => r !== '');
  for (const record of records) {
    if (record.length < 3) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3); // skip the single space after XY
    if (xy === '??') {
      pushCapped(out.untracked, path, () => { out.truncated.untracked = true; });
      continue;
    }
    if (conflictedCodes.has(xy)) {
      pushCapped(out.conflicted, path, () => { out.truncated.conflicted = true; });
      continue;
    }
    if (xy[0] !== ' ') pushCapped(out.staged, path, () => { out.truncated.staged = true; });
    if (xy[1] !== ' ') pushCapped(out.unstaged, path, () => { out.truncated.unstaged = true; });
  }
  return out;
}

function pushCapped(arr: string[], item: string, onTruncate: () => void): void {
  if (arr.length >= FILES_PER_BUCKET_CAP) {
    onTruncate();
    return;
  }
  arr.push(item);
}

// ---------------------------------------------------------------------------
// HS-8472 — pending (unpushed) commits for the git-status popover
// ---------------------------------------------------------------------------

const PENDING_COMMITS_CAP = 50;
// Field/record separators: ASCII Unit Separator (US, \x1f) between fields and
// Record Separator (RS, \x1e) between commits. They never appear in commit
// metadata, so the body's own newlines don't confuse the parse.
const US = '\x1f';
const RS = '\x1e';

/**
 * Read the commits in HEAD that aren't in the upstream (`@{u}..HEAD`) — the
 * unpushed/"pending" commits — newest first, capped at `PENDING_COMMITS_CAP`.
 * Returns `null` when not a git repo; `{ commits: [], truncated: false }` when
 * there's no upstream or nothing pending. The `invoker` is a test seam.
 */
export async function getPendingCommits(
  projectRoot: string,
  invoker: GitInvoker = defaultInvoker,
): Promise<{ commits: PendingCommit[]; truncated: boolean } | null> {
  if (!isGitRepo(projectRoot)) return null;
  return instrumentAsync(join(projectRoot, '.hotsheet'), 'git.getPendingCommits', async () => {
    const root = getGitRoot(projectRoot) ?? projectRoot;
    // Fetch one over the cap so we can flag truncation. `@{u}` errors (non-zero)
    // when the branch has no upstream → treat as "nothing pending".
    const res = await invoker(
      ['log', '@{u}..HEAD', '--no-merges', `--max-count=${String(PENDING_COMMITS_CAP + 1)}`,
        `--pretty=format:%H${US}%h${US}%s${US}%b${RS}`],
      root,
    );
    if (res.status !== 0) return { commits: [], truncated: false };
    const all = parsePendingCommits(res.stdout);
    return { commits: all.slice(0, PENDING_COMMITS_CAP), truncated: all.length > PENDING_COMMITS_CAP };
  });
}

/** Pure: parse the `git log --pretty=format:%H\x1f%h\x1f%s\x1f%b\x1e` output
 *  into commit records. Tolerant of a trailing RS / blank records. Exported
 *  for tests. */
export function parsePendingCommits(stdout: string): PendingCommit[] {
  const out: PendingCommit[] = [];
  for (const rec of stdout.split(RS)) {
    const trimmed = rec.replace(/^\n+/, '');
    if (trimmed.trim() === '') continue;
    const parts = trimmed.split(US);
    const hash = (parts[0] ?? '').trim();
    if (hash === '') continue;
    out.push({
      hash,
      shortHash: (parts[1] ?? '').trim(),
      subject: (parts[2] ?? '').trim(),
      body: (parts[3] ?? '').replace(/\s+$/, ''),
    });
  }
  return out;
}
