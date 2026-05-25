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
