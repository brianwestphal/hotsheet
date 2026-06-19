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

const TELEMETRY_TABLES = ['otel_metrics', 'otel_events', 'otel_spans', 'announcer_usage', 'ticket_work_intervals'] as const;
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

/** Rows read from a source DB before being routed to a destination. */
type TelemetryRow = Record<string, unknown>;

/** Keyset page size: rows pulled from a source table per round-trip, and the
 *  max rows per batched destination insert. Kept well under PostgreSQL's 65535
 *  bind-parameter ceiling (widest table = otel_spans at 11 cols → 11×300). */
const BATCH = 300;

/** Yield the event loop between batches so a large migration never starves the
 *  already-listening server (the HS-8874 startup wedge). */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve); });
}

/**
 * Public entry point. Returns counts; logs a one-line summary. Safe to call on
 * every startup — it self-guards via the `telemetryMigratedV1` config flag, and
 * resumes per-source-DB via `telemetryMigrationV1DoneDirs` if a prior run was
 * interrupted.
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

  // Resumability: skip source DBs a prior (interrupted) run already drained.
  const doneDirs = new Set(readGlobalConfig().telemetryMigrationV1DoneDirs ?? []);

  const perTable: Record<string, number> = {};
  let moved = 0;
  let scannedDbs = 0;

  for (const sourceDir of projectDirs) {
    if (doneDirs.has(sourceDir)) { scannedDbs++; continue; }
    // A source DB's "own" secret — rows with this secret already live where they
    // belong, so they're skipped.
    const ownSecret = readProjectSecret(sourceDir);
    try {
      const result = await migrateFromSourceDb(sourceDir, ownSecret, secretToDataDir);
      moved += result.moved;
      for (const [t, n] of Object.entries(result.perTable)) perTable[t] = (perTable[t] ?? 0) + n;
      scannedDbs++;
      // Record progress AFTER this DB is fully drained, so a crash/quit before
      // here re-runs it (the dedupe guard makes the re-run a no-op for rows
      // already copied).
      doneDirs.add(sourceDir);
      writeGlobalConfig({ telemetryMigrationV1DoneDirs: [...doneDirs] });
    } catch (err) {
      console.error(`[telemetry-migration] skipping unreadable source DB ${sourceDir}:`, err);
    }
  }

  // Done — set the completion flag and drop the now-redundant progress list.
  writeGlobalConfig({ telemetryMigratedV1: true, telemetryMigrationV1DoneDirs: [] });
  const summary = Object.entries(perTable).map(([t, n]) => `${t}=${String(n)}`).join(' ');
  console.log(`  [telemetry-migration] HS-8874: scanned ${String(scannedDbs)} DB(s), moved ${String(moved)} row(s) to their owning project / central${summary === '' ? '' : ` (${summary})`}.`);
  return { moved, perTable, scannedDbs };
}

/**
 * Scan one source DB for foreign rows (rows whose `project_secret` != the source
 * project's own secret) and copy them into the DB matching each row's secret (or
 * central for a NULL secret). Reads are keyset-paginated and inserts are batched
 * per destination (one statement per page, not per row) so the pass stays
 * O(n log n) against the dedupe indexes instead of the old O(n^2) per-row scan.
 * Returns per-table moved counts.
 */
async function migrateFromSourceDb(
  sourceDir: string,
  ownSecret: string | null,
  secretToDataDir: Map<string, string>,
): Promise<{ moved: number; perTable: Record<string, number> }> {
  const perTable: Record<string, number> = {};
  let moved = 0;

  for (const table of TELEMETRY_TABLES) {
    let lastId = 0;
    for (;;) {
      // Keyset page of foreign rows from the source, ordered by the SERIAL `id`.
      // Foreign = a different secret than the source's own, OR a NULL secret
      // (those belong in central). When ownSecret is null (source has no secret)
      // every row is foreign and routed to its true destination below.
      const rows = await runWithTelemetryDb(sourceDir, async () => {
        const db = await getTelemetryDb();
        const res = await db.query<TelemetryRow>(
          ownSecret === null
            ? `SELECT * FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`
            : `SELECT * FROM ${table} WHERE id > $1 AND project_secret IS DISTINCT FROM $2 ORDER BY id LIMIT $3`,
          ownSecret === null ? [lastId, BATCH] : [lastId, ownSecret, BATCH],
        );
        return res.rows;
      });
      if (rows.length === 0) break;
      lastId = Number(rows[rows.length - 1].id);

      // Group the page by destination DB, then one batched insert per group.
      const byDest = new Map<string, TelemetryRow[]>();
      for (const row of rows) {
        const secret = typeof row.project_secret === 'string' ? row.project_secret : null;
        const destDir = secret === null
          ? centralTelemetryDataDir()
          : secretToDataDir.get(secret) ?? centralTelemetryDataDir();
        // Don't copy a row back into its own source DB.
        if (destDir === sourceDir) continue;
        const bucket = byDest.get(destDir);
        if (bucket === undefined) byDest.set(destDir, [row]);
        else bucket.push(row);
      }

      for (const [destDir, group] of byDest) {
        const inserted = await runWithTelemetryDb(destDir, () => insertBatchIfAbsent(table, group));
        if (inserted > 0) { moved += inserted; perTable[table] = (perTable[table] ?? 0) + inserted; }
      }

      if (rows.length < BATCH) break;
      await yieldToEventLoop();
    }
  }

  return { moved, perTable };
}

/**
 * Batch-insert `rows` into `table` in the CURRENT telemetry-DB context, skipping
 * any row whose natural key already exists there (idempotency). One statement
 * for the whole batch: `INSERT … SELECT … FROM (VALUES …) WHERE NOT EXISTS(…)`.
 * The `NOT EXISTS` probe is index-backed (the `*_dedupe` indexes in
 * connection.ts) because the NOT-NULL scalar key columns are compared with `=`.
 * Intra-batch duplicates (rows with identical natural keys in the same page —
 * the target can't yet contain them, so `NOT EXISTS` wouldn't catch them) are
 * removed in JS first. Returns the number of rows inserted.
 *
 * `id` (SERIAL) is intentionally dropped so the destination assigns its own.
 */
async function insertBatchIfAbsent(table: TelemetryTable, rows: TelemetryRow[]): Promise<number> {
  const unique = dedupeWithinBatch(table, rows);
  if (unique.length === 0) return 0;

  const db = await getTelemetryDb();
  const cols = COLUMNS[table];
  // Every cell is explicitly cast to its column type so the VALUES alias has
  // stable column types (timestamptz / jsonb / etc.) — both for the INSERT and
  // for the `t.col = v.col` dedupe comparisons. PGLite returns JSONB as parsed
  // objects; `jsonbValue` re-stringifies them so the `::jsonb` cast re-parses.
  const params: unknown[] = [];
  const valueRows = unique.map(row => {
    const cells = cols.map(c => {
      params.push(jsonbValue(table, c, row[c]));
      return `$${String(params.length)}::${COLUMN_TYPES[table][c]}`;
    });
    return `(${cells.join(', ')})`;
  });

  const keyMatch = DEDUPE_KEYS[table].map(k => {
    if (k.kind === 'jsonbtext') return `t.${k.col}::text IS NOT DISTINCT FROM v.${k.col}::text`;
    if (k.kind === 'nullsafe') return `t.${k.col} IS NOT DISTINCT FROM v.${k.col}`;
    return `t.${k.col} = v.${k.col}`;
  }).join(' AND ');

  const selectList = cols.map(c => `v.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')})
     SELECT ${selectList} FROM (VALUES ${valueRows.join(', ')}) AS v(${cols.join(', ')})
     WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE ${keyMatch})`;
  const res = await db.query(sql, params);
  return res.affectedRows ?? 0;
}

/** Remove rows that duplicate an earlier row's natural key within the same page
 *  (keep first). The batched `NOT EXISTS` only guards against rows ALREADY in
 *  the target; two identical rows in one page would both pass it. */
function dedupeWithinBatch(table: TelemetryTable, rows: TelemetryRow[]): TelemetryRow[] {
  const seen = new Set<string>();
  const out: TelemetryRow[] = [];
  for (const row of rows) {
    const key = naturalKeyString(table, row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Canonical string form of a row's natural key, for in-JS intra-batch dedupe.
 *  JSONB key columns are compared by their text form; scalars use their JSON
 *  form so types stay distinct (number 0 vs string "0"). */
function naturalKeyString(table: TelemetryTable, row: TelemetryRow): string {
  return DEDUPE_KEYS[table]
    .map(k => {
      const v = row[k.col];
      if (k.kind === 'jsonbtext') return typeof v === 'string' ? v : JSON.stringify(v ?? null);
      return JSON.stringify(v ?? null);
    })
    .join(' ');
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
  ticket_work_intervals: ['project_secret', 'ticket_number', 'started_at', 'ended_at'],
};

/** Columns that are JSONB and need a `::jsonb` cast on insert. */
const JSONB_COLUMNS: Record<TelemetryTable, string[]> = {
  otel_metrics: ['attributes_json', 'value_json'],
  otel_events: ['attributes_json', 'body_json'],
  otel_spans: ['attributes_json'],
  announcer_usage: [],
  ticket_work_intervals: [],
};

/** PostgreSQL type each insert column is cast to in the VALUES list (see
 *  `insertBatchIfAbsent`). Casting every cell keeps the VALUES alias's column
 *  types stable for both the INSERT target and the `t.col = v.col` dedupe. */
const COLUMN_TYPES: Record<TelemetryTable, Record<string, string>> = {
  otel_metrics: { ts: 'timestamptz', project_secret: 'text', session_id: 'text', metric_name: 'text', attributes_json: 'jsonb', value_json: 'jsonb', aggregation_temporality: 'text', is_monotonic: 'boolean' },
  otel_events: { ts: 'timestamptz', project_secret: 'text', session_id: 'text', prompt_id: 'text', event_name: 'text', attributes_json: 'jsonb', body_json: 'jsonb' },
  otel_spans: { trace_id: 'text', span_id: 'text', parent_span_id: 'text', project_secret: 'text', session_id: 'text', prompt_id: 'text', span_name: 'text', start_ts: 'timestamptz', end_ts: 'timestamptz', attributes_json: 'jsonb', status_code: 'text' },
  announcer_usage: { ts: 'timestamptz', project_secret: 'text', model: 'text', input_tokens: 'integer', output_tokens: 'integer', cost: 'numeric' },
  ticket_work_intervals: { project_secret: 'text', ticket_number: 'text', started_at: 'timestamptz', ended_at: 'timestamptz' },
};

/** A natural-key column + how to compare it. `eq` (`=`) is used ONLY for
 *  NOT-NULL scalar columns — these lead the `*_dedupe` indexes so the existence
 *  probe is index-seekable. `nullsafe` (`IS NOT DISTINCT FROM`) is for the
 *  nullable `project_secret`; `jsonbtext` compares JSONB columns by `::text`. */
interface DedupeKey { col: string; kind: 'eq' | 'nullsafe' | 'jsonbtext'; }

/** Natural-key columns per table (no table has a stable unique business key, so
 *  we compose one). Order leads with the index-seekable `eq` columns. */
const DEDUPE_KEYS: Record<TelemetryTable, DedupeKey[]> = {
  otel_spans: [{ col: 'trace_id', kind: 'eq' }, { col: 'span_id', kind: 'eq' }],
  otel_metrics: [
    { col: 'ts', kind: 'eq' }, { col: 'metric_name', kind: 'eq' },
    { col: 'project_secret', kind: 'nullsafe' },
    { col: 'attributes_json', kind: 'jsonbtext' }, { col: 'value_json', kind: 'jsonbtext' },
  ],
  otel_events: [
    { col: 'ts', kind: 'eq' }, { col: 'event_name', kind: 'eq' },
    { col: 'project_secret', kind: 'nullsafe' }, { col: 'body_json', kind: 'jsonbtext' },
  ],
  announcer_usage: [
    { col: 'ts', kind: 'eq' }, { col: 'model', kind: 'eq' },
    { col: 'input_tokens', kind: 'eq' }, { col: 'output_tokens', kind: 'eq' },
    { col: 'project_secret', kind: 'nullsafe' },
  ],
  // A ticket can't open two work intervals at the same instant; (project, ticket,
  // started_at) is a stable natural key for idempotent re-copies. All NOT NULL.
  ticket_work_intervals: [
    { col: 'project_secret', kind: 'eq' }, { col: 'ticket_number', kind: 'eq' },
    { col: 'started_at', kind: 'eq' },
  ],
};

/** HS-8874 — exported only so the unit test can open destination DBs the same
 *  way the migration does without re-deriving the helper. NOT part of the public
 *  API. */
export const _testing = { getDbForDir };
