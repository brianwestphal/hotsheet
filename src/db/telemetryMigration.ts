/**
 * HS-8874 — one-time, NON-DESTRUCTIVE per-project telemetry migration.
 *
 * Before HS-8874 every OTLP row was written to ONE telemetry DB — whatever
 * project the server happened to launch with (`getTelemetryDb()` resolved to
 * `defaultDbPath`). Each row carried a `project_secret`, so a single launch-
 * default DB accumulated rows for EVERY project. HS-8874 moves to per-project
 * ownership: each project's rows live in that project's own `<dataDir>/db`, and
 * rows with no `hotsheet_project` (NULL secret) live in a central store
 * (`~/.hotsheet/telemetry`).
 *
 * This migration relocates the EXISTING rows: for every known project DB it
 * finds rows whose `project_secret` does NOT belong to that DB's own project
 * (they only landed there because it was once the launch default) and COPIES
 * them into the DB of the project that owns them (or central, for NULL-secret
 * rows). It is:
 *   - **non-destructive** — source rows are never deleted (the cross-project
 *     dashboard reads each DB filtered by its own secret, so un-deleted foreign
 *     rows can't double-count);
 *   - **idempotent** — each destination insert is gated by a natural-key
 *     `NOT EXISTS` check, so re-running adds nothing.
 *
 * Runs once at startup (guarded by the `telemetryMigratedV1` flag in
 * `~/.hotsheet/config.json`), sequentially, best-effort: a single unreadable DB
 * is logged and skipped, never aborting the whole pass.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { readProjectList } from '../project-list.js';
import { centralTelemetryDataDir, getDbForDir, getTelemetryDb, runWithTelemetryDb } from './connection.js';

const TELEMETRY_TABLES = ['otel_metrics', 'otel_events', 'otel_spans', 'announcer_usage'] as const;
type TelemetryTable = (typeof TELEMETRY_TABLES)[number];

export interface MigrationResult {
  moved: number;
  perTable: Record<string, number>;
  scannedDbs: number;
}

/** Minimal settings.json shape we need — just the project's own secret. */
const SettingsSecretSchema = z.object({ secret: z.string().optional() }).loose();

/** Read a project's secret from its `<dataDir>/settings.json`, or null. */
function readProjectSecret(dataDir: string): string | null {
  const path = join(dataDir, 'settings.json');
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = SettingsSecretSchema.safeParse(raw);
    if (!parsed.success) return null;
    const secret = parsed.data.secret;
    return typeof secret === 'string' && secret !== '' ? secret : null;
  } catch {
    return null;
  }
}

/**
 * Public entry point. Returns counts; logs a one-line summary. Safe to call on
 * every startup — it self-guards via the `telemetryMigratedV1` config flag.
 */
export async function migratePerProjectTelemetry(): Promise<MigrationResult> {
  const empty: MigrationResult = { moved: 0, perTable: {}, scannedDbs: 0 };
  if (readGlobalConfig().telemetryMigratedV1 === true) return empty;

  const projectDirs = readProjectList();
  // secret → owning project's dataDir. Built from each project's settings.json.
  const secretToDataDir = new Map<string, string>();
  for (const dir of projectDirs) {
    const secret = readProjectSecret(dir);
    if (secret !== null) secretToDataDir.set(secret, dir);
  }

  const perTable: Record<string, number> = {};
  let moved = 0;
  let scannedDbs = 0;

  for (const sourceDir of projectDirs) {
    // A source DB's "own" secret — rows with this secret already live where they
    // belong, so they're skipped.
    const ownSecret = readProjectSecret(sourceDir);
    try {
      const result = await migrateFromSourceDb(sourceDir, ownSecret, secretToDataDir);
      moved += result.moved;
      for (const [t, n] of Object.entries(result.perTable)) perTable[t] = (perTable[t] ?? 0) + n;
      scannedDbs++;
    } catch (err) {
      console.error(`[telemetry-migration] skipping unreadable source DB ${sourceDir}:`, err);
    }
  }

  writeGlobalConfig({ telemetryMigratedV1: true });
  const summary = Object.entries(perTable).map(([t, n]) => `${t}=${String(n)}`).join(' ');
  console.log(`  [telemetry-migration] HS-8874: scanned ${String(scannedDbs)} DB(s), moved ${String(moved)} row(s) to their owning project / central${summary === '' ? '' : ` (${summary})`}.`);
  return { moved, perTable, scannedDbs };
}

/**
 * Scan one source DB for foreign rows (rows whose `project_secret` != the source
 * project's own secret) and copy each into the DB matching its secret (or
 * central for a NULL secret). Returns per-table moved counts.
 */
async function migrateFromSourceDb(
  sourceDir: string,
  ownSecret: string | null,
  secretToDataDir: Map<string, string>,
): Promise<{ moved: number; perTable: Record<string, number> }> {
  const perTable: Record<string, number> = {};
  let moved = 0;

  for (const table of TELEMETRY_TABLES) {
    // Pull the foreign rows out of the source DB.
    const rows = await runWithTelemetryDb(sourceDir, async () => {
      const db = await getTelemetryDb();
      // Foreign = a different secret than the source's own, OR a NULL secret
      // (those belong in central). `IS DISTINCT FROM` is null-safe: a NULL
      // project_secret is DISTINCT FROM any concrete ownSecret, so NULL rows are
      // selected. When ownSecret is null (source has no secret), every row is
      // foreign — fine, they get routed to their true destination below.
      const res = await db.query<Record<string, unknown>>(
        ownSecret === null
          ? `SELECT * FROM ${table}`
          : `SELECT * FROM ${table} WHERE project_secret IS DISTINCT FROM $1`,
        ownSecret === null ? [] : [ownSecret],
      );
      return res.rows;
    });

    for (const row of rows) {
      const secret = typeof row.project_secret === 'string' ? row.project_secret : null;
      const destDir = secret === null
        ? centralTelemetryDataDir()
        : secretToDataDir.get(secret) ?? centralTelemetryDataDir();
      // Don't copy a row back into its own source DB (would only happen for the
      // central edge case where source IS central; the dedupe guard makes it a
      // no-op regardless, but skip the round-trip).
      if (destDir === sourceDir) continue;
      const inserted = await runWithTelemetryDb(destDir, () => insertIfAbsent(table, row));
      if (inserted) { moved++; perTable[table] = (perTable[table] ?? 0) + 1; }
    }
  }

  return { moved, perTable };
}

/**
 * Insert one row into `table` in the CURRENT telemetry-DB context unless a row
 * with the same natural key already exists (idempotency). Returns whether a row
 * was inserted. Dedupe keys (no table has a stable unique business key, so we
 * compose one):
 *   - otel_spans: (trace_id, span_id)
 *   - otel_metrics: (ts, project_secret, metric_name, attributes_json::text, value_json::text)
 *   - otel_events: (ts, project_secret, event_name, body_json::text)
 *   - announcer_usage: (ts, project_secret, model, input_tokens, output_tokens)
 * `id` (SERIAL) is intentionally dropped so the destination assigns its own.
 */
async function insertIfAbsent(table: TelemetryTable, row: Record<string, unknown>): Promise<boolean> {
  const db = await getTelemetryDb();
  const cols = COLUMNS[table];
  // PGLite returns JSONB columns as parsed JS objects; re-inserting through a
  // `::jsonb` cast needs a JSON string (mirrors the writers' `JSON.stringify`).
  const values = cols.map(c => jsonbValue(table, c, row[c]));
  const placeholders = cols.map((_, i) => `$${String(i + 1)}`);
  const valueExprs = cols.map((c, i) => JSONB_COLUMNS[table].includes(c) ? `${placeholders[i]}::jsonb` : placeholders[i]);

  const { whereSql, whereParams } = dedupeWhere(table, row, cols.length);
  const sql = `INSERT INTO ${table} (${cols.join(', ')})
     SELECT ${valueExprs.join(', ')}
     WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${whereSql})`;
  const res = await db.query(sql, [...values, ...whereParams]);
  return (res.affectedRows ?? 0) > 0;
}

/** Normalize a column value for re-insert: JSONB objects → JSON string (the
 *  `::jsonb` cast re-parses); everything else passes through. NULL stays NULL. */
function jsonbValue(table: TelemetryTable, col: string, value: unknown): unknown {
  if (!JSONB_COLUMNS[table].includes(col)) return value ?? null;
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Insert-column lists (excludes the SERIAL `id`). */
const COLUMNS: Record<TelemetryTable, string[]> = {
  otel_metrics: ['ts', 'project_secret', 'session_id', 'metric_name', 'attributes_json', 'value_json', 'aggregation_temporality', 'is_monotonic'],
  otel_events: ['ts', 'project_secret', 'session_id', 'prompt_id', 'event_name', 'attributes_json', 'body_json'],
  otel_spans: ['trace_id', 'span_id', 'parent_span_id', 'project_secret', 'session_id', 'prompt_id', 'span_name', 'start_ts', 'end_ts', 'attributes_json', 'status_code'],
  announcer_usage: ['ts', 'project_secret', 'model', 'input_tokens', 'output_tokens', 'cost'],
};

/** Columns that are JSONB and need a `::jsonb` cast on insert. */
const JSONB_COLUMNS: Record<TelemetryTable, string[]> = {
  otel_metrics: ['attributes_json', 'value_json'],
  otel_events: ['attributes_json', 'body_json'],
  otel_spans: ['attributes_json'],
  announcer_usage: [],
};

/**
 * Build the `NOT EXISTS` dedupe predicate + its params for a row. Placeholder
 * indices start AFTER the insert-value params (which occupy `$1..$baseCount`).
 * Each key column uses `IS NOT DISTINCT FROM` so a NULL on both sides matches
 * (a concrete-value equality would treat NULL=NULL as unknown and let a dup
 * through). JSONB key columns are compared by their `::text` rendering, matching
 * the natural keys documented on `insertIfAbsent`.
 */
function dedupeWhere(
  table: TelemetryTable,
  row: Record<string, unknown>,
  baseCount: number,
): { whereSql: string; whereParams: unknown[] } {
  const keys = DEDUPE_KEYS[table];
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const key of keys) {
    const idx = baseCount + params.length + 1;
    if (JSONB_COLUMNS[table].includes(key)) {
      // Compare the canonical text form on both sides (the stored value and the
      // incoming JSON re-parsed via `::jsonb`).
      params.push(jsonbValue(table, key, row[key]));
      parts.push(`${key}::text IS NOT DISTINCT FROM $${String(idx)}::jsonb::text`);
    } else {
      params.push(row[key] ?? null);
      parts.push(`${key} IS NOT DISTINCT FROM $${String(idx)}`);
    }
  }
  return { whereSql: parts.join(' AND '), whereParams: params };
}

/** Natural-key columns per table (see `insertIfAbsent` doc). */
const DEDUPE_KEYS: Record<TelemetryTable, string[]> = {
  otel_spans: ['trace_id', 'span_id'],
  otel_metrics: ['ts', 'project_secret', 'metric_name', 'attributes_json', 'value_json'],
  otel_events: ['ts', 'project_secret', 'event_name', 'body_json'],
  announcer_usage: ['ts', 'project_secret', 'model', 'input_tokens', 'output_tokens'],
};

/** HS-8874 — exported only so the unit test can open destination DBs the same
 *  way the migration does without re-deriving the helper. NOT part of the public
 *  API. */
export const _testing = { getDbForDir };
