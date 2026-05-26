import { spawnSync } from 'child_process';
import { join } from 'path';

// HS-8522 — wire shapes inferred from the typed-API-layer schemas
// (`src/api/git.ts`), the single source of truth shared with the client.
import type { FetchResult, GitStatus, GitStatusFiles } from '../api/git.js';
import { instrumentSync } from '../diagnostics/freezeLogger.js';
import { getGitRoot, isGitRepo } from '../gitignore.js';

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

/** Spawn options shared across every git invocation in this module. */
type GitInvoker = (args: string[], cwd: string) => { stdout: string; status: number | null };

const defaultInvoker: GitInvoker = (args, cwd) => {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...process.env,
      // HS-7954: never block the server on a credential prompt; never fight
      // the user's interactive terminal for `.git/index.lock`.
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  return { stdout: typeof res.stdout === 'string' ? res.stdout : '', status: res.status };
};

/**
 * Read the project's git status. Returns `null` when the project root
 * isn't a git repo (so the client can hide the chip). Conservative on per-
 * call failure — a timed-out / errored sub-call yields the conservative
 * default for that field rather than propagating up.
 *
 * The `invoker` parameter is a test seam — production callers omit it and
 * get the real `spawnSync` shell-out.
 */
export function getGitStatus(projectRoot: string, invoker: GitInvoker = defaultInvoker): GitStatus | null {
  if (!isGitRepo(projectRoot)) return null;
  // HS-8362 — instrument the spawnSync chain (up to 5 git invocations
  // serialized, each a synchronous block while git runs). `dataDir` is
  // derived from `projectRoot` by the standard `<projectRoot>/.hotsheet`
  // convention; non-Hot-Sheet projectRoots silently no-op the freeze.log
  // append because `freezeLogger.appendFreezeLog` catches the directory-
  // missing error and warns to console without throwing. The label is
  // `git.getStatus` (no per-project suffix — projectRoot is captured
  // implicitly by the dataDir routing).
  return instrumentSync(join(projectRoot, '.hotsheet'), 'git.getStatus', () => getGitStatusUnwrapped(projectRoot, invoker));
}

function getGitStatusUnwrapped(projectRoot: string, invoker: GitInvoker): GitStatus | null {
  const root = getGitRoot(projectRoot) ?? projectRoot;

  const branchRes = invoker(['symbolic-ref', '--short', 'HEAD'], root);
  let branch: string;
  let detached = false;
  if (branchRes.status === 0 && branchRes.stdout.trim() !== '') {
    branch = branchRes.stdout.trim();
  } else {
    // Detached HEAD — use the short SHA. If even that fails (corrupt repo),
    // fall back to a literal '(detached)' so the chip still renders.
    detached = true;
    const sha = invoker(['rev-parse', '--short', 'HEAD'], root);
    branch = sha.status === 0 && sha.stdout.trim() !== '' ? sha.stdout.trim() : '(detached)';
  }

  const porcelain = invoker(['status', '--porcelain=v1', '--no-renames'], root);
  const counts = porcelain.status === 0
    ? bucketPorcelain(porcelain.stdout)
    : { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };

  // HS-7955 — upstream + ahead + behind. Silent failure → null / 0 (e.g.
  // a freshly-created branch with no upstream yet, or detached HEAD).
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  if (!detached) {
    const upRes = invoker(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    if (upRes.status === 0 && upRes.stdout.trim() !== '') {
      upstream = upRes.stdout.trim();
      const aheadRes = invoker(['rev-list', '--count', '@{u}..HEAD'], root);
      if (aheadRes.status === 0) {
        const n = Number.parseInt(aheadRes.stdout.trim(), 10);
        if (Number.isFinite(n)) ahead = n;
      }
      const behindRes = invoker(['rev-list', '--count', 'HEAD..@{u}'], root);
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
export function runGitFetch(projectRoot: string, invoker: GitInvoker = defaultInvokerWithTimeout(30_000)): FetchResult {
  if (!isGitRepo(projectRoot)) {
    return { ok: false, lastFetchedAt: null, error: 'Not a git repository' };
  }
  const root = getGitRoot(projectRoot) ?? projectRoot;
  // Check for an upstream first — `git fetch` against a branch with no
  // upstream is a no-op-ish (fetches every remote) which isn't what the
  // user clicked the button for. Surface a clear error instead.
  const upRes = invoker(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  if (upRes.status !== 0 || upRes.stdout.trim() === '') {
    return { ok: false, lastFetchedAt: null, error: 'No upstream branch — set one with `git push -u <remote> <branch>`.' };
  }
  const fetchRes = invoker(['fetch', '--quiet', '--no-write-fetch-head'], root);
  if (fetchRes.status === 0) {
    const now = Date.now();
    lastFetchedAt.set(projectRoot, now);
    return { ok: true, lastFetchedAt: now, error: '' };
  }
  return { ok: false, lastFetchedAt: getLastFetchedAt(projectRoot), error: fetchRes.stdout.trim() === '' ? 'fetch failed' : fetchRes.stdout.trim() };
}

function defaultInvokerWithTimeout(timeoutMs: number): GitInvoker {
  return (args, cwd) => {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    // For fetch we want stderr too — combine into a single field for the
    // caller's UI surfacing.
    const out = (typeof res.stdout === 'string' ? res.stdout : '')
      + (typeof res.stderr === 'string' ? res.stderr : '');
    return { stdout: out, status: res.status };
  };
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
export function getGitStatusFiles(projectRoot: string, invoker: GitInvoker = defaultInvoker): GitStatusFiles | null {
  if (!isGitRepo(projectRoot)) return null;
  // HS-8362 — single spawnSync (smaller surface than `getGitStatus`'s
  // 5-call chain), still wrapped for completeness so freeze.log can show
  // whether the expanded-popover file-list endpoint is contributing to
  // any observed stall. Triggered on demand by the gitStatusChip popover
  // click in the sidebar.
  return instrumentSync(join(projectRoot, '.hotsheet'), 'git.getStatusFiles', () => {
    const root = getGitRoot(projectRoot) ?? projectRoot;
    const res = invoker(['status', '--porcelain=v1', '--no-renames', '-z'], root);
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
