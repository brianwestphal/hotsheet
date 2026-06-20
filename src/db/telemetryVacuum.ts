/**
 * HS-8884 — reclaim telemetry-DB disk after deletes.
 *
 * PGLite (embedded Postgres) does NOT return disk to the OS when rows are
 * deleted: the §67.6 retention sweep (`cleanup.ts`) and the HS-8885 migration
 * source-delete both only `DELETE`, so dead tuples pile up in the relation files
 * and a telemetry DB that once grew to hundreds of MB stays that big forever
 * (the HS-8882 bloat: a 409MB `db/base/...` file long after its rows aged out).
 * The fix is a `VACUUM` pass:
 *   - **plain `VACUUM`** — reuses dead-tuple space for future inserts (bounds
 *     growth). Cheap, takes no exclusive lock. The routine path.
 *   - **`VACUUM FULL`** — rewrites the table and actually shrinks the files back
 *     to the OS. This is what recovers the EXISTING bloat, but it takes an
 *     exclusive lock and on a big DB can block for seconds-to-minutes, so it is
 *     **size-gated + throttled** and only ever runs OFF the main event loop via
 *     the §75 background scheduler (running it synchronously at startup is the
 *     exact HS-8874 wedge class `diagnostics/watchdog.ts` now SIGKILLs).
 *
 * This module owns the decision + execution; `scheduleTelemetryMaintenance`
 * fans one job per telemetry DB onto the scheduler at GC priority, deferred
 * under load, serialized as one exclusive group so two heavy reclaims never
 * thrash the disk at once.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { readProjectList } from '../project-list.js';
import { type BackgroundScheduler, getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';
import { centralTelemetryDataDir, getTelemetryDb, runWithTelemetryDb } from './connection.js';

/** Below this the DB is small enough that bloat doesn't matter — skip entirely.
 *  An EMPTY PGLite cluster is already ~38 MB on disk (the Postgres system
 *  catalogs), so this sits comfortably above that baseline: a DB this big has a
 *  meaningful amount of telemetry / dead tuples on top of the cluster overhead. */
export const PLAIN_VACUUM_MIN_BYTES = 64 * 1024 * 1024; // 64 MB
/** A `VACUUM FULL` (file-shrinking, exclusive-lock) reclaim only kicks in once a
 *  DB is meaningfully bloated. Below this, plain VACUUM (reuse) is enough. The
 *  HS-8882 report saw 214–409 MB telemetry DBs, all caught by this gate. */
export const FULL_VACUUM_MIN_BYTES = 150 * 1024 * 1024; // 150 MB
/** The heavy full reclaim runs at most this often per DB (it's expensive + holds
 *  an exclusive lock). Between full runs, plain VACUUM keeps growth in check. */
export const FULL_VACUUM_THROTTLE_DAYS = 7;
const FULL_VACUUM_THROTTLE_MS = FULL_VACUUM_THROTTLE_DAYS * 24 * 60 * 60 * 1000;

export type VacuumMode = 'none' | 'plain' | 'full';

/**
 * HS-8897 — does this error look like PGLite's `VACUUM FULL` catalog
 * unique-violation? On some telemetry clusters `VACUUM FULL` fails while
 * rewriting a relation, with Postgres error `23505` on `pg_class`'s
 * `(relname, relnamespace)` unique index (`duplicate key … pg_class_relname_nsp_index`,
 * e.g. `idx_command_log_created` "already exists"). It's a known PGLite
 * limitation — plain `VACUUM` (which never rewrites the catalog) is unaffected —
 * so we treat it as a soft, expected failure rather than an alarming error.
 *
 * Pure + exported for unit testing. Matches on the SQLSTATE + constraint name,
 * with a message-text fallback for error shapes that only surface `.message`.
 */
export function isVacuumFullCatalogError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  // `as Record<string,unknown>` only to read optional fields off an unknown
  // error; every access is type-guarded below, so no unchecked assumption ships.
  const rec = err as Record<string, unknown>;
  const code = typeof rec.code === 'string' ? rec.code : '';
  const constraint = typeof rec.constraint === 'string' ? rec.constraint : '';
  const message = typeof rec.message === 'string' ? rec.message : '';
  if (code === '23505' && constraint.startsWith('pg_class')) return true;
  return /duplicate key value violates unique constraint "pg_class/.test(message);
}

export interface VacuumExecResult {
  /** The mode that actually completed (`'full'` may degrade to `'plain'`). */
  ranMode: 'plain' | 'full';
  /** Whether a `VACUUM FULL` was attempted (true even when it degraded). Drives
   *  the throttle stamp so a degrading DB backs off future FULL retries. */
  fullAttempted: boolean;
}

/**
 * HS-8897 — run the chosen VACUUM against an injected `exec`, degrading a failing
 * `VACUUM FULL` to a plain `VACUUM` when the failure is the known PGLite
 * `pg_class` catalog limitation (see {@link isVacuumFullCatalogError}). Any other
 * failure propagates. Pure but for `exec`/logging, so it unit-tests without a
 * real cluster.
 */
export async function performVacuum(
  exec: (sql: string) => Promise<void>,
  mode: 'plain' | 'full',
): Promise<VacuumExecResult> {
  if (mode === 'plain') {
    await exec('VACUUM');
    return { ranMode: 'plain', fullAttempted: false };
  }
  try {
    await exec('VACUUM FULL');
    return { ranMode: 'full', fullAttempted: true };
  } catch (err) {
    if (!isVacuumFullCatalogError(err)) throw err;
    console.warn(
      '  Telemetry VACUUM FULL unsupported on this cluster (PGLite pg_class catalog limitation) — falling back to plain VACUUM and backing off full retries.',
    );
    await exec('VACUUM');
    return { ranMode: 'plain', fullAttempted: true };
  }
}

export interface VacuumThresholds {
  plainMinBytes?: number;
  fullMinBytes?: number;
  throttleMs?: number;
}

/**
 * Pure policy: given a DB's on-disk size, when it was last full-vacuumed, and
 * the current time, decide whether to do nothing, a plain VACUUM, or a full
 * reclaim. Exported for unit testing — all the branching lives here so the
 * effectful `maintainTelemetryDb` stays a thin wrapper.
 */
export function decideVacuumMode(
  sizeBytes: number,
  lastFullAtMs: number | null,
  nowMs: number,
  thresholds: VacuumThresholds = {},
): VacuumMode {
  const plainMin = thresholds.plainMinBytes ?? PLAIN_VACUUM_MIN_BYTES;
  const fullMin = thresholds.fullMinBytes ?? FULL_VACUUM_MIN_BYTES;
  const throttleMs = thresholds.throttleMs ?? FULL_VACUUM_THROTTLE_MS;

  if (sizeBytes < plainMin) return 'none';
  const throttleElapsed = lastFullAtMs === null || nowMs - lastFullAtMs >= throttleMs;
  if (sizeBytes >= fullMin && throttleElapsed) return 'full';
  return 'plain';
}

/** A telemetry DB's PGLite cluster directory (`<dataDir>/db`). */
export function telemetryDbDir(dataDir: string): string {
  return join(dataDir, 'db');
}

/** Recursive on-disk size (bytes) of a directory. Best-effort: an unreadable
 *  entry contributes 0 rather than throwing, so a transient fs error can't abort
 *  the maintenance pass. Returns 0 when the dir doesn't exist. */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    if (!existsSync(dir)) return 0;
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) total += dirSizeBytes(p);
      else total += st.size;
    } catch {
      /* vanished mid-walk / permission — skip */
    }
  }
  return total;
}

function lastFullVacuumAtMs(dbDir: string): number | null {
  const map = readGlobalConfig().telemetryVacuumFullAt;
  const iso = map?.[dbDir];
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export interface MaintainOptions extends VacuumThresholds {
  /** Injectable clock (defaults to `Date.now`) so tests control throttling. */
  now?: () => number;
  /** HS-8884 — force a `VACUUM FULL` regardless of size/throttle. Used by the
   *  §74 "Clear telemetry data" flow: the user explicitly asked to reclaim, so
   *  shrink the files now even if the DB is below the routine reclaim threshold
   *  or was full-vacuumed recently. */
  force?: boolean;
}

export interface MaintainResult {
  mode: VacuumMode;
  sizeBytes: number;
}

/**
 * Run the appropriate VACUUM (if any) for one telemetry DB. Computes the on-disk
 * size WITHOUT opening the cluster, so a small/cold DB returns `'none'` cheaply
 * and never instantiates PGLite. Only when a VACUUM is warranted does it open
 * the DB (in `dataDir`'s telemetry context) and run it. A full reclaim stamps
 * `telemetryVacuumFullAt[dbDir]` so the throttle holds across restarts.
 *
 * Best-effort: any failure (open error, VACUUM error) is logged and swallowed —
 * disk reclaim is a maintenance nicety, never a reason to disturb the app.
 */
export async function maintainTelemetryDb(dataDir: string, opts: MaintainOptions = {}): Promise<MaintainResult> {
  const now = opts.now ?? (() => Date.now());
  const dbDir = telemetryDbDir(dataDir);
  const sizeBytes = dirSizeBytes(dbDir);
  const mode: VacuumMode = opts.force === true
    ? 'full'
    : decideVacuumMode(sizeBytes, lastFullVacuumAtMs(dbDir), now(), opts);
  if (mode === 'none') return { mode, sizeBytes };

  let ranMode: VacuumMode = mode;
  let fullAttempted = false;
  try {
    // Return the result OUT of the DB context (rather than mutating closure vars)
    // so the post-context `if (fullAttempted)` keeps its real `boolean` type.
    const result = await runWithTelemetryDb(dataDir, async () => {
      const db = await getTelemetryDb();
      // VACUUM can't run inside a transaction block — `exec` issues it as a bare
      // statement (PGLite autocommits each). HS-8897 — `performVacuum` degrades a
      // PGLite-catalog-limited VACUUM FULL to a plain VACUUM instead of throwing.
      return performVacuum(async (sql) => { await db.exec(sql); }, mode);
    });
    ranMode = result.ranMode;
    fullAttempted = result.fullAttempted;
    // Stamp the throttle whenever a FULL was attempted — on success it records
    // the last reclaim; on a degraded fallback (HS-8897) it backs off future
    // FULL retries so a known-unsupported cluster doesn't re-attempt (and re-warn)
    // on every maintenance pass, only once per throttle window.
    if (fullAttempted) {
      const map = { ...(readGlobalConfig().telemetryVacuumFullAt ?? {}) };
      map[dbDir] = new Date(now()).toISOString();
      writeGlobalConfig({ telemetryVacuumFullAt: map });
    }
    console.log(`  Telemetry VACUUM${ranMode === 'full' ? ' FULL' : ''}: reclaimed ${dbDir} (was ${String(Math.round(sizeBytes / (1024 * 1024)))} MB).`);
  } catch (err) {
    console.error(`Telemetry VACUUM (${mode}) failed for ${dbDir}:`, err);
    return { mode: 'none', sizeBytes };
  }
  return { mode: ranMode, sizeBytes };
}

export interface ScheduleOptions {
  /** Inject a scheduler (tests). Defaults to the process-wide singleton. */
  scheduler?: BackgroundScheduler;
  /** Inject the per-dir worker (tests). Defaults to `maintainTelemetryDb`. */
  maintain?: (dataDir: string) => Promise<unknown>;
}

/**
 * Submit one telemetry-VACUUM job per telemetry DB (the launched project, every
 * registered project, and the central store) onto the §75 background scheduler.
 * Returns the submit promises so a caller can await completion (tests); the
 * startup caller fire-and-forgets. Each job is GC priority, deferred under
 * event-loop lag, and in a single `exclusiveGroup` so heavy reclaims serialize.
 */
export function scheduleTelemetryMaintenance(launchedDataDir: string, opts: ScheduleOptions = {}): Promise<void>[] {
  const scheduler = opts.scheduler ?? getBackgroundScheduler();
  const maintain = opts.maintain ?? ((dir: string) => maintainTelemetryDb(dir));
  const dirs = new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()]);
  return [...dirs].map(dir => scheduler.submit({
    key: `telemetry-vacuum:${telemetryDbDir(dir)}`,
    projectKey: dir,
    priority: PRIORITY.GC,
    deferUnderLag: true,
    exclusiveGroup: 'telemetry-vacuum',
    run: async () => { await maintain(dir); },
  }));
}

/**
 * HS-8884 / §74 — schedule an immediate FULL reclaim of ONE telemetry DB after
 * the user clears its data ("Clear telemetry data"). Off-loop via the scheduler
 * (so the request returns at once and a big rewrite can't wedge the loop) but
 * NOT deferred under lag — the user explicitly asked, so it should run. Shares
 * the `telemetry-vacuum` exclusive group + key, so it coalesces with / serializes
 * against the routine maintenance pass. Returns the submit promise (awaitable in
 * tests).
 */
export function scheduleTelemetryReclaim(dataDir: string, opts: ScheduleOptions = {}): Promise<void> {
  const scheduler = opts.scheduler ?? getBackgroundScheduler();
  const maintain = opts.maintain ?? ((dir: string) => maintainTelemetryDb(dir, { force: true }));
  return scheduler.submit({
    key: `telemetry-vacuum:${telemetryDbDir(dataDir)}`,
    projectKey: dataDir,
    priority: PRIORITY.GC,
    deferUnderLag: false,
    exclusiveGroup: 'telemetry-vacuum',
    run: async () => { await maintain(dataDir); },
  });
}
