import { type PGlite } from '@electric-sql/pglite';
import { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import { gzipSync } from 'zlib';

import { SCHEMA_VERSION } from './db/connection.js';

/** HS-7893: a versioned, human/AI-readable snapshot of every row in every
 *  Hot Sheet table. Co-saved alongside the PGLite tarball at backup time
 *  as `backup-<ts>.json.gz`. **Not** wired into the restore UI — purely an
 *  escape hatch when a tarball won't open (see `docs/41-backup-json-cosave.md`).
 *  Attachment file blobs are NOT included; only the row paths in the
 *  `attachments` table. Tracked for proper attachment backups in a
 *  follow-up ticket. */
export interface JsonDbExport {
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/** Hard-coded list of the DURABLE tables to dump (a subset of `initSchema()`
 *  in `src/db/connection.ts`). The raw `otel_*` telemetry tables are
 *  intentionally excluded — telemetry is a separate disposable dataset (see
 *  docs §67 / §72.8), and as of HS-9230 it lives in a different cluster anyway.
 *  The compact `otel_rollup_*` tables (HS-9232) ARE included — they're durable,
 *  small, and the per-ticket cost rollup is kept indefinitely, so it belongs in
 *  the rescue payload. Hard-coding (instead of `information_schema`) keeps the
 *  export deterministic across PGLite versions and avoids picking up
 *  internal/system tables. When a new DURABLE table is added in `initSchema`,
 *  append it here AND bump `SCHEMA_VERSION` (leave the raw `otel_*` tables out). */
const TABLES = [
  'tickets',
  'attachments',
  'settings',
  'stats_snapshots',
  'command_log',
  'ticket_sync',
  'sync_outbox',
  'note_sync',
  'feedback_drafts',
  'otel_rollup_daily',   // HS-9232 — compact daily telemetry rollup (durable, snapshotted)
  'otel_rollup_ticket',  // HS-9232 — per-ticket cost rollup, kept indefinitely
  'otel_daily_seen',     // HS-9243 — daily distinct prompt/session dedup set (durable, snapshotted)
  'otel_ticket_prompt_span', // HS-9243 — per-ticket prompt-duration spans (durable, snapshotted)
  'otel_rollup_activity', // HS-9279 — daily tool/hour/tool-latency rollups (durable, snapshotted)
  'otel_hourly_seen', // HS-9279 — per-(day,hour) distinct-prompt dedup for the heatmap (durable, snapshotted)
] as const;

/** Read every row of every Hot Sheet table into a serialisable shape.
 *  Missing tables (e.g. on a partially-migrated DB) yield `[]` rather
 *  than throwing — the export should always be writable so the rescue
 *  path stays available even when the schema is in flux. */
export async function buildJsonExport(db: PGlite): Promise<JsonDbExport> {
  const tables: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    try {
      const result = await db.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
      tables[table] = result.rows;
    } catch {
      tables[table] = [];
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

/** Serialise `exportData` to gzipped JSON, then write it to `path`
 *  atomically: write to `<path>.tmp`, fsync, rename. Rename is the only
 *  atomic step in POSIX, so a crash mid-write leaves either the previous
 *  file (or nothing) at `path` — never a partial file. The .tmp is
 *  unlinked on rename failure to avoid leaking.
 *
 *  HS-8178 — async via `fs.promises` so the fsync runs on libuv's
 *  threadpool instead of blocking the main event loop. The user's
 *  `backupDir` points at Google Drive (`~/Library/CloudStorage/...`)
 *  where macOS can stall fsync for tens of seconds while the file-
 *  provider sync agent spins up; on the main thread that froze every
 *  WS message + PGLite query + HTTP route until fsync returned. */
export async function writeJsonExportAtomically(path: string, exportData: JsonDbExport): Promise<void> {
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(exportData);
  const gz = gzipSync(json);

  // open + write + sync + close in one async chain. `fileHandle.sync()`
  // is the Promise-flavoured `fsyncSync` — runs on the libuv threadpool.
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.write(gz);
    await handle.sync();
  } finally {
    if (handle !== null) {
      try { await handle.close(); } catch { /* swallow — close error doesn't invalidate the write */ }
    }
  }

  try {
    await fsp.rename(tmp, path);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* tmp may already be gone */ }
    throw err;
  }
}

/** Translate a tarball backup filename to its JSON sibling. Used by both
 *  `createBackup` (to write the sibling) and `pruneBackups` (to delete
 *  it when its tarball gets pruned). */
export function jsonSiblingFilename(tarballFilename: string): string {
  return tarballFilename.replace(/\.tar\.gz$/, '.json.gz');
}
