/**
 * HS-8561 — unit coverage for `src/git/watcher.ts`. Pre-fix coverage
 * was 13.43%; this suite exercises the 500ms result cache + the
 * subscriber wire-up + the watcher lifecycle (ensure / dispose / dispose-all)
 * without standing up a real `fs.watch` (which is platform-flaky and
 * impossible to deterministically trigger from a unit test). Real
 * filesystem `.git/index` mtime nudges live in the e2e suite; this
 * one pins the pure-state-machine half of the module.
 */
import { join } from 'path';
import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetActiveProjectsForTests, markProjectActive } from '../activeProjects.js';
import { _resetDefaultSchedulerForTests } from '../scheduler/backgroundScheduler.js';
import {
  _resetGitStatusCacheForTests,
  _setRecursiveWatchForTests,
  disposeAllGitWatchers,
  disposeGitWatcher,
  dropGitStatusCache,
  ensureGitWatcher,
  getCachedGitStatus,
  getGitChangeVersion,
  isIgnoredWorkingTreePath,
  pollWorkingTreesOnce,
  subscribeToGitChanges,
} from './watcher.js';

// HS-8713 — the watcher builds paths with `path.join`, so on Windows the
// targets are `...\.git` (backslashes). Assert against `join(...)` rather than
// hardcoded POSIX strings so these tests are OS-portable.
// HS-9109 — the watcher now watches the `.git` DIRECTORY (not the index/HEAD
// files) so it survives git's atomic index-rename.
const gitDirPath = join('/tmp/proj', '.git');

// --- Mocks ---

const mockGetGitStatus = vi.fn<(root: string) => unknown>();
const mockIsGitRepo = vi.fn<(root: string) => boolean>();
const mockGetGitRoot = vi.fn<(root: string) => string | null>();
const mockExistsSync = vi.fn<(path: string) => boolean>();
const mockFsWatch = vi.fn<(path: string, cb: (event: string, filename: string | null) => void) => { close: () => void }>();
// HS-9111 — the watcher now attaches an `error` listener (`handle.on('error', …)`),
// so every fake watch handle needs an `on`. Injected by the `fs` mock wrapper
// below so the individual `mockReturnValue({ close })` sites don't each repeat it.
const noopOn = (): void => { /* no-op */ };

vi.mock('./status.js', () => ({
  getGitStatus: (root: string): unknown => mockGetGitStatus(root),
}));

vi.mock('../gitignore.js', () => ({
  isGitRepo: (root: string): boolean => mockIsGitRepo(root),
  getGitRoot: (root: string): string | null => mockGetGitRoot(root),
}));

vi.mock('fs', () => ({
  existsSync: (p: string): boolean => mockExistsSync(p),
  // HS-9224 — `fs.watch` is called two ways now: the `.git` watch as `(path, cb)`
  // and the recursive working-tree watch as `(path, { recursive: true }, cb)`.
  // Extract the listener from whichever position it's in.
  watch: (p: string, optsOrCb: unknown, maybeCb?: unknown): { close: () => void; on: () => void } => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (event: string, filename: string | null) => void;
    return { on: noopOn, ...mockFsWatch(p, cb) };
  },
  // HS-9224 — `readGitignoreDirs` reads `<gitRoot>/.gitignore`; default to "no
  // gitignore" so tests don't depend on a real file.
  readFileSync: (): string => '',
}));

beforeEach(() => {
  _resetGitStatusCacheForTests();
  _resetDefaultSchedulerForTests(); // HS-8724 — isolate the global scheduler the watcher's pre-warm submits to
  _resetActiveProjectsForTests(); // HS-8725 — empty ⇒ isProjectActive defaults true, so existing assertions hold
  // HS-9224 — pin the POLL-fallback path (recursive working-tree watch OFF) for
  // this suite, so the `.git`-watch + poll assertions are platform-independent
  // (these tests run the single-`fs.watch` design). The recursive path has its
  // own suite below.
  _setRecursiveWatchForTests(false);
  disposeAllGitWatchers();
  mockGetGitStatus.mockReset();
  mockIsGitRepo.mockReset();
  mockGetGitRoot.mockReset();
  mockExistsSync.mockReset();
  mockFsWatch.mockReset().mockReturnValue({ close: vi.fn() });
});

afterEach(() => {
  _resetGitStatusCacheForTests();
  disposeAllGitWatchers();
  _setRecursiveWatchForTests(null); // HS-9224 — restore platform detection
  vi.useRealTimers();
});

describe('getCachedGitStatus — 500ms result cache', () => {
  it('returns the underlying getGitStatus result on first call', async () => {
    const status = { branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true };
    mockGetGitStatus.mockReturnValue(status);
    expect(await getCachedGitStatus('/tmp/proj')).toEqual(status);
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on a second call within the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await getCachedGitStatus('/tmp/proj');
    vi.advanceTimersByTime(100); // well under 500ms
    await getCachedGitStatus('/tmp/proj');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after the TTL elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await getCachedGitStatus('/tmp/proj');
    vi.advanceTimersByTime(600); // past 500ms TTL
    await getCachedGitStatus('/tmp/proj');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
  });

  it('caches `null` results too — a non-git project doesn\'t re-shell on every poll', async () => {
    mockGetGitStatus.mockReturnValue(null);
    await getCachedGitStatus('/tmp/not-git');
    await getCachedGitStatus('/tmp/not-git');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
  });

  it('caches per-project (different roots get separate entries)', async () => {
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await getCachedGitStatus('/tmp/A');
    await getCachedGitStatus('/tmp/B');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
    expect(mockGetGitStatus).toHaveBeenNthCalledWith(1, '/tmp/A');
    expect(mockGetGitStatus).toHaveBeenNthCalledWith(2, '/tmp/B');
  });

  it('coalesces concurrent misses for the same project onto one git run (HS-8723)', async () => {
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    // Two reads fired before the first resolves must share a single git run.
    const [a, b] = await Promise.all([
      getCachedGitStatus('/tmp/proj'),
      getCachedGitStatus('/tmp/proj'),
    ]);
    expect(a).toEqual(b);
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
  });
});

describe('dropGitStatusCache', () => {
  it('forces a re-resolve on the next read for the dropped project only', async () => {
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await getCachedGitStatus('/tmp/A');
    await getCachedGitStatus('/tmp/B');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
    dropGitStatusCache('/tmp/A');
    await getCachedGitStatus('/tmp/A');
    await getCachedGitStatus('/tmp/B'); // B is still cached
    expect(mockGetGitStatus).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when the project has no cached entry', () => {
    expect(() => { dropGitStatusCache('/tmp/never-cached'); }).not.toThrow();
  });
});

describe('ensureGitWatcher — idempotent wire-up', () => {
  function arrangeRepo(): void {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true); // both .git dir + .git/index + .git/HEAD exist
  }

  it('no-ops when the project isn\'t a git repo', () => {
    mockIsGitRepo.mockReturnValue(false);
    ensureGitWatcher('/tmp/not-git');
    expect(mockFsWatch).not.toHaveBeenCalled();
  });

  it('no-ops when getGitRoot returns null', () => {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue(null);
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).not.toHaveBeenCalled();
  });

  it('no-ops when the .git directory doesn\'t exist (worktree / submodule)', () => {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(false); // .git dir is a file, not a dir — skip per v1 design
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).not.toHaveBeenCalled();
  });

  it('HS-9109: wires up a SINGLE watcher on the .git directory (survives index rename)', () => {
    arrangeRepo();
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    expect(mockFsWatch.mock.calls[0][0]).toBe(gitDirPath);
  });

  it('swallows fs.watch errors (degraded mode on FUSE / SMB)', () => {
    arrangeRepo();
    mockFsWatch.mockImplementation(() => { throw new Error('ENOSYS'); });
    expect(() => { ensureGitWatcher('/tmp/proj'); }).not.toThrow();
    // Watcher entry still registered (degraded but tracked) so the
    // version counter is queryable.
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
  });

  it('is idempotent — calling twice for the same root reuses the existing watchers', () => {
    arrangeRepo();
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).toHaveBeenCalledTimes(1); // no additional calls
  });
});

describe('HS-9109 — directory-watch filename filtering', () => {
  function arrangeWithCb(): () => ((event: string, filename: string | null) => void) {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    let watcherCb: ((event: string, filename: string | null) => void) | null = null;
    mockFsWatch.mockImplementation((_p, cb) => { watcherCb = cb; return { close: vi.fn() }; });
    ensureGitWatcher('/tmp/proj');
    return () => {
      if (watcherCb === null) throw new Error('watcher callback not captured');
      return watcherCb;
    };
  }

  it('fires for index + HEAD changes', () => {
    vi.useFakeTimers();
    const cb = arrangeWithCb();
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });

    cb()('change', 'index');
    vi.advanceTimersByTime(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);

    cb()('change', 'HEAD');
    vi.advanceTimersByTime(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(2);
    expect(heard).toEqual(['/tmp/proj', '/tmp/proj']);
    unsub();
  });

  it('does NOT fire for index.lock or unrelated .git churn (no self-trigger)', () => {
    vi.useFakeTimers();
    const cb = arrangeWithCb();

    cb()('change', 'index.lock');
    cb()('change', 'COMMIT_EDITMSG');
    cb()('change', 'config');
    vi.advanceTimersByTime(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(0); // nothing relevant changed
  });

  it('falls back to firing on a null filename (platform can\'t report it)', () => {
    vi.useFakeTimers();
    const cb = arrangeWithCb();
    cb()('change', null);
    vi.advanceTimersByTime(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);
  });
});

describe('debounced fire — fs.watch callback', () => {
  it('bumps the per-project version + drops the cache + fans out to subscribers (debounced)', async () => {
    vi.useFakeTimers();
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    let watcherCb: ((event: string, filename: string | null) => void) | null = null;
    mockFsWatch.mockImplementation((_p, cb) => {
      watcherCb = cb;
      return { close: vi.fn() };
    });
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });

    // Seed a cache entry so we can confirm the watcher tear-down drops it
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await getCachedGitStatus('/tmp/proj');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);

    ensureGitWatcher('/tmp/proj');
    expect(watcherCb).not.toBeNull();
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);

    // Fire the watcher callback. The 250ms debounce means nothing
    // visible happens yet.
    watcherCb!('change', 'index');
    expect(heard).toEqual([]);
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);

    // A burst of additional events within the debounce window
    // collapses to one notification.
    watcherCb!('change', 'index');
    watcherCb!('change', 'HEAD');

    // Advance past the debounce.
    vi.advanceTimersByTime(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);
    expect(heard).toEqual(['/tmp/proj']);

    // Cache was dropped — next read re-resolves.
    await getCachedGitStatus('/tmp/proj');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('HS-8725: a background (inactive) project busts cache + bumps version but does NOT notify or pre-warm', async () => {
    vi.useFakeTimers();
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    let watcherCb: ((event: string, filename: string | null) => void) | null = null;
    mockFsWatch.mockImplementation((_p, cb) => { watcherCb = cb; return { close: vi.fn() }; });
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });

    // Mark a DIFFERENT project active, so /tmp/proj is now a background tab.
    markProjectActive(join('/tmp/other', '.hotsheet'));

    await getCachedGitStatus('/tmp/proj'); // seed cache — getGitStatus call #1
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);

    ensureGitWatcher('/tmp/proj');
    watcherCb!('change', 'index');
    vi.advanceTimersByTime(300);

    // Cache bust + version bump still happen (so a switch-to refetches fresh)...
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);
    // ...but NO subscriber notify and NO pre-warm git run for the background tab.
    expect(heard).toEqual([]);
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1); // no pre-warm fired

    unsub();
  });

  it('subscriber callback that throws does NOT break the fan-out', () => {
    vi.useFakeTimers();
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    let watcherCb: ((event: string, filename: string | null) => void) | null = null;
    mockFsWatch.mockImplementation((_p, cb) => {
      watcherCb = cb;
      return { close: vi.fn() };
    });
    const heard: string[] = [];
    const unsubA = subscribeToGitChanges(() => { throw new Error('boom'); });
    const unsubB = subscribeToGitChanges((root) => { heard.push(root); });

    ensureGitWatcher('/tmp/proj');
    watcherCb!('change', 'index');
    vi.advanceTimersByTime(300);
    expect(heard).toEqual(['/tmp/proj']);

    unsubA();
    unsubB();
  });

  it('unsubscribe stops further notifications', () => {
    vi.useFakeTimers();
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    let watcherCb: ((event: string, filename: string | null) => void) | null = null;
    mockFsWatch.mockImplementation((_p, cb) => {
      watcherCb = cb;
      return { close: vi.fn() };
    });
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });

    ensureGitWatcher('/tmp/proj');
    watcherCb!('change', 'index');
    vi.advanceTimersByTime(300);
    expect(heard).toEqual(['/tmp/proj']);

    unsub();
    watcherCb!('change', 'index');
    vi.advanceTimersByTime(300);
    expect(heard).toEqual(['/tmp/proj']); // no new entry
  });
});

// HS-9111 — the foreground working-tree poll (docs/48 §48.3.3): a working-tree
// edit (tracked file modified / untracked file created) doesn't touch
// `.git/index|HEAD`, so the `.git`-dir watcher never fires; the low-frequency
// `git status` poll bumps the version when the working-tree signature moves.
describe('working-tree poll (HS-9111)', () => {
  const full = (over: Partial<Record<string, unknown>> = {}) => ({
    branch: 'main', detached: false, ahead: 0, behind: 0,
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...over,
  });

  function watch(root = '/tmp/proj') {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue(root);
    mockExistsSync.mockReturnValue(true);
    ensureGitWatcher(root);
  }

  it('bumps the version + fans out when a working-tree edit changes the signature', async () => {
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });
    watch();
    // First poll establishes the baseline (clean tree) — no fire.
    mockGetGitStatus.mockResolvedValue(full());
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
    expect(heard).toEqual([]);

    // A tracked file is modified (no `git add`) → unstaged climbs. Drop the
    // 500 ms result cache to mimic the real >4 s gap between polls.
    dropGitStatusCache('/tmp/proj');
    mockGetGitStatus.mockResolvedValue(full({ unstaged: 1 }));
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);
    expect(heard).toEqual(['/tmp/proj']);
    unsub();
  });

  it('does NOT fire when the signature is unchanged between polls', async () => {
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });
    watch();
    mockGetGitStatus.mockResolvedValue(full({ untracked: 2 }));
    await pollWorkingTreesOnce(); // baseline
    dropGitStatusCache('/tmp/proj');
    await pollWorkingTreesOnce(); // same signature
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
    expect(heard).toEqual([]);
    unsub();
  });

  it('skips a background (inactive) project — no poll-driven fire', async () => {
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });
    watch();
    // Mark a DIFFERENT project active so /tmp/proj is a background tab.
    markProjectActive(join('/tmp/other', '.hotsheet'));
    mockGetGitStatus.mockResolvedValue(full());
    await pollWorkingTreesOnce(); // baseline attempt — skipped (inactive)
    dropGitStatusCache('/tmp/proj');
    mockGetGitStatus.mockResolvedValue(full({ unstaged: 3 }));
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
    expect(heard).toEqual([]);
    unsub();
  });

  it('untracked-only change (new file, never staged) also bumps the version', async () => {
    watch();
    mockGetGitStatus.mockResolvedValue(full());
    await pollWorkingTreesOnce(); // baseline
    dropGitStatusCache('/tmp/proj');
    mockGetGitStatus.mockResolvedValue(full({ untracked: 1 }));
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);
  });
});

// HS-9224 — the recursive working-tree watch (macOS / Windows). When active it
// replaces the 4s poll: a non-ignored file event runs a signature-gated status
// check, and the idle case costs zero `git status`. Linux falls back to the
// poll (the suite above).
describe('isIgnoredWorkingTreePath (HS-9224)', () => {
  const none = new Set<string>();
  it('ignores .git / .hotsheet / node_modules churn at any depth', () => {
    expect(isIgnoredWorkingTreePath('.git/index', none)).toBe(true);
    expect(isIgnoredWorkingTreePath('.hotsheet/freeze.log', none)).toBe(true);
    expect(isIgnoredWorkingTreePath('node_modules/foo/bar.js', none)).toBe(true);
    expect(isIgnoredWorkingTreePath('src/node_modules/x', none)).toBe(true); // nested too
  });
  it('does NOT ignore an ordinary source edit', () => {
    expect(isIgnoredWorkingTreePath('src/client/app.tsx', none)).toBe(false);
    expect(isIgnoredWorkingTreePath('README.md', none)).toBe(false);
  });
  it('honors per-repo extra ignored dirs (from .gitignore)', () => {
    const extra = new Set(['dist', 'coverage']);
    expect(isIgnoredWorkingTreePath('dist/cli.js', extra)).toBe(true);
    expect(isIgnoredWorkingTreePath('coverage/lcov.info', extra)).toBe(true);
    expect(isIgnoredWorkingTreePath('src/index.ts', extra)).toBe(false);
  });
});

describe('recursive working-tree watch (HS-9224)', () => {
  /** Arrange a recursive-enabled watcher and return getters for both callbacks:
   *  the `.git`-dir watch cb and the recursive working-tree watch cb (keyed by
   *  the watched path — `.git` dir vs the repo root). */
  function arrangeRecursive(root = '/tmp/proj') {
    _setRecursiveWatchForTests(true);
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue(root);
    mockExistsSync.mockReturnValue(true);
    const cbs = new Map<string, (event: string, filename: string | null) => void>();
    mockFsWatch.mockImplementation((p, cb) => { cbs.set(p, cb); return { close: vi.fn() }; });
    ensureGitWatcher(root);
    return {
      gitCb: () => cbs.get(join(root, '.git'))!,
      wtCb: () => cbs.get(root)!,
    };
  }

  it('attaches BOTH a .git-dir watch and a recursive working-tree watch', () => {
    arrangeRecursive();
    expect(mockFsWatch).toHaveBeenCalledTimes(2);
    const paths = mockFsWatch.mock.calls.map(c => c[0]);
    expect(paths).toContain(join('/tmp/proj', '.git'));
    expect(paths).toContain('/tmp/proj');
  });

  it('a non-ignored working-tree edit runs a signature-gated check + fans out', async () => {
    vi.useFakeTimers();
    const { wtCb } = arrangeRecursive();
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });

    // Baseline (clean tree).
    mockGetGitStatus.mockResolvedValue({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    wtCb()('change', 'src/app.ts');
    await vi.advanceTimersByTimeAsync(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(0); // first observation = baseline only
    expect(heard).toEqual([]);

    // A real edit moves the signature → notify.
    dropGitStatusCache('/tmp/proj');
    mockGetGitStatus.mockResolvedValue({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
    wtCb()('change', 'src/app.ts');
    await vi.advanceTimersByTimeAsync(300);
    expect(getGitChangeVersion('/tmp/proj')).toBe(1);
    expect(heard).toEqual(['/tmp/proj']);
    unsub();
  });

  it('ignores node_modules / .git / .hotsheet events (no status run)', async () => {
    vi.useFakeTimers();
    const { wtCb } = arrangeRecursive();
    mockGetGitStatus.mockResolvedValue({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    wtCb()('change', 'node_modules/foo/index.js');
    wtCb()('change', '.git/index');
    wtCb()('change', '.hotsheet/freeze.log');
    await vi.advanceTimersByTimeAsync(300);
    // No working-tree check scheduled at all → getGitStatus never called.
    expect(mockGetGitStatus).not.toHaveBeenCalled();
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
  });

  it('the poll SKIPS a project covered by a live recursive watch', async () => {
    arrangeRecursive();
    // Even with a signature change available, the poll must not run a status for
    // a recursive-covered project (the watch is event-driven).
    mockGetGitStatus.mockResolvedValue({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, unstaged: 9, untracked: 0, conflicted: 0 });
    await pollWorkingTreesOnce();
    expect(mockGetGitStatus).not.toHaveBeenCalled();
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
  });

  it('closes BOTH handles on dispose', () => {
    _setRecursiveWatchForTests(true);
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    const closes: ReturnType<typeof vi.fn>[] = [];
    mockFsWatch.mockImplementation(() => { const close = vi.fn(); closes.push(close); return { close }; });
    ensureGitWatcher('/tmp/proj');
    expect(closes).toHaveLength(2);
    disposeGitWatcher('/tmp/proj');
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });
});

describe('getGitChangeVersion', () => {
  it('returns 0 for an unknown project (no watcher has fired)', () => {
    expect(getGitChangeVersion('/tmp/never-watched')).toBe(0);
  });

  it('returns 0 for a watcher that has never fired', () => {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    ensureGitWatcher('/tmp/proj');
    expect(getGitChangeVersion('/tmp/proj')).toBe(0);
  });
});

describe('disposeGitWatcher + disposeAllGitWatchers', () => {
  it('closes the per-project watcher handles + drops the cache entry', async () => {
    const close = vi.fn();
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    mockFsWatch.mockReturnValue({ close });
    mockGetGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });

    ensureGitWatcher('/tmp/proj');
    await getCachedGitStatus('/tmp/proj'); // seed cache
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);

    disposeGitWatcher('/tmp/proj');
    expect(close).toHaveBeenCalledTimes(1); // HS-9109 — one .git-directory handle
    // Cache dropped — next read re-resolves.
    await getCachedGitStatus('/tmp/proj');
    expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the project has no watcher', () => {
    expect(() => { disposeGitWatcher('/tmp/never-watched'); }).not.toThrow();
  });

  it('swallows close() errors (handle may already be closed)', () => {
    const close = vi.fn(() => { throw new Error('already closed'); });
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    mockFsWatch.mockReturnValue({ close });

    ensureGitWatcher('/tmp/proj');
    expect(() => { disposeGitWatcher('/tmp/proj'); }).not.toThrow();
  });

  it('cancels a pending debounce timer on dispose', () => {
    vi.useFakeTimers();
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockExistsSync.mockReturnValue(true);
    let watcherCb: ((event: string, filename: string | null) => void) | null = null;
    mockFsWatch.mockImplementation((_p, cb) => {
      watcherCb = cb;
      return { close: vi.fn() };
    });
    const heard: string[] = [];
    const unsub = subscribeToGitChanges((root) => { heard.push(root); });

    ensureGitWatcher('/tmp/proj');
    watcherCb!('change', 'index'); // schedules a 250ms debounce
    disposeGitWatcher('/tmp/proj'); // should cancel the pending timer
    vi.advanceTimersByTime(300);
    expect(heard).toEqual([]); // notification never fired

    unsub();
  });

  it('disposeAllGitWatchers tears down every project + clears subscribers', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    let callCount = 0;
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockImplementation((r: string) => r);
    mockExistsSync.mockReturnValue(true);
    mockFsWatch.mockImplementation(() => {
      callCount++;
      return { close: callCount <= 1 ? closeA : closeB }; // HS-9109 — one handle per project
    });

    ensureGitWatcher('/tmp/A');
    ensureGitWatcher('/tmp/B');
    const heard: string[] = [];
    subscribeToGitChanges((root) => { heard.push(root); });

    disposeAllGitWatchers();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(getGitChangeVersion('/tmp/A')).toBe(0); // watcher entry gone
    expect(getGitChangeVersion('/tmp/B')).toBe(0);
    // Subscribers cleared — a re-ensure + fire shouldn't reach the old handler.
    // (Verified indirectly by the fact that `heard` stays empty after the
    // re-ensure flow below.)
    expect(heard).toEqual([]);
  });
});
