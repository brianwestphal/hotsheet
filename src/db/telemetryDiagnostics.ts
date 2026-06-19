/**
 * HS-8888 (§85.2.4) — per-table telemetry diagnostic.
 *
 * Confirms which OTLP table dominates a telemetry DB. HS-8882 *suspected* that
 * §68 enhanced-tracing **spans** are the bloat driver but couldn't verify the
 * row distribution without the user's DB, and the §85 span-targeted retention
 * window + ~500k row cap (HS-8890) rely on that assumption. This surfaces the
 * truth two ways:
 *   - a field on `GET /api/telemetry/_debug` (live, active project), and
 *   - a one-line log per telemetry DB, emitted OFF the main loop via the §75
 *     scheduler (`scheduleTelemetryBreakdownLog`) so it can't wedge startup.
 *
 * Counts are **unscoped** (all rows in the DB, not filtered by `project_secret`):
 * the question is what consumes the DB's disk, and under HS-8874 each project has
 * its own DB anyway (so its rows are effectively the project's, modulo any not-
 * yet-migrated foreign rows, which HS-8885 now also clears).
 */
import { readProjectList } from '../project-list.js';
import { type BackgroundScheduler, getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';
import { centralTelemetryDataDir, getTelemetryDb, runWithTelemetryDb } from './connection.js';
import { dirSizeBytes, telemetryDbDir } from './telemetryVacuum.js';

export interface TelemetryTableBreakdown {
  /** The PGLite cluster dir measured (`<dataDir>/db`). */
  dbDir: string;
  /** On-disk size of the whole cluster in bytes (includes the ~38 MB baseline). */
  sizeBytes: number;
  /** Row counts per OTLP table (all rows — the disk-relevant total). */
  rows: { otel_spans: number; otel_metrics: number; otel_events: number };
}

const OTEL_TABLES = ['otel_spans', 'otel_metrics', 'otel_events'] as const;

/**
 * Per-table row counts + on-disk size for one telemetry DB. Self-contained: runs
 * the COUNTs in `dataDir`'s telemetry context and measures `<dataDir>/db`.
 */
export async function telemetryTableBreakdown(dataDir: string): Promise<TelemetryTableBreakdown> {
  const rows = await runWithTelemetryDb(dataDir, async () => {
    const db = await getTelemetryDb();
    const out = { otel_spans: 0, otel_metrics: 0, otel_events: 0 };
    for (const table of OTEL_TABLES) {
      const res = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      out[table] = Number(res.rows[0]?.c ?? 0);
    }
    return out;
  });
  return { dbDir: telemetryDbDir(dataDir), sizeBytes: dirSizeBytes(telemetryDbDir(dataDir)), rows };
}

/** One-line human form: `otel_spans=N otel_metrics=N otel_events=N (X MB on disk)`. */
export function formatTelemetryBreakdown(b: TelemetryTableBreakdown): string {
  const mb = Math.round(b.sizeBytes / (1024 * 1024));
  return `otel_spans=${String(b.rows.otel_spans)} otel_metrics=${String(b.rows.otel_metrics)} otel_events=${String(b.rows.otel_events)} (${String(mb)} MB on disk: ${b.dbDir})`;
}

export interface BreakdownLogOptions {
  /** Inject a scheduler (tests). Defaults to the process-wide singleton. */
  scheduler?: BackgroundScheduler;
  /** Inject the per-dir worker (tests). Defaults to `telemetryTableBreakdown`. */
  breakdown?: (dataDir: string) => Promise<TelemetryTableBreakdown>;
}

/**
 * Log the per-table breakdown for every telemetry DB (the launched project, every
 * registered project, and the central store), one job per DB on the §75 scheduler
 * at GC priority, deferred under event-loop lag. OFF the main loop so it never
 * wedges startup; the DBs were already opened (and cached) by the startup
 * retention sweep, so the COUNTs are cheap. Returns the submit promises (tests
 * await them); the startup caller fire-and-forgets. A DB with no telemetry rows
 * isn't logged (nothing to report).
 */
export function scheduleTelemetryBreakdownLog(launchedDataDir: string, opts: BreakdownLogOptions = {}): Promise<void>[] {
  const scheduler = opts.scheduler ?? getBackgroundScheduler();
  const breakdown = opts.breakdown ?? telemetryTableBreakdown;
  const dirs = new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()]);
  return [...dirs].map(dir => scheduler.submit({
    key: `telemetry-breakdown:${telemetryDbDir(dir)}`,
    projectKey: dir,
    priority: PRIORITY.GC,
    deferUnderLag: true,
    run: async () => {
      try {
        const b = await breakdown(dir);
        const total = b.rows.otel_spans + b.rows.otel_metrics + b.rows.otel_events;
        if (total > 0) console.log(`  Telemetry breakdown: ${formatTelemetryBreakdown(b)}`);
      } catch (err) {
        console.error(`Telemetry breakdown failed for ${telemetryDbDir(dir)}:`, err);
      }
    },
  }));
}
