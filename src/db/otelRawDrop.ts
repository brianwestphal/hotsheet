import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { readProjectList } from '../project-list.js';
import { centralTelemetryDataDir, getDbForDir, telemetryClusterDataDir } from './connection.js';

const RAW_TABLES = ['otel_events', 'otel_spans', 'otel_metrics'] as const;

/**
 * HS-9280 — all four rollup/JSONL backfills must be complete (their global-config
 * flags set) before it is safe to drop the raw tables they read. A fresh install
 * with no raw history sets all four `true` on its first (empty) pass — each backfill
 * sets its flag unconditionally after its per-dir loop — so this holds there too.
 */
function allBackfillsComplete(): boolean {
  const c = readGlobalConfig();
  return c.telemetryRollupBackfilledV1 === true
    && c.telemetryActivityRollupBackfilledV1 === true
    && c.telemetryDailySeenBackfilledV1 === true
    && c.telemetryTicketSpanBackfilledV1 === true;
}

/**
 * HS-9280 (epic HS-9226 Phase 3c) — guarded one-shot DROP of the raw telemetry
 * tables (`otel_events` / `otel_spans` / `otel_metrics`) from EVERY project + the
 * central cluster + each main db, once the rollup + JSONL migration is complete.
 *
 * Why here and not `initSchema`: `initSchema` runs on every cluster open — including
 * the opens the startup backfills do — so a DROP there would wipe raw *before* the
 * backfills read it (history loss). This runs ONCE at startup, AFTER the backfills,
 * gated on their four completion flags. `initSchema` no longer CREATEs these tables,
 * so the drop sticks (they are not re-created on the next open).
 *
 * Best-effort per db: one unreadable project never aborts the sweep. The
 * `telemetryRawDroppedV1` once-flag is set only when EVERY db succeeded, so a
 * transient failure retries on the next launch. Idempotent (`DROP TABLE IF EXISTS`).
 * Returns `null` when skipped (backfills not yet complete, or already dropped).
 */
export async function dropRawTelemetryTables(launchedDataDir: string): Promise<{ droppedFrom: number } | null> {
  if (readGlobalConfig().telemetryRawDroppedV1 === true) return null; // already reclaimed
  if (!allBackfillsComplete()) return null;                            // backfills not done → hold

  const dirs = [...new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()])];
  let droppedFrom = 0;
  let allSucceeded = true;
  for (const dir of dirs) {
    // A project has BOTH a main db (`<dir>/db`, from the pre-relocation schema, may
    // still hold raw rows) and a telemetry cluster (`<dir>/telemetry/db`); the
    // central store maps to itself (the Set dedupes that case).
    for (const dbDir of new Set<string>([dir, telemetryClusterDataDir(dir)])) {
      try {
        const db = await getDbForDir(dbDir);
        await db.exec(`DROP TABLE IF EXISTS ${RAW_TABLES.join(', ')};`);
        droppedFrom++;
      } catch (err) {
        allSucceeded = false;
        console.warn(`[telemetry] raw-table drop skipped for ${dbDir}:`, err);
      }
    }
  }
  if (allSucceeded) writeGlobalConfig({ telemetryRawDroppedV1: true });
  return { droppedFrom };
}
