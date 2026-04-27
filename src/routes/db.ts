import { Hono } from 'hono';

import { clearRecoveryMarker, readRecoveryMarker } from '../db/connection.js';
import { findWorkingBackup, getResetwalAvailability, runResetwalAndDump } from '../db/repair.js';
import type { AppEnv } from '../types.js';

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
    const msg = err instanceof Error ? err.message : 'Validation failed';
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
  const marker = readRecoveryMarker(dataDir);
  if (marker === null) {
    return c.json({ error: 'No recovery marker — pg_resetwal repair is only available after an open-failure recovery.' }, 400);
  }
  try {
    const result = await runResetwalAndDump(dataDir, marker.corruptPath);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'pg_resetwal failed';
    return c.json({ error: msg }, 500);
  }
});
