import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, renameSync, rmSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
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

    INSERT INTO settings (key, value) VALUES ('detail_position', 'side') ON CONFLICT DO NOTHING;
    INSERT INTO settings (key, value) VALUES ('detail_width', '360') ON CONFLICT DO NOTHING;
    INSERT INTO settings (key, value) VALUES ('detail_height', '300') ON CONFLICT DO NOTHING;
    INSERT INTO settings (key, value) VALUES ('trash_cleanup_days', '3') ON CONFLICT DO NOTHING;
    INSERT INTO settings (key, value) VALUES ('completed_cleanup_days', '30') ON CONFLICT DO NOTHING;
    INSERT INTO settings (key, value) VALUES ('verified_cleanup_days', '30') ON CONFLICT DO NOTHING;
  `);

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
  `).catch((e: Error) => { if (!e.message.includes('already exists') && !e.message.includes('already')) console.error('Migration error (TIMESTAMPTZ):', e.message); });

  // Migrations for existing databases
  await db.exec(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]';
  `).catch((e: Error) => { if (!e.message.includes('already exists')) console.error('Migration error (columns):', e.message); });
}
