import type { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { parseJsonOrNull } from '../schemas.js';
import { clearEmptyClusterMarker, writeRecoveryMarker } from './recoveryMarker.js';

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
 * 1. **The cluster was created from nothing** — not opened from a populated one.
 *    A user who deletes every ticket by hand trips (2) and (3) but not this one,
 *    and their empty state is a legitimate thing to back up. HS-9585 made this
 *    fact PERSISTENT (`.db-created-empty.json`); it used to be process-scoped,
 *    which silently disarmed the whole guard on the next restart.
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

/**
 * `.hotsheet/.db-created-empty.json` — HS-9585. The created-empty fact, on disk.
 *
 * It used to live only in the in-memory set below, which meant the guard
 * protected a project for exactly ONE process. `noteClusterCreatedEmpty` fires
 * only when the open path finds no `PG_VERSION`, so after the first restart the
 * empty cluster *exists* and is opened rather than created — the flag was never
 * set, and the durability writers were free again. The 2026-08-04 shape
 * therefore survived a restart with the protection gone:
 *
 *   1. Recovery crashes mid-flight, `db/` is missing (HS-9572).
 *   2. Process A creates an empty cluster, arms the guard, refuses writes. Good.
 *   3. Anything restarts the server — the user, a reboot, the §45 watchdog.
 *   4. Process B OPENS the same empty cluster, the guard is silent, and the
 *      snapshot is overwritten while retention rotates the good tarballs out.
 *
 * The module's original reasoning — "a restart that finds a populated cluster is
 * no longer in the dangerous state" — is true, and is simply not the case that
 * fails. A restart that finds an EMPTY cluster is still in danger, and is the
 * one that actually happens.
 *
 * Local to `dataDir` for the same reason as the content marker: it is consulted
 * on the artifact-write path, and `backupDir` may be a cloud File Provider where
 * a read blocks unboundedly (docs/7 §7.10 / HS-9527).
 */
const CREATED_EMPTY_MARKER = '.db-created-empty.json';

const CreatedEmptyMarkerSchema = z.object({
  at: z.string(),
  /** HS-9585 — set once the user has been told (docs/135). Persisted so a
   *  dismissal survives the restart that the rest of this marker exists to
   *  survive; without it, process B would re-raise a banner the user closed. */
  surfacedAt: z.string().optional(),
});

type CreatedEmptyMarker = z.infer<typeof CreatedEmptyMarkerSchema>;

function createdEmptyPath(dataDir: string): string {
  return join(dataDir, CREATED_EMPTY_MARKER);
}

/** Missing / unparseable reads as "not created empty" — the guard fails OPEN, so
 *  a marker problem can never stop a healthy project from being backed up. */
function readCreatedEmptyMarker(dataDir: string): CreatedEmptyMarker | null {
  const path = createdEmptyPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return parseJsonOrNull(CreatedEmptyMarkerSchema, readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Best-effort — failing to persist must not fail the open that triggered it. */
function writeCreatedEmptyMarker(dataDir: string, marker: CreatedEmptyMarker): void {
  try {
    writeFileSync(createdEmptyPath(dataDir), JSON.stringify(marker, null, 2));
  } catch {
    /* best effort — the in-memory flag still protects this process */
  }
}

/** dataDirs whose cluster this process created from nothing. Kept alongside the
 *  marker so the common case costs no filesystem call, and so the guard still
 *  works for this process when the marker cannot be written. */
const createdEmpty = new Set<string>();

/** Record that `dataDir`'s cluster was initialized rather than opened. Called
 *  from the one place that can tell the difference: the open path, which checks
 *  for `PG_VERSION` before PGLite writes it. */
export function noteClusterCreatedEmpty(dataDir: string): void {
  createdEmpty.add(dataDir);
  // Don't clobber an existing marker: it may carry `surfacedAt`, and re-creating
  // an empty cluster is not a reason to re-raise a dismissed banner.
  if (readCreatedEmptyMarker(dataDir) === null) {
    writeCreatedEmptyMarker(dataDir, { at: new Date().toISOString() });
  }
}

/** Clear the fact — the cluster has real content again (a restore landed, or the
 *  user started working in a genuinely new project). Clears BOTH the in-memory
 *  flag and the on-disk marker, so the next process starts unarmed too. */
export function clearClusterCreatedEmpty(dataDir: string): void {
  createdEmpty.delete(dataDir);
  try { rmSync(createdEmptyPath(dataDir), { force: true }); } catch { /* ignore */ }
}

/** Memory OR disk. The disk half is what survives a restart; the memory half is
 *  what still works when the marker could not be written. */
export function wasClusterCreatedEmpty(dataDir: string): boolean {
  return createdEmpty.has(dataDir) || readCreatedEmptyMarker(dataDir) !== null;
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
  if (liveTicketCount > 0) {
    clearClusterCreatedEmpty(dataDir);
    // HS-9576 — rows are back, so the banner's claim ("your data is not here")
    // has stopped being true. Retract it without waiting for a dismissal.
    surfacedEmpty.delete(dataDir);
    clearEmptyClusterMarker(dataDir);
  }

  const priorTicketCount = readContentMarker(dataDir)?.lastTicketCount ?? 0;
  const blocked = shouldBlockArtifactWrite({
    createdEmpty: wasClusterCreatedEmpty(dataDir),
    liveTicketCount,
    priorTicketCount,
  });
  if (blocked) surfaceEmptyCluster(dataDir, priorTicketCount);
  return { blocked, liveTicketCount, priorTicketCount };
}

/** dataDirs already told to the user this process. Keeps the banner from being
 *  rewritten under a user who dismissed it — a blocked project trips the guard
 *  again every backup tick (5 min) and every snapshot tick, so without this the
 *  "Dismiss" button would only work for a few minutes. */
const surfacedEmpty = new Set<string>();

/**
 * HS-9576 — turn the refusal into something the user can see.
 *
 * The guard's whole value is buying time, and it buys none if the only evidence
 * is a stderr line in a process nobody is watching: the 2026-08-04 incident was
 * invisible for a day precisely because an empty project looks like a working
 * one. This writes the same `.db-recovery-marker.json` the HS-7899 corrupt-open
 * banner already reads, tagged `kind: 'empty-cluster'` so the client can say
 * what actually happened.
 *
 * **Both writers feed this, deliberately.** Snapshots and backups run on
 * different cadences and a blocked project trips both, but the user's situation
 * is one situation, not two — so the once-per-project-per-session gate below is
 * what dedupes them, rather than picking one writer and hoping it fires.
 */
function surfaceEmptyCluster(dataDir: string, priorTicketCount: number): void {
  if (surfacedEmpty.has(dataDir)) return;
  // HS-9585 — the gate is persisted as well as process-scoped, so a dismissal
  // survives the restart the created-empty marker now survives. Without this,
  // making the PROTECTION durable would have made the NAGGING durable too.
  const marker = readCreatedEmptyMarker(dataDir);
  if (marker?.surfacedAt !== undefined) { surfacedEmpty.add(dataDir); return; }
  surfacedEmpty.add(dataDir);
  writeCreatedEmptyMarker(dataDir, { at: marker?.at ?? new Date().toISOString(), surfacedAt: new Date().toISOString() });
  writeRecoveryMarker(dataDir, {
    kind: 'empty-cluster',
    // No rename happened in THIS process — a preserved directory, if one
    // exists, was left by an earlier one and is offered by the §42 picker.
    corruptPath: '',
    recoveredAt: new Date().toISOString(),
    errorMessage: '',
    priorTicketCount,
  });
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

/** Test seam — the created-empty and already-surfaced sets are process-global
 *  by design. */
export function _resetEmptyClusterGuardForTests(): void {
  createdEmpty.clear();
  surfacedEmpty.clear();
}
