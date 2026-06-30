/**
 * HS-8586 — Snapshot Protection, Phase 1: the canonical-snapshot writer.
 *
 * Background: our live PGLite cluster (`nodefs`, `<dataDir>/db/`) is a
 * multi-file PostgreSQL data directory that corrupts when those files are
 * left mutually inconsistent by a crash / unclean exit (the HS-8575
 * investigation). Option D (`docs/73-snapshot-protection.md`) keeps that
 * low-RAM live cluster but stops trusting it as the source of truth: we
 * maintain ONE atomically-written snapshot of the whole DB and (Phase 2,
 * HS-8587) auto-restore from it when the live cluster comes up broken.
 *
 * This module owns producing that snapshot. It does NOT wire up restore —
 * that is HS-8587. Phase 1 only proves the artifact exists and round-trips.
 *
 * The canonical snapshot lives at `<dataDir>/snapshot.tar.gz` (where
 * `<dataDir>` is the project's `.hotsheet/` directory — the same place the
 * `.db-recovery-marker.json` lives, NOT the configurable `backupDir`, which
 * may be a slow Google-Drive-synced folder per HS-8174). Local + fast =
 * fresh, which is the whole point of decision D1.
 *
 * Production is the proven backup path: `CHECKPOINT` →
 * `db.dumpDataDir('gzip')` → atomic `tmp` + `fsync` + `rename` (the exact
 * shape of `writeJsonExportAtomically`, `src/dbJsonExport.ts`). The atomic
 * rename means a crash mid-write leaves either the complete previous
 * snapshot or the complete new one — never a partial file.
 *
 * Triggers (all gated on the per-project `db_snapshot_protection` setting,
 * default on):
 *   1. Debounced post-write — `scheduleSnapshot` is called from
 *      `scheduleAllSync` (`src/sync/markdown.ts`) so every ticket mutation
 *      schedules a coalesced snapshot ~2 s later.
 *   2. Graceful shutdown — `snapshotAllForShutdown` runs inside
 *      `gracefulShutdown` (`src/lifecycle.ts`) BEFORE `closeAllDatabases`,
 *      so a clean exit always leaves an up-to-the-moment snapshot.
 *   3. Periodic safety floor — a dirty-gated interval (default 120 s)
 *      bounds loss on a hard crash even if the debounce never fired.
 */
import { existsSync, promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import { join } from 'path';

import { instrumentAsync } from '../diagnostics/freezeLogger.js';
import { readFileSettings } from '../file-settings.js';
import { getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';
import { getDbForDir } from './connection.js';

/** Default debounce after the last mutation before a snapshot fires. */
const DEFAULT_DEBOUNCE_MS = 2000;
/** Default dirty-gated safety-floor interval. */
const DEFAULT_SAFETY_INTERVAL_MS = 120_000;
/** HS-9226 — minimum spacing between two debounce-driven snapshots. The snapshot
 *  does `db.dumpDataDir('gzip')`, which serializes the WHOLE PGLite cluster
 *  synchronously on the event loop — O(DB size). On a telemetry-bloated DB
 *  (hundreds of MB) that's multiple SECONDS of frozen UI, and the 2 s debounce
 *  re-fired it after every burst of activity (a tab-switch / a running resume
 *  generating telemetry). This floor caps the debounce path to at most one dump
 *  per minute; the dirty-gated safety interval is the backstop, and graceful
 *  shutdown still snapshots unconditionally. The real cure is a smaller DB
 *  (telemetry retention/compaction) and/or moving the dump off the loop. */
const DEFAULT_MIN_SNAPSHOT_SPACING_MS = 60_000;

/** Result of a successful snapshot write, for callers that want to surface it. */
export interface SnapshotResult {
  path: string;
  sizeBytes: number;
  /** epoch ms */
  at: number;
}

interface SnapshotState {
  /** A mutation has landed since the last successful snapshot. */
  dirty: boolean;
  /** A snapshot write is currently running (per-project serialization). */
  inProgress: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  safetyTimer: ReturnType<typeof setInterval> | null;
  lastSnapshotAt: number | null;
  lastSizeBytes: number | null;
}

const snapshotStates = new Map<string, SnapshotState>();

/** The first registered dataDir, used to resolve `scheduleSnapshot()` calls
 *  that omit an explicit dir (the legacy single-project path). */
let defaultDataDir: string | null = null;

function getOrCreateState(dataDir: string): SnapshotState {
  let state = snapshotStates.get(dataDir);
  if (!state) {
    state = {
      dirty: false,
      inProgress: false,
      debounceTimer: null,
      safetyTimer: null,
      lastSnapshotAt: null,
      lastSizeBytes: null,
    };
    snapshotStates.set(dataDir, state);
  }
  return state;
}

function resolveDir(dataDir?: string): string | null {
  if (dataDir !== undefined) return dataDir;
  return defaultDataDir;
}

/** Absolute path of the canonical snapshot for a project. Exported so the
 *  Phase 2 (HS-8587) restore flow + the Settings status line can find it. */
export function snapshotPath(dataDir: string): string {
  return join(dataDir, 'snapshot.tar.gz');
}

/** Per-project master switch, default ON (decision D3). Tolerates the value
 *  being stored as a real boolean OR as the API's stringified `"true"` /
 *  `"false"` (project settings round-trip through strings). */
export function isSnapshotProtectionEnabled(dataDir: string): boolean {
  const v = readFileSettings(dataDir)['db_snapshot_protection'];
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v !== 'false' && v !== '0' && v !== '';
  return true;
}

function numericSetting(dataDir: string, key: string, fallback: number): number {
  const v = readFileSettings(dataDir)[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Register a project's safety-floor timer + remember it as the default dir.
 * Called once per project at startup alongside `initBackupScheduler` /
 * `initMarkdownSync`. Idempotent.
 */
export function initSnapshotScheduler(dataDir: string): void {
  if (defaultDataDir === null) defaultDataDir = dataDir;
  const state = getOrCreateState(dataDir);
  if (state.safetyTimer !== null) return;
  state.safetyTimer = setInterval(() => {
    if (state.dirty && !state.inProgress) void submitSnapshotJob(dataDir);
  }, numericSetting(dataDir, 'db_snapshot_safety_interval_ms', DEFAULT_SAFETY_INTERVAL_MS));
  // Don't keep the event loop alive just for the safety floor.
  state.safetyTimer.unref();
}

/**
 * Schedule a debounced snapshot. Called from `scheduleAllSync` on every
 * ticket mutation; bursts coalesce into one write. No-op when protection is
 * disabled for the project.
 */
export function scheduleSnapshot(dataDir?: string): void {
  const dir = resolveDir(dataDir);
  if (dir === null) return;
  if (!isSnapshotProtectionEnabled(dir)) return;
  const state = getOrCreateState(dir);
  state.dirty = true;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => fireDebouncedSnapshot(dir), numericSetting(dir, 'db_snapshot_debounce_ms', DEFAULT_DEBOUNCE_MS));
}

/**
 * HS-9226 — the debounce timer's body, factored out so it can re-arm itself.
 * Enforces `DEFAULT_MIN_SNAPSHOT_SPACING_MS` between debounce-driven snapshots:
 * if the last snapshot was too recent, re-arm for the remaining window instead
 * of firing another multi-second dump. `dirty` stays set, so the deferred fire
 * (or the safety floor) still captures the pending mutations.
 */
function fireDebouncedSnapshot(dir: string): void {
  const state = getOrCreateState(dir);
  state.debounceTimer = null;
  const spacing = numericSetting(dir, 'db_snapshot_min_spacing_ms', DEFAULT_MIN_SNAPSHOT_SPACING_MS);
  const sinceLast = state.lastSnapshotAt === null ? Number.POSITIVE_INFINITY : Date.now() - state.lastSnapshotAt;
  if (sinceLast < spacing) {
    state.debounceTimer = setTimeout(() => fireDebouncedSnapshot(dir), spacing - sinceLast);
    return;
  }
  void submitSnapshotJob(dir);
}

/**
 * HS-8724 — submit the snapshot write to the central background scheduler so it
 * shares the process-wide concurrency budget + fairness pool with backups and
 * the other projects' snapshots. Coalesces by `snapshot:<dataDir>` (a burst of
 * debounce/safety fires collapses to one write) and uses `deferUnderLag: false`
 * — a snapshot is durability work, so it must run even under sustained
 * event-loop lag (deferring it would widen the data-loss window). Returns the
 * scheduler's awaitable so the shutdown flush can wait for completion.
 * `writeSnapshotNow` stays the worker (also callable directly, e.g. in tests).
 */
function submitSnapshotJob(dataDir: string): Promise<void> {
  return getBackgroundScheduler().submit({
    key: `snapshot:${dataDir}`,
    priority: PRIORITY.SNAPSHOT,
    projectKey: dataDir,
    deferUnderLag: false,
    run: async () => { await writeSnapshotNow(dataDir); },
  });
}

/**
 * Write the canonical snapshot now (CHECKPOINT → dump → atomic write).
 * Returns the result, or `null` when protection is off or a write is already
 * in flight for this project. Failures are logged + leave the project dirty
 * so the next trigger retries.
 */
export async function writeSnapshotNow(dataDir: string): Promise<SnapshotResult | null> {
  if (!isSnapshotProtectionEnabled(dataDir)) return null;
  // Don't resurrect a removed data dir: if the live `db/` is gone (project
  // unregistered, or a torn-down test temp dir whose pending debounce only
  // now fired) `getDbForDir` would `mkdir` + reopen an empty cluster and
  // overwrite the snapshot with nothing. Bail instead.
  if (!existsSync(join(dataDir, 'db'))) return null;
  const state = getOrCreateState(dataDir);
  if (state.inProgress) return null;
  state.inProgress = true;
  // Optimistically clear; a mutation arriving during the dump re-sets dirty
  // (via scheduleSnapshot) so the follow-up write captures it.
  state.dirty = false;
  try {
    const db = await getDbForDir(dataDir);
    // CHECKPOINT first so the dump is internally consistent — without it
    // pg_control can point at a WAL position the snapshot captures as
    // garbage and restore PANICs (the HS-7891 guard).
    await instrumentAsync(dataDir, 'snapshot.checkpoint', () => db.exec('CHECKPOINT'));
    const blob = await db.dumpDataDir('gzip');
    const buffer = Buffer.from(await blob.arrayBuffer());
    await instrumentAsync(dataDir, 'snapshot.write', () => writeFileAtomic(snapshotPath(dataDir), buffer));
    state.lastSnapshotAt = Date.now();
    state.lastSizeBytes = buffer.length;
    return { path: snapshotPath(dataDir), sizeBytes: buffer.length, at: state.lastSnapshotAt };
  } catch (err) {
    state.dirty = true;
    console.error(`[snapshot] write failed for ${dataDir}:`, err);
    return null;
  } finally {
    state.inProgress = false;
  }
}

/**
 * Final-snapshot step for `gracefulShutdown`. Clears every project's timers
 * (so nothing reopens a DB after `closeAllDatabases`), then writes a fresh
 * snapshot for each protection-enabled project so a clean exit loses nothing.
 * Per-project failures are logged but don't block the rest of shutdown.
 */
export async function snapshotAllForShutdown(): Promise<void> {
  const dirs = Array.from(snapshotStates.keys());
  for (const dir of dirs) {
    const state = snapshotStates.get(dir);
    if (!state) continue;
    if (state.debounceTimer) { clearTimeout(state.debounceTimer); state.debounceTimer = null; }
    if (state.safetyTimer) { clearInterval(state.safetyTimer); state.safetyTimer = null; }
  }
  for (const dir of dirs) {
    if (!isSnapshotProtectionEnabled(dir)) continue;
    try {
      // HS-8724 — go through the scheduler (awaitable) so a snapshot already
      // in flight for this project coalesces and we wait for the freshest
      // write rather than bailing on its `inProgress` guard.
      await submitSnapshotJob(dir);
    } catch (err) {
      console.error(`[snapshot] shutdown snapshot failed for ${dir}:`, err);
    }
  }
}

/** Last-snapshot metadata for the Phase 2 Settings status line. */
export function getSnapshotStatus(dataDir: string): { lastSnapshotAt: number | null; lastSizeBytes: number | null } {
  const state = snapshotStates.get(dataDir);
  return {
    lastSnapshotAt: state?.lastSnapshotAt ?? null,
    lastSizeBytes: state?.lastSizeBytes ?? null,
  };
}

/**
 * Atomic file write: `tmp` + fsync + `rename`. Mirrors
 * `writeJsonExportAtomically` (`src/dbJsonExport.ts`) for a raw buffer —
 * `rename` is the only atomic step in POSIX, so a crash mid-write leaves
 * either the previous file at `path` or nothing, never a partial. The fsync
 * runs on libuv's threadpool (HS-8178) so it doesn't block the event loop on
 * a slow disk.
 */
async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.write(data);
    await handle.sync();
  } finally {
    if (handle !== null) {
      try { await handle.close(); } catch { /* close error doesn't invalidate the write */ }
    }
  }
  try {
    await fsp.rename(tmp, path);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* tmp may already be gone */ }
    throw err;
  }
}

/** Test-only — clears all timers + state so each case starts clean. */
export function _resetSnapshotStateForTests(): void {
  for (const state of snapshotStates.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.safetyTimer) clearInterval(state.safetyTimer);
  }
  snapshotStates.clear();
  defaultDataDir = null;
}
