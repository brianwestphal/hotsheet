import { existsSync } from 'fs';
import { join } from 'path';

import { attachmentBlobsDir, indexExistingManifestEntries, restoreAttachmentBlob } from './attachmentBackup.js';
// HS-8555 — `rmSync`-and-swallow extracted into `deleteAttachmentFile`.
import { deleteAttachmentFile, getAllAttachments } from './db/attachments.js';
import { centralTelemetryDataDir, getTelemetryDb, runWithTelemetryDb, telemetryClusterDataDir } from './db/connection.js';
import { sweepOtelJsonl } from './db/otelJsonlStore.js';
import {
  deleteAttachment,
  getAttachments,
  getSettings,
  getTicketsForCleanup,
  hardDeleteTicket,
  listOrphanDraftAttachments,
  updateTicket,
} from './db/queries.js';
import { getBackupDir, readFileSettings } from './file-settings.js';
import { readGlobalConfig } from './global-config.js';
import { ORPHAN_DRAFT_ATTACHMENT_HORIZON_MS } from './limits.js';
import { readProjectList } from './project-list.js';
import { getProjectSecret } from './secret-file.js';

// HS-8558 — the orphan-attachment horizon moved to `src/limits.ts` for
// cross-file consolidation. See the rationale comment block on the
// exported constant.

export async function cleanupAttachments(dataDir: string): Promise<void> {
  try {
    const settings = await getSettings();
    const verifiedDays = parseInt(settings.verified_cleanup_days, 10) || 30;
    const trashDays = parseInt(settings.trash_cleanup_days, 10) || 3;

    const tickets = await getTicketsForCleanup(verifiedDays, trashDays);

    let archived = 0;
    let deleted = 0;
    for (const ticket of tickets) {
      if (ticket.status === 'verified') {
        // Auto-archive verified tickets (not delete).
        // HS-8548 — the cast used to read `as never` because
        // `TicketStatus` predated the addition of `'archive'`; both
        // `TicketStatus` and the `updateTicket` signature now include
        // `'archive'` directly so no cast is needed.
        await updateTicket(ticket.id, { status: 'archive' });
        archived++;
      } else {
        // Hard-delete trashed tickets and their attachment files
        const attachments = await getAttachments(ticket.id);
        for (const att of attachments) deleteAttachmentFile(att);
        await hardDeleteTicket(ticket.id);
        deleted++;
      }
    }

    // HS-8428 — GC orphan draft attachments (rows whose `draft_id` no
    // longer matches any feedback_drafts row AND whose `created_at` is
    // older than the horizon). The client tries to clean these up on
    // dialog close-without-save, but a crashed tab / killed server /
    // network hiccup at the wrong moment leaves them behind. This sweep
    // is the backstop.
    let orphans = 0;
    const orphanList = await listOrphanDraftAttachments(ORPHAN_DRAFT_ATTACHMENT_HORIZON_MS);
    for (const att of orphanList) {
      deleteAttachmentFile(att);
      await deleteAttachment(att.id);
      orphans++;
    }

    if (archived > 0 || deleted > 0 || orphans > 0) {
      const parts: string[] = [];
      if (archived > 0) parts.push(`archived ${archived} verified ticket(s)`);
      if (deleted > 0) parts.push(`deleted ${deleted} trashed ticket(s)`);
      if (orphans > 0) parts.push(`GC'd ${orphans} orphan draft attachment(s)`);
      console.log(`  Cleanup: ${parts.join(', ')}.`);
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
  }

  // HS-8783 — self-heal attachment rows whose file was deleted out-of-band.
  await cleanupOrphanedAttachments(dataDir);
}

/**
 * HS-8783 / HS-8802 — self-heal attachment rows whose `stored_path` file was
 * removed out-of-band (deleted/pruned while the DB row lingers). For each
 * missing-file row:
 *  - **Recoverable** (content still in the backup store via a manifest cross-ref
 *    blob) → **restore** it: copy the blob back to `stored_path` so the broken
 *    image / 404 in the detail panel self-heals (HS-8802). A row that's
 *    recoverable but whose copy fails is left untouched to retry next sweep.
 *  - **Unrecoverable** (no cross-ref blob) → prune the row, mirroring the
 *    manual-reanalyze guard (`attachmentBackup.ts`).
 * Skips entirely when the backup root isn't present (e.g. a temporarily-
 * unmounted custom `backupDir`): without a readable store we can neither restore
 * nor prove non-recoverability, so we never risk a wrongful delete. Returns the
 * pruned + restored counts. Runs in the active project's DB context (caller
 * wraps it in `runWithDataDir`).
 */
export async function cleanupOrphanedAttachments(dataDir: string): Promise<{ pruned: number; restored: number }> {
  try {
    const backupRoot = getBackupDir(dataDir);
    if (!existsSync(backupRoot)) return { pruned: 0, restored: 0 };

    const missing = (await getAllAttachments()).filter(a => !existsSync(a.stored_path));
    if (missing.length === 0) return { pruned: 0, restored: 0 };

    const index = indexExistingManifestEntries(backupRoot);
    const blobsDir = attachmentBlobsDir(backupRoot);
    let pruned = 0;
    let restored = 0;
    for (const att of missing) {
      const xref = index.get(att.id);
      if (xref !== undefined && existsSync(join(blobsDir, xref.sha))) {
        // HS-8802 — content is still in the backup store: restore it instead of
        // leaving a broken row. The file is known-missing (filtered above), so
        // there's no live file to trample; restoring to the original
        // `stored_path` keeps the DB row valid with no rewrite.
        if (await restoreAttachmentBlob(blobsDir, xref.sha, att.stored_path)) restored++;
        continue; // recoverable — keep the row whether or not the copy succeeded
      }
      await deleteAttachment(att.id);
      pruned++;
    }
    if (pruned > 0 || restored > 0) {
      const parts: string[] = [];
      if (restored > 0) parts.push(`restored ${String(restored)} attachment file(s) from backups`);
      if (pruned > 0) parts.push(`pruned ${String(pruned)} attachment row(s) whose file is missing and unrecoverable from backups`);
      console.log(`  Cleanup: ${parts.join(', ')}.`);
    }
    return { pruned, restored };
  } catch (err) {
    console.error('Orphaned-attachment cleanup failed:', err);
    return { pruned: 0, restored: 0 };
  }
}

/**
 * HS-8154 — telemetry retention sweep (§67.6). Deletes `otel_metrics` /
 * `otel_events` / `otel_spans` rows older than the per-project
 * `telemetry_retention_days` setting (default 30, `0` = keep forever).
 *
 * Hooked into the same once-per-startup call point as
 * `cleanupAttachments` so we don't add a new timer. A future ticket
 * can add a periodic timer if long-running sessions show enough row
 * growth between startups to matter; at single-user scale today the
 * startup sweep is sufficient.
 *
 * Returns `{ deleted }` for tests; the function also logs a one-line
 * summary to stdout when rows were actually deleted, mirroring the
 * `cleanupAttachments` log shape.
 *
 * **HS-8607 — scopes deletion to THIS project's `project_secret`.**
 *
 * **HS-8874** — telemetry is now stored per-project (each project's own DB).
 * The sweep runs in THIS project's telemetry DB context (`runWithTelemetryDb`)
 * and deletes only rows whose `project_secret` matches — the secret filter is
 * defense-in-depth, since a non-destructively-migrated DB may still hold
 * un-deleted foreign rows. The cross-project driver
 * (`cleanupAllProjectsTelemetry`) iterates every project DB + the central
 * store. The `dataDir` passed in is BOTH the settings source AND the target
 * telemetry DB.
 *
 * **HS-8890 (§85.2.2/85.2.3) — per-table windows + span row cap.** `otel_spans`
 * (§68 enhanced tracing, high-volume) uses a SHORTER window — the per-project
 * `telemetry_span_retention_days` (default 7), while metrics + events keep the
 * `telemetry_retention_days` window (default 30). `0` keeps a window forever for
 * either group. After the time-based deletes, a hard **row cap**
 * (`SPAN_ROW_CAP`) trims `otel_spans` to its newest N as a burst backstop the
 * time window can't provide — applied even when the span window is "forever",
 * since it's a safety limit, not a retention preference.
 */
export async function cleanupTelemetryRows(dataDir: string): Promise<{ deleted: number }> {
  try {
    const settings = readFileSettings(dataDir);
    const metricsDays = typeof settings.telemetry_retention_days === 'number' ? settings.telemetry_retention_days : 30;
    const spanDays = typeof settings.telemetry_span_retention_days === 'number' ? settings.telemetry_span_retention_days : DEFAULT_SPAN_RETENTION_DAYS;

    // HS-8607 — can't scope a deletion without the project's secret; bail
    // rather than risk an unscoped DELETE across the project's DB.
    const secret = getProjectSecret(dataDir) || null; // HS-8999 — sidecar secret
    if (secret === null) return { deleted: 0 };

    const deleted = await runWithTelemetryDb(dataDir, async () => {
      const db = await getTelemetryDb();
      let n = 0;
      // Metrics + events: the `telemetry_retention_days` window (`ts` column).
      // `0` (or <= 0) means "keep forever" per §67.6.
      if (metricsDays > 0) {
        for (const table of ['otel_metrics', 'otel_events'] as const) {
          const result = await db.query(
            `DELETE FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval AND project_secret = $2`,
            [String(metricsDays), secret],
          );
          n += result.affectedRows ?? 0;
        }
      }
      // HS-9229 — verbose inspector-only events get a SHORTER window than the
      // general metrics/events window, since they're the bulk and no stats query
      // reads them. Independent of `metricsDays` so it bounds even a "forever" (0)
      // general window.
      n += await deleteVerboseEventsOlderThan(db, secret);
      // Spans: the shorter `telemetry_span_retention_days` window (`start_ts`).
      if (spanDays > 0) {
        const spansResult = await db.query(
          `DELETE FROM otel_spans WHERE start_ts < NOW() - ($1 || ' days')::interval AND project_secret = $2`,
          [String(spanDays), secret],
        );
        n += spansResult.affectedRows ?? 0;
      }
      // HS-8890 / HS-9229 — hard row caps (burst backstops, independent of the
      // windows) for all three high-volume tables.
      n += await capSpanRows(db, secret);
      n += await capTableRows(db, 'otel_events', 'ts', secret, EVENT_ROW_CAP);
      n += await capTableRows(db, 'otel_metrics', 'ts', secret, METRIC_ROW_CAP);
      return n;
    });

    // HS-9236 — age-delete the rotating JSONL raw store alongside the raw-table
    // sweep, using the SAME windows (events/metrics at `telemetry_retention_days`,
    // spans at `telemetry_span_retention_days`). The files live in the cluster dir
    // (outside `db/`); best-effort so a JSONL sweep failure never fails the sweep.
    try {
      const jsonlDir = telemetryClusterDataDir(dataDir);
      const now = new Date();
      await sweepOtelJsonl(jsonlDir, metricsDays, now, ['events', 'metrics']);
      await sweepOtelJsonl(jsonlDir, spanDays, now, ['spans']);
    } catch (err) {
      console.debug('[otel] jsonl sweep failed:', err);
    }

    if (deleted > 0) {
      console.log(`  Telemetry retention sweep: deleted ${String(deleted)} row(s) (metrics/events > ${String(metricsDays)}d, verbose events > ${String(DEFAULT_VERBOSE_EVENT_RETENTION_DAYS)}d, spans > ${String(spanDays)}d; caps span/event/metric ${String(SPAN_ROW_CAP)}/${String(EVENT_ROW_CAP)}/${String(METRIC_ROW_CAP)}).`);
    }
    return { deleted };
  } catch (err) {
    console.error('Telemetry retention sweep failed:', err);
    return { deleted: 0 };
  }
}

/** HS-8890 (§85.2.2) — default `otel_spans` retention window (days) when
 *  `telemetry_span_retention_days` / `centralSpanRetentionDays` is unset. Shorter
 *  than the 30-day metrics/events default because §68 spans are high-volume. */
export const DEFAULT_SPAN_RETENTION_DAYS = 7;

/** HS-8890 (§85.2.3) — hard cap on `otel_spans` row count per project secret, a
 *  burst backstop the time window can't provide (one heavy day can write far more
 *  than the window's worth). Keep the newest N; trim the rest by `start_ts`. */
export const SPAN_ROW_CAP = 500_000;

/** HS-9229 (§85.2.3, epic HS-9226 Phase 0) — the same burst backstop for the
 *  high-frequency `otel_events` / `otel_metrics` tables, which previously had ONLY
 *  the age window and no row cap (the §85 gap that let them grow to 563 MB / 203 MB
 *  unbounded). Sized to match spans — a runaway-burst limit, NOT the primary bound
 *  (that's the age window + the shorter verbose-event window below). */
export const EVENT_ROW_CAP = 500_000;
export const METRIC_ROW_CAP = 500_000;

/** HS-9229 — high-frequency, inspector-only event names that no stats query reads
 *  (the §68 event list / debug views are their only consumers). They're the bulk
 *  of `otel_events`, so they get a SHORTER age window than human-meaningful events.
 *  Deliberately EXCLUDES `api_request` (per-ticket cost attribution), `user_prompt`
 *  / `assistant_response` (human-meaningful, tiny), and the `token.usage` /
 *  `cost.usage` metrics — all of which keep the full `telemetry_retention_days`
 *  window. Names are matched in BOTH the bare and `claude_code.`-prefixed forms
 *  Claude Code emits (mirrors `eventNameMatchSql`). */
export const VERBOSE_EVENT_BASE_NAMES = [
  'hook_execution_start',
  'hook_execution_complete',
  'tool_result',
  'tool_decision',
] as const;

/** HS-9229 — default age window (days) for the verbose inspector-only events
 *  above. Mirrors the §85 span window (7d) since these are the same kind of
 *  high-volume, inspector-only telemetry. Independent of `telemetry_retention_days`
 *  so it bounds the bulk even when the general window is "keep forever" (`0`). */
export const DEFAULT_VERBOSE_EVENT_RETENTION_DAYS = 7;

/** Expand the verbose base names into the dual (bare + `claude_code.`-prefixed)
 *  forms Claude Code emits, as an `IN (...)` parameter list. */
function verboseEventNames(): string[] {
  return VERBOSE_EVENT_BASE_NAMES.flatMap(n => [n, `claude_code.${n}`]);
}

/**
 * HS-9229 — delete the verbose inspector-only events older than `days` for
 * `secret` (`null` = central NULL-secret rows). Runs in the CURRENT telemetry DB
 * context. No-op when `days <= 0`. Returns rows deleted.
 */
export async function deleteVerboseEventsOlderThan(
  db: Awaited<ReturnType<typeof getTelemetryDb>>,
  secret: string | null,
  days: number = DEFAULT_VERBOSE_EVENT_RETENTION_DAYS,
): Promise<number> {
  if (days <= 0) return 0;
  const names = verboseEventNames();
  const secretClause = secret === null ? 'project_secret IS NULL' : 'project_secret = $1';
  const baseParams = secret === null ? [] : [secret];
  // Placeholders for the IN list, after the secret param (if any) and the days param.
  const start = baseParams.length + 2; // $1 (secret?) + $N days, then names
  const inPlaceholders = names.map((_, i) => `$${String(start + i)}`).join(', ');
  const daysParam = `$${String(baseParams.length + 1)}`;
  const res = await db.query(
    `DELETE FROM otel_events
       WHERE ${secretClause}
         AND ts < NOW() - (${daysParam} || ' days')::interval
         AND event_name IN (${inPlaceholders})`,
    [...baseParams, String(days), ...names],
  );
  return res.affectedRows ?? 0;
}

/**
 * Trim a telemetry `table` for `secret` (pass `null` for the central NULL-secret
 * rows) down to the newest `cap` by its timestamp column, deleting the oldest
 * overflow. Runs in the CURRENT telemetry DB context. Returns the number of rows
 * deleted. A no-op when at/under the cap. Applied unconditionally by the sweep —
 * it's a safety limit, so it bounds even a "keep forever" (`0`-day) window. `cap`
 * is a parameter so tests can exercise it without inserting half a million rows.
 * Exported for unit testing.
 *
 * `table` + `tsColumn` are caller-supplied literals (never user input) — the only
 * call sites pass the fixed `otel_*` table names + their `ts`/`start_ts` columns.
 */
export async function capTableRows(
  db: Awaited<ReturnType<typeof getTelemetryDb>>,
  table: 'otel_spans' | 'otel_events' | 'otel_metrics',
  tsColumn: 'ts' | 'start_ts',
  secret: string | null,
  cap: number,
): Promise<number> {
  const secretClause = secret === null ? 'project_secret IS NULL' : 'project_secret = $1';
  const params = secret === null ? [] : [secret];
  const countRes = await db.query<{ c: bigint | number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE ${secretClause}`,
    params,
  );
  const count = Number(countRes.rows[0]?.c ?? 0);
  if (count <= cap) return 0;
  const overflow = count - cap;
  // Delete the oldest `overflow` rows by the timestamp column (ties broken by
  // `id`). PGLite supports a `LIMIT` subquery in the `DELETE ... WHERE id IN (...)` form.
  const capParam = secret === null ? '$1' : '$2';
  const delRes = await db.query(
    `DELETE FROM ${table} WHERE id IN (
       SELECT id FROM ${table} WHERE ${secretClause}
       ORDER BY ${tsColumn} ASC, id ASC LIMIT ${capParam}
     )`,
    [...params, overflow],
  );
  return delRes.affectedRows ?? 0;
}

/**
 * Trim `otel_spans` down to `cap` (default `SPAN_ROW_CAP`). Thin wrapper over
 * {@link capTableRows} kept for its existing callers + tests.
 */
export async function capSpanRows(
  db: Awaited<ReturnType<typeof getTelemetryDb>>,
  secret: string | null,
  cap: number = SPAN_ROW_CAP,
): Promise<number> {
  return capTableRows(db, 'otel_spans', 'start_ts', secret, cap);
}

/**
 * HS-8607 — sweep telemetry retention for EVERY registered project, not
 * just the launched one. Because all telemetry shares the primary DB
 * (keyed by `project_secret`), a per-launched-project sweep left every
 * OTHER project's rows un-pruned forever — `initProject` only runs the
 * sweep for the `dataDir` it was launched with. This iterates the
 * persisted project list (`~/.hotsheet/projects.json`) plus the launched
 * `dataDir` (deduped, in case it isn't listed yet) and delegates each to
 * `cleanupTelemetryRows`, so every project's rows get pruned by their own
 * secret + retention window. Per-project failures are already swallowed
 * inside `cleanupTelemetryRows`, so one bad settings file can't abort the
 * rest of the sweep.
 */
export async function cleanupAllProjectsTelemetry(launchedDataDir: string): Promise<{ deleted: number }> {
  const dataDirs = new Set<string>([launchedDataDir, ...readProjectList()]);
  let deleted = 0;
  for (const dir of dataDirs) {
    const result = await cleanupTelemetryRows(dir);
    deleted += result.deleted;
  }
  // HS-8874 — also sweep the centralized store (`~/.hotsheet/telemetry`), which
  // holds the no-`hotsheet_project` rows (NULL `project_secret`). It has no
  // per-project retention setting, so it uses the default 30-day window.
  deleted += (await cleanupCentralTelemetry()).deleted;
  return { deleted };
}

/** HS-8874 / HS-8877 — retention window (days) for the centralized telemetry
 *  store. Central rows carry a NULL `project_secret` and there's no project
 *  settings file, so the window comes from the global config key
 *  `centralTelemetryRetentionDays` (HS-8877), falling back to the §67.6 default
 *  of 30 days. A value of `0` means "keep forever" (matches the per-project
 *  retention semantics), so the sweep is skipped. */
const DEFAULT_CENTRAL_TELEMETRY_RETENTION_DAYS = 30;

function centralTelemetryRetentionDays(): number {
  const configured = readGlobalConfig().centralTelemetryRetentionDays;
  return typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_CENTRAL_TELEMETRY_RETENTION_DAYS;
}

/** HS-8890 (§85.2.2) — central-store span window. Like the per-project
 *  `telemetry_span_retention_days`, central spans use the global
 *  `centralSpanRetentionDays`, defaulting to the §85 7-day span default; `0`
 *  keeps central spans forever. */
function centralSpanRetentionDays(): number {
  const configured = readGlobalConfig().centralSpanRetentionDays;
  return typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_SPAN_RETENTION_DAYS;
}

async function cleanupCentralTelemetry(): Promise<{ deleted: number }> {
  const retentionDays = centralTelemetryRetentionDays();
  const spanDays = centralSpanRetentionDays();
  try {
    const deleted = await runWithTelemetryDb(centralTelemetryDataDir(), async () => {
      const db = await getTelemetryDb();
      let n = 0;
      // Metrics + events: central window. `0` = keep forever (skip).
      if (retentionDays > 0) {
        for (const table of ['otel_metrics', 'otel_events'] as const) {
          const result = await db.query(
            `DELETE FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval AND project_secret IS NULL`,
            [String(retentionDays)],
          );
          n += result.affectedRows ?? 0;
        }
      }
      // HS-9229 — verbose inspector-only events: shorter window on the central
      // NULL-secret rows too.
      n += await deleteVerboseEventsOlderThan(db, null);
      // Spans: shorter central span window (HS-8890). `0` = keep forever (skip).
      if (spanDays > 0) {
        const spansResult = await db.query(
          `DELETE FROM otel_spans WHERE start_ts < NOW() - ($1 || ' days')::interval AND project_secret IS NULL`,
          [String(spanDays)],
        );
        n += spansResult.affectedRows ?? 0;
      }
      // HS-8890 / HS-9229 — hard row caps on the central NULL-secret rows too.
      n += await capSpanRows(db, null);
      n += await capTableRows(db, 'otel_events', 'ts', null, EVENT_ROW_CAP);
      n += await capTableRows(db, 'otel_metrics', 'ts', null, METRIC_ROW_CAP);
      return n;
    });
    if (deleted > 0) {
      console.log(`  Central telemetry retention sweep: deleted ${String(deleted)} row(s) (metrics/events > ${String(retentionDays)}d, verbose events > ${String(DEFAULT_VERBOSE_EVENT_RETENTION_DAYS)}d, spans > ${String(spanDays)}d; caps span/event/metric ${String(SPAN_ROW_CAP)}/${String(EVENT_ROW_CAP)}/${String(METRIC_ROW_CAP)}).`);
    }
    return { deleted };
  } catch (err) {
    console.error('Central telemetry retention sweep failed:', err);
    return { deleted: 0 };
  }
}
