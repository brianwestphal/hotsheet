import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  buildAttachmentManifest,
  deleteManifestSibling,
  manifestSiblingFilename,
  reanalyzeMissingManifests,
  runAttachmentGc,
  writeManifestAtomically,
} from './attachmentBackup.js';
import { closeDb, getDb, runWithDataDir, setDataDir } from './db/connection.js';
import { fsyncDbDir } from './db/fsyncWrap.js';
import { buildJsonExport, jsonSiblingFilename, writeJsonExportAtomically } from './dbJsonExport.js';
import { getBackupDir } from './file-settings.js';

export interface BackupInfo {
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
  /** HS-7929 — daily attachment-blob GC. Independent cadence; runs at
   *  startup once + every 24h while the process is alive. */
  attachmentGcInterval: ReturnType<typeof setInterval> | null;
}

/** Per-project backup scheduler state. Each project gets its own timers.
 *  Modified by: getOrCreateState() (create), initBackupScheduler() (set timers),
 *  scheduleFiveMinBackup() (reset fiveMinTimer). */
const backupStates = new Map<string, BackupState>();

function getOrCreateState(dataDir: string): BackupState {
  let state = backupStates.get(dataDir);
  if (!state) {
    state = {
      backupInProgress: false,
      fiveMinTimer: null,
      hourlyInterval: null,
      dailyInterval: null,
      attachmentGcInterval: null,
    };
    backupStates.set(dataDir, state);
  }
  return state;
}

/** Active backup previews keyed by dataDir. Stores the temporary PGlite instance.
 *  Modified by: loadBackupForPreview() (add), cleanupPreview() (clear). */
const activePreviews = new Map<string, PGlite>();

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
    const db = await runWithDataDir(dataDir, () => getDb());
    const dir = tierDir(dataDir, tier);
    mkdirSync(dir, { recursive: true });

    // HS-7891: force a checkpoint before dumping. dumpDataDir() snapshots
    // PGLite's WASM-memfs at this exact moment, so without an explicit
    // CHECKPOINT pg_control may point at a WAL position the dump captures
    // as zero/garbage — restore then PANICs with "could not locate a valid
    // checkpoint record". The CHECKPOINT flushes WAL into the data files so
    // the snapshot is internally consistent.
    await db.exec('CHECKPOINT');
    // HS-7935: PGLite's WASM ↔ host-fs bridge silently no-ops the postgres
    // `fsync()` calls (HS-7932 spike), so the CHECKPOINT-rewritten files
    // are still in the host kernel page cache rather than physical disk.
    // Walk `<dataDir>/db/` and explicitly fsync every regular file so
    // durability isn't bounded by the OS's natural dirty-page flush
    // interval (~30s).
    fsyncDbDir(dataDir);
    const blob = await db.dumpDataDir('gzip');
    const buffer = Buffer.from(await blob.arrayBuffer());

    const now = new Date();
    const filename = `backup-${formatTimestamp(now)}.tar.gz`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, buffer);

    // HS-7893: co-save a versioned JSON snapshot of every row in every
    // table alongside the tarball. Pure escape hatch — the JSON has no
    // restore UI; it's there so a corrupt tarball doesn't take user data
    // with it. Failures here are logged but never fail the whole backup
    // because the tarball is the primary artifact.
    try {
      const exportData = await buildJsonExport(db);
      const jsonPath = join(dir, jsonSiblingFilename(filename));
      writeJsonExportAtomically(jsonPath, exportData);
    } catch (jsonErr) {
      console.error(`JSON co-save failed (${tier}):`, jsonErr);
    }

    // HS-7929: capture each attachment blob into the centralised
    // hash-addressed store at `<backupRoot>/attachments/<sha>` and write a
    // `backup-<TS>.attachments.json` manifest sibling. Same best-effort
    // policy as the JSON co-save — failures here log but don't fail the
    // tarball.
    try {
      const backupRoot = backupsDir(dataDir);
      const manifest = await buildAttachmentManifest(db, backupRoot, filename);
      const manifestPath = join(dir, manifestSiblingFilename(filename));
      writeManifestAtomically(manifestPath, manifest);
    } catch (attachErr) {
      console.error(`Attachment manifest failed (${tier}):`, attachErr);
    }

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
      const tarballPath = join(dir, files[i].filename);
      try { rmSync(tarballPath, { force: true }); } catch { /* ignore */ }
      // HS-7893: keep tarball + JSON-sibling in lockstep — pruning one
      // without the other leaves orphans cluttering the backup dir.
      try { rmSync(join(dir, jsonSiblingFilename(files[i].filename)), { force: true }); } catch { /* ignore */ }
      // HS-7929: drop the attachment-manifest sibling too. The orphan blobs
      // (referenced only by the deleted manifest) get reclaimed by the
      // daily GC, not here — keeps the prune step cheap.
      deleteManifestSibling(tarballPath);
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

const VALID_TIERS = new Set<string>(['5min', 'hourly', 'daily']);

function validateBackupParams(tier: string, filename: string): void {
  if (!VALID_TIERS.has(tier)) throw new Error(`Invalid backup tier: ${tier}`);
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) throw new Error('Invalid filename');
}

export async function loadBackupForPreview(dataDir: string, tier: string, filename: string): Promise<{ tickets: Array<Record<string, unknown>>; stats: { total: number; open: number; upNext: number } }> {
  validateBackupParams(tier, filename);

  const filePath = join(tierDir(dataDir, tier as Tier), filename);
  if (!existsSync(filePath)) throw new Error('Backup file not found');

  const buffer = readFileSync(filePath);
  const blob = new Blob([buffer]);

  const previewDir = join(backupsDir(dataDir), '_preview');
  mkdirSync(previewDir, { recursive: true });

  // Clean up any existing preview for this project
  await cleanupPreview(dataDir);

  const db = new PGlite(previewDir, { loadDataDir: blob });
  await db.waitReady;
  activePreviews.set(dataDir, db);

  const tickets = await db.query<Record<string, unknown>>(
    `SELECT * FROM tickets WHERE status != 'deleted' ORDER BY created_at DESC`
  );

  const statsResult = await db.query<{ total: string; open: string; up_next: string }>(`
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

export async function cleanupPreview(dataDir?: string): Promise<void> {
  // If a specific dataDir is given, clean up just that one
  const dirs = dataDir !== undefined ? [dataDir] : Array.from(activePreviews.keys());
  for (const dir of dirs) {
    const db = activePreviews.get(dir);
    if (db) {
      try { await db.close(); } catch { /* ignore */ }
      activePreviews.delete(dir);
    }
    const previewDir = join(backupsDir(dir), '_preview');
    if (existsSync(previewDir)) {
      rmSync(previewDir, { recursive: true, force: true });
    }
  }
}

export async function restoreBackup(dataDir: string, tier: string, filename: string): Promise<void> {
  validateBackupParams(tier, filename);
  await cleanupPreview(dataDir);

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

  // HS-7929: re-hydrate attachment binaries from the manifest sibling, if
  // present. Without this step, restored attachments table rows point at
  // `stored_path` paths that may not exist (the live attachments dir was
  // deleted along with `db/` above, OR the user is restoring to a fresh
  // machine). The manifest tells us which sha-addressed blobs were live at
  // backup time; we copy them back in-place + rewrite `stored_path` so
  // every restored row resolves.
  try {
    const { readManifest, restoreAttachmentsFromManifest, attachmentBlobsDir } = await import('./attachmentBackup.js');
    const manifestPath = join(tierDir(dataDir, tier as Tier), manifestSiblingFilename(filename));
    const manifest = readManifest(manifestPath);
    if (manifest !== null) {
      const blobsDir = attachmentBlobsDir(backupsDir(dataDir));
      const liveAttachmentsDir = join(dataDir, 'attachments');
      const restored = await restoreAttachmentsFromManifest(manifest, blobsDir, liveAttachmentsDir);
      // Update each restored attachments row's `stored_path` so it resolves
      // to whatever final filename we landed on (handles the
      // `-restored-<TS>` suffix case).
      for (const r of restored) {
        const newStoredPath = join(liveAttachmentsDir, r.finalStoredName);
        await newDb.query(
          'UPDATE attachments SET stored_path = $1 WHERE id = $2',
          [newStoredPath, r.attachmentId],
        );
      }
      if (restored.length > 0) {
        console.log(`[attachmentBackup] restore: re-hydrated ${restored.length} attachment(s) from manifest`);
      }
    }
  } catch (err) {
    console.error('[attachmentBackup] restore: manifest-based re-hydration failed (continuing):', err);
  }
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
  const state = getOrCreateState(dataDir);

  // Clean up any leftover preview directory from a crash
  const previewDir = join(backupsDir(dataDir), '_preview');
  if (existsSync(previewDir)) {
    rmSync(previewDir, { recursive: true, force: true });
  }

  // HS-7894: catch up on overdue backups at startup, then enter the
  // normal 5-min cycle. Without the catch-up, daily/hourly backups go
  // missing for users who quit Hot Sheet before 24h of process uptime —
  // setInterval timers reset on every restart, so the daily timer never
  // fires for a typical dev workstation. The catch-up creates one
  // backup per overdue tier (5min, hourly, daily) sequentially.
  setTimeout(() => {
    void triggerMissedBackups(dataDir).then(() => scheduleFiveMinBackup(dataDir));
  }, 10_000);

  // Recurring hourly + daily intervals keep firing while the process is
  // alive. The startup catch-up above handles short-lived processes.
  state.hourlyInterval = setInterval(() => void createBackup(dataDir, 'hourly'), TIERS['hourly'].intervalMs);
  state.dailyInterval = setInterval(() => void createBackup(dataDir, 'daily'), TIERS['daily'].intervalMs);

  // HS-7937: at startup, rebuild any missing attachment manifests for
  // tarballs older than 24h. Critically scheduled BEFORE the daily GC so
  // any rebuilt manifests are visible to the GC's reference-set union —
  // otherwise the GC would treat their blobs as orphans and reclaim them.
  // Runs once; manifests are written by the normal backup path going
  // forward, so re-analysis only matters at boot.
  setTimeout(() => {
    void reanalyzeMissingManifests(backupsDir(dataDir)).then(stats => {
      if (stats.rebuilt > 0 || stats.failed > 0) {
        console.log(`[attachmentBackup] reanalyze: rebuilt=${stats.rebuilt} skipped=${stats.skipped} failed=${stats.failed}`);
      }
    }).catch((err: unknown) => {
      console.error('[attachmentBackup] reanalyze startup run failed:', err);
    });
  }, 25_000);

  // HS-7929: daily attachment-blob GC, parallel cadence to the daily-tier
  // backup but independent of it. Runs once at startup (delayed to let the
  // initial backup catch-up + reanalyze settle) + every 24h thereafter.
  // GC is a no-op when `<backupRoot>/attachments/` doesn't exist (e.g.
  // before any backup has fired) so the startup call is cheap.
  setTimeout(() => {
    void runAttachmentGc(backupsDir(dataDir)).then(stats => {
      if (stats.deleted > 0) {
        console.log(`[attachmentBackup] GC: reclaimed ${stats.deleted} blob(s), ${(stats.bytesReclaimed / 1024 / 1024).toFixed(2)} MB`);
      }
    }).catch((err: unknown) => {
      console.error('[attachmentBackup] GC startup run failed:', err);
    });
  }, 30_000);
  state.attachmentGcInterval = setInterval(() => {
    void runAttachmentGc(backupsDir(dataDir)).then(stats => {
      if (stats.deleted > 0) {
        console.log(`[attachmentBackup] GC: reclaimed ${stats.deleted} blob(s), ${(stats.bytesReclaimed / 1024 / 1024).toFixed(2)} MB`);
      }
    }).catch((err: unknown) => {
      console.error('[attachmentBackup] GC daily run failed:', err);
    });
  }, 24 * 60 * 60 * 1000);
}

/** HS-7894: detect tiers whose newest backup is older than the tier's
 *  interval (or that have no backup at all). Pure function exported for
 *  unit testing. */
export function findOverdueTiers(backups: BackupInfo[], now: number): Tier[] {
  const overdue: Tier[] = [];
  for (const tier of Object.keys(TIERS) as Tier[]) {
    const inTier = backups.filter(b => b.tier === tier);
    const lastTime = inTier.length === 0
      ? 0
      : Math.max(...inTier.map(b => new Date(b.createdAt).getTime()));
    if (now - lastTime >= TIERS[tier].intervalMs) overdue.push(tier);
  }
  return overdue;
}

/** HS-7894: create one backup per overdue tier, sequentially. The
 *  per-dataDir `backupInProgress` flag is shared across tiers, so racing
 *  three setIntervals against each other can drop two of the three;
 *  awaiting between tiers avoids that. */
export async function triggerMissedBackups(dataDir: string): Promise<void> {
  const overdue = findOverdueTiers(listBackups(dataDir), Date.now());
  for (const tier of overdue) {
    await createBackup(dataDir, tier);
  }
}
