import { AsyncLocalStorage } from 'node:async_hooks';

import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

/** HS-7893: schema version stamp written into JSON-format backup files.
 *  Bump this manually whenever `initSchema` adds/removes/renames a column,
 *  changes a type, or adds a new table. The JSON co-save is a pure escape
 *  hatch — restoration is manual / scripted — but the version field lets
 *  a reader know whether the rows match today's schema. Start at 1; the
 *  exact value is opaque, only equality with the current code's version
 *  matters. */
export const SCHEMA_VERSION = 1;

/** HS-7899: written into a marker file when `recoverFromOpenFailure`
 *  falls all the way through to the rename-as-corrupt + fresh-cluster
 *  path. The client polls for this on launch so it can prompt the user
 *  to restore from backup instead of silently presenting an empty
 *  Hot Sheet. Persisted (rather than process-local) so the prompt
 *  survives subsequent restarts until the user dismisses or restores. */
export interface DbRecoveryMarker {
  /** Absolute path the live `db/` directory was renamed to. */
  corruptPath: string;
  /** ISO 8601 timestamp of when recovery happened. */
  recoveredAt: string;
  /** Underlying error message that triggered the recovery, for the UI. */
  errorMessage: string;
}

const RECOVERY_MARKER_FILENAME = '.db-recovery-marker.json';

function recoveryMarkerPath(dataDir: string): string {
  return join(dataDir, RECOVERY_MARKER_FILENAME);
}

/** Read the marker file for this dataDir, or null if no recovery has
 *  happened (or the user has already dismissed). Tolerates corrupt /
 *  unreadable marker files by returning null and silently moving on —
 *  the marker is informational, not load-bearing. */
export function readRecoveryMarker(dataDir: string): DbRecoveryMarker | null {
  const path = recoveryMarkerPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Partial<DbRecoveryMarker>;
    if (typeof obj.corruptPath !== 'string') return null;
    if (typeof obj.recoveredAt !== 'string') return null;
    return {
      corruptPath: obj.corruptPath,
      recoveredAt: obj.recoveredAt,
      errorMessage: typeof obj.errorMessage === 'string' ? obj.errorMessage : '',
    };
  } catch {
    return null;
  }
}

function writeRecoveryMarker(dataDir: string, marker: DbRecoveryMarker): void {
  try {
    writeFileSync(recoveryMarkerPath(dataDir), JSON.stringify(marker, null, 2));
  } catch (writeErr: unknown) {
    const writeMessage = writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.error(`Could not write DB recovery marker: ${writeMessage}`);
  }
}

/** Clear the marker. Called when the user dismisses the recovery banner
 *  or successfully restores from backup. Idempotent — missing file is
 *  fine. */
export function clearRecoveryMarker(dataDir: string): void {
  const path = recoveryMarkerPath(dataDir);
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

// Per-dataDir database instances
const databases = new Map<string, PGlite>();

// Legacy singleton state for backward compatibility (tests, single-project mode)
let defaultDbPath: string | null = null;

// Per-request dataDir context — set by server middleware so getDb() returns the correct
// project's database without threading dataDir through every query function.
const requestDataDir = new AsyncLocalStorage<string>();

/** Run a function with a specific dataDir bound to the async context.
 *  All getDb() calls within will use this project's database. */
export function runWithDataDir<T>(dataDir: string, fn: () => T): T {
  return requestDataDir.run(dataDir, fn);
}

/** Get the current data directory from async context or legacy default.
 *  Returns the `.hotsheet/` data directory path (NOT the db/ subdirectory). */
export function getDataDir(): string {
  const contextDataDir = requestDataDir.getStore();
  if (contextDataDir !== undefined) return contextDataDir;
  if (defaultDbPath !== null) return defaultDbPath.replace(/\/db$/, '');
  throw new Error('Data directory not available. Call setDataDir() or use runWithDataDir().');
}

export function setDataDir(dataDir: string) {
  const dbDir = join(dataDir, 'db');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dataDir, 'attachments'), { recursive: true });
  defaultDbPath = dbDir;
}

export async function closeDb(): Promise<void> {
  // Close the default/legacy db
  if (defaultDbPath !== null) {
    const db = databases.get(defaultDbPath);
    if (db) {
      await db.close();
      databases.delete(defaultDbPath);
    }
  }
}

export async function closeDbForDir(dataDir: string): Promise<void> {
  const dbDir = join(dataDir, 'db');
  const db = databases.get(dbDir);
  if (db) {
    await db.close();
    databases.delete(dbDir);
  }
}

export function adoptDb(instance: PGlite): void {
  if (defaultDbPath !== null) {
    databases.set(defaultDbPath, instance);
  }
}

/** Get the database for the current request's project, or the default project. */
export async function getDb(): Promise<PGlite> {
  // Check per-request context first (set by server middleware)
  const contextDataDir = requestDataDir.getStore();
  if (contextDataDir !== undefined) {
    return getDbForDir(contextDataDir);
  }
  // Fall back to default (tests, startup code, single-project mode)
  if (defaultDbPath === null) throw new Error('Data directory not set. Call setDataDir() first.');
  return getDbByPath(defaultDbPath);
}

/** Get or create a database for a specific dataDir. */
export async function getDbForDir(dataDir: string): Promise<PGlite> {
  const dbDir = join(dataDir, 'db');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dataDir, 'attachments'), { recursive: true });

  // If this is the first database and no default is set, make it the default
  if (defaultDbPath === null) {
    defaultDbPath = dbDir;
  }

  return getDbByPath(dbDir);
}

async function getDbByPath(dbPath: string): Promise<PGlite> {
  const existing = databases.get(dbPath);
  if (existing) return existing;

  try {
    return await openAndCacheDb(dbPath);
  } catch (err: unknown) {
    return await recoverFromOpenFailure(dbPath, err);
  }
}

async function openAndCacheDb(dbPath: string): Promise<PGlite> {
  const db = new PGlite(dbPath);
  await db.waitReady;
  await initSchema(db);
  databases.set(dbPath, db);
  return db;
}

async function recoverFromOpenFailure(dbPath: string, err: unknown): Promise<PGlite> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  // Only attempt recovery for the WASM-aborted / runtime-error class that
  // PGLite throws on a bad data dir. Other errors (permission, ENOSPC,
  // schema mismatch, etc.) propagate unchanged. Match on either the
  // message substring (production "Aborted()" case) or the constructor
  // name "RuntimeError" — message-only matching missed the
  // `RuntimeError: unreachable` variant.
  const errName = err instanceof Error ? err.name : '';
  const isRuntimeFailure =
    message.includes('Aborted') || message.includes('RuntimeError') || errName === 'RuntimeError';
  if (!isRuntimeFailure) throw err;

  // HS-7889: surface the underlying error. The previous "appears corrupt"
  // log hid both `err.message` (e.g. "Aborted(). Build with -sASSERTIONS
  // for more info.") and PGLite's PANIC stderr line, so users saw "tickets
  // gone" with zero cause.
  console.error('Failed to open database:', message);
  if (stack !== undefined) console.error(stack);

  // HS-7888 mitigation: a stale postmaster.pid from an unclean shutdown
  // alone can block open even when the data files are healthy. Try
  // removing it and reopening before giving up. Safe because a live
  // instance is already gated by .hotsheet/.lock at the CLI layer.
  if (tryRemoveStalePostmasterPid(dbPath)) {
    try {
      return await openAndCacheDb(dbPath);
    } catch (retryErr: unknown) {
      const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.error('Retry after stale postmaster.pid removal also failed:', retryMessage);
    }
  }

  // Last resort. Preserve the original directory so the user can recover
  // it manually via the disaster-recovery runbook (docs/7-backup-restore.md
  // §7.8: pg_resetwal + loadDataDir). Never auto-delete — the data may be
  // 100% recoverable with out-of-band tools, as proven by the 2026-04-27
  // incident which restored 639/639 tickets.
  const corruptPath = `${dbPath}-corrupt-${Date.now()}`;
  console.error(`Database appears to be corrupt. Preserving as ${corruptPath} and recreating...`);
  try {
    renameSync(dbPath, corruptPath);
  } catch (renameErr: unknown) {
    const renameMessage = renameErr instanceof Error ? renameErr.message : String(renameErr);
    // Previous behavior was to rmSync the live data on rename failure —
    // pure data loss. Surface the original error instead so the user can
    // intervene manually.
    console.error(`Could not preserve corrupt database directory: ${renameMessage}. Aborting auto-recreate to avoid data loss.`);
    throw err;
  }
  // HS-7899: drop a marker the client polls on launch so the user gets
  // prompted to restore from backup instead of seeing a silently empty
  // Hot Sheet. dbPath is `<dataDir>/db`; the marker lives next to other
  // .hotsheet/ state alongside it.
  const dataDir = dbPath.replace(/[\\/]db$/, '');
  writeRecoveryMarker(dataDir, {
    corruptPath,
    recoveredAt: new Date().toISOString(),
    errorMessage: message,
  });
  return await openAndCacheDb(dbPath);
}

function tryRemoveStalePostmasterPid(dbPath: string): boolean {
  const pidPath = join(dbPath, 'postmaster.pid');
  if (!existsSync(pidPath)) return false;
  try {
    rmSync(pidPath, { force: true });
    return true;
  } catch (rmErr: unknown) {
    const rmMessage = rmErr instanceof Error ? rmErr.message : String(rmErr);
    console.error(`Could not remove stale postmaster.pid: ${rmMessage}`);
    return false;
  }
}

async function initSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1;

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'issue',
      priority TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'not_started',
      up_next BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_up_next ON tickets(up_next);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

  `);
  // Default settings are now in settings.json (project settings).
  // The settings table is retained for plugin settings only.

  // Stats snapshots table for historical charts
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stats_snapshots (
      date TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // Command log table for Claude/shell communication history
  await db.exec(`
    CREATE TABLE IF NOT EXISTS command_log (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'system',
      summary TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_command_log_created ON command_log(created_at);
  `);
  // Migrate existing command_log from TIMESTAMP to TIMESTAMPTZ
  // Migrate all timestamp columns to TIMESTAMPTZ for correct timezone handling
  await db.exec(`
    ALTER TABLE tickets ALTER COLUMN created_at TYPE TIMESTAMPTZ;
    ALTER TABLE tickets ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
    ALTER TABLE tickets ALTER COLUMN completed_at TYPE TIMESTAMPTZ;
    ALTER TABLE tickets ALTER COLUMN deleted_at TYPE TIMESTAMPTZ;
    ALTER TABLE attachments ALTER COLUMN created_at TYPE TIMESTAMPTZ;
    ALTER TABLE command_log ALTER COLUMN created_at TYPE TIMESTAMPTZ;
  `).catch((e: unknown) => { if (e instanceof Error && !e.message.includes('already exists') && !e.message.includes('already')) console.error('Migration error (TIMESTAMPTZ):', e.message); });

  // Migrations for existing databases
  await db.exec(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
  `).catch((e: unknown) => { if (e instanceof Error && !e.message.includes('already exists')) console.error('Migration error (columns):', e.message); });

  // Plugin sync tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_sync (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      remote_updated_at TIMESTAMPTZ,
      local_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sync_status TEXT NOT NULL DEFAULT 'synced',
      conflict_data TEXT,
      UNIQUE(ticket_id, plugin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_sync_plugin ON ticket_sync(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_sync_status ON ticket_sync(sync_status);
    CREATE INDEX IF NOT EXISTS idx_ticket_sync_remote ON ticket_sync(plugin_id, remote_id);

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      field_changes TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_plugin ON sync_outbox(plugin_id);

    CREATE TABLE IF NOT EXISTS note_sync (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      remote_comment_id TEXT NOT NULL,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(ticket_id, note_id, plugin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_note_sync_ticket ON note_sync(ticket_id, plugin_id);
    -- HS-5056: last_synced_text enables three-way edit/delete detection for notes.
    -- Without it we can only tell if a note is new — we can't tell which side edited it.
    ALTER TABLE note_sync ADD COLUMN IF NOT EXISTS last_synced_text TEXT;

    -- HS-7599: feedback drafts. A user-saved partial response to a FEEDBACK
    -- NEEDED note that the user wants to come back to later. Drafts live in
    -- their own table, NOT in tickets.notes, so they don't sync to GitHub /
    -- other plugin backends (drafts are local-only). parent_note_id links
    -- a draft to the FEEDBACK NEEDED note that prompted it; nulled when the
    -- parent note is deleted but the draft itself is preserved as
    -- free-floating per the §21 lifecycle rule. prompt_text is a snapshot
    -- of the original feedback prompt at save-time so the click-to-reopen
    -- flow can reconstruct the dialog even after the parent note is gone
    -- or its prefix has cleared. partitions_json stores the block structure
    -- + inline responses + catch-all verbatim (see §21.2.3 for the saved
    -- shape) so future changes to parseFeedbackBlocks heuristics do not
    -- reshape an existing draft when it is re-opened.
    CREATE TABLE IF NOT EXISTS feedback_drafts (
      id TEXT PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      parent_note_id TEXT,
      prompt_text TEXT NOT NULL DEFAULT '',
      partitions_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_drafts_ticket ON feedback_drafts(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_drafts_parent_note ON feedback_drafts(parent_note_id);
  `);

  // Migration: ensure all existing notes have stable persisted IDs
  await migrateNoteIds(db);
}

async function migrateNoteIds(db: PGlite): Promise<void> {
  const result = await db.query<{ id: number; notes: string }>(
    "SELECT id, notes FROM tickets WHERE notes != '' AND notes != '[]'"
  );
  let noteCounter = 0;
  for (const row of result.rows) {
    try {
      const parsed: unknown = JSON.parse(row.notes);
      if (!Array.isArray(parsed)) continue;
      let changed = false;
      for (const note of parsed as { id?: string }[]) {
        if (note.id == null || note.id === '') {
          note.id = `n_${Date.now().toString(36)}_${(noteCounter++).toString(36)}`;
          changed = true;
        }
      }
      if (changed) {
        await db.query('UPDATE tickets SET notes = $1 WHERE id = $2', [JSON.stringify(parsed), row.id]);
      }
    } catch { /* skip malformed notes */ }
  }
}
