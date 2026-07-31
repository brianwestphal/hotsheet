/**
 * HS-9535 — "has anything been written since the last backup?"
 *
 * ## Why this exists
 *
 * Measured fleet-wide (HS-9529): **58 % of consecutive 5-minute backups are
 * byte-identical**, and an idle project is 100 % — `kerf` produced 8 consecutive
 * backups whose every table was unchanged. Each of those cost a CHECKPOINT, an
 * fsync of the whole cluster, a full `dumpDataDir` + gzip, a manifest rebuild, a
 * JSON co-save and a tarball write, to produce a file indistinguishable from the
 * one before it — multiplied by nine projects on one event loop.
 *
 * ## Why the WAL LSN and not a write counter
 *
 * The ticket proposed bumping a counter from `queryInstrumentation`'s proxy on
 * "any mutating statement". That requires classifying SQL by hand, and the
 * classifier is the whole correctness argument: one unrecognised statement shape
 * and a backup is silently skipped after a real write. Data loss, from a string
 * comparison.
 *
 * PostgreSQL already maintains the authoritative answer. `pg_current_wal_lsn()`
 * advances when — and only when — something is written to the write-ahead log.
 * Measured against a real cluster on 2026-07-31:
 *
 *   - idle for 20 s          → unchanged
 *   - 200 `SELECT`s          → unchanged
 *   - one `INSERT`           → advanced
 *   - close and reopen       → advanced
 *
 * The last one matters: the LSN also moves for checkpoints, vacuum and PGLite's
 * own bookkeeping, so it can report "changed" when no user data did. That is the
 * SAFE direction — an unnecessary backup costs CPU; a skipped one costs data.
 * The first backup after any restart is therefore always taken.
 *
 * (`pg_stat_user_tables` would have been the more precise signal and is useless
 * here: PGLite runs no stats collector, so every counter reads 0 forever. Tested
 * before choosing the LSN.)
 *
 * ## The invariant
 *
 * **Never skip on doubt.** Every failure path in this module returns `null`,
 * and `shouldSkipBackup` treats `null` as "back it up". A missing marker, an
 * unreadable one, an error from the query — all mean the same thing: we do not
 * know, so we do the work.
 */

/** Opaque marker for "the state of the database's write history". */
export type ChangeMarker = string;

/** Minimal shape needed from a PGLite handle — keeps this testable without one. */
export interface MarkerQueryable {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Read the cluster's current WAL position.
 *
 * Returns `null` on any failure. A cluster that cannot answer must be backed up,
 * not skipped — see the invariant above.
 */
export async function readChangeMarker(db: MarkerQueryable): Promise<ChangeMarker | null> {
  try {
    const result = await db.query('SELECT pg_current_wal_lsn()::text AS lsn');
    const value = result.rows[0]?.lsn;
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    // Older/newer PGLite, a closed handle, a cluster mid-recovery. All the same
    // answer: we cannot tell, so do not skip.
    return null;
  }
}

/**
 * Decide whether this backup can be skipped.
 *
 * Pure, because this is the decision that can lose data and it should be
 * readable in one screen and testable without a database.
 *
 * Skips only when BOTH markers are present AND identical. Every other
 * combination — either missing, or differing — takes the backup.
 */
export function shouldSkipBackup(
  current: ChangeMarker | null,
  lastBackedUp: ChangeMarker | null | undefined,
): boolean {
  if (current === null) return false;                    // cannot read → back up
  if (lastBackedUp === null || lastBackedUp === undefined) return false; // never backed up → back up
  return current === lastBackedUp;
}

/** Key for the persisted marker map: one entry per project per tier.
 *
 *  Per TIER, not just per project: a project idle for an hour should skip its
 *  hourly backup too, and each tier last ran at a different moment. A single
 *  per-project marker would let the 5-minute tier's skip decision silently
 *  suppress the hourly one. */
export function markerKey(dataDir: string, tier: string): string {
  return `${dataDir}::${tier}`;
}
