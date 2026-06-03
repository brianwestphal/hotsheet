/**
 * HS-8587 — Snapshot Protection Phase 2: auto-restore integration tests.
 *
 * Exercises the full recovery path through a real PGLite cluster: seed →
 * snapshot → corrupt the live `db/` (the same `PG_VERSION` lever the
 * HS-7889 corruption tests use) → reopen → assert the cluster auto-restored
 * from the canonical snapshot (or a §7 backup tier, or fell back to empty).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeAllDatabases, getDb, readRecoveryMarker, setDataDir } from './connection.js';
import { createTicket, getTickets } from './queries.js';
import { listRestoreSources } from './restore.js';
import { _resetSnapshotStateForTests, snapshotPath, writeSnapshotNow } from './snapshot.js';

// HS-8650 — this suite drives a REAL PGLite cluster through
// seed → `dumpDataDir`/`writeSnapshotNow` → corrupt → reopen → auto-restore,
// then `closeAllDatabases()` in `afterEach`. In isolation it's ~6.5s, but
// during the full merged-coverage run (200+ files in parallel + V8
// instrumentation) the CPU starvation pushes a single test body to ~28s and
// the close work past vitest's DEFAULT 10s `hookTimeout` — surfacing as
// "Hook timed out in 10000ms" in `afterEach`, a CI-flakiness risk (not a
// product bug). Scope generous timeouts to THIS file (rather than bumping the
// global config + masking real hangs elsewhere): testTimeout headroom for the
// slow snapshot dump/restore bodies, hookTimeout headroom for the close.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let dataDir: string;

/** Corrupt the live cluster the way the HS-7889 tests do — overwriting
 *  `PG_VERSION` reliably makes PGLite's open abort with a recoverable error. */
function corruptLiveCluster(): void {
  writeFileSync(join(dataDir, 'db', 'PG_VERSION'), 'not-a-real-version\n');
}

beforeEach(() => {
  dataDir = join(tmpdir(), `hs-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(async () => {
  await closeAllDatabases();
  _resetSnapshotStateForTests();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('listRestoreSources', () => {
  it('lists nothing when neither a snapshot nor backups exist', () => {
    expect(listRestoreSources(dataDir)).toEqual([]);
  });

  it('puts the canonical snapshot first, then existing backup tiers', () => {
    writeFileSync(snapshotPath(dataDir), 'x'); // existence-only; not loaded here
    const tierDir = join(dataDir, 'backups', '5min');
    mkdirSync(tierDir, { recursive: true });
    writeFileSync(join(tierDir, 'backup-2026-05-01T00-00-00Z.tar.gz'), 'x');

    const sources = listRestoreSources(dataDir);
    expect(sources[0].label).toBe('snapshot');
    expect(sources.some((s) => s.label.startsWith('backup:5min:'))).toBe(true);
  });
});

// win32-SKIPPED — and stays that way by design. These test IN-PROCESS recovery
// (corrupt a live cluster, then recover in the same process). On Windows the
// failed PGLite open holds `db/` handles for the process lifetime, so the
// in-process preserve-aside rename can't succeed — that's exactly WHY HS-8717
// added the DEFERRED path (recover on the next startup; see the
// "deferred recovery on next startup" suite below + the real-server validation).
// In-process recovery on Windows is not achievable, so these remain POSIX-only.
describe.skipIf(process.platform === 'win32')('auto-restore on corrupt open (HS-8587)', () => {
  it('restores from the canonical snapshot, preserving the corrupt dir aside', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('Restored via snapshot');
    await createTicket('Second ticket');
    await writeSnapshotNow(dataDir);
    expect(existsSync(snapshotPath(dataDir))).toBe(true);
    await closeAllDatabases();

    corruptLiveCluster();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb(); // triggers recovery → restore from snapshot
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.length).toBe(2);
    expect(tickets.some((t) => t.title === 'Restored via snapshot')).toBe(true);

    const marker = readRecoveryMarker(dataDir);
    expect(marker).not.toBeNull();
    expect(marker!.restoredFrom).toBe('snapshot');
    expect(marker!.restoredTicketCount).toBe(2);

    // The corrupt cluster is preserved aside for manual rescue, never deleted.
    const siblings = readdirSync(dataDir).filter((n) => n.startsWith('db-corrupt-'));
    expect(siblings.length).toBeGreaterThan(0);
  });

  it('falls back to a §7 backup tier tarball when no canonical snapshot exists', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('Restored via backup tier');
    await writeSnapshotNow(dataDir);

    // A snapshot tarball is byte-identical in format to a backup tarball
    // (both are dumpDataDir('gzip')). Stage it as a 5min-tier backup, then
    // remove the canonical snapshot so the fallback chain has to use it.
    const tierDir = join(dataDir, 'backups', '5min');
    mkdirSync(tierDir, { recursive: true });
    copyFileSync(snapshotPath(dataDir), join(tierDir, 'backup-2026-05-01T00-00-00Z.tar.gz'));
    rmSync(snapshotPath(dataDir));
    await closeAllDatabases();

    corruptLiveCluster();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb();
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.some((t) => t.title === 'Restored via backup tier')).toBe(true);
    const marker = readRecoveryMarker(dataDir);
    expect(marker!.restoredFrom).toMatch(/^backup:5min:/);
  });

  it('falls back to an empty cluster + banner marker when no source loads', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('unsaved — no snapshot was ever taken');
    await closeAllDatabases(); // NO snapshot, NO backups

    corruptLiveCluster();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb();
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.length).toBe(0); // empty recreate

    const marker = readRecoveryMarker(dataDir);
    expect(marker).not.toBeNull();
    // No `restoredFrom` → the client shows the blocking restore banner, not a toast.
    expect(marker!.restoredFrom).toBeUndefined();
  });
});

// HS-8717 — deferred recovery (the Windows self-heal). When a corrupt open can't
// preserve db/ in-process (Windows holds the failed PGLite instance's handles
// for the process lifetime), recovery writes a `.db-pending-recovery.json`
// marker and exits; the NEXT startup completes the preserve+restore BEFORE
// opening, in a fresh process with no handles. These tests model that next
// startup by clean-closing first (handles released), corrupting, dropping the
// marker, then opening.
//
// win32-SKIPPED: a vitest process can't truly model a real process exit — after
// `closeAllDatabases()` the PGLite WASM module is still resident in the SAME
// Node process, so on Windows the "fresh" reopen still contends with the prior
// instance's handles and the heal path thrashes (it hung for ~23 min). The real
// Windows flow IS validated end-to-end against the actual server (HS-8717
// completion note: s2 defers → s3 self-heals, server up, marker cleared). On
// POSIX these run and exercise the deferred-recovery logic.
describe.skipIf(process.platform === 'win32')('deferred recovery on next startup (HS-8717)', () => {
  const pendingMarkerPath = (): string => join(dataDir, '.db-pending-recovery.json');

  it('preserves the corrupt db/ aside and restores the snapshot before opening', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('Deferred-recovery ticket');
    await writeSnapshotNow(dataDir);
    await closeAllDatabases(); // releases handles, like a process exit

    corruptLiveCluster();
    // Simulate the prior launch that deferred because it couldn't move db/.
    writeFileSync(pendingMarkerPath(), JSON.stringify({ attempts: 1, requestedAt: '2026-06-03T00:00:00.000Z' }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb(); // completeDeferredRecovery heals BEFORE opening
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.some((t) => t.title === 'Deferred-recovery ticket')).toBe(true);

    const marker = readRecoveryMarker(dataDir);
    expect(marker).not.toBeNull();
    expect(marker!.restoredFrom).toBe('snapshot');

    expect(readdirSync(dataDir).filter((n) => n.startsWith('db-corrupt-')).length).toBeGreaterThan(0);
    expect(existsSync(pendingMarkerPath())).toBe(false); // marker cleared after heal
  });

  it('gives up (and clears the marker) after too many attempts', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('Whatever');
    await closeAllDatabases();

    corruptLiveCluster();
    // attempts above MAX (3) → the boot-loop guard bails without renaming.
    writeFileSync(pendingMarkerPath(), JSON.stringify({ attempts: 99, requestedAt: '2026-06-03T00:00:00.000Z' }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb();
    errSpy.mockRestore();

    expect(existsSync(pendingMarkerPath())).toBe(false); // guard cleared it (no infinite loop)
  });
});
