/**
 * HS-9536 — report backup roots that a `backupDir` change left behind.
 *
 * The capture and the safety classification are HS-9532 (`backupDirChange.ts`).
 * This is the read side: take the remembered roots, keep only the ones that are
 * genuinely stranded, and measure them.
 *
 * ## Two rules this module exists to enforce
 *
 * **1. Only `disjoint` is reportable.** The old and new roots can overlap, and
 * both directions mislead: if the new root is INSIDE the old one, the "abandoned"
 * tree contains the live backups; if the old is inside the new, it was never
 * abandoned at all. `isOrphanedRelation` is the gate, and anything it rejects is
 * silently dropped rather than shown with a caveat — a caveat next to a path is
 * an invitation to act on it anyway.
 *
 * **2. Every filesystem touch goes through `backupFs`.** An abandoned root is
 * *more* likely than the live one to be an unreachable cloud folder or an
 * unplugged drive — that is frequently why it was abandoned. Sizing it with plain
 * `fs` is the HS-9527 wedge with a new name. A root we cannot measure is a root
 * we say nothing about.
 *
 * Note that `telemetryVacuum.ts::dirSizeBytes` is deliberately NOT reused: it is
 * synchronous, which is fine against a local telemetry cluster and a wedge
 * against Google Drive.
 */

import { join } from 'path';

import { classifyDirChange, isOrphanedRelation } from './backupDirChange.js';
import { backupFsFor, tolerateOutage } from './backupFs.js';

/** One abandoned root, with enough context for a user to decide what to do. */
export interface StrandedBackupRoot {
  /** The old `backupDir`, as recorded. */
  path: string;
  /** Total bytes under it, or `null` when the filesystem would not answer. */
  sizeBytes: number | null;
  /** ISO timestamp of the newest backup found, or `null` if none/unreadable. */
  newestBackupAt: string | null;
  /** How many tier directories still hold tarballs. */
  tierCount: number;
}

/** The tier layout a backup root is expected to have. */
const TIERS = ['5min', 'hourly', 'daily'] as const;

/**
 * Measure one root. Never throws: an unreachable filesystem yields nulls, which
 * the caller renders as "size unknown" rather than dropping the entry — the path
 * itself is still the useful part.
 */
export async function measureRoot(root: string): Promise<Omit<StrandedBackupRoot, 'path'>> {
  const bfs = backupFsFor(root);
  // Explicit type argument: at the `return` below, control-flow narrowing has
  // already proved `sizeBytes` is a `number`, so inference would pick a T too
  // narrow to accept the null fallback.
  return tolerateOutage<Omit<StrandedBackupRoot, 'path'>>(async () => {
    let sizeBytes: number | null = 0;
    let newestMs: number | null = null;
    let tierCount = 0;
    for (const tier of TIERS) {
      const dir = join(root, tier);
      const files = (await bfs.readdirOrEmpty(dir)).filter(f => f.endsWith('.tar.gz'));
      if (files.length === 0) continue;
      tierCount += 1;
      for (const file of files) {
        // Per-file `stat` is deliberately tolerated individually: one vanished
        // file mid-scan must not discard the whole measurement.
        const stat = await tolerateOutage(() => bfs.stat(join(dir, file)), null);
        if (stat === null) continue;
        sizeBytes += stat.size;
        const mtime = stat.mtimeMs;
        if (newestMs === null || mtime > newestMs) newestMs = mtime;
      }
    }
    return {
      sizeBytes,
      newestBackupAt: newestMs === null ? null : new Date(newestMs).toISOString(),
      tierCount,
    };
  }, { sizeBytes: null, newestBackupAt: null, tierCount: 0 });
}

export interface FindStrandedDeps {
  /** Injected for tests. Defaults to the real classifier. */
  classify?: (oldDir: string, newDir: string) => Promise<string>;
  /** Injected for tests. Defaults to the real measurement. */
  measure?: (root: string) => Promise<Omit<StrandedBackupRoot, 'path'>>;
}

/**
 * Which of the remembered roots are genuinely stranded, and how big are they.
 *
 * Returns `[]` when there is no current `backupDir` — with nothing to compare
 * against, no relation can be established, and the rule is that only a proven
 * `disjoint` is reportable.
 *
 * Roots holding no tarballs are dropped: an empty directory is not something to
 * tell a user about, and after a manual cleanup it is exactly what remains.
 */
export async function findStrandedBackupRoots(
  previousDirs: readonly string[],
  currentDir: string | undefined,
  deps: FindStrandedDeps = {},
): Promise<StrandedBackupRoot[]> {
  if (currentDir === undefined || currentDir.trim() === '') return [];
  const classify = deps.classify ?? ((a: string, b: string) => classifyDirChange(a, b));
  const measure = deps.measure ?? measureRoot;

  const out: StrandedBackupRoot[] = [];
  for (const path of previousDirs) {
    const relation = await classify(path, currentDir);
    if (!isOrphanedRelation(relation as never)) continue;
    const measured = await measure(path);
    // Nothing left there — a cleaned-up root, or one that never held backups.
    if (measured.tierCount === 0) continue;
    out.push({ path, ...measured });
  }
  return out;
}
