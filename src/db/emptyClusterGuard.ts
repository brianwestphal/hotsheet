import type { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { parseJsonOrNull } from '../schemas.js';

/**
 * HS-9573 — refuse to write a durability artifact from a cluster that was
 * created EMPTY over a project that demonstrably had data.
 *
 * ## The incident this exists for
 *
 * On 2026-08-04 a corrupt-open recovery crashed mid-flight (HS-9572) after it had
 * renamed `db/` aside but before it could restore. The next start found no `db/`,
 * so PGLite did the only thing it can: it created a fresh, empty cluster. Nothing
 * was corrupt anymore, so no recovery path ran and no banner appeared — the
 * project simply came up with zero tickets.
 *
 * Then the durability machinery did its job perfectly, on an empty database:
 *
 * - `writeSnapshotNow` dumped it over `snapshot.tar.gz`, destroying the canonical
 *   copy of 432 tickets (docs/73).
 * - `createBackup` wrote an empty tarball every 5 minutes, and retention rotated
 *   the good ones out tier by tier (docs/7). The hourly tier lost 12 of 13 slots
 *   before anyone noticed.
 *
 * Both systems converted themselves into copies of the loss, on schedule, in
 * silence. That is the failure this module prevents.
 *
 * ## Why the existing guard did not catch it
 *
 * `writeSnapshotNow` already refuses to write when `db/` is **missing** — it
 * anticipated "reopen would mkdir an empty cluster and overwrite the snapshot
 * with nothing" and guarded the case where the directory vanished. But here `db/`
 * very much existed. It had been created, empty, seconds earlier. Presence was
 * never the right question; **content** is.
 *
 * ## The rule
 *
 * Block only on the conjunction of three facts, because each one alone is
 * routine and only together do they mean "we are about to overwrite real data
 * with nothing":
 *
 * 1. **The cluster was created fresh this process** — not opened from existing
 *    files. A user who deletes every ticket by hand trips (2) and (3) but not
 *    this one, and their empty state is a legitimate thing to back up.
 * 2. **It currently holds zero tickets.**
 * 3. **This project is known to have held tickets before**, per the content
 *    marker below.
 *
 * A brand-new project satisfies (1) and (2) and fails (3), so its first snapshot
 * and backup are written normally.
 */

/** `.hotsheet/.db-content-marker.json` — the high-water mark of what this
 *  project's durability artifacts have actually captured. Deliberately LOCAL to
 *  `dataDir` (never `backupDir`): it is read on the artifact-write path, and
 *  `backupDir` may be a cloud File Provider where a read blocks unboundedly
 *  (docs/7 §7.10 / HS-9527). */
const CONTENT_MARKER = '.db-content-marker.json';

const ContentMarkerSchema = z.object({
  lastTicketCount: z.number(),
  at: z.string(),
});

export type ContentMarker = z.infer<typeof ContentMarkerSchema>;

/** dataDirs whose cluster this process created from nothing. Process-scoped by
 *  design — it describes what happened at THIS open, and a restart that finds a
 *  populated cluster is no longer in the dangerous state. */
const createdEmpty = new Set<string>();

/** Record that `dataDir`'s cluster was initialized rather than opened. Called
 *  from the one place that can tell the difference: the open path, which checks
 *  for `PG_VERSION` before PGLite writes it. */
export function noteClusterCreatedEmpty(dataDir: string): void {
  createdEmpty.add(dataDir);
}

/** Clear the flag — the cluster has real content again (a restore landed, or the
 *  user started working in a genuinely new project). */
export function clearClusterCreatedEmpty(dataDir: string): void {
  createdEmpty.delete(dataDir);
}

export function wasClusterCreatedEmpty(dataDir: string): boolean {
  return createdEmpty.has(dataDir);
}

/** Read the content marker. Missing / unparseable reads as "no prior data known"
 *  — the guard fails OPEN, because a marker problem must never be able to stop a
 *  healthy project from being backed up. */
export function readContentMarker(dataDir: string): ContentMarker | null {
  const path = join(dataDir, CONTENT_MARKER);
  if (!existsSync(path)) return null;
  try {
    return parseJsonOrNull(ContentMarkerSchema, readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Record what the artifact we just wrote actually contained. Best-effort: a
 *  failure here must not fail the backup/snapshot that succeeded. */
export function writeContentMarker(dataDir: string, ticketCount: number): void {
  try {
    writeFileSync(
      join(dataDir, CONTENT_MARKER),
      JSON.stringify({ lastTicketCount: ticketCount, at: new Date().toISOString() } satisfies ContentMarker, null, 2),
    );
  } catch {
    /* best effort — the artifact is the thing that matters */
  }
}

/**
 * The decision, as a pure function of the three facts. Exported separately from
 * the I/O so every branch is unit-testable without a cluster or a filesystem —
 * this is the predicate that decides whether a user keeps their data.
 */
export function shouldBlockArtifactWrite(facts: {
  createdEmpty: boolean;
  liveTicketCount: number;
  priorTicketCount: number;
}): boolean {
  return facts.createdEmpty && facts.liveTicketCount === 0 && facts.priorTicketCount > 0;
}

/** Count what a durability artifact would actually preserve. Deleted tickets are
 *  excluded to match `createBackup`'s own metadata count, so the marker and the
 *  guard speak in the same units. */
export async function countLiveTickets(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE status != 'deleted'`
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export interface ArtifactGuardVerdict {
  blocked: boolean;
  liveTicketCount: number;
  priorTicketCount: number;
}

/**
 * The live check both writers call. Returns the verdict AND the count, so the
 * caller can update the content marker after a successful write without asking
 * the database twice.
 *
 * Clears the created-empty flag as a side effect once the cluster has content:
 * whatever put rows back (a restore, or the user just working) has ended the
 * dangerous window, and leaving the flag set would arm the guard against a
 * project that has already recovered.
 */
export async function checkArtifactGuard(dataDir: string, db: PGlite): Promise<ArtifactGuardVerdict> {
  let liveTicketCount: number;
  try {
    liveTicketCount = await countLiveTickets(db);
  } catch {
    // Schema may not exist yet (a genuinely new cluster mid-init). Nothing to
    // protect and nothing to compare — let the write proceed.
    return { blocked: false, liveTicketCount: 0, priorTicketCount: 0 };
  }
  if (liveTicketCount > 0) clearClusterCreatedEmpty(dataDir);

  const priorTicketCount = readContentMarker(dataDir)?.lastTicketCount ?? 0;
  const blocked = shouldBlockArtifactWrite({
    createdEmpty: wasClusterCreatedEmpty(dataDir),
    liveTicketCount,
    priorTicketCount,
  });
  return { blocked, liveTicketCount, priorTicketCount };
}

/** The refusal log line. One shape for both writers so an incident leaves a
 *  greppable, self-explanatory trail rather than silence. */
export function logArtifactBlocked(kind: string, dataDir: string, verdict: ArtifactGuardVerdict): void {
  console.error(
    `[${kind}] REFUSING to write for ${dataDir}: this cluster was created empty this process and holds 0 tickets, `
    + `but this project last captured ${String(verdict.priorTicketCount)}. Writing would overwrite good data with nothing (HS-9573). `
    + `The previous artifacts are intact — restore from Settings → Backups, or from a preserved db-corrupt-* directory.`
  );
}

/** Test seam — the created-empty set is process-global by design. */
export function _resetEmptyClusterGuardForTests(): void {
  createdEmpty.clear();
}
