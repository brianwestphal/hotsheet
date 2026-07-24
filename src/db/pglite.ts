import { PGlite, type PGliteOptions } from '@electric-sql/pglite';

/**
 * HS-8585 — Hot Sheet always connects to the **`template1`** database.
 *
 * PGLite 0.3.x used `template1` as its default database, so every existing
 * on-disk cluster (`<dataDir>/db/`) AND every backup / snapshot tarball has
 * our `tickets` / `attachments` / `settings` tables there. PGLite 0.4.0
 * changed the default to `postgres`. Opening an existing cluster under 0.4.x
 * WITHOUT pinning the database connects to an empty `postgres` DB — the data
 * is still on disk in `template1`, but the app sees nothing: silent data loss
 * on upgrade. (Verified empirically before the 0.4.5 bump.)
 *
 * Centralizing construction here means no callsite can forget the pin — a
 * stray `new PGlite(path)` elsewhere would silently regress every existing
 * user. Always import `createPglite` instead of constructing `PGlite` directly.
 */
export const HOTSHEET_PG_DATABASE = 'template1';

/**
 * HS-9426 (docs/127) — PGLite's built-in `defaultStartParams`, copied verbatim.
 *
 * PGLite starts its single-process postgres with these `-c` flags. The
 * `startParams` option **REPLACES** this list rather than appending to it, so to
 * add our own GUCs we must prepend the full defaults — an incomplete array makes
 * the cluster **fail to initialize** (`PGlite failed to initialize properly`).
 *
 * ⚠ This is a copy of an **unexported** internal constant, so it can DRIFT when
 * `@electric-sql/pglite` is upgraded. `pglite.startParams.test.ts` reads the
 * bundled `dist` and fails loudly if the two ever diverge — that test IS the
 * guard the HS-9426 ticket required. If it fails after a PGLite bump, re-copy the
 * `defaultStartParams=[…]` array from the dist into here.
 */
export const PGLITE_DEFAULT_START_PARAMS: readonly string[] = [
  '--single', '-F', '-O', '-j',
  '-c', 'search_path=public',
  '-c', 'exit_on_error=false',
  '-c', 'log_checkpoints=false',
  '-c', 'max_worker_processes=0',
  '-c', 'max_parallel_workers=0',
  '-c', 'max_parallel_workers_per_gather=0',
];

/**
 * HS-9426 (docs/127) — start params for a TELEMETRY cluster: the defaults plus a
 * small WAL budget. The default `max_wal_size=1GB` / `min_wal_size=80MB` is wildly
 * oversized for an append-mostly store with a ~22 MB working set, and PGLite never
 * reclaims WAL below the budget — a real telemetry cluster reached 1.0 GB of WAL
 * over 22 MB of data (HS-9422). With this budget the WAL settles to ~48–64 MB
 * across the close/reopen cycle instead. `min_wal_size` has a hard floor (16 MB
 * fails init; 32 MB is the smallest that works). `max_wal_size` is a soft target —
 * WAL still peaks during a heavy write burst, then recycles back down.
 */
export const TELEMETRY_START_PARAMS: readonly string[] = [
  ...PGLITE_DEFAULT_START_PARAMS,
  '-c', 'max_wal_size=64MB',
  '-c', 'min_wal_size=32MB',
];

/**
 * Construct a PGLite instance pinned to Hot Sheet's `template1` database.
 *
 * `dataDir` may be `undefined` for an in-memory instance (e.g. validating a
 * dumped tarball via `loadDataDir`). The `database` pin always wins over any
 * caller-supplied value — the invariant is non-negotiable.
 */
export function createPglite(dataDir: string | undefined, options: PGliteOptions = {}): PGlite {
  const merged: PGliteOptions = { ...options, database: HOTSHEET_PG_DATABASE };
  return dataDir === undefined ? new PGlite(merged) : new PGlite(dataDir, merged);
}
