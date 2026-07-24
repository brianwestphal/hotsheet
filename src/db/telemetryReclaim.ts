/**
 * HS-9427 (docs/127 §127.5) — reclaim EXISTING telemetry `pg_wal` bloat.
 *
 * HS-9426 stops NEW telemetry clusters ballooning their WAL to the default 1 GB,
 * but a cluster created under the old budget keeps it forever — nothing shrinks
 * WAL in place (VACUUM/CHECKPOINT don't; HS-9422/9424). The only reclaim is to
 * rebuild the cluster (`rebuildTelemetryClusterFromDump` in `connection.ts`),
 * which dumps the whole cluster and reloads it under the small budget.
 *
 * This module is the POLICY layer: which clusters, the size threshold, and the
 * honest before/after report. Triggered by the manual "Reclaim telemetry disk"
 * button (Settings → Telemetry; maintainer decision HS-9427 option a) — a rare,
 * user-initiated cleanup, NOT an automatic pass, so a delete-and-rebuild stays
 * opt-in.
 */
import { join } from 'path';

import { closeDbForDir, rebuildTelemetryClusterFromDump, telemetryClusterDataDir } from './connection.js';
import { clusterSizeBreakdown } from './telemetryVacuum.js';

/** Default `pg_wal` size a telemetry cluster must exceed to be worth rebuilding.
 *  256 MB is well above the ~64 MB steady state a HS-9426-tuned cluster settles
 *  to, so a healthy cluster never qualifies — only ones bloated under the old
 *  1 GB budget do. */
export const RECLAIM_WAL_THRESHOLD_BYTES = 256 * 1024 * 1024;

export interface ClusterReclaimResult {
  /** The cluster's telemetry data dir (`…/telemetry` or `~/.hotsheet/telemetry`). */
  clusterDataDir: string;
  /** 'reclaimed' — rebuilt + shrank; 'skipped' — under threshold; 'failed' — rebuild threw. */
  status: 'reclaimed' | 'skipped' | 'failed';
  beforeBytes: number;
  afterBytes: number;
  /** Bytes freed (`before - after`); 0 for skipped/failed. */
  freedBytes: number;
  error?: string;
}

export interface ReclaimOptions {
  /** Override the WAL threshold (tests). */
  thresholdBytes?: number;
  /** The set of telemetry dataDirs to consider. Injected so callers (and tests)
   *  control the scope; production passes every registered project + central. */
  clusterDataDirs: string[];
  /** Rebuild fn seam (tests). */
  rebuild?: (clusterDataDir: string) => Promise<void>;
}

/**
 * Rebuild every telemetry cluster whose `pg_wal` exceeds the threshold. Serial —
 * a dump/rebuild is I/O-heavy and there's no reason to run several at once. Each
 * cluster is independent: one failure is reported and the rest continue.
 */
export async function reclaimBloatedTelemetryClusters(opts: ReclaimOptions): Promise<ClusterReclaimResult[]> {
  const threshold = opts.thresholdBytes ?? RECLAIM_WAL_THRESHOLD_BYTES;
  const rebuild = opts.rebuild ?? rebuildTelemetryClusterFromDump;
  const results: ClusterReclaimResult[] = [];

  for (const clusterDataDir of dedupe(opts.clusterDataDirs)) {
    const dbDir = join(clusterDataDir, 'db');
    const before = clusterSizeBreakdown(dbDir);
    if (before.walBytes <= threshold) {
      results.push({ clusterDataDir, status: 'skipped', beforeBytes: before.totalBytes, afterBytes: before.totalBytes, freedBytes: 0 });
      continue;
    }
    try {
      await rebuild(clusterDataDir);
      // Close the freshly-rebuilt instance too: this pass may open clusters that
      // weren't in use, and leaving them pinned would re-create the HS-9420 leak.
      await closeDbForDir(clusterDataDir);
      const after = clusterSizeBreakdown(dbDir);
      results.push({
        clusterDataDir,
        status: 'reclaimed',
        beforeBytes: before.totalBytes,
        afterBytes: after.totalBytes,
        freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
      });
    } catch (err) {
      results.push({
        clusterDataDir,
        status: 'failed',
        beforeBytes: before.totalBytes,
        afterBytes: before.totalBytes,
        freedBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** Roll the per-cluster results into the totals the API/UI reports. */
export function summarizeReclaim(results: readonly ClusterReclaimResult[]): {
  reclaimed: number; skipped: number; failed: number; freedBytes: number;
} {
  let reclaimed = 0, skipped = 0, failed = 0, freedBytes = 0;
  for (const r of results) {
    if (r.status === 'reclaimed') { reclaimed++; freedBytes += r.freedBytes; }
    else if (r.status === 'skipped') skipped++;
    else failed++;
  }
  return { reclaimed, skipped, failed, freedBytes };
}

/** The telemetry dataDirs for a set of project dataDirs plus the central store. */
export function telemetryDirsForProjects(projectDataDirs: readonly string[], centralDataDir: string): string[] {
  return dedupe([...projectDataDirs.map(d => telemetryClusterDataDir(d)), centralDataDir]);
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
