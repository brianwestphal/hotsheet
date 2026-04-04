import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import { closeDb, getDb, setDataDir } from './db/connection.js';
import { getBackupDir } from './file-settings.js';

interface BackupInfo {
  tier: '5min' | 'hourly' | 'daily';
  filename: string;
  createdAt: string;
  ticketCount: number;
  sizeBytes: number;
}

const TIERS = {
  '5min': { intervalMs: 5 * 60 * 1000, maxAge: 60 * 60 * 1000, maxCount: 12 },
  'hourly': { intervalMs: 60 * 60 * 1000, maxAge: 12 * 60 * 60 * 1000, maxCount: 12 },
  'daily': { intervalMs: 24 * 60 * 60 * 1000, maxAge: 7 * 24 * 60 * 60 * 1000, maxCount: 7 },
} as const;

type Tier = keyof typeof TIERS;

// Per-dataDir backup state
interface BackupState {
  backupInProgress: boolean;
  fiveMinTimer: ReturnType<typeof setTimeout> | null;
  hourlyInterval: ReturnType<typeof setInterval> | null;
  dailyInterval: ReturnType<typeof setInterval> | null;
}

const backupStates = new Map<string, BackupState>();

function getOrCreateState(dataDir: string): BackupState {
  let state = backupStates.get(dataDir);
  if (!state) {
    state = { backupInProgress: false, fiveMinTimer: null, hourlyInterval: null, dailyInterval: null };
    backupStates.set(dataDir, state);
  }
  return state;
}

let previewDb: PGlite | null = null;
let currentDataDir: string | null = null;

function backupsDir(dataDir: string): string {
  return getBackupDir(dataDir);
}

function tierDir(dataDir: string, tier: Tier): string {
  return join(backupsDir(dataDir), tier);
}


function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

function parseTimestamp(filename: string): Date | null {
  // Filename: backup-2026-03-12T23-27-37Z.tar.gz
  // Need to restore: 2026-03-12T23:27:37Z
  const match = filename.match(/^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.tar\.gz$/);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export async function createBackup(dataDir: string, tier: Tier): Promise<BackupInfo | null> {
  const state = getOrCreateState(dataDir);
  if (state.backupInProgress) return null;
  state.backupInProgress = true;

  try {
    const db = await getDb();
    const dir = tierDir(dataDir, tier);
    mkdirSync(dir, { recursive: true });

    const blob = await db.dumpDataDir('gzip');
    const buffer = Buffer.from(await blob.arrayBuffer());

    const now = new Date();
    const filename = `backup-${formatTimestamp(now)}.tar.gz`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, buffer);

    // Get ticket count for metadata
    let ticketCount = 0;
    try {
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM tickets WHERE status != 'deleted'`);
      ticketCount = parseInt(result.rows[0]?.count || '0', 10);
    } catch { /* schema might not exist yet */ }

    const info: BackupInfo = {
      tier,
      filename,
      createdAt: now.toISOString(),
      ticketCount,
      sizeBytes: buffer.length,
    };

    pruneBackups(dataDir, tier);
    return info;
  } catch (err) {
    console.error(`Backup failed (${tier}):`, err);
    return null;
  } finally {
    state.backupInProgress = false;
  }
}

function pruneBackups(dataDir: string, tier: Tier): void {
  const dir = tierDir(dataDir, tier);
  if (!existsSync(dir)) return;

  const config = TIERS[tier];
  const cutoff = Date.now() - config.maxAge;

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.tar.gz'))
    .map(f => ({ filename: f, date: parseTimestamp(f) }))
    .filter((f): f is { filename: string; date: Date } => f.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  for (let i = 0; i < files.length; i++) {
    if (i >= config.maxCount || files[i].date.getTime() < cutoff) {
      try { rmSync(join(dir, files[i].filename), { force: true }); } catch { /* ignore */ }
    }
  }
}

export function listBackups(dataDir: string): BackupInfo[] {
  const backups: BackupInfo[] = [];

  for (const tier of Object.keys(TIERS) as Tier[]) {
    const dir = tierDir(dataDir, tier);
    if (!existsSync(dir)) continue;

    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith('.tar.gz')) continue;
      const date = parseTimestamp(filename);
      if (!date) continue;

      let sizeBytes = 0;
      try { sizeBytes = statSync(join(dir, filename)).size; } catch { /* ignore */ }

      backups.push({
        tier,
        filename,
        createdAt: date.toISOString(),
        ticketCount: -1, // Unknown without opening the backup
        sizeBytes,
      });
    }
  }

  return backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function loadBackupForPreview(dataDir: string, tier: string, filename: string): Promise<{ tickets: Array<Record<string, unknown>>; stats: { total: number; open: number; upNext: number } }> {
  await cleanupPreview();

  const filePath = join(tierDir(dataDir, tier as Tier), filename);
  if (!existsSync(filePath)) throw new Error('Backup file not found');

  const buffer = readFileSync(filePath);
  const blob = new Blob([buffer]);

  const previewDir = join(backupsDir(dataDir), '_preview');
  mkdirSync(previewDir, { recursive: true });

  previewDb = new PGlite(previewDir, { loadDataDir: blob });
  await previewDb.waitReady;

  const tickets = await previewDb.query<Record<string, unknown>>(
    `SELECT * FROM tickets WHERE status != 'deleted' ORDER BY created_at DESC`
  );

  const statsResult = await previewDb.query<{ total: string; open: string; up_next: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE status != 'deleted') as total,
      COUNT(*) FILTER (WHERE status IN ('not_started', 'started')) as open,
      COUNT(*) FILTER (WHERE up_next = true AND status != 'deleted') as up_next
    FROM tickets
  `);
  const row = statsResult.rows[0];

  return {
    tickets: tickets.rows,
    stats: {
      total: parseInt(row.total, 10),
      open: parseInt(row.open, 10),
      upNext: parseInt(row.up_next, 10),
    },
  };
}

export async function cleanupPreview(): Promise<void> {
  if (previewDb) {
    try { await previewDb.close(); } catch { /* ignore */ }
    previewDb = null;
  }
  // Clean up preview directory if present — but dataDir may vary, so we track it
  if (currentDataDir !== null) {
    const previewDir = join(backupsDir(currentDataDir), '_preview');
    if (existsSync(previewDir)) {
      rmSync(previewDir, { recursive: true, force: true });
    }
  }
}

export async function restoreBackup(dataDir: string, tier: string, filename: string): Promise<void> {
  await cleanupPreview();

  const filePath = join(tierDir(dataDir, tier as Tier), filename);
  if (!existsSync(filePath)) throw new Error('Backup file not found');

  // Create a safety backup before restoring
  await createBackup(dataDir, '5min');

  const buffer = readFileSync(filePath);
  const blob = new Blob([buffer]);

  // Close current database
  await closeDb();

  // Remove current database directory
  const dbDir = join(dataDir, 'db');
  rmSync(dbDir, { recursive: true, force: true });

  // Re-initialize with backup data
  setDataDir(dataDir);
  await import('./db/connection.js');
  // Create new PGlite with the backup data loaded
  const PGliteClass = (await import('@electric-sql/pglite')).PGlite;
  const newDb = new PGliteClass(dbDir, { loadDataDir: blob });
  await newDb.waitReady;

  // The connection module needs to adopt this instance
  const { adoptDb } = await import('./db/connection.js');
  adoptDb(newDb);
}

function scheduleFiveMinBackup(dataDir: string): void {
  const state = getOrCreateState(dataDir);
  if (state.fiveMinTimer) clearTimeout(state.fiveMinTimer);
  state.fiveMinTimer = setTimeout(() => {
    void createBackup(dataDir, '5min').then(() => scheduleFiveMinBackup(dataDir));
  }, TIERS['5min'].intervalMs);
}

/** Trigger an immediate 5-min tier backup and reset the timer. Returns null if one is already in progress. */
export async function triggerManualBackup(dataDir: string): Promise<BackupInfo | null> {
  const result = await createBackup(dataDir, '5min');
  if (result) scheduleFiveMinBackup(dataDir);
  return result;
}

/** Get the backup timers for a given dataDir. Used by ProjectContext. */
export function getBackupTimers(dataDir: string): { fiveMin: ReturnType<typeof setTimeout> | null; hourly: ReturnType<typeof setInterval> | null; daily: ReturnType<typeof setInterval> | null } {
  const state = backupStates.get(dataDir);
  if (!state) return { fiveMin: null, hourly: null, daily: null };
  return { fiveMin: state.fiveMinTimer, hourly: state.hourlyInterval, daily: state.dailyInterval };
}

export function initBackupScheduler(dataDir: string): void {
  currentDataDir = dataDir;
  const state = getOrCreateState(dataDir);

  // Clean up any leftover preview directory from a crash
  const previewDir = join(backupsDir(dataDir), '_preview');
  if (existsSync(previewDir)) {
    rmSync(previewDir, { recursive: true, force: true });
  }

  // Initial backup after a short delay, then start the recurring 5-min cycle
  setTimeout(() => {
    void createBackup(dataDir, '5min').then(() => scheduleFiveMinBackup(dataDir));
  }, 10_000);

  // Schedule recurring hourly and daily backups
  state.hourlyInterval = setInterval(() => void createBackup(dataDir, 'hourly'), TIERS['hourly'].intervalMs);
  state.dailyInterval = setInterval(() => void createBackup(dataDir, 'daily'), TIERS['daily'].intervalMs);
}
