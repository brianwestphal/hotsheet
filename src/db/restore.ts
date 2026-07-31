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
import { backupFsFor } from '../backupFs.js';
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
export async function listRestoreSources(dataDir: string): Promise<RestoreSource[]> {
  const sources: RestoreSource[] = [];

  // The snapshot is LOCAL by construction (`<dataDir>/snapshot.tar.gz`), so a
  // sync probe here is fine and — more to the point — must not be gated behind
  // the backup filesystem: an unreachable `backupDir` still leaves the snapshot
  // as a perfectly good restore source, which is the whole reason §73 exists.
  const snap = snapshotPath(dataDir);
  if (existsSync(snap)) sources.push({ path: snap, label: 'snapshot' });

  const backupRoot = getBackupDir(dataDir);
  const bfs = backupFsFor(backupRoot);
  // HS-9527 — an unreachable backup filesystem contributes no sources rather
  // than blocking recovery. `listBackups` already degrades to `[]`.
  for (const b of await listBackups(dataDir)) {
    const p = join(backupRoot, b.tier, b.filename);
    if (await bfs.existsOrUnknown(p)) sources.push({ path: p, label: `backup:${b.tier}:${b.createdAt}` });
  }

  return sources;
}
