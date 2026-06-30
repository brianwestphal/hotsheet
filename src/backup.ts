import { type PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync } from 'fs';
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
import { fsyncDbDirAsync } from './db/fsyncWrap.js';
import { createPglite } from './db/pglite.js';
import { buildJsonExport, jsonSiblingFilename, writeJsonExportAtomically } from './dbJsonExport.js';
import { getRecentEventLoopLagMs, instrumentAsync, onServerWake } from './diagnostics/freezeLogger.js';
import { getBackupDir } from './file-settings.js';
import { _resetDefaultSchedulerForTests, getBackgroundScheduler, PRIORITY } from './scheduler/backgroundScheduler.js';

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
  /** HS-9224 — consecutive AUTOMATIC 5-min ticks skipped under backpressure.
   *  Bounded by `MAX_CONSECUTIVE_FIVE_MIN_SKIPS` so the tier can't be starved. */
  fiveMinConsecutiveSkips: number;
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
      fiveMinConsecutiveSkips: 0,
    };
    backupStates.set(dataDir, state);
  }
  return state;
}

/** Active backup previews keyed by dataDir. Stores the temporary PGlite instance.
 *  Modified by: loadBackupForPreview() (add), cleanupPreview() (clear). */
const activePreviews = new Map<string, PGlite>();

/**
 * HS-8229 / HS-8724 — run a backup body under the process-global "at most one
 * backup at a time" guarantee. Originally a bespoke await-loop mutex (HS-8229);
 * now a thin wrapper over the central `backgroundScheduler` (HS-8724). At most
 * one backup runs at a time across the whole process — the original concern was
 * N registered projects on similar cadences contending for libuv threadpool +
 * disk bandwidth + Google Drive sync rate limits (HS-8174). The per-dataDir
 * `backupInProgress` flag stays as a same-project early-return so a single
 * project's tier collisions bail before reaching the scheduler.
 *
 * Exported for unit tests; production callers go through `createBackup`.
 */
// HS-8724 (load resilience, docs/75 §75.6 Phase 2) — backups now run through
// the central `backgroundScheduler` instead of a bespoke mutex. The scheduler's
// `exclusiveGroup: 'backup'` preserves HS-8229's guarantee that at most one
// backup runs at a time across the whole process (Google-Drive rate limits +
// disk contention, HS-8174) while letting a backup overlap a snapshot under the
// shared concurrency budget. `deferUnderLag: false` — backups are durability
// work and must run even under sustained event-loop lag. Each call gets a
// unique key so backups queue FIFO (no coalescing) and every caller's result
// is its own.
let backupLockSeq = 0;
const BACKUP_EXCLUSIVE_GROUP = 'backup';

export function withGlobalBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  // The job settles this deferred so the caller's promise mirrors fn's outcome
  // exactly (resolve OR reject) — preserving `withGlobalBackupLock`'s
  // propagate-on-throw contract. The scheduler's own awaitable never rejects, so
  // we route the result through `out` instead and fire-and-forget the submit.
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const out = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject; });
  void getBackgroundScheduler().submit({
    key: `backup:${++backupLockSeq}`,
    priority: PRIORITY.BACKUP,
    exclusiveGroup: BACKUP_EXCLUSIVE_GROUP,
    deferUnderLag: false,
    run: async () => {
      try { settle(await fn()); } catch (e) { fail(e); }
    },
  });
  return out;
}

/** **TEST ONLY** — reset the scheduler (drops any queued/serialized backups)
 *  AND every per-project gate. Used between cases so a prior test's leaked
 *  scheduler state OR a lingering per-project `backupInProgress` flag can't
 *  strand the next case. (HS-8720: under CI coverage starvation a prior
 *  backup's `finally` reset can lag, so clear `backupStates` too.) */
export function _resetGlobalBackupLockForTesting(): void {
  _resetDefaultSchedulerForTests();
  backupStates.clear();
}

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

  // HS-8229 — wrap the body in the process-global mutex so cross-project
  // backups serialize. The per-dataDir `backupInProgress` gate above
  // (untouched) still prevents same-project tier collisions, so a
  // 5-min/hourly tier-pile-up on a single project bails BEFORE entering
  // the global queue.
  return withGlobalBackupLock(async () => {
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
    // HS-8160 — wrap CHECKPOINT (the most likely PGLite-side stall in
    // the backup pipeline) so freeze.log tags it as
    // `pglite.checkpoint:backup:<tier>`.
    await instrumentAsync(dataDir, `pglite.checkpoint:backup:${tier}`, () => db.exec('CHECKPOINT'));
    // HS-7935: PGLite's WASM ↔ host-fs bridge silently no-ops the postgres
    // `fsync()` calls (HS-7932 spike), so the CHECKPOINT-rewritten files
    // are still in the host kernel page cache rather than physical disk.
    // Walk `<dataDir>/db/` and explicitly fsync every regular file so
    // durability isn't bounded by the OS's natural dirty-page flush
    // interval (~30s).
    // HS-8160 — wrap fsyncDbDir; on a slow filesystem (e.g. user's
    // Google Drive backupDir per HS-8174) this is the most likely
    // sync-side stall.
    // HS-8351 — switched to `fsyncDbDirAsync` + `instrumentAsync` so the
    // fsync syscalls run on libuv's threadpool instead of blocking the
    // main event loop. Pre-fix this was the #1 cause of slow-server
    // banner triggers (94% of instrumented sync stalls per HS-8330
    // analysis); post-fix the wall-clock latency is unchanged but the
    // event loop stays free for keystrokes / WS frames / HTTP traffic.
    // Label preserved so HS-8160 freeze.log analysis still resolves.
    await instrumentAsync(dataDir, `fsyncDbDir:backup:${tier}`, () => fsyncDbDirAsync(dataDir));
    const blob = await db.dumpDataDir('gzip');
    const buffer = Buffer.from(await blob.arrayBuffer());

    const now = new Date();
    const filename = `backup-${formatTimestamp(now)}.tar.gz`;
    const filePath = join(dir, filename);
    // HS-8160 / HS-8178 — wrap the tarball write. Switched to
    // `fs.promises.writeFile` + `instrumentAsync` so the write +
    // implicit fsync run on libuv's threadpool instead of blocking
    // the main event loop on a slow `backupDir` (Google Drive stall
    // per HS-8174 candidate 2). The instrument label stays the same
    // so existing freeze.log entries from HS-8160 still resolve.
    await instrumentAsync(dataDir, `backup.writeTarball:${tier}`, () => fsp.writeFile(filePath, buffer));

    // HS-7893: co-save a versioned JSON snapshot of every row in every
    // table alongside the tarball. Pure escape hatch — the JSON has no
    // restore UI; it's there so a corrupt tarball doesn't take user data
    // with it. Failures here are logged but never fail the whole backup
    // because the tarball is the primary artifact.
    try {
      const exportData = await buildJsonExport(db);
      const jsonPath = join(dir, jsonSiblingFilename(filename));
      // HS-8160 / HS-8178 — wrap the JSON co-save (write + fsync inside,
      // both async via fs.promises post-HS-8178).
      await instrumentAsync(dataDir, `backup.writeJsonCoSave:${tier}`, () => writeJsonExportAtomically(jsonPath, exportData));
    } catch (jsonErr) {
      console.error(`JSON co-save failed (${tier}):`, jsonErr);
    }

    // HS-7929: capture each attachment blob into the centralized
    // hash-addressed store at `<backupRoot>/attachments/<sha>` and write a
    // `backup-<TS>.attachments.json` manifest sibling. Same best-effort
    // policy as the JSON co-save — failures here log but don't fail the
    // tarball.
    try {
      const backupRoot = backupsDir(dataDir);
      // HS-8353 — instrument so freeze.log attributes any stall here
      // to the manifest-build pass instead of leaving it as anonymous
      // server-heartbeat noise. Includes streaming hashing of every
      // attachment blob + link-then-copy into the shared store, which
      // touches every attachment file once per backup.
      const manifest = await instrumentAsync(dataDir, `attachmentBackup.buildManifest:${tier}`, () => buildAttachmentManifest(db, backupRoot, filename));
      const manifestPath = join(dir, manifestSiblingFilename(filename));
      // HS-8160 / HS-8178 — wrap the attachment-manifest write (write
      // + fsync inside, both async via fs.promises post-HS-8178).
      await instrumentAsync(dataDir, `backup.writeAttachmentManifest:${tier}`, () => writeManifestAtomically(manifestPath, manifest));
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
  });
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

  const db = createPglite(previewDir, { loadDataDir: blob });
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
  // Create new PGlite with the backup data loaded (HS-8585 — pinned to
  // template1 via createPglite so the restored cluster's tables are visible).
  const newDb = createPglite(dbDir, { loadDataDir: blob });
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
      // HS-8353 — instrument the restore-path re-hydration. User-initiated
      // so blocking is acceptable per HS-8178 scope, but a stall here
      // would otherwise appear as anonymous server-heartbeat noise.
      const restored = await instrumentAsync(dataDir, 'attachmentBackup.restoreFromManifest', () => restoreAttachmentsFromManifest(manifest, blobsDir, liveAttachmentsDir));
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

/**
 * HS-8352 — random-jitter scaler for the first 5-min tick. Pre-fix every
 * project boots its scheduler at the same hard-coded `+10 s` offset from
 * `initBackupScheduler`, then schedules the first regular tick at exactly
 * `intervalMs`. On a workstation with N registered projects the result is
 * N backups queued head-to-tail every 5 min, all contending for the
 * HS-8229 global mutex + the libuv threadpool. Jittering the first tick
 * across `[0.5x, 1.5x]` of `intervalMs` spreads the projects over a
 * 2.5-7.5 min window; subsequent ticks are scheduled from inside
 * `createBackup(...).then()`, so each project's completion time becomes
 * its own offset and the steady-state cadence stays spread.
 *
 * `rng` is injected so tests can pin `Math.random()` without monkey-
 * patching the global. Default uses `Math.random` per HS-8330's
 * recommendation (option 1: simpler than hash-based deterministic offset,
 * indistinguishable in practice).
 */
export function jitteredFirstTickMs(intervalMs: number, rng: () => number = Math.random): number {
  return Math.round(intervalMs * (0.5 + rng()));
}

// ---------------------------------------------------------------------------
// HS-9224 — adaptive gating for the AUTOMATIC 5-min backup tick
// ---------------------------------------------------------------------------
//
// The 5-min tier is the most frequent and least-urgent backup. Under acute
// disk/CPU pressure (a post-reboot Spotlight reindex, a Time Machine pass) its
// CHECKPOINT + fsync + manifest pass piled multi-second event-loop stalls onto
// an already-saturated machine — the exact window a UI freeze was reported. We
// SKIP a 5-min tick when the loop is sustained-laggy or we just resumed from a
// system suspend, and reschedule for the next interval.
//
// Durability is preserved: the next tick retries, the un-gated hourly/daily
// tiers are the backstop, and a hard cap forces a tick through after enough
// skips so a pathologically-busy loop can't starve the 5-min tier forever. We
// gate ONLY the automatic timer — manual backups, hourly, daily, and the
// startup missed-backup catch-up run unconditionally — and we do NOT change the
// scheduler's `deferUnderLag: false` (HS-8724 durability intent): once a tick is
// admitted it still runs to completion.

/** Skip a 5-min tick while event-loop lag is at/above this (ms). Set well above
 *  the scheduler's 200 ms default so only genuinely bad lag skips a backup. */
const FIVE_MIN_LAG_SKIP_THRESHOLD_MS = 300;
/** Skip 5-min ticks for this long after a system wake (suspend/resume). Sized to
 *  the acute post-resume jolt; a longer sustained reindex is covered by the lag
 *  gate, which resumes the tier as soon as the loop calms. */
const POST_WAKE_BACKUP_COOLDOWN_MS = 90_000;
/** Hard cap: admit a 5-min tick after this many consecutive skips regardless of
 *  pressure (~30 min at the 5-min cadence), so the tier is never starved. */
const MAX_CONSECUTIVE_FIVE_MIN_SKIPS = 6;

let lastWakeAt = Number.NEGATIVE_INFINITY;
let backupWakeListenerRegistered = false;
// Test seams — overridable clock + lag provider (default to the real ones).
let backupNow: () => number = () => Date.now();
let backupLagProvider: () => number = getRecentEventLoopLagMs;

/** Register the system-wake listener once per process so a suspend/resume opens
 *  the post-wake cooldown for every project's 5-min timer. */
function ensureBackupWakeListener(): void {
  if (backupWakeListenerRegistered) return;
  backupWakeListenerRegistered = true;
  onServerWake(() => { lastWakeAt = backupNow(); });
}

/** Whether the automatic 5-min tick should skip right now — within the post-wake
 *  cooldown, or under sustained high event-loop lag. Pure given the injected
 *  clock + lag provider. */
export function shouldDeferFiveMinBackup(): boolean {
  if (backupNow() - lastWakeAt < POST_WAKE_BACKUP_COOLDOWN_MS) return true;
  if (backupLagProvider() >= FIVE_MIN_LAG_SKIP_THRESHOLD_MS) return true;
  return false;
}

/** Test-only — override the clock / lag provider / last-wake time and reset the
 *  wake-listener guard so each case starts from a clean slate. */
export function _setFiveMinBackupGateForTests(opts: { now?: () => number; lag?: () => number; lastWakeAt?: number } = {}): void {
  backupNow = opts.now ?? (() => Date.now());
  backupLagProvider = opts.lag ?? getRecentEventLoopLagMs;
  lastWakeAt = opts.lastWakeAt ?? Number.NEGATIVE_INFINITY;
  backupWakeListenerRegistered = false;
}

function scheduleFiveMinBackup(dataDir: string, options: { jitter?: boolean; rng?: () => number } = {}): void {
  const state = getOrCreateState(dataDir);
  if (state.fiveMinTimer) clearTimeout(state.fiveMinTimer);
  const delayMs = options.jitter === true
    ? jitteredFirstTickMs(TIERS['5min'].intervalMs, options.rng)
    : TIERS['5min'].intervalMs;
  state.fiveMinTimer = setTimeout(() => {
    // HS-9224 — skip this automatic tick under post-wake / sustained-lag
    // pressure (unless we've hit the durability cap). A skip just reschedules
    // the next tick; it never enters `createBackup`, so `backupInProgress` and
    // the hourly/daily tiers are untouched.
    if (shouldDeferFiveMinBackup() && state.fiveMinConsecutiveSkips < MAX_CONSECUTIVE_FIVE_MIN_SKIPS) {
      state.fiveMinConsecutiveSkips++;
      scheduleFiveMinBackup(dataDir);
      return;
    }
    state.fiveMinConsecutiveSkips = 0;
    void createBackup(dataDir, '5min').then(() => scheduleFiveMinBackup(dataDir));
  }, delayMs);
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

  // HS-9224 — open the post-wake cooldown for the 5-min gate on suspend/resume.
  // Idempotent (registered once per process); safe to call per project.
  ensureBackupWakeListener();

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
    // HS-8352 — jitter the FIRST regular 5-min tick across [0.5x, 1.5x]
    // of intervalMs so a multi-project workstation spreads its backup
    // train across a 2.5-7.5 min window instead of clustering every
    // project on the same offset-from-boot. Subsequent ticks recurse
    // via `createBackup(...).then(() => scheduleFiveMinBackup(dataDir))`
    // without jitter — the completion-time offset preserves the spread.
    void triggerMissedBackups(dataDir).then(() => scheduleFiveMinBackup(dataDir, { jitter: true }));
    // HS-9225 — was 10 s. Pushed to 30 s so the catch-up backup train (a heavy
    // CHECKPOINT + dumpDataDir + fsync + manifest per overdue tier) lands AFTER
    // the startup rush — PGLite init, first ticket load, a kicked-off resume,
    // the first tab-switch — instead of on top of it. Durability is unaffected:
    // 20 extra seconds against tier intervals of 5 min / 1 h / 24 h.
  }, 30_000);

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
    // HS-8353 — instrument the manifest re-analysis pass. Iterates every
    // historical tarball lacking a manifest sibling + rebuilds it from
    // the JSON co-save + cross-references sibling manifests' blob shas.
    // Cross-tier readdir + per-blob hashing makes this the most
    // expensive single attachmentBackup operation; on a fresh boot with
    // many historical backups it can run for several seconds.
    void instrumentAsync(dataDir, 'attachmentBackup.reanalyzeMissingManifests', () => reanalyzeMissingManifests(backupsDir(dataDir))).then(stats => {
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
    // HS-8353 — instrument startup orphan GC. Cross-tier scan of every
    // backup tarball manifest + a readdir of the blob store; on a slow
    // filesystem this can stall the event loop.
    void instrumentAsync(dataDir, 'attachmentBackup.orphanGc:startup', () => runAttachmentGc(backupsDir(dataDir))).then(stats => {
      if (stats.deleted > 0) {
        console.log(`[attachmentBackup] GC: reclaimed ${stats.deleted} blob(s), ${(stats.bytesReclaimed / 1024 / 1024).toFixed(2)} MB`);
      }
    }).catch((err: unknown) => {
      console.error('[attachmentBackup] GC startup run failed:', err);
    });
  }, 30_000);
  state.attachmentGcInterval = setInterval(() => {
    // HS-8353 — instrument daily orphan GC. Same shape as the startup
    // run but recurring every 24 h. HS-8724 — submitted through the central
    // scheduler at GC priority + `deferUnderLag: true`: GC is the lowest-value
    // background work, so it yields to everything else and waits out lag spikes.
    void getBackgroundScheduler().submit({
      key: `attachment-gc:${dataDir}`,
      priority: PRIORITY.GC,
      projectKey: dataDir,
      deferUnderLag: true,
      run: () => instrumentAsync(dataDir, 'attachmentBackup.orphanGc:daily', () => runAttachmentGc(backupsDir(dataDir))).then(stats => {
        if (stats.deleted > 0) {
          console.log(`[attachmentBackup] GC: reclaimed ${stats.deleted} blob(s), ${(stats.bytesReclaimed / 1024 / 1024).toFixed(2)} MB`);
        }
      }).catch((err: unknown) => {
        console.error('[attachmentBackup] GC daily run failed:', err);
      }),
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
    // HS-9225 — the startup catch-up runs every overdue tier back-to-back; on a
    // fresh restart that's 5min + hourly + daily heavy backups (CHECKPOINT +
    // dumpDataDir + fsync + manifest) firing right as the user starts work
    // (the reported "froze within a minute of launch"). Skip the least-valuable
    // 5-min catch-up under backpressure — its regular cadence recreates it
    // within minutes — while hourly/daily still run for durability. Under no
    // pressure (incl. the unit test) the 5-min catch-up runs as before.
    if (tier === '5min' && shouldDeferFiveMinBackup()) continue;
    await createBackup(dataDir, tier);
  }
}
