/**
 * HS-9527 — `backupFs` guard tests.
 *
 * The contract under test is a resilience contract, so the cases are written as
 * SEQUENCES across breaker states (closed → open → half-open → closed) rather
 * than one-shot calls from a clean start — per the project's transition-matrix
 * testing rule. A green single-operation test would prove nothing here: the
 * whole failure mode is what happens on the fifth call after the third stall.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetBackupFsForTests,
  backupFsFor,
  getBackupFsHealth,
  isBackupFsAvailable,
  isBackupFsUnavailable,
  tolerateOutage,
} from './backupFs.js';

let root: string;
/** The production deadline is 15 s; three of those per breaker-transition case
 *  would make this file take minutes. The tunables are read per call precisely
 *  so a test can shrink them — the LOGIC under test is unchanged, only how long
 *  a stall has to last before it counts. */
const SHORT_DEADLINE_MS = '120';

beforeEach(() => {
  _resetBackupFsForTests();
  process.env.HOTSHEET_BACKUP_FS_META_TIMEOUT_MS = SHORT_DEADLINE_MS;
  process.env.HOTSHEET_BACKUP_FS_IO_TIMEOUT_MS = SHORT_DEADLINE_MS;
  root = mkdtempSync(join(tmpdir(), 'hs-backupfs-'));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HOTSHEET_BACKUP_FS_META_TIMEOUT_MS;
  delete process.env.HOTSHEET_BACKUP_FS_IO_TIMEOUT_MS;
  rmSync(root, { recursive: true, force: true });
});

/** A promise that never settles — stands in for a `read(2)` on a wedged File
 *  Provider mount, which is the exact thing that has no timeout of its own. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => { /* deliberately never resolved */ });
}

describe('happy path', () => {
  it('reads and writes through the guard like plain fs', async () => {
    const bfs = backupFsFor(root);
    const p = join(root, 'a.json');
    await bfs.writeFile(p, '{"k":1}');
    expect(await bfs.readFileUtf8(p)).toBe('{"k":1}');
    expect(await bfs.exists(p)).toBe(true);
    expect(await bfs.readdir(root)).toContain('a.json');
    expect((await bfs.stat(p)).size).toBeGreaterThan(0);
    await bfs.rm(p);
    expect(await bfs.exists(p)).toBe(false);
  });

  it('a missing directory reads as empty rather than throwing', async () => {
    const bfs = backupFsFor(root);
    expect(await bfs.readdirOrEmpty(join(root, 'nope'))).toEqual([]);
  });
});

describe('an ANSWERED error is not a stall', () => {
  it('ENOENT does not count toward the breaker, however often it happens', async () => {
    const bfs = backupFsFor(root);
    // Ten misses in a row — far past the failure threshold. A missing file is the
    // filesystem working correctly; treating it as a failure would take backups
    // offline for fifteen minutes because someone deleted a manifest.
    for (let i = 0; i < 10; i++) {
      await expect(bfs.readFileUtf8(join(root, `missing-${String(i)}`))).rejects.toThrow();
    }
    expect(isBackupFsAvailable(root)).toBe(true);
    expect(getBackupFsHealth(root).state).toBe('closed');
    expect(getBackupFsHealth(root).stats.timedOut).toBe(0);
  });
});

describe('deadline + breaker', () => {
  it('a stalled operation gives the caller back a typed error instead of hanging', async () => {
    const bfs = backupFsFor(root);
    const call = bfs.run('stalled', 'meta', () => neverSettles<undefined>());
    await expect(call).rejects.toSatisfy(isBackupFsUnavailable);
  });

  it('opens after the threshold, then fails fast WITHOUT touching the filesystem', async () => {
    const bfs = backupFsFor(root);
    const attempted: string[] = [];

    // Three stalls → breaker opens.
    for (let i = 0; i < 3; i++) {
      await expect(bfs.run(`stall-${String(i)}`, 'meta', () => {
        attempted.push(`stall-${String(i)}`);
        return neverSettles<undefined>();
      })).rejects.toSatisfy(isBackupFsUnavailable);
    }

    expect(getBackupFsHealth(root).state).toBe('open');
    expect(isBackupFsAvailable(root)).toBe(false);

    // The next call must reject IMMEDIATELY and must never invoke the operation.
    const before = Date.now();
    await expect(bfs.run('after-open', 'meta', () => {
      attempted.push('after-open');
      return neverSettles<undefined>();
    })).rejects.toSatisfy(isBackupFsUnavailable);
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(attempted).not.toContain('after-open');
    expect(getBackupFsHealth(root).stats.failedFast).toBeGreaterThan(0);
  });

  it('a real read still fails fast while the breaker is open — no fs call at all', async () => {
    const bfs = backupFsFor(root);
    const p = join(root, 'present.json');
    writeFileSync(p, '{}');

    for (let i = 0; i < 3; i++) {
      await expect(bfs.run(`stall-${String(i)}`, 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);
    }

    // The file is RIGHT THERE and readable. It must still fail fast: while the
    // breaker is open we do not spend a threadpool thread finding out.
    await expect(bfs.readFileUtf8(p)).rejects.toSatisfy(isBackupFsUnavailable);
  });

  it('half-open lets ONE probe through and closes on success', async () => {
    const bfs = backupFsFor(root);
    const p = join(root, 'present.json');
    writeFileSync(p, '{"ok":true}');

    for (let i = 0; i < 3; i++) {
      await expect(bfs.run(`stall-${String(i)}`, 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);
    }
    expect(getBackupFsHealth(root).state).toBe('open');

    // Jump past the first backoff rung (30 s). Fake ONLY `Date` — the breaker
    // reads the wall clock, but the guard's own deadline still uses a real
    // `setTimeout`, and faking that too would freeze the operation we are
    // trying to let through. Kept faked across the probe: reverting the clock
    // first would put the breaker straight back to `open`.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    expect(getBackupFsHealth(root).state).toBe('half-open');

    // The probe succeeds → breaker closes and normal service resumes.
    expect(await bfs.readFileUtf8(p)).toBe('{"ok":true}');
    expect(getBackupFsHealth(root).state).toBe('closed');
    expect(isBackupFsAvailable(root)).toBe(true);
  });
});

/**
 * HS-9547 — the transitions the original ten tests did not reach.
 *
 * Those covered closed→open and half-open→**closed**. The other exit from
 * half-open — the probe FAILS, because the cloud folder is still down — was
 * untested, and with it the whole backoff ladder past its first rung and the
 * reset that stops a flapping share ratcheting to permanent 15-minute lockouts.
 *
 * Every case here is a SEQUENCE. There is no way to observe a ladder from a
 * single call, which is exactly why line coverage could not see the gap.
 */
describe('the backoff ladder (HS-9547)', () => {
  /** Drive the breaker from closed to open. Threshold is 3 consecutive stalls. */
  async function tripBreaker(bfs: ReturnType<typeof backupFsFor>, tag: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await expect(bfs.run(`${tag}-${String(i)}`, 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);
    }
  }

  /** Advance the WALL clock only. The guard's deadline runs on a real
   *  `setTimeout`, so faking timers wholesale would freeze the very operation
   *  each step needs to let through. */
  function advance(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
  }

  it('re-opens when the half-open probe fails, and the next wait is LONGER', async () => {
    const bfs = backupFsFor(root);
    await tripBreaker(bfs, 'first');
    expect(getBackupFsHealth(root).state).toBe('open');

    vi.useFakeTimers({ toFake: ['Date'] });
    advance(31_000);
    expect(getBackupFsHealth(root).state).toBe('half-open');

    // The probe stalls — the folder is still dead. This is the transition that
    // had no test: half-open → open rather than half-open → closed.
    await expect(bfs.run('probe-1', 'meta', () => neverSettles<undefined>()))
      .rejects.toSatisfy(isBackupFsUnavailable);
    expect(getBackupFsHealth(root).state).toBe('open');

    // Rung 1 is 60 s, so the wait that just worked (30 s) must NOT be enough.
    // This assertion is the point of the case: without it, an implementation
    // that re-opened at a flat 30 s forever would pass everything else.
    advance(31_000);
    expect(getBackupFsHealth(root).state, 'rung 1 is 60 s, not another 30 s').toBe('open');

    advance(30_000);
    expect(getBackupFsHealth(root).state).toBe('half-open');
  });

  it('keeps escalating, and clamps at the top of the ladder instead of running off it', async () => {
    const bfs = backupFsFor(root);
    await tripBreaker(bfs, 'esc');
    vi.useFakeTimers({ toFake: ['Date'] });

    // Walk the ladder: 30 s → 60 s → 5 min → 15 min. Each failed probe moves up.
    for (const [i, wait] of [30_000, 60_000, 300_000].entries()) {
      advance(wait + 1_000);
      expect(getBackupFsHealth(root).state, `rung ${String(i)} should have elapsed`).toBe('half-open');
      await expect(bfs.run(`probe-${String(i)}`, 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);
      expect(getBackupFsHealth(root).state).toBe('open');
    }

    // Now at the last rung (15 min). Failing again must stay there rather than
    // index past the end of the array and produce `undefined` as a wait.
    advance(901_000);
    expect(getBackupFsHealth(root).state).toBe('half-open');
    await expect(bfs.run('probe-top', 'meta', () => neverSettles<undefined>()))
      .rejects.toSatisfy(isBackupFsUnavailable);
    advance(899_000);
    expect(getBackupFsHealth(root).state, 'still clamped at 15 min, not undefined/NaN').toBe('open');
    advance(2_000);
    expect(getBackupFsHealth(root).state).toBe('half-open');
  });

  it('RESETS the ladder once the filesystem answers — a flapping share never ratchets', async () => {
    // The invariant with a real user-visible consequence. If `backoffLevel` did
    // not reset on success, a share that drops out once an hour would climb to
    // 15-minute lockouts and stay there, pausing backups almost permanently on a
    // filesystem that is mostly fine.
    const bfs = backupFsFor(root);
    const p = join(root, 'present.json');
    writeFileSync(p, '{"ok":true}');

    await tripBreaker(bfs, 'ratchet');
    vi.useFakeTimers({ toFake: ['Date'] });

    // Climb two rungs so the reset is being checked from a non-zero level —
    // resetting from level 0 is not a test of anything.
    advance(31_000);
    await expect(bfs.run('probe-a', 'meta', () => neverSettles<undefined>()))
      .rejects.toSatisfy(isBackupFsUnavailable);
    advance(61_000);
    expect(getBackupFsHealth(root).state).toBe('half-open');

    // It answers. Breaker closes.
    expect(await bfs.readFileUtf8(p)).toBe('{"ok":true}');
    expect(getBackupFsHealth(root).state).toBe('closed');

    // It drops out again. The new wait must be the FIRST rung (30 s), not the
    // 5 minutes it had escalated to.
    await tripBreaker(bfs, 'again');
    expect(getBackupFsHealth(root).state).toBe('open');
    advance(31_000);
    expect(getBackupFsHealth(root).state, 'the ladder must restart at 30 s after a success').toBe('half-open');
  });

  it('escalates per root — one dead folder never delays a healthy one', async () => {
    // The per-root isolation test above covers the closed/open split. This is the
    // interleaved version: the ladder state itself must not be shared, or a
    // project on local disk inherits a cloud folder's 15-minute lockout.
    const dead = backupFsFor(root);
    const liveRoot = mkdtempSync(join(tmpdir(), 'hs-backupfs-live-'));
    try {
      const live = backupFsFor(liveRoot);
      const p = join(liveRoot, 'ok.json');
      writeFileSync(p, '{"live":true}');

      await tripBreaker(dead, 'dead');
      vi.useFakeTimers({ toFake: ['Date'] });
      advance(31_000);
      await expect(dead.run('probe', 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);

      // `dead` is now open on rung 1. `live` has never failed and must be
      // untouched — same process, same gate, independent breakers.
      expect(getBackupFsHealth(root).state).toBe('open');
      expect(getBackupFsHealth(liveRoot).state).toBe('closed');
      expect(isBackupFsAvailable(liveRoot)).toBe(true);
      expect(await live.readFileUtf8(p)).toBe('{"live":true}');
    } finally {
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });
});

describe('the concurrency gate', () => {
  it('never puts more than maxInflight operations into the threadpool', async () => {
    const bfs = backupFsFor(root);
    let concurrent = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    const calls = Array.from({ length: 6 }, (_, i) => bfs.run(`op-${String(i)}`, 'meta', () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      return new Promise<void>(resolve => {
        release.push(() => { concurrent--; resolve(); });
      });
    }).catch(() => { /* the queued ones may miss their deadline; not this test's concern */ }));

    // Let the gate admit whatever it is going to admit.
    await new Promise(r => setTimeout(r, 50));
    expect(peak).toBeLessThanOrEqual(2);

    while (release.length > 0) release.pop()!();
    await Promise.all(calls);
  });
});

describe('tolerateOutage', () => {
  it('substitutes the fallback for an outage and re-throws anything else', async () => {
    const outage = async (): Promise<number> => {
      await Promise.resolve();
      const bfs = backupFsFor(root);
      return bfs.run('x', 'meta', () => neverSettles<number>());
    };
    // Trip the breaker first so the outage is instant.
    const bfs = backupFsFor(root);
    for (let i = 0; i < 3; i++) {
      await expect(bfs.run(`stall-${String(i)}`, 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);
    }
    expect(await tolerateOutage(outage, -1)).toBe(-1);

    await expect(tolerateOutage(() => Promise.reject(new Error('a real bug')), -1))
      .rejects.toThrow('a real bug');
  });
});

describe('breaker scope', () => {
  it('is per-root: a dead cloud folder does not pause a project on local disk', async () => {
    const dead = backupFsFor(join(root, 'dead'));
    const alive = backupFsFor(root);
    const p = join(root, 'live.json');
    writeFileSync(p, '{}');

    for (let i = 0; i < 3; i++) {
      await expect(dead.run(`stall-${String(i)}`, 'meta', () => neverSettles<undefined>()))
        .rejects.toSatisfy(isBackupFsUnavailable);
    }

    expect(isBackupFsAvailable(join(root, 'dead'))).toBe(false);
    expect(isBackupFsAvailable(root)).toBe(true);
    expect(await alive.readFileUtf8(p)).toBe('{}');
  });
});
