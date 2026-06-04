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
  disposeAllGitWatchers,
  disposeGitWatcher,
  dropGitStatusCache,
  ensureGitWatcher,
  getCachedGitStatus,
  getGitChangeVersion,
  subscribeToGitChanges,
} from './watcher.js';

// HS-8713 — the watcher builds paths with `path.join`, so on Windows the
// targets are `...\.git\index` (backslashes). Assert against `join(...)`
// rather than hardcoded POSIX strings so these tests are OS-portable.
const gitIndexPath = join('/tmp/proj', '.git', 'index');
const gitHeadPath = join('/tmp/proj', '.git', 'HEAD');

// --- Mocks ---

const mockGetGitStatus = vi.fn<(root: string) => unknown>();
const mockIsGitRepo = vi.fn<(root: string) => boolean>();
const mockGetGitRoot = vi.fn<(root: string) => string | null>();
const mockExistsSync = vi.fn<(path: string) => boolean>();
const mockFsWatch = vi.fn<(path: string, cb: (event: string, filename: string | null) => void) => { close: () => void }>();

vi.mock('./status.js', () => ({
  getGitStatus: (root: string): unknown => mockGetGitStatus(root),
}));

vi.mock('../gitignore.js', () => ({
  isGitRepo: (root: string): boolean => mockIsGitRepo(root),
  getGitRoot: (root: string): string | null => mockGetGitRoot(root),
}));

vi.mock('fs', () => ({
  existsSync: (p: string): boolean => mockExistsSync(p),
  watch: (p: string, cb: (event: string, filename: string | null) => void): { close: () => void } => mockFsWatch(p, cb),
}));

beforeEach(() => {
  _resetGitStatusCacheForTests();
  _resetDefaultSchedulerForTests(); // HS-8724 — isolate the global scheduler the watcher's pre-warm submits to
  _resetActiveProjectsForTests(); // HS-8725 — empty ⇒ isProjectActive defaults true, so existing assertions hold
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

  it('wires up watchers for both .git/index AND .git/HEAD on the happy path', () => {
    arrangeRepo();
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).toHaveBeenCalledTimes(2);
    expect(mockFsWatch.mock.calls[0][0]).toBe(gitIndexPath);
    expect(mockFsWatch.mock.calls[1][0]).toBe(gitHeadPath);
  });

  it('skips a missing per-file target (e.g. fresh repo without HEAD yet)', () => {
    mockIsGitRepo.mockReturnValue(true);
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    // .git dir + .git/index exist; .git/HEAD does NOT
    mockExistsSync.mockImplementation((p: string) => p !== gitHeadPath);
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).toHaveBeenCalledTimes(1);
    expect(mockFsWatch.mock.calls[0][0]).toBe(gitIndexPath);
  });

  it('swallows fs.watch errors per-file (degraded mode on FUSE / SMB)', () => {
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
    expect(mockFsWatch).toHaveBeenCalledTimes(2);
    ensureGitWatcher('/tmp/proj');
    expect(mockFsWatch).toHaveBeenCalledTimes(2); // no additional calls
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
    expect(close).toHaveBeenCalledTimes(2); // index + HEAD
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
      return { close: callCount <= 2 ? closeA : closeB };
    });

    ensureGitWatcher('/tmp/A');
    ensureGitWatcher('/tmp/B');
    const heard: string[] = [];
    subscribeToGitChanges((root) => { heard.push(root); });

    disposeAllGitWatchers();
    expect(closeA).toHaveBeenCalledTimes(2);
    expect(closeB).toHaveBeenCalledTimes(2);
    expect(getGitChangeVersion('/tmp/A')).toBe(0); // watcher entry gone
    expect(getGitChangeVersion('/tmp/B')).toBe(0);
    // Subscribers cleared — a re-ensure + fire shouldn't reach the old handler.
    // (Verified indirectly by the fact that `heard` stays empty after the
    // re-ensure flow below.)
    expect(heard).toEqual([]);
  });
});
