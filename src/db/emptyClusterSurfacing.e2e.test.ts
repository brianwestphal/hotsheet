/**
 * HS-9576 (docs/135) — the empty-cluster guard tells the user, across a real
 * process boundary.
 *
 * The unit tests in `emptyClusterGuard.test.ts` prove the predicate and the
 * marker write against a stub cluster. What they cannot prove is the thing that
 * actually failed on 2026-08-04: that a SERVER, started fresh over a project
 * whose `db/` had vanished, reaches the state where `GET /api/db/recovery-status`
 * tells the client its data is missing. Every step in between — PGLite creating
 * the cluster, `noteClusterCreatedEmpty` firing at the right moment, the content
 * marker surviving on disk, the backup path consulting the guard, the route
 * serving the new fields — is real here and mocked nowhere.
 *
 * The sequence is the incident, minus the crash: run a healthy project, capture
 * a backup (which records the content marker), stop, remove `db/` the way an
 * interrupted recovery leaves it (HS-9572), and start again.
 */
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canRunServerSpawnTests,
  postJson,
  readSecret,
  type SpawnedHotSheet,
  spawnHotSheet,
  waitForExit,
} from '../spawnTestServer.js';

let activeChildren: SpawnedHotSheet[] = [];

function spawnTracked(opts?: Parameters<typeof spawnHotSheet>[0]): SpawnedHotSheet {
  const child = spawnHotSheet(opts);
  activeChildren.push(child);
  return child;
}

beforeEach(() => { activeChildren = []; });

afterEach(() => {
  for (const child of activeChildren) {
    if (!child.proc.killed && child.proc.exitCode === null) child.proc.kill('SIGKILL');
    try { rmSync(child.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(child.homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeChildren = [];
});

interface RecoveryStatus {
  marker: { kind?: string; priorTicketCount?: number; corruptPath?: string; restoredFrom?: string } | null;
}

async function recoveryStatus(port: number, secret: string): Promise<RecoveryStatus['marker']> {
  const res = await fetch(`http://localhost:${String(port)}/api/db/recovery-status`, {
    headers: { 'X-Hotsheet-Secret': secret },
  });
  const body = await res.json() as RecoveryStatus;
  return body.marker;
}

/** Ask for a backup, tolerating the genuine "already in progress" 409 — the
 *  ticket writes above schedule a debounced auto-backup that can still be
 *  running. Fails loudly if the reason is anything else. */
async function backupWithRetry(base: string, secret: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await postJson(`${base}/api/backups/now`, {}, secret);
    if (res.ok) return;
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Backup already in progress');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('backup never completed');
}

describe.skipIf(!canRunServerSpawnTests)('empty-cluster surfacing across a restart (HS-9576)', () => {
  it('reports the missing data on /api/db/recovery-status and refuses the backup out loud', async () => {
    // 1. A healthy project with real tickets, backed up — the backup is what
    //    writes the content marker the guard later compares against.
    const first = spawnTracked();
    await first.ready;
    const secret = readSecret(first.dataDir);
    const base = `http://localhost:${String(first.port)}`;
    for (const title of ['alpha', 'beta', 'gamma']) {
      const res = await postJson(`${base}/api/tickets`, { title }, secret);
      expect(res.ok).toBe(true);
    }
    await backupWithRetry(base, secret);
    expect(existsSync(join(first.dataDir, '.db-content-marker.json'))).toBe(true);

    first.proc.kill('SIGKILL');
    await waitForExit(first.proc, 10_000);

    // 2. The HS-9572 shape: recovery renamed `db/` aside and died before it
    //    could restore, so the next start finds no cluster at all. Nothing is
    //    corrupt, so no recovery path runs and no corrupt-open marker exists.
    rmSync(join(first.dataDir, 'db'), { recursive: true, force: true });

    const second = spawnTracked({ dataDir: first.dataDir, homeDir: first.homeDir, port: first.port });
    await second.ready;
    const base2 = `http://localhost:${String(second.port)}`;

    // 3. A durability write is what trips the guard. Ask for one directly
    //    rather than waiting out the 5-minute tick.
    const blocked = await postJson(`${base2}/api/backups/now`, {}, secret);
    expect(blocked.status).toBe(409);
    const err = await blocked.json() as { error: string };
    // Not "already in progress" — the user asked why and got the real answer.
    expect(err.error).toMatch(/database is empty/);

    // 4. Which is exactly what the banner reads.
    const marker = await recoveryStatus(second.port, secret);
    expect(marker).toMatchObject({ kind: 'empty-cluster', priorTicketCount: 3 });
    // No cluster was renamed aside in THIS process, and saying otherwise would
    // point the §42 picker at a path that does not exist.
    expect(marker?.corruptPath).toBe('');
    expect(marker?.restoredFrom).toBeUndefined();
  }, 90_000);

  it('stays quiet for a brand-new project, which is empty for the innocent reason', async () => {
    const child = spawnTracked();
    await child.ready;
    const secret = readSecret(child.dataDir);
    const base = `http://localhost:${String(child.port)}`;

    // A first backup on a project that has never held a ticket must succeed —
    // getting this wrong would mean a new install never gets a backup at all.
    const res = await postJson(`${base}/api/backups/now`, {}, secret);
    expect(res.ok).toBe(true);
    expect(await recoveryStatus(child.port, secret)).toBeNull();
  }, 60_000);
});
