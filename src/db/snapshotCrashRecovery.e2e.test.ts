/**
 * HS-8588 — Snapshot Protection Phase 3: SIGKILL crash-recovery e2e
 * (docs/73-snapshot-protection.md §73.9).
 *
 * The in-process integration tests (`src/db/snapshotRestore.test.ts`, HS-8587)
 * already prove the restore path against a reopened cluster. These prove the
 * same contract across a REAL process boundary + an uncatchable SIGKILL (no
 * `gracefulShutdown`, so no final snapshot — the genuine crash shape):
 *
 *   1. Bounded loss — writes captured by the last debounced snapshot survive
 *      a SIGKILL + corrupt-cluster relaunch; writes made AFTER that snapshot
 *      are the only thing lost (loss ≤ the un-snapshotted-writes bound).
 *   2. Snapshot freshness wins — when both a canonical snapshot AND a §7
 *      backup tarball exist, restore prefers the fresher local snapshot.
 *   3. Multi-project isolation — two projects in one server each restore
 *      their OWN data with no cross-talk through the shared snapshot map.
 *
 * Uses the shared `src/spawnTestServer.ts` harness. `describe.skipIf` keeps
 * restricted sandboxes (tsx IPC EPERM, HS-8202) from timing out.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canRunServerSpawnTests,
  patchJson,
  postJson,
  readSecret,
  type SpawnedHotSheet,
  spawnHotSheet,
  waitForExit,
} from '../spawnTestServer.js';

let activeChildren: SpawnedHotSheet[] = [];
let extraDataDirs: string[] = [];

function spawnTracked(opts?: Parameters<typeof spawnHotSheet>[0]): SpawnedHotSheet {
  const child = spawnHotSheet(opts);
  activeChildren.push(child);
  return child;
}

beforeEach(() => {
  activeChildren = [];
  extraDataDirs = [];
});

afterEach(() => {
  for (const child of activeChildren) {
    if (!child.proc.killed && child.proc.exitCode === null) child.proc.kill('SIGKILL');
    try { rmSync(child.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(child.homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of extraDataDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeChildren = [];
  extraDataDirs = [];
});

/** Corrupt the live cluster so the next open aborts with a recoverable error,
 *  forcing the auto-restore path. Garbles `PG_VERSION` (the lever the HS-7889 /
 *  HS-8587 tests use) AND `global/pg_control` — pg_control is the first file
 *  PG validates on open, so a bad CRC guarantees a fatal open regardless of how
 *  cleanly the cluster was last checkpointed (belt-and-suspenders against the
 *  rare case a heavily-checkpointed cluster tolerates a bad PG_VERSION). Safe
 *  to call only when no process holds the dir (after the SIGKILL'd child exits). */
function corruptCluster(dataDir: string): void {
  const dbDir = join(dataDir, 'db');
  writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');
  try { writeFileSync(join(dbDir, 'global', 'pg_control'), Buffer.alloc(8192, 0xff)); } catch { /* layout may differ */ }
}

/** Drop the stale `hotsheet.lock` a SIGKILL leaves behind (gracefulShutdown's
 *  `releaseProjectLocks` never runs on SIGKILL). A real relaunch removes it
 *  itself via `acquireLock`'s `process.kill(pid, 0)` stale check — EXCEPT in
 *  the rare PID-reuse case, which this fast spawn/kill loop hits routinely.
 *  Lock stale-detection is orthogonal to snapshot recovery (and unit-covered
 *  in `lock.test.ts`), so we clear it here to keep THIS test deterministic. */
function removeStaleLock(dataDir: string): void {
  try { rmSync(join(dataDir, 'hotsheet.lock'), { force: true }); } catch { /* ignore */ }
}

interface SnapshotStatus { lastSnapshotAt: number | null; lastSizeBytes: number | null }
interface RecoveryMarker { restoredFrom?: string; restoredTicketCount?: number; corruptPath: string }

function projectQuery(secret?: string): string {
  return secret === undefined ? '' : `?project=${encodeURIComponent(secret)}`;
}

/** Poll the snapshot-status route until a snapshot written at/after `afterMs`
 *  is visible — i.e. one that captures every mutation made before `afterMs`. */
async function waitForSnapshotAfter(port: number, afterMs: number, secret: string | undefined, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/db/snapshot-status${projectQuery(secret)}`);
      if (res.ok) {
        const s = await res.json() as SnapshotStatus;
        if (s.lastSnapshotAt !== null && s.lastSnapshotAt >= afterMs) return;
      }
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No snapshot at/after ${afterMs} appeared within ${timeoutMs}ms on port ${port}`);
}

async function createTickets(port: number, secret: string, titles: string[]): Promise<void> {
  for (const title of titles) {
    const res = await postJson(`http://localhost:${port}/api/tickets`, { title, defaults: { category: 'task' } }, secret);
    if (res.status !== 201) throw new Error(`Create "${title}" failed: ${res.status}`);
  }
}

async function setDebounce(port: number, secret: string, ms: number): Promise<void> {
  const res = await patchJson(`http://localhost:${port}/api/file-settings`, { db_snapshot_debounce_ms: ms }, secret);
  if (!res.ok) throw new Error(`PATCH debounce failed: ${res.status}`);
}

async function getOpenTitles(port: number, secret?: string): Promise<string[]> {
  const sep = secret === undefined ? '?' : `${projectQuery(secret)}&`;
  const res = await fetch(`http://localhost:${port}/api/tickets${sep}status=not_started`);
  if (!res.ok) throw new Error(`GET tickets failed: ${res.status}`);
  const body = await res.json() as Array<{ title: string }>;
  return body.map((t) => t.title);
}

async function getRecoveryMarker(port: number, secret?: string): Promise<RecoveryMarker | null> {
  const res = await fetch(`http://localhost:${port}/api/db/recovery-status${projectQuery(secret)}`);
  if (!res.ok) throw new Error(`GET recovery-status failed: ${res.status}`);
  const body = await res.json() as { marker: RecoveryMarker | null };
  return body.marker;
}

async function killAndWait(child: SpawnedHotSheet): Promise<void> {
  child.proc.kill('SIGKILL');
  await waitForExit(child.proc, 10_000);
}

describe.skipIf(!canRunServerSpawnTests)('snapshot crash-recovery e2e (HS-8588) (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  // HS-8720 — `{ retry: 2 }` matches the cli.test.ts precedent for spawn-based
  // e2e flakes. These cases drive a REAL `tsx src/cli.ts` child through a
  // debounced-snapshot → SIGKILL → corrupt-cluster → auto-restore sequence whose
  // correctness hinges on real-process + filesystem timing. Under the full
  // merged-coverage run (200+ files in parallel + V8 instrumentation) CPU
  // starvation can perturb that timing enough to surface a rare non-deterministic
  // failure (e.g. an empty restored set). A genuine logic regression would fail
  // all three attempts deterministically; a starvation race clears on retry.
  it('SIGKILL + corrupt cluster → auto-restores from snapshot; loss is bounded to post-snapshot writes', { retry: 2, timeout: 90_000 }, async () => {
    const child = spawnTracked();
    await child.ready;
    const secret = readSecret(child.dataDir);

    // Short debounce so the durable snapshot fires promptly + deterministically.
    await setDebounce(child.port, secret, 800);
    await createTickets(child.port, secret, ['Durable-1', 'Durable-2', 'Durable-3']);
    const afterDurable = Date.now();
    await waitForSnapshotAfter(child.port, afterDurable, undefined, 12_000);

    // Widen the debounce so the next writes can NOT land in a snapshot before
    // we crash — they become the bounded loss window.
    await setDebounce(child.port, secret, 600_000);
    await createTickets(child.port, secret, ['Lost-1', 'Lost-2']);

    // Hard crash — SIGKILL is uncatchable, so gracefulShutdown's final
    // snapshot never runs (the genuine crash shape).
    await killAndWait(child);
    corruptCluster(child.dataDir);
    removeStaleLock(child.dataDir);

    // Relaunch onto the corrupt cluster.
    const relaunch = spawnTracked({ dataDir: child.dataDir });
    await relaunch.ready;

    const marker = await getRecoveryMarker(relaunch.port);
    expect(marker).not.toBeNull();
    expect(marker!.restoredFrom).toBe('snapshot');
    expect(marker!.restoredTicketCount).toBe(3);

    const titles = await getOpenTitles(relaunch.port);
    expect(titles).toEqual(expect.arrayContaining(['Durable-1', 'Durable-2', 'Durable-3']));
    // Bounded loss: only the writes made after the last snapshot are gone.
    expect(titles).not.toContain('Lost-1');
    expect(titles).not.toContain('Lost-2');
  });

  it('prefers the fresher canonical snapshot over an older §7 backup tarball', { retry: 2, timeout: 90_000 }, async () => {
    const child = spawnTracked();
    await child.ready;
    const secret = readSecret(child.dataDir);

    await setDebounce(child.port, secret, 800);
    await createTickets(child.port, secret, ['Old-1', 'Old-2']);
    await waitForSnapshotAfter(child.port, Date.now(), undefined, 12_000);

    // Force a §7 backup tarball capturing the {Old-1, Old-2} state.
    const backupRes = await postJson(`http://localhost:${child.port}/api/backups/now`, {}, secret);
    expect(backupRes.ok).toBe(true);
    const backupList = await (await fetch(`http://localhost:${child.port}/api/backups?project=${secret}`)).json() as { backups: unknown[] };
    expect(backupList.backups.length).toBeGreaterThan(0); // a competing restore source exists

    // Now write one MORE ticket + let the canonical snapshot capture it. The
    // snapshot is now strictly fresher than the backup tarball.
    const afterFresh = Date.now();
    await createTickets(child.port, secret, ['Fresh-1']);
    await waitForSnapshotAfter(child.port, afterFresh, undefined, 12_000);

    await killAndWait(child);
    corruptCluster(child.dataDir);
    removeStaleLock(child.dataDir);

    const relaunch = spawnTracked({ dataDir: child.dataDir });
    await relaunch.ready;

    const marker = await getRecoveryMarker(relaunch.port);
    expect(marker!.restoredFrom).toBe('snapshot'); // snapshot beats the backup tier
    expect(marker!.restoredTicketCount).toBe(3);

    const titles = await getOpenTitles(relaunch.port);
    // We got the FRESH snapshot (has Fresh-1) — not the older backup (lacks it).
    expect(titles).toEqual(expect.arrayContaining(['Old-1', 'Old-2', 'Fresh-1']));
  });

  it('multi-project: both projects restore their own data with no cross-talk', { retry: 2, timeout: 120_000 }, async () => {
    const child = spawnTracked();
    await child.ready;
    const secret1 = readSecret(child.dataDir);

    // Register a second project in the same server.
    const dataDir2 = mkdtempSync(join(tmpdir(), 'hs-e2e-data2-'));
    extraDataDirs.push(dataDir2);
    const regRes = await postJson(`http://localhost:${child.port}/api/projects/register`, { dataDir: dataDir2 });
    expect(regRes.ok).toBe(true);
    const secret2 = readSecret(dataDir2);
    expect(secret2).not.toBe(secret1);

    await setDebounce(child.port, secret1, 800);
    await setDebounce(child.port, secret2, 800);
    await createTickets(child.port, secret1, ['P1-only']);
    await createTickets(child.port, secret2, ['P2-only']);
    const after = Date.now();
    await waitForSnapshotAfter(child.port, after, secret1, 12_000);
    await waitForSnapshotAfter(child.port, after, secret2, 12_000);

    await killAndWait(child);
    corruptCluster(child.dataDir);
    corruptCluster(dataDir2);
    removeStaleLock(child.dataDir);
    removeStaleLock(dataDir2);

    // Relaunch (project 1 = primary, restored at boot). Re-register project 2
    // explicitly — the register call opens its corrupt cluster, triggering its
    // own restore synchronously (avoids depending on boot-time multi-project
    // restore timing).
    const relaunch = spawnTracked({ dataDir: child.dataDir });
    await relaunch.ready;
    const reReg = await postJson(`http://localhost:${relaunch.port}/api/projects/register`, { dataDir: dataDir2 });
    expect(reReg.ok).toBe(true);

    const m1 = await getRecoveryMarker(relaunch.port, secret1);
    const m2 = await getRecoveryMarker(relaunch.port, secret2);
    expect(m1!.restoredFrom).toBe('snapshot');
    expect(m2!.restoredFrom).toBe('snapshot');

    const titles1 = await getOpenTitles(relaunch.port, secret1);
    const titles2 = await getOpenTitles(relaunch.port, secret2);
    expect(titles1).toContain('P1-only');
    expect(titles1).not.toContain('P2-only');
    expect(titles2).toContain('P2-only');
    expect(titles2).not.toContain('P1-only');
  });
});
