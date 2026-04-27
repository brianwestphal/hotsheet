import { type PGlite } from '@electric-sql/pglite';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'fs';
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

/** Hard-coded list of tables to dump. Mirrors `initSchema()` in
 *  `src/db/connection.ts`. Hard-coding (instead of `information_schema`)
 *  keeps the export deterministic across PGLite versions and avoids
 *  picking up internal/system tables. When a new table is added in
 *  `initSchema`, append it here AND bump `SCHEMA_VERSION`. */
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
 *  unlinked on rename failure to avoid leaking. */
export function writeJsonExportAtomically(path: string, exportData: JsonDbExport): void {
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(exportData);
  const gz = gzipSync(json);

  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, gz);
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }

  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may already be gone */ }
    throw err;
  }
}

/** Translate a tarball backup filename to its JSON sibling. Used by both
 *  `createBackup` (to write the sibling) and `pruneBackups` (to delete
 *  it when its tarball gets pruned). */
export function jsonSiblingFilename(tarballFilename: string): string {
  return tarballFilename.replace(/\.tar\.gz$/, '.json.gz');
}
