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
