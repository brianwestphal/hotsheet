import { AsyncLocalStorage } from 'node:async_hooks';

import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';

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
    const db = new PGlite(dbPath);
    await db.waitReady;
    await initSchema(db);
    databases.set(dbPath, db);
    return db;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Aborted') || message.includes('RuntimeError')) {
      const corruptPath = `${dbPath}-corrupt-${Date.now()}`;
      console.error(`Database appears to be corrupt. Preserving as ${corruptPath} and recreating...`);
      try {
        renameSync(dbPath, corruptPath);
      } catch {
        try { rmSync(dbPath, { recursive: true, force: true }); } catch { /* may not exist */ }
      }
      const db = new PGlite(dbPath);
      await db.waitReady;
      await initSchema(db);
      databases.set(dbPath, db);
      return db;
    }
    throw err;
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
