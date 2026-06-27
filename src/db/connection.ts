import { AsyncLocalStorage } from 'node:async_hooks';

import { type PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { globalHotsheetDir } from '../global-dir.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { createPglite } from './pglite.js';

/** HS-7893: schema version stamp written into JSON-format backup files.
 *  Bump this manually whenever `initSchema` adds/removes/renames a column,
 *  changes a type, or adds a new table. The JSON co-save is a pure escape
 *  hatch — restoration is manual / scripted — but the version field lets
 *  a reader know whether the rows match today's schema. Start at 1; the
 *  exact value is opaque, only equality with the current code's version
 *  matters. */
export const SCHEMA_VERSION = 6; // HS-8874 — telemetry project_secret is now nullable (central non-project store)

/**
 * HS-8426 — pure helper: should this open-time error trigger the
 * preserve-and-recreate recovery flow in `recoverFromOpenFailure`?
 *
 * Two error classes qualify:
 *
 *   1. **WASM-level traps.** PGLite throws `Aborted` (the `-sASSERTIONS=0`
 *      production build's name for an emscripten assertion fault) or
 *      `RuntimeError` (the `RuntimeError: unreachable` variant) when its
 *      WASM Postgres can't even start against the on-disk cluster.
 *      Match by message substring (`Aborted` / `RuntimeError`) OR by
 *      constructor name (`RuntimeError`) — message-only matching missed
 *      the `RuntimeError: unreachable` variant before HS-7889.
 *
 *   2. **Postgres-level catalog corruption.** When the cluster opens but
 *      the system catalog is inconsistent (typical surface: the user's
 *      cluster from an older PGLite/PG version, or a partially-applied
 *      `ALTER TABLE` from an interrupted migration), PG raises errors
 *      with the substring "catalog is missing" — one example surfaced
 *      by HS-8426: "pg_attribute catalog is missing 1 attribute(s) for
 *      relation OID 16386" — from inside `initSchema`'s first DDL. These
 *      do NOT match the WASM patterns above. The phrase is specific to
 *      PG's `relcache` consistency checks and never appears in benign
 *      error paths (ENOSPC / EACCES / ENOENT).
 *
 * Other errors (`ENOSPC`, `EACCES`, `ENOENT`, schema mismatches surfaced
 * by our own code) propagate unchanged so the user sees a clean failure
 * instead of having their data preserved-aside.
 *
 * Pure: takes only the thrown value, returns a boolean. No filesystem
 * or DB access. Exported for the unit test.
 */
export function isRecoverableOpenError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  let message: string;
  if (err instanceof Error) message = err.message;
  else if (typeof err === 'string') message = err;
  else if (typeof err === 'number' || typeof err === 'boolean') message = String(err);
  else return false; // non-Error, non-primitive: no message to inspect
  const errName = err instanceof Error ? err.name : '';
  if (message.includes('Aborted')) return true;
  if (message.includes('RuntimeError')) return true;
  if (errName === 'RuntimeError') return true;
  // HS-8426 — PG-level catalog corruption (e.g. `pg_attribute catalog
  // is missing 1 attribute(s) for relation OID ...`).
  if (message.includes('catalog is missing')) return true;
  // HS-8585 — PGLite 0.4.x wraps a failed cluster open in a generic
  // `Error("PGlite failed to initialize properly")` (no `cause`), where
  // 0.3.x surfaced the raw WASM `Aborted` / `RuntimeError`. Without matching
  // it, the corrupt-open recovery + §73 auto-restore silently stop firing on
  // 0.4.x. The phrase only appears on init failure; benign fs errors
  // (ENOSPC / EACCES / ENOENT) still surface their own codes and preserve-
  // aside is non-destructive, so treating an init failure as recoverable is
  // safe even in the rare non-corruption init failure.
  if (message.includes('failed to initialize properly')) return true;
  return false;
}

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
  /** HS-8587 — when the recovery auto-restored from a Snapshot Protection
   *  source (§73), the source label (`snapshot` / `backup:<tier>:<ts>`).
   *  Absent means no good source existed and we fell back to an empty
   *  fresh cluster — the client shows the blocking restore banner in that
   *  case, but a friendly "recovered from snapshot" toast when present. */
  restoredFrom?: string;
  /** HS-8587 — ticket count in the restored cluster, for the toast. */
  restoredTicketCount?: number;
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
    // HS-8567 — zod-validate the marker file at the parse boundary.
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const RecoveryMarkerSchema = z.object({
      corruptPath: z.string(),
      recoveredAt: z.string(),
      errorMessage: z.string().optional(),
      restoredFrom: z.string().optional(),
      restoredTicketCount: z.number().optional(),
    }).loose();
    const result = RecoveryMarkerSchema.safeParse(parsed);
    if (!result.success) return null;
    return {
      corruptPath: result.data.corruptPath,
      recoveredAt: result.data.recoveredAt,
      errorMessage: result.data.errorMessage ?? '',
      restoredFrom: result.data.restoredFrom,
      restoredTicketCount: result.data.restoredTicketCount,
    };
  } catch {
    return null;
  }
}

function writeRecoveryMarker(dataDir: string, marker: DbRecoveryMarker): void {
  try {
    writeFileSync(recoveryMarkerPath(dataDir), JSON.stringify(marker, null, 2));
  } catch (writeErr: unknown) {
    const writeMessage = getErrorMessage(writeErr);
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

// HS-8717 — "pending recovery" marker. Written when a corrupt-open recovery
// CANNOT preserve `db/` aside in-process: on Windows the just-failed PGLite
// instance holds file handles under `db/` for the PROCESS LIFETIME, so
// `renameSync` (and any delete) EPERMs and no in-process retry helps. Rather
// than abort with no self-heal, recovery drops this marker and lets the process
// exit; the NEXT startup — a fresh process with no handles — completes the
// preserve+restore BEFORE opening (`completeDeferredRecovery`). On POSIX the
// in-process rename succeeds, so this marker is never written and the deferred
// path is a pure no-op.
const PENDING_RECOVERY_FILENAME = '.db-pending-recovery.json';
const MAX_DEFERRED_RECOVERY_ATTEMPTS = 3;

function pendingRecoveryPath(dataDir: string): string {
  return join(dataDir, PENDING_RECOVERY_FILENAME);
}

/** Read the pending-recovery marker (or null). A present-but-unparseable marker
 *  still counts as "pending" (attempts=1) — better to attempt recovery than to
 *  ignore a known-corrupt cluster. */
function readPendingRecovery(dataDir: string): { attempts: number } | null {
  const path = pendingRecoveryPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const result = z.object({ attempts: z.number() }).loose().safeParse(parsed);
    return { attempts: result.success ? result.data.attempts : 1 };
  } catch {
    return { attempts: 1 };
  }
}

function writePendingRecovery(dataDir: string, attempts: number): void {
  try {
    writeFileSync(pendingRecoveryPath(dataDir), JSON.stringify({ attempts, requestedAt: new Date().toISOString() }, null, 2));
  } catch (writeErr: unknown) {
    console.error('Could not write pending-recovery marker:', getErrorMessage(writeErr));
  }
}

function clearPendingRecovery(dataDir: string): void {
  try { rmSync(pendingRecoveryPath(dataDir), { force: true }); } catch { /* ignore */ }
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

// HS-8874 — per-resolution telemetry-DB context. Telemetry is now stored
// per-project (in each project's own `<dataDir>/db`) plus a centralized store
// for non-project rows (`~/.hotsheet/telemetry`). The read layer fans out
// across project DBs + central by binding the target dataDir here for each
// rollup; the writers resolve a DB per OTLP resource. See `getTelemetryDb`.
const telemetryDbDir = new AsyncLocalStorage<string>();

/** HS-8874 — run a function with a specific telemetry-DB dataDir bound to the
 *  async context. All `getTelemetryDb()` calls within resolve to that DB. */
export function runWithTelemetryDb<T>(dataDir: string, fn: () => T): T {
  return telemetryDbDir.run(dataDir, fn);
}

/** HS-8874 — centralized store for NON-project telemetry (rows that carry no
 *  `hotsheet_project` resource attr). Lives outside any project at
 *  `~/.hotsheet/telemetry` so it isn't tied to whichever project the server
 *  launched with. */
export function centralTelemetryDataDir(): string {
  // HS-8874 — `HOTSHEET_TELEMETRY_DIR` redirects the central store off
  // `~/.hotsheet/telemetry`. Production never sets it; it exists so unit tests
  // (which exercise the real writer/migration central-routing paths) isolate to
  // a temp dir instead of instantiating a PGlite cluster in the developer's real
  // home — which the rebuilt app would then read as live telemetry.
  const override = process.env.HOTSHEET_TELEMETRY_DIR;
  if (override !== undefined && override !== '') return override;
  return join(globalHotsheetDir(), 'telemetry');
}

/** Get the current data directory from async context or legacy default.
 *  Returns the `.hotsheet/` data directory path (NOT the db/ subdirectory). */
export function getDataDir(): string {
  const contextDataDir = requestDataDir.getStore();
  if (contextDataDir !== undefined) return contextDataDir;
  // HS-8718 — strip the trailing `db` segment with a separator-agnostic regex
  // so it works on Windows too (`defaultDbPath` ends in `\db` there). A
  // forward-slash-only `/\/db$/` left `\db` attached on win32, so the no-context
  // path returned `<dataDir>\db` instead of `<dataDir>` — and file-based
  // settings (auto_order / auto_context, via readProjectSettings/writeProjectSettings)
  // were then read/written under the wrong directory.
  if (defaultDbPath !== null) return defaultDbPath.replace(/[\\/]db$/, '');
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

/**
 * HS-7931 — close every cached PGLite instance. Used by `gracefulShutdown`
 * (`src/lifecycle.ts`) so every shutdown path gives PGLite a chance to
 * CHECKPOINT (the close path internally flushes WAL into the data files)
 * before the process exits. PGLite 0.3.16 does NOT remove `postmaster.pid`
 * on close — that's still cleaned up by HS-7888's stale-pid mitigation on
 * next launch. The durability win here is the CHECKPOINT, not pid removal.
 * Per-instance failures are logged but don't stop subsequent instances
 * from being closed — losing a single project's clean close is much
 * better than blocking the user's quit.
 *
 * HS-7935 — after each close, walk `<dbDir>` and explicitly `fs.fsyncSync`
 * every regular file. PGLite's NODEFS bridge silently no-ops `fsync` so
 * the close-time CHECKPOINT lands in the host kernel page cache without
 * being flushed to physical disk. The wrap closes that durability gap.
 */
export async function closeAllDatabases(): Promise<void> {
  const entries = Array.from(databases.entries());
  databases.clear();
  // Lazy-import the fsync helper so test files that mock the module don't
  // have to know about it.
  // HS-8351 — async variant so the graceful-shutdown fsync doesn't block
  // the event loop on a slow `<dataDir>/db/` (the main event loop is
  // mostly idle by this point — server is closing — but adding one
  // `await` for free correctness is the right shape).
  const { fsyncDirAsync } = await import('./fsyncWrap.js');
  for (const [dbPath, db] of entries) {
    try {
      await db.close();
    } catch (err) {
      console.error(`[db] close failed for ${dbPath}:`, err);
    }
    // Best-effort flush. Per-file errors are logged inside fsyncDirAsync.
    try {
      await fsyncDirAsync(dbPath);
    } catch (err) {
      console.error(`[db] fsync failed for ${dbPath}:`, err);
    }
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

/**
 * HS-8874 — resolve the telemetry database for the current context.
 *
 * Telemetry is now stored PER-PROJECT: each project's OTLP rows
 * (`otel_metrics` / `otel_events` / `otel_spans` / `announcer_usage`) live in
 * THAT project's own `<dataDir>/db`. Rows that carry no `hotsheet_project`
 * resource attr go to a centralized store at `~/.hotsheet/telemetry`. This
 * replaced the pre-HS-8874 single shared store (the launch-default project's
 * DB), which scattered telemetry whenever the launch project changed.
 *
 * Resolution order:
 *   1. an explicit `runWithTelemetryDb(dir)` context — used by the read-layer
 *      fan-out (per-project rollups + the central read) and by the writers
 *      (which bind the resource's target DB), and by the cleanup / clear /
 *      migration code that targets a specific project's DB;
 *   2. else the per-request `requestDataDir` context — so per-project analytics
 *      reads the project the user is viewing without an explicit wrapper;
 *   3. else the legacy `defaultDbPath` (single-project mode / tests that call
 *      `setDataDir()` without binding the request context);
 *   4. else the centralized telemetry store — the no-context fallback.
 *
 * `getDbForDir` runs the full `initSchema` (which creates the otel tables), so
 * it is safe to open the central dir the same way as any project dir.
 */
export async function getTelemetryDb(): Promise<PGlite> {
  const telemetryDir = telemetryDbDir.getStore();
  if (telemetryDir !== undefined) return getDbForDir(telemetryDir);
  const contextDataDir = requestDataDir.getStore();
  if (contextDataDir !== undefined) return getDbForDir(contextDataDir);
  // `defaultDbPath` is the `<dataDir>/db` directory; `getDbByPath` opens it
  // directly (it already exists with the schema applied).
  if (defaultDbPath !== null) return getDbByPath(defaultDbPath);
  return getDbForDir(centralTelemetryDataDir());
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

  // HS-8717 — complete any recovery a previous launch had to defer because it
  // couldn't move the corrupt `db/` aside in-process (Windows handle lock). This
  // runs BEFORE the open, in a fresh process with no handles, so the rename
  // succeeds. No-op (returns null) when there's no pending marker.
  const recovered = await completeDeferredRecovery(dbPath);
  if (recovered !== null) return recovered;

  let db: PGlite;
  try {
    db = await openAndCacheDb(dbPath);
  } catch (err: unknown) {
    return await recoverFromOpenFailure(dbPath, err, false);
  }
  // HS-8587 — integrity probe (§73.5). Catches SILENT corruption: the
  // cluster opened + `initSchema` applied, but the catalog / `tickets`
  // table is bad. A failure here forces the recovery path even though
  // `isRecoverableOpenError` wouldn't match (the open didn't throw).
  try {
    await probeIntegrity(db);
    return db;
  } catch (probeErr: unknown) {
    const m = getErrorMessage(probeErr);
    console.error('[db] integrity probe failed after open:', m);
    databases.delete(dbPath);
    try { await db.close(); } catch { /* already broken */ }
    return await recoverFromOpenFailure(dbPath, probeErr, true);
  }
}

async function openAndCacheDb(dbPath: string, loadDataDir?: Blob): Promise<PGlite> {
  const db = createPglite(dbPath, loadDataDir !== undefined ? { loadDataDir } : {});
  try {
    await db.waitReady;
    await initSchema(db);
  } catch (err) {
    // HS-8717 — close the just-failed instance so its file handles release
    // before the caller's recovery tries to move the `db/` dir aside. Best
    // effort (a half-initialized PGLite may throw from close()).
    try { await db.close(); } catch { /* half-initialized — best effort */ }
    throw err;
  }
  databases.set(dbPath, db);
  return db;
}

/**
 * HS-8587 — cheap read-only health check run once at open. `SELECT 1`
 * smoke-tests the connection; `SELECT count(*) FROM tickets` exercises the
 * catalog + the one table whose loss is unacceptable. Throws on any failure
 * (PG catalog-corruption errors surface here). Returns the ticket count for
 * the recovery marker / toast. Deliberately NOT a full `amcheck` — the goal
 * is to catch the corruption class we actually see, not every theoretical one.
 */
async function probeIntegrity(db: PGlite): Promise<number> {
  await db.query('SELECT 1');
  const res = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM tickets");
  return res.rows[0]?.c ?? 0;
}

/**
 * HS-8587 — walk the Snapshot Protection restore sources (canonical snapshot
 * first, then §7 backup tiers newest-first) and `loadDataDir` the first one
 * that loads + passes the integrity probe into a fresh `db/`. Returns the
 * live db + the source label + ticket count, or null if no source works.
 * `restore.js` is imported lazily so the `connection → backup → connection`
 * static cycle never forms.
 */
async function tryRestoreFromSources(dbPath: string, dataDir: string): Promise<{ db: PGlite; label: string; ticketCount: number } | null> {
  let sources: { path: string; label: string }[];
  try {
    const { listRestoreSources } = await import('./restore.js');
    sources = listRestoreSources(dataDir);
  } catch (e) {
    console.error('[db] could not enumerate restore sources:', e);
    return null;
  }
  for (const src of sources) {
    try {
      const buffer = readFileSync(src.path);
      const db = await openAndCacheDb(dbPath, new Blob([buffer]));
      const ticketCount = await probeIntegrity(db);
      console.error(`[db] auto-restored from ${src.label} (${ticketCount} tickets)`);
      return { db, label: src.label, ticketCount };
    } catch (e) {
      const m = getErrorMessage(e);
      console.error(`[db] restore source ${src.label} did not load: ${m}`);
      // Un-cache + wipe the partial dir before trying the next source.
      const bad = databases.get(dbPath);
      if (bad) { databases.delete(dbPath); try { await bad.close(); } catch { /* ignore */ } }
      try { rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * HS-8717 — rename a directory aside, retrying a few times on transient
 * Windows sharing-violation errors (antivirus / indexer / a sibling instance
 * mid-exit). Does NOT help the corrupt-open case on Windows — there the failed
 * PGLite instance holds `db/` for the whole process lifetime, so we give up
 * fast and let the caller DEFER to the next startup. POSIX succeeds on attempt 1.
 */
async function renameDirWithRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (renameErr: unknown) {
      const code = (renameErr as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY';
      if (!retryable || attempt >= maxAttempts) throw renameErr;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/**
 * HS-8717 — complete a deferred (Windows) recovery on startup, BEFORE any
 * PGLite open. A prior launch that hit a corrupt cluster it couldn't preserve
 * in-process left a pending-recovery marker and exited. This launch is a fresh
 * process with NO handles on `db/`, so the preserve-aside rename now succeeds:
 * move the corrupt `db/` aside, then restore the newest Snapshot-Protection
 * source into a clean `db/` (reusing `tryRestoreFromSources`). Returns the
 * restored (cached) PGlite, or null to let the caller open normally (no marker
 * / gave up / rename still blocked / no restore source). No-op on POSIX.
 */
async function completeDeferredRecovery(dbPath: string): Promise<PGlite | null> {
  const dataDir = dbPath.replace(/[\\/]db$/, '');
  const pending = readPendingRecovery(dataDir);
  if (pending === null) return null; // fast path — always on POSIX + the normal case

  if (pending.attempts > MAX_DEFERRED_RECOVERY_ATTEMPTS) {
    console.error(`[db] deferred recovery gave up after ${String(pending.attempts)} attempts; leaving the corrupt cluster for manual rescue.`);
    clearPendingRecovery(dataDir);
    return null;
  }
  if (!existsSync(dbPath)) { clearPendingRecovery(dataDir); return null; }

  console.error('[db] completing deferred recovery — a prior launch could not move the corrupt database aside in-process (Windows handle lock)…');
  const corruptPath = `${dbPath}-corrupt-${Date.now()}`;
  try {
    await renameDirWithRetry(dbPath, corruptPath);
  } catch (renameErr: unknown) {
    writePendingRecovery(dataDir, pending.attempts + 1);
    console.error(`[db] deferred recovery could not move db/ yet: ${getErrorMessage(renameErr)}`);
    return null;
  }

  const restored = await tryRestoreFromSources(dbPath, dataDir);
  writeRecoveryMarker(dataDir, {
    corruptPath,
    recoveredAt: new Date().toISOString(),
    errorMessage: 'Database was corrupt and could not be preserved in-process (Windows handle lock); recovered on the next restart.',
    ...(restored !== null ? { restoredFrom: restored.label, restoredTicketCount: restored.ticketCount } : {}),
  });
  clearPendingRecovery(dataDir);
  if (restored !== null) {
    console.error(`[db] deferred recovery restored from ${restored.label} (${String(restored.ticketCount)} tickets).`);
    return restored.db;
  }
  console.error('[db] deferred recovery: no snapshot/backup could be loaded; starting with a fresh empty database.');
  return null;
}

async function recoverFromOpenFailure(dbPath: string, err: unknown, forceRecover: boolean): Promise<PGlite> {
  const message = getErrorMessage(err);
  const stack = err instanceof Error ? err.stack : undefined;

  // `forceRecover` is set by the integrity-probe failure path (the cluster
  // opened, so `isRecoverableOpenError` won't match, but it IS corrupt).
  if (!forceRecover && !isRecoverableOpenError(err)) throw err;

  // HS-7889: surface the underlying error. The previous "appears corrupt"
  // log hid both `err.message` (e.g. "Aborted(). Build with -sASSERTIONS
  // for more info.") and PGLite's PANIC stderr line, so users saw "tickets
  // gone" with zero cause.
  console.error('Failed to open database:', message);
  if (stack !== undefined) console.error(stack);

  // HS-7888 mitigation: a stale postmaster.pid from an unclean shutdown
  // alone can block open even when the data files are healthy. Try
  // removing it and reopening before giving up. Safe because a live
  // instance is already gated by .hotsheet/.lock at the CLI layer. Only
  // meaningful for a true OPEN failure — a probe failure means the cluster
  // already opened, so there's no stale-pid block to clear. HS-8587 also
  // probes the reopened cluster so the pid-retry can't return a corrupt-
  // but-openable DB.
  if (!forceRecover && tryRemoveStalePostmasterPid(dbPath)) {
    try {
      const db = await openAndCacheDb(dbPath);
      await probeIntegrity(db);
      return db;
    } catch (retryErr: unknown) {
      const retryMessage = getErrorMessage(retryErr);
      console.error('Retry after stale postmaster.pid removal also failed:', retryMessage);
      const bad = databases.get(dbPath);
      if (bad) { databases.delete(dbPath); try { await bad.close(); } catch { /* ignore */ } }
    }
  }

  // Preserve the original directory so the user can recover it manually via
  // the disaster-recovery runbook (docs/7-backup-restore.md §7.8). Never
  // auto-delete — the data may be 100% recoverable with out-of-band tools,
  // as proven by the 2026-04-27 incident which restored 639/639 tickets.
  const dataDir = dbPath.replace(/[\\/]db$/, '');
  const corruptPath = `${dbPath}-corrupt-${Date.now()}`;
  console.error(`Database appears to be corrupt. Preserving as ${corruptPath} ...`);
  try {
    await renameDirWithRetry(dbPath, corruptPath);
  } catch (renameErr: unknown) {
    const renameMessage = getErrorMessage(renameErr);
    // HS-8717 — on Windows the just-failed PGLite open holds `db/` file handles
    // for the PROCESS LIFETIME, so it can't be renamed/deleted in-process and no
    // retry helps. Instead of aborting (FATAL, no self-heal) or deleting (data
    // loss), DEFER: drop a pending-recovery marker and let the process exit. The
    // NEXT startup runs `completeDeferredRecovery` BEFORE opening — a fresh
    // process with no handles, so the preserve+restore succeeds. On POSIX the
    // rename above succeeds, so this branch never runs.
    const prev = readPendingRecovery(dataDir);
    writePendingRecovery(dataDir, (prev?.attempts ?? 0) + 1);
    console.error(`Could not preserve corrupt database directory in-process: ${renameMessage}. Wrote a pending-recovery marker — Hot Sheet will auto-recover from the latest snapshot on the next restart.`);
    throw err;
  }

  // HS-8587 — Snapshot Protection (§73): before falling back to an empty
  // cluster, auto-restore from the canonical snapshot, then the §7 backup
  // tiers. First source that loads + passes the integrity probe wins.
  const restored = await tryRestoreFromSources(dbPath, dataDir);
  if (restored !== null) {
    // Marker carries `restoredFrom` so the client shows a friendly toast
    // ("Recovered from snapshot — N tickets") instead of the blocking banner.
    writeRecoveryMarker(dataDir, {
      corruptPath,
      recoveredAt: new Date().toISOString(),
      errorMessage: message,
      restoredFrom: restored.label,
      restoredTicketCount: restored.ticketCount,
    });
    return restored.db;
  }

  // No snapshot or backup could be restored — fall back to a fresh empty
  // cluster + the HS-7899 blocking restore banner (marker without
  // `restoredFrom`). dbPath is `<dataDir>/db`; the marker lives next to the
  // other .hotsheet/ state.
  console.error('No snapshot or backup could be restored; creating a fresh empty database.');
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
    const rmMessage = getErrorMessage(rmErr);
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

  // HS-8862 — distributed-execution claim/lease columns (docs/90 §90.2.1).
  // Orthogonal to status/up_next: NULL claimed_by ⇒ unclaimed ⇒ behavior
  // identical to today (the single-local-maintainer default never sets these).
  await db.exec(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claim_lease_expires_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS worker_label TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claim_count INTEGER NOT NULL DEFAULT 0;
    -- HS-9045 — true once a worker completes a ticket on its own branch but the
    -- work has NOT yet been integrated into the target branch; the owner clears it
    -- when it merges the branch (docs/89 §89.7). Drives the "pending merge" row
    -- styling. Defaults false so existing + owner-direct-completed tickets aren't
    -- flagged.
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_integration BOOLEAN NOT NULL DEFAULT FALSE;
    -- HS-9107 — the worker branch a pending_integration ticket's work landed on
    -- (e.g. hotsheet/worker-1), recorded by the worker when it marks the ticket
    -- merge-pending. Lets the "merge pending" badge pre-target Glassbox on the
    -- target..branch diff ("what this finished ticket added"). Nullable: owner-direct
    -- completions and pre-HS-9107 tickets have none. Cleared with pending_integration.
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS integration_branch TEXT;
    CREATE INDEX IF NOT EXISTS idx_tickets_claimed_by ON tickets(claimed_by);
  `).catch((e: unknown) => { if (e instanceof Error && !e.message.includes('already exists')) console.error('Migration error (claim columns):', e.message); });

  // HS-8865 — flat `blocked_by` dependency gate (docs/90 §90.6). A peer edge: a
  // ticket is blocked while any ticket it `blocks_on` is not completed/verified.
  // FLAT only (a scheduling gate), never a parent/child tree (sub-tasks reverted
  // 2026-03-23). claim-next excludes blocked tickets so parallel workers don't
  // grab a dependent before its prerequisites are done.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_blocked_by (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      blocks_on_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      PRIMARY KEY (ticket_id, blocks_on_ticket_id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_by_ticket ON ticket_blocked_by(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_blocked_by_blocker ON ticket_blocked_by(blocks_on_ticket_id);
  `).catch((e: unknown) => { if (e instanceof Error && !e.message.includes('already exists')) console.error('Migration error (ticket_blocked_by):', e.message); });

  // HS-8428 — draft-scoped attachments. A nullable `draft_id` lets the
  // server distinguish attachments that belong to an in-flight feedback
  // draft (rendered only inside the feedback dialog, not in the ticket's
  // main attachment list) from attachments that have been promoted to
  // the ticket. The feedback dialog uploads on file-select, links by
  // `draft_id`; on submit a single `UPDATE … SET draft_id = NULL`
  // promotes the whole batch atomically. No FK to feedback_drafts.id —
  // the client may upload before the draft row exists (orphans get
  // GC'd by the cleanup sweep, see src/cleanup.ts). Index on draft_id
  // for the promote / cleanup scans.
  await db.exec(`
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS draft_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_attachments_draft ON attachments(draft_id);
  `).catch((e: unknown) => { if (e instanceof Error && !e.message.includes('already exists')) console.error('Migration error (attachments.draft_id):', e.message); });

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

    -- HS-8144 — Claude Code OpenTelemetry raw-row tables (§67.6).
    -- Three signal types, each with its own table; JSONB attribute bags
    -- keep the schema flexible against Claude Code's evolving metric set
    -- without per-metric hand-mapped columns. Indexes target the three
    -- rollup patterns the UI surfaces in §67.10 actually run:
    --   - (project_secret, ts DESC) for per-project today/week rollups
    --   - (session_id, ts) for per-session drilldown
    --   - (prompt_id) for the per-prompt timeline modal (events + spans)
    -- See docs/67-telemetry.md for the full design + rationale.
    CREATE TABLE IF NOT EXISTS otel_metrics (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      project_secret TEXT NOT NULL,
      session_id TEXT,
      metric_name TEXT NOT NULL,
      attributes_json JSONB,
      value_json JSONB NOT NULL,
      -- HS-8600 — OTLP metric-level aggregation temporality ('delta' /
      -- 'cumulative' / NULL when unknown or N/A e.g. gauges) + isMonotonic.
      -- The dashboards SUM rows, which is only correct for DELTA; persisting
      -- these makes a future cumulative source detectable instead of silently
      -- re-inflating cost/token totals (the HS-8599 overcount class).
      aggregation_temporality TEXT,
      is_monotonic BOOLEAN
    );
    CREATE INDEX IF NOT EXISTS idx_otel_metrics_project_ts ON otel_metrics(project_secret, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_otel_metrics_session_ts ON otel_metrics(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics(metric_name);
    -- HS-8600 — additive migration for existing clusters (CREATE IF NOT EXISTS
    -- above no-ops when the table already exists).
    ALTER TABLE otel_metrics ADD COLUMN IF NOT EXISTS aggregation_temporality TEXT;
    ALTER TABLE otel_metrics ADD COLUMN IF NOT EXISTS is_monotonic BOOLEAN;

    CREATE TABLE IF NOT EXISTS otel_events (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      project_secret TEXT NOT NULL,
      session_id TEXT,
      prompt_id TEXT,
      event_name TEXT NOT NULL,
      attributes_json JSONB,
      body_json JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_otel_events_project_ts ON otel_events(project_secret, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_otel_events_session_ts ON otel_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_otel_events_prompt ON otel_events(prompt_id);

    CREATE TABLE IF NOT EXISTS otel_spans (
      id SERIAL PRIMARY KEY,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      project_secret TEXT NOT NULL,
      session_id TEXT,
      prompt_id TEXT,
      span_name TEXT NOT NULL,
      start_ts TIMESTAMPTZ NOT NULL,
      end_ts TIMESTAMPTZ NOT NULL,
      attributes_json JSONB,
      status_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_otel_spans_project_ts ON otel_spans(project_secret, start_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_otel_spans_session_ts ON otel_spans(session_id, start_ts);
    CREATE INDEX IF NOT EXISTS idx_otel_spans_prompt ON otel_spans(prompt_id);
    CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans(trace_id);

    -- HS-8730 (per-ticket cost, time-window correlation) — records when each
    -- ticket was actively being worked (its status was 'started'), so the
    -- per-ticket rollup can attribute api_request cost by timestamp instead of
    -- only the channelUI prompt marker. HS-8874/HS-8875 — lives in the OWNING
    -- project's own DB (per-project, like otel_events / announcer_usage), keyed
    -- by project_secret; getPerTicketRollup reads that project's DB so the
    -- rollup join with otel_events is single-DB.
    CREATE TABLE IF NOT EXISTS ticket_work_intervals (
      id SERIAL PRIMARY KEY,
      project_secret TEXT NOT NULL,
      ticket_number TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_twi_secret_ticket ON ticket_work_intervals(project_secret, ticket_number);
    CREATE INDEX IF NOT EXISTS idx_twi_open ON ticket_work_intervals(project_secret, ticket_number, ended_at);

    -- §78 Announcer (HS-8745). Persisted "announcement" entries: AI-generated
    -- narrated summaries of work done in a window, played back as audio (and
    -- later A/V). Per-project (lives in each project's own DB). covers_from/to
    -- record which signal time-range the entry summarizes so the reel is
    -- reconstructable; dismissed marks "mark uninteresting" (Phase 2).
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      covers_from TIMESTAMPTZ,
      covers_to TIMESTAMPTZ,
      title TEXT NOT NULL,
      script TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      dismissed BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(dismissed, position, id);
    -- HS-8749 — tier-1 text+emphasis visuals: a JSON array of key phrases
    -- (verbatim substrings of the script) the PIP renders emphasized; defaults
    -- to an empty array for older rows and curated hotsheet_announce entries.
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS emphasis TEXT NOT NULL DEFAULT '[]';
    -- HS-8772 — tier-2 visuals (§78.5/§78.7): a JSON array of visual specs (today
    -- only code diffs) the PIP renders alongside the script; empty for entries
    -- without a visual (the common case).
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS visuals TEXT NOT NULL DEFAULT '[]';
    -- HS-8803 — per-entry "listened at" wall-clock. NULL = never heard. Set when
    -- the user lands on the entry; the reel hides listened entries once an hour
    -- has passed (a grace window to scrub back), and a fresh open starts on the
    -- first NULL (non-listened) entry. The one-time backlog backfill from the
    -- old close-cursor lives in getActiveAnnouncements (the cursor is in
    -- settings.json, not reachable from this raw SQL).
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS listened_at TIMESTAMPTZ;

    -- HS-8766 — Announcer summarization token usage + cost (the user's own
    -- Anthropic API spend). Lives in the SHARED telemetry DB keyed by
    -- project_secret (like otel_metrics, via getTelemetryDb) so the per-project
    -- analytics dashboard (§71) and the cross-project stats page (§70) can
    -- aggregate it with the same project filter. One row per generate call.
    CREATE TABLE IF NOT EXISTS announcer_usage (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      project_secret TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost NUMERIC NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_announcer_usage_project_ts ON announcer_usage(project_secret, ts DESC);

    -- HS-8874 (migration efficiency) — dedupe-support indexes for the
    -- per-project telemetry migration's idempotent NOT EXISTS check. Each
    -- leads with the NOT-NULL scalar prefix of that table's natural key
    -- (migratePerProjectTelemetry's DEDUPE_KEYS), so the existence probe is an
    -- index seek to a tiny candidate set instead of a full table scan — the
    -- O(n^2) per-row scan was what wedged startup on a large telemetry DB.
    -- Non-unique (existing rows may legitimately collide; a UNIQUE constraint
    -- could fail to create on already-duplicated data).
    CREATE INDEX IF NOT EXISTS idx_otel_spans_dedupe ON otel_spans(trace_id, span_id);
    CREATE INDEX IF NOT EXISTS idx_otel_metrics_dedupe ON otel_metrics(ts, metric_name);
    CREATE INDEX IF NOT EXISTS idx_otel_events_dedupe ON otel_events(ts, event_name);
    CREATE INDEX IF NOT EXISTS idx_announcer_usage_dedupe ON announcer_usage(ts, model);
    CREATE INDEX IF NOT EXISTS idx_twi_dedupe ON ticket_work_intervals(project_secret, ticket_number, started_at);
  `);

  // HS-8874 — telemetry is now stored per-project, plus a centralized store
  // (`~/.hotsheet/telemetry`) for rows that carry NO `hotsheet_project` resource
  // attr. Central rows have a NULL `project_secret`, so the four telemetry
  // tables' `project_secret` columns must allow NULL. Pre-HS-8874 they were
  // `NOT NULL` (the single-shared-store design always had a secret). Drop the
  // constraint additively on existing clusters; new tables created by the DDL
  // above are still `NOT NULL`, so the ALTER is what makes central writes work.
  await db.exec(`
    ALTER TABLE otel_metrics ALTER COLUMN project_secret DROP NOT NULL;
    ALTER TABLE otel_events ALTER COLUMN project_secret DROP NOT NULL;
    ALTER TABLE otel_spans ALTER COLUMN project_secret DROP NOT NULL;
    ALTER TABLE announcer_usage ALTER COLUMN project_secret DROP NOT NULL;
  `).catch((e: unknown) => { if (e instanceof Error && !e.message.includes('does not exist')) console.error('Migration error (telemetry project_secret nullable):', e.message); });

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
