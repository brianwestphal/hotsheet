/**
 * HS-8587 — Snapshot Protection Phase 2: restore-source discovery.
 *
 * When the live `nodefs` cluster comes up broken (open throws OR the
 * integrity probe fails), `connection.ts::recoverFromOpenFailure` walks the
 * sources this module lists, newest-first, and `loadDataDir`s the first one
 * that loads + passes the probe into a fresh `db/`. See §73.4.
 *
 * Source order (decision D1 — local + fresh wins):
 *   1. `<dataDir>/snapshot.tar.gz` — the HS-8586 canonical snapshot. Local,
 *      debounced ~2 s, so usually the freshest source.
 *   2. The §7 backup tiers (`5min` → `hourly` → `daily`), newest-first, as
 *      the deeper fallback for the rare case the canonical snapshot is
 *      itself missing/unreadable.
 *
 * Lazy-imported by `connection.ts` (only on the recovery path) so the
 * `connection → backup → connection` static cycle never forms.
 */
import { existsSync } from 'fs';
import { join } from 'path';

import { listBackups } from '../backup.js';
import { getBackupDir } from '../file-settings.js';
import { snapshotPath } from './snapshot.js';

export interface RestoreSource {
  /** Absolute path of the tarball to `loadDataDir`. */
  path: string;
  /** Human-readable label recorded in the recovery marker / toast. */
  label: string;
}

/**
 * Ordered, existence-filtered list of restore sources for a project. The
 * canonical snapshot is always first (freshest + local); the §7 backup
 * tiers follow, newest-first (`listBackups` already sorts descending by
 * `createdAt` across tiers).
 */
export function listRestoreSources(dataDir: string): RestoreSource[] {
  const sources: RestoreSource[] = [];

  const snap = snapshotPath(dataDir);
  if (existsSync(snap)) sources.push({ path: snap, label: 'snapshot' });

  const backupRoot = getBackupDir(dataDir);
  for (const b of listBackups(dataDir)) {
    const p = join(backupRoot, b.tier, b.filename);
    if (existsSync(p)) sources.push({ path: p, label: `backup:${b.tier}:${b.createdAt}` });
  }

  return sources;
}
