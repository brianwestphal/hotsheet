import { Hono } from 'hono';

import { CorruptPathReqSchema } from '../api/db.js';
import { clearRecoveryMarker, readRecoveryMarker } from '../db/connection.js';
import { findWorkingBackup, getResetwalAvailability, listCorruptClusters, probeCorruptCluster, resolveCorruptCluster, runResetwalAndDump } from '../db/repair.js';
import { getSnapshotStatus } from '../db/snapshot.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';

/** HS-7899: routes for the launch-time DB-recovery banner. The marker
 *  itself is written by `recoverFromOpenFailure()` in
 *  `src/db/connection.ts` whenever the live `db/` dir was renamed
 *  aside as `db-corrupt-<ts>` and a fresh empty cluster created. The
 *  client polls `/recovery-status` on boot, shows a non-dismissable
 *  banner if a marker exists, and either opens the Settings → Backups
 *  flow ("Restore from backup") or POSTs to `/dismiss-recovery` to
 *  clear the marker. */
export const dbRoutes = new Hono<AppEnv>();

dbRoutes.get('/recovery-status', (c) => {
  const dataDir = c.get('dataDir');
  const marker = readRecoveryMarker(dataDir);
  return c.json({ marker });
});

dbRoutes.post('/dismiss-recovery', (c) => {
  const dataDir = c.get('dataDir');
  clearRecoveryMarker(dataDir);
  return c.json({ ok: true });
});

// HS-8594: Snapshot Protection status for the Settings → Backups toggle —
// see docs/73-snapshot-protection.md §73.6.

/** Last-snapshot metadata for the "Snapshot protection" status line.
 *  `getSnapshotStatus` reads the in-memory writer state populated by the
 *  HS-8586 snapshot writer; both fields are null until the first snapshot
 *  of the current session lands. */
dbRoutes.get('/snapshot-status', (c) => {
  const dataDir = c.get('dataDir');
  return c.json(getSnapshotStatus(dataDir));
});

// HS-7897: Repair Database routes — see docs/42-repair-database.md.

/** Iterate every backup tarball newest-first, validate by `loadDataDir`,
 *  return the first one that opens cleanly. Used by Settings → Backups
 *  → Database Repair → "Find a working backup". */
dbRoutes.post('/repair/find-working-backup', async (c) => {
  const dataDir = c.get('dataDir');
  try {
    const result = await findWorkingBackup(dataDir);
    return c.json({ backup: result });
  } catch (err) {
    const msg = getErrorMessage(err);
    return c.json({ error: msg }, 500);
  }
});

/** Probe the system for a `pg_resetwal` binary and return whether it's
 *  reachable, plus platform-specific install instructions for the
 *  client to surface when it isn't. */
dbRoutes.get('/repair/pg-resetwal-availability', async (c) => {
  const availability = await getResetwalAvailability();
  return c.json(availability);
});

/** Run `pg_resetwal -f` on a copy of the corrupt directory from the
 *  recovery marker, then dump the repaired directory as a fresh
 *  `.tar.gz` into the 5-min backup tier. Client then refreshes the
 *  backup list and offers Restore on the new tarball. The original
 *  corrupt directory is preserved. */
dbRoutes.post('/repair/run-pg-resetwal', async (c) => {
  const dataDir = c.get('dataDir');

  // HS-9575 — the client may name WHICH preserved directory to repair. Before
  // this the flow could only use the recovery marker's `corruptPath`, and a
  // recovery that died partway leaves the previous incident's marker in place:
  // on 2026-08-04 that named a 0-byte directory while the one holding 432
  // tickets sat beside it, unofferable.
  const requested = await readCorruptPath(c);
  let corruptPath: string;
  if (requested !== null) {
    // Never trust a browser-supplied path: it goes straight to `cpSync` and
    // `pg_resetwal`. Only an exact match against an enumerated candidate passes.
    const resolved = await resolveCorruptCluster(dataDir, requested);
    if (resolved === null) {
      return c.json({ error: 'That path is not one of this project\'s preserved corrupt directories.' }, 400);
    }
    corruptPath = resolved;
  } else {
    const marker = readRecoveryMarker(dataDir);
    if (marker === null) {
      return c.json({ error: 'No recovery marker — pass a corruptPath, or use one of the preserved directories listed by /db/repair/corrupt-clusters.' }, 400);
    }
    corruptPath = marker.corruptPath;
  }

  try {
    const result = await runResetwalAndDump(dataDir, corruptPath);
    return c.json(result);
  } catch (err) {
    const msg = getErrorMessage(err);
    return c.json({ error: msg }, 500);
  }
});

/** Every preserved `db-corrupt-*` directory, newest first — metadata only, so
 *  the picker can render before the (slow) per-candidate probes finish. */
dbRoutes.get('/repair/corrupt-clusters', async (c) => {
  const clusters = await listCorruptClusters(c.get('dataDir'));
  return c.json({ clusters });
});

/** How many tickets a candidate would actually yield. Runs the real recovery
 *  (copy → `pg_resetwal -f` → open → COUNT) against a temp copy, so the user can
 *  see which directory is worth repairing before committing to one. */
dbRoutes.post('/repair/probe-corrupt-cluster', async (c) => {
  const dataDir = c.get('dataDir');
  const requested = await readCorruptPath(c);
  if (requested === null) return c.json({ error: 'corruptPath is required.' }, 400);
  const resolved = await resolveCorruptCluster(dataDir, requested);
  if (resolved === null) {
    return c.json({ error: 'That path is not one of this project\'s preserved corrupt directories.' }, 400);
  }
  return c.json({ recoverableTicketCount: await probeCorruptCluster(resolved) });
});

/** Parse an optional `{ corruptPath }` body. Returns null for an absent or
 *  malformed body so `run-pg-resetwal` keeps its no-argument behavior. */
async function readCorruptPath(c: { req: { json: () => Promise<unknown> } }): Promise<string | null> {
  try {
    const parsed = CorruptPathReqSchema.safeParse(await c.req.json());
    return parsed.success ? parsed.data.corruptPath : null;
  } catch {
    return null;
  }
}
