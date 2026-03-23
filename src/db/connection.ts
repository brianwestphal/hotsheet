import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

let db: PGlite | null = null;
let currentDbPath: string | null = null;

export function setDataDir(dataDir: string) {
  const dbDir = join(dataDir, 'db');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dataDir, 'attachments'), { recursive: true });
  currentDbPath = dbDir;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

export function adoptDb(instance: PGlite): void {
  db = instance;
}

export async function getDb(): Promise<PGlite> {
  if (db !== null) return db;
  if (currentDbPath === null) throw new Error('Data directory not set. Call setDataDir() first.');
  try {
    db = new PGlite(currentDbPath);
    await db.waitReady;
    await initSchema(db);
    return db;
  } catch (err: unknown) {
    db = null;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Aborted') || message.includes('RuntimeError')) {
      console.error('Database appears to be corrupt. Recreating...');
      console.error('(Previous ticket data will be lost.)');
      try {
        rmSync(currentDbPath, { recursive: true, force: true });
      } catch { /* may not exist */ }
      db = new PGlite(currentDbPath);
      await db.waitReady;
      await initSchema(db);
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
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      deleted_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
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

  // Migrations for existing databases
  await db.exec(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]';
  `).catch(() => { /* columns may already exist */ });
}
