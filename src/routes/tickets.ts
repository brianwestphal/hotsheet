// HS-8555 — `rmSync`-and-swallow extracted into `deleteAttachmentFile`
// in `src/db/attachments.ts`; this file no longer needs a direct `fs`
// import (the route handlers all routed through that helper).
import { Hono } from 'hono';

// HS-8555 — centralized attachment-blob delete helper.
import { deleteAttachmentFile, deleteDraftAttachments, getDraftAttachments } from '../db/attachments.js';
import { getBlockedBy, isBlocked, setBlockedBy } from '../db/blockedBy.js';
import { claimById, claimNext, getClaims, release, renewLease } from '../db/claims.js';
import { getDb } from '../db/connection.js';
import { createFeedbackDraft, deleteFeedbackDraft, listFeedbackDrafts, updateFeedbackDraft } from '../db/feedbackDrafts.js';
import {
  batchDeleteTickets,
  batchRestoreTickets,
  batchUpdateTickets,
  createTicket,
  deleteNote,
  deleteTicket,
  duplicateTickets,
  editNote,
  emptyTrash,
  extractBracketTags,
  getAttachments,
  getTicket,
  getTickets,
  hardDeleteTicket,
  parseNotes,
  queryTickets,
  restoreTicket,
  toggleUpNext,
  updateTicket,
} from '../db/queries.js';
import { countSearchMatchesInExcludedStatuses, listKnownTicketPrefixes } from '../db/tickets.js';
import { readFileSettings } from '../file-settings.js';
import { TICKETS_LIST_MAX_LIMIT } from '../limits.js';
import { getBackendForPlugin, getPluginById as getPluginMeta } from '../plugins/loader.js';
import { onTicketChanged, onTicketCreated, onTicketDeleted } from '../plugins/syncEngine.js';
import { parseJsonOrNull, TagsArraySchema } from '../schemas.js';
import type { AppEnv, Ticket, TicketFilters, TicketStatus } from '../types.js';
import { onClaimNext } from '../workers/poolManager.js';
import { parseIntParam } from './helpers.js';
import { notifyMutation } from './notify.js';
import { isPluginEnabledForProject } from './plugins.js';
import {
  BatchActionSchema, BlockedBySchema, ClaimSchema, CreateTicketSchema, DuplicateSchema,
  FeedbackDraftCreateSchema, FeedbackDraftUpdateSchema,
  NotesBulkSchema, NotesEditSchema,   parseBody,
QueryTicketsSchema, ReleaseSchema,
  SortBySchema, SortDirSchema,
  TicketPrioritySchema, TicketStatusSchema, UpdateTicketSchema,
} from './validation.js';

/** All valid values for the `status` query-param filter, including virtual filters. */
const VALID_STATUS_FILTERS = new Set<string>([
  'not_started', 'started', 'completed', 'verified', 'backlog', 'archive', 'deleted',
  'open', 'non_verified', 'active',
]);

export const ticketRoutes = new Hono<AppEnv>();

// --- Tickets ---

ticketRoutes.get('/tickets', async (c) => {
  const filters: TicketFilters = {};

  const category = c.req.query('category');
  if (category !== undefined && category !== '') filters.category = category;

  const priority = c.req.query('priority');
  if (priority !== undefined && priority !== '') {
    const p = TicketPrioritySchema.safeParse(priority);
    if (!p.success) return c.json({ error: `Invalid priority "${priority}"` }, 400);
    filters.priority = p.data;
  }

  const status = c.req.query('status');
  if (status !== undefined && status !== '') {
    if (!VALID_STATUS_FILTERS.has(status)) return c.json({ error: `Invalid status filter "${status}"` }, 400);
    filters.status = status as TicketFilters['status'];
  }

  const upNext = c.req.query('up_next');
  if (upNext !== undefined) filters.up_next = upNext === 'true';

  const search = c.req.query('search');
  if (search !== undefined && search !== '') filters.search = search;

  const sortBy = c.req.query('sort_by');
  if (sortBy !== undefined && sortBy !== '') {
    const sb = SortBySchema.safeParse(sortBy);
    if (sb.success) filters.sort_by = sb.data;
  }

  const sortDir = c.req.query('sort_dir');
  if (sortDir !== undefined && sortDir !== '') {
    const sd = SortDirSchema.safeParse(sortDir);
    if (sd.success) filters.sort_dir = sd.data;
  }

  // HS-7756 — opt-in mix of normally-excluded buckets (backlog + archive)
  // when the user clicks the "Include {N} ..." rows under the multi-select
  // toolbar. Both default to false; truthy strings are 'true' / '1'.
  const includeBacklog = c.req.query('include_backlog');
  if (includeBacklog === 'true' || includeBacklog === '1') filters.include_backlog = true;
  const includeArchive = c.req.query('include_archive');
  if (includeArchive === 'true' || includeArchive === '1') filters.include_archive = true;

  // HS-8337 — optional list-mode pagination. `limit` is a positive integer
  // capped at 10000 (the same upper bound used by `countSearchMatchesInExcludedStatuses`'s
  // implicit fixed-page semantics; well above any realistic single-page
  // payload). `offset` is a non-negative integer. Bad values return 400 so
  // a client typo doesn't silently degrade to "fetch everything".
  const rawLimit = c.req.query('limit');
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0 || n > TICKETS_LIST_MAX_LIMIT) return c.json({ error: `Invalid limit "${rawLimit}"` }, 400);
    filters.limit = n;
  }
  const rawOffset = c.req.query('offset');
  if (rawOffset !== undefined && rawOffset !== '') {
    const n = Number.parseInt(rawOffset, 10);
    if (!Number.isFinite(n) || n < 0) return c.json({ error: `Invalid offset "${rawOffset}"` }, 400);
    filters.offset = n;
  }

  const tickets = await getTickets(filters);
  return c.json(tickets);
});

/**
 * HS-7756 — `GET /api/tickets/search-counts?search=<q>` — returns per-bucket
 * match counts for the supplied search query, restricted to the buckets the
 * main "active" view excludes (`backlog` + `archive`). Used by the client
 * to decide whether to render the "Include `{N}` backlog items" /
 * "Include `{N}` archive items" rows under the multi-select toolbar. Empty
 * query returns zeroes; missing query returns zeroes.
 */
ticketRoutes.get('/tickets/search-counts', async (c) => {
  const search = c.req.query('search') ?? '';
  const counts = await countSearchMatchesInExcludedStatuses(search);
  return c.json(counts);
});

/**
 * HS-8036 — `GET /api/tickets/prefixes` returns every distinct
 * ticket-number prefix that's appeared in this project's tickets, plus
 * the project's currently-configured `ticketPrefix` from
 * `settings.json` (always included, even if no tickets with that
 * prefix exist yet — which happens right after a user changes the
 * prefix and before they create the first ticket under the new one).
 * Used by the client-side ticket-reference link detector to build a
 * regex matching every legitimate ticket-number shape — so legacy
 * prefixes (a project that used to be `BUG-` and is now `HS-`) still
 * resolve when their ticket numbers appear in notes.
 */
ticketRoutes.get('/tickets/prefixes', async (c) => {
  const fileSettings = readFileSettings(c.get('dataDir'));
  const seenInDb = await listKnownTicketPrefixes();
  const prefixes = new Set<string>(seenInDb);
  if (fileSettings.ticketPrefix !== undefined && fileSettings.ticketPrefix !== '') {
    prefixes.add(fileSettings.ticketPrefix);
  }
  // Default `HS` is always added so a project with a freshly-flipped
  // custom prefix and no historical tickets still has a sane fallback.
  prefixes.add('HS');
  return c.json({ prefixes: [...prefixes].sort() });
});

// --- HS-8862 — distributed-execution claim/lease (docs/90 §90.3). Registered
//     BEFORE `/tickets/:id` so `GET /tickets/claims` isn't captured by `:id`. ---

ticketRoutes.get('/tickets/claims', async (c) => {
  return c.json({ claims: await getClaims() });
});

ticketRoutes.post('/tickets/claim-next', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ClaimSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  // HS-8962 — drain-aware: a pool worker marked draining is told to stop (and
  // flipped to `stopped`) instead of claiming, so it exits its loop *after*
  // finishing the ticket it was already on (docs/91 §91.4). Non-pool workers are
  // unaffected (drain is always false for them).
  const { drain } = onClaimNext(c.get('dataDir'), parsed.data.worker);
  if (drain) return c.json({ ticket: null, drain: true });
  const ticket = await claimNext(parsed.data.worker, parsed.data.label ?? null, parsed.data.ttlSeconds);
  if (ticket !== null) notifyMutation(c.get('dataDir'));
  return c.json({ ticket });
});

ticketRoutes.post('/tickets/:id/claim', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ClaimSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const result = await claimById(id, parsed.data.worker, parsed.data.label ?? null, parsed.data.ttlSeconds);
  if (result.ok) {
    notifyMutation(c.get('dataDir'));
    return c.json(result);
  }
  // 404 for an unknown/unclaimable ticket; 409 for a live foreign lease.
  return c.json(result, result.reason === 'conflict' ? 409 : 404);
});

ticketRoutes.post('/tickets/:id/renew-lease', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ClaimSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const result = await renewLease(id, parsed.data.worker, parsed.data.ttlSeconds);
  return c.json(result);
});

ticketRoutes.post('/tickets/:id/release', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ReleaseSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  await release(id, parsed.data.worker ?? undefined);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// HS-8865 — flat blocked_by dependency gate (docs/90 §90.6).
ticketRoutes.get('/tickets/:id/blocked-by', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const [blockedBy, blocked] = await Promise.all([getBlockedBy(id), isBlocked(id)]);
  return c.json({ blockedBy, blocked });
});

ticketRoutes.put('/tickets/:id/blocked-by', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(BlockedBySchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const result = await setBlockedBy(id, parsed.data.blockerIds);
  if (!result.ok) return c.json({ error: `blocked_by rejected: ${result.reason}`, reason: result.reason }, 400);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true, blockedBy: result.blockedBy });
});

ticketRoutes.post('/tickets', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(CreateTicketSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  let title = parsed.data.title;
  const defaults = { ...(parsed.data.defaults || {}) };

  // Extract [tag] bracket syntax from title (HS-1750)
  const { title: cleanTitle, tags: bracketTags } = extractBracketTags(title);
  if (bracketTags.length > 0) {
    title = cleanTitle || title;
    let existingTags: string[] = [];
    if (defaults.tags !== undefined) {
      // HS-8567 — zod-validate the parsed JSON; defensive fallback to []
      // preserves the pre-fix swallow-on-error behavior.
      const parsedTags = parseJsonOrNull(TagsArraySchema, defaults.tags);
      if (parsedTags !== null) existingTags = parsedTags;
    }
    for (const tag of bracketTags) {
      if (!existingTags.some(t => t.toLowerCase() === tag.toLowerCase())) existingTags.push(tag);
    }
    defaults.tags = JSON.stringify(existingTags);
  }

  // Read custom ticket prefix from project settings
  const fileSettings = readFileSettings(c.get('dataDir'));
  const prefix = fileSettings.ticketPrefix !== undefined && fileSettings.ticketPrefix !== '' ? fileSettings.ticketPrefix : undefined;

  const ticket = await createTicket(title, defaults, prefix);

  // When created via API/AI (no User-Action header), mark as unread so the user sees a blue dot
  const isUserAction = c.req.header('X-Hotsheet-User-Action') === 'true';
  if (!isUserAction) {
    await updateTicket(ticket.id, { last_read_at: '1970-01-01T00:00:00Z' });
  }

  notifyMutation(c.get('dataDir'));
  void onTicketCreated(ticket.id).catch(() => {});
  return c.json(ticket, 201);
});

/**
 * HS-8036 — `GET /api/tickets/by-number/:number` — look up a ticket
 * by its `ticket_number` (e.g. `HS-1234`) instead of its numeric id.
 * Used by the stacking ticket-reference dialog (`ticketRefDialog.tsx`)
 * which has the human-readable number from the link's
 * `data-ticket-number` attribute but no quick access to the numeric
 * id without scanning the in-memory cache.
 *
 * Returns the same shape as `GET /tickets/:id` (ticket fields only —
 * the dialog doesn't need attachments / notes / sync metadata since
 * it's read-only per HS-8036's v1 scope). 404 when the number doesn't
 * exist; the dialog shows a toast on that.
 */
ticketRoutes.get('/tickets/by-number/:number', async (c) => {
  const number = c.req.param('number');
  const db = await getDb();
  const result = await db.query<Ticket>(
    'SELECT * FROM tickets WHERE ticket_number = $1 LIMIT 1', [number],
  );
  if (result.rows.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json(result.rows[0]);
});

ticketRoutes.get('/tickets/:id', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  const attachments = await getAttachments(id);
  const notes = parseNotes(ticket.notes);

  // Include sync info if this ticket is synced
  const db = await getDb();
  const syncResult = await db.query<{ plugin_id: string; remote_id: string; sync_status: string }>(
    'SELECT plugin_id, remote_id, sync_status FROM ticket_sync WHERE ticket_id = $1', [id],
  );
  const syncInfoRaw = await Promise.all(syncResult.rows.map(async r => {
    if (!await isPluginEnabledForProject(r.plugin_id)) return null;
    const backend = getBackendForPlugin(r.plugin_id);
    const pluginMeta = getPluginMeta(r.plugin_id);
    return {
      pluginId: r.plugin_id,
      pluginName: backend?.name ?? r.plugin_id,
      pluginIcon: pluginMeta?.manifest.icon ?? null,
      remoteId: r.remote_id,
      remoteUrl: backend?.getRemoteUrl?.(r.remote_id) ?? null,
      syncStatus: r.sync_status,
    };
  }));
  const syncInfo = syncInfoRaw.filter(s => s !== null);

  return c.json({ ...ticket, notes: JSON.stringify(notes), attachments, syncInfo });
});

ticketRoutes.patch('/tickets/:id', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateTicketSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const keepRead = c.req.header('X-Hotsheet-User-Action') === 'true';
  const ticket = await updateTicket(id, parsed.data, { keepRead });
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  // Don't notify/sync for read-tracking-only changes (prevents poll loop)
  const isReadTrackingOnly = Object.keys(parsed.data).length === 1 && parsed.data.last_read_at !== undefined;
  if (!isReadTrackingOnly) {
    notifyMutation(c.get('dataDir'));
    // HS-8556 — `parsed.data` is already a typed `UpdateTicket` shape
    // from zod; the previous `as Record<string, unknown>` cast widened
    // to match `onTicketChanged`'s signature without going through any
    // runtime check. Spread into a plain object so the structural
    // assignability handles the conversion without a cast.
    void onTicketChanged(id, { ...parsed.data }).catch(() => {});
  }
  return c.json(ticket);
});

ticketRoutes.delete('/tickets/:id', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  await deleteTicket(id);
  notifyMutation(c.get('dataDir'));
  void onTicketDeleted(id).catch(() => {});
  return c.json({ ok: true });
});

// --- Notes ---

ticketRoutes.put('/tickets/:id/notes-bulk', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(NotesBulkSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const db = await getDb();
  const result = await db.query(
    `UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
    [parsed.data.notes, id]
  );
  if (result.rows.length === 0) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

ticketRoutes.patch('/tickets/:id/notes/:noteId', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const noteId = c.req.param('noteId');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(NotesEditSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const notes = await editNote(id, noteId, parsed.data.text);
  if (!notes) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json(notes);
});

ticketRoutes.delete('/tickets/:id/notes/:noteId', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const noteId = c.req.param('noteId');
  const notes = await deleteNote(id, noteId);
  if (!notes) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json(notes);
});

// --- Feedback drafts (HS-7599 / docs/21-feedback.md §21.2.3) ---

/** GET /api/tickets/:id/feedback-drafts — list every draft for this ticket
 *  in created-at order. Drafts live in their own table (NOT in
 *  `tickets.notes`) so they don't sync to GitHub / other plugins —
 *  feedback drafts are private, local-only state. The client renders each
 *  draft inline after its `parent_note_id` (if that note still exists) or
 *  as free-floating at the end of the list. */
ticketRoutes.get('/tickets/:id/feedback-drafts', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const drafts = await listFeedbackDrafts(id);
  // HS-8428 — hydrate each draft with its draft-scoped attachments so a
  // reopen surfaces the previously-uploaded files alongside the text
  // partitions. One small SELECT per draft (the typical ticket has ≤ a
  // few drafts open at a time); could be batched with a single JOIN if
  // a perf problem ever surfaces.
  const hydrated = await Promise.all(drafts.map(async d => ({
    ...d,
    attachments: await getDraftAttachments(d.id),
  })));
  return c.json(hydrated);
});

ticketRoutes.post('/tickets/:id/feedback-drafts', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(FeedbackDraftCreateSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const draft = await createFeedbackDraft({
    id: parsed.data.id,
    ticketId: id,
    parentNoteId: parsed.data.parent_note_id,
    promptText: parsed.data.prompt_text,
    partitions: parsed.data.partitions,
  });
  notifyMutation(c.get('dataDir'));
  return c.json(draft);
});

ticketRoutes.patch('/tickets/:id/feedback-drafts/:draftId', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const draftId = c.req.param('draftId');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(FeedbackDraftUpdateSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const draft = await updateFeedbackDraft(draftId, parsed.data.partitions);
  if (draft === null) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json(draft);
});

ticketRoutes.delete('/tickets/:id/feedback-drafts/:draftId', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const draftId = c.req.param('draftId');
  // HS-8428 — drop any draft-scoped attachments BEFORE the draft row
  // itself so the cleanup sweep doesn't have to mop them up. Attachments
  // are deleted by `draft_id`, not by FK cascade (we intentionally don't
  // FK to feedback_drafts.id so uploads can precede draft creation).
  // The DB rows go first, then the files on disk — surviving the rare
  // case where the DB delete succeeds but the rmSync throws (the
  // physical file leaks but `getAttachments` already excludes the row
  // by the draft_id filter, so no inconsistency surfaces).
  const droppedAttachments = await deleteDraftAttachments(draftId);
  for (const att of droppedAttachments) deleteAttachmentFile(att);
  const deleted = await deleteFeedbackDraft(draftId);
  // HS-8428 — if the draft row was already gone but the client uploaded
  // attachments (orphan-cleanup path the client fires on dialog close-
  // without-save), we still want to report success when attachments were
  // cleaned up. Return 404 only when nothing happened on either surface.
  if (!deleted && droppedAttachments.length === 0) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true, droppedAttachments: droppedAttachments.length });
});

ticketRoutes.delete('/tickets/:id/hard', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const attachments = await getAttachments(id);
  for (const att of attachments) deleteAttachmentFile(att);
  await hardDeleteTicket(id);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// --- Batch operations ---

ticketRoutes.post('/tickets/batch', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(BatchActionSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const { ids, action, value } = parsed.data;
  const keepRead = c.req.header('X-Hotsheet-User-Action') === 'true';

  switch (action) {
    case 'delete':
      await batchDeleteTickets(ids);
      for (const id of ids) void onTicketDeleted(id).catch(() => {});
      break;
    case 'restore':
      await batchRestoreTickets(ids);
      break;
    case 'category': {
      // HS-8556 — `BatchActionSchema.value` is `z.union([z.string(),
      // z.boolean()]).optional()`; the previous `as string` cast was
      // a runtime gap (a client mis-sending `true` would have flowed
      // through unchecked). Runtime-narrow + 400-on-mismatch.
      if (typeof value !== 'string' || value === '') return c.json({ error: 'category requires a non-empty string value' }, 400);
      await batchUpdateTickets(ids, { category: value }, { keepRead });
      for (const id of ids) void onTicketChanged(id, { category: value }).catch(() => {});
      break;
    }
    case 'priority': {
      const p = TicketPrioritySchema.safeParse(value);
      if (!p.success) return c.json({ error: `Invalid priority "${value}"` }, 400);
      await batchUpdateTickets(ids, { priority: p.data }, { keepRead });
      for (const id of ids) void onTicketChanged(id, { priority: p.data }).catch(() => {});
      break;
    }
    case 'status': {
      const s = TicketStatusSchema.safeParse(value);
      if (!s.success) return c.json({ error: `Invalid status "${value}"` }, 400);
      await batchUpdateTickets(ids, { status: s.data }, { keepRead });
      for (const id of ids) void onTicketChanged(id, { status: s.data }).catch(() => {});
      break;
    }
    case 'up_next': {
      // HS-8556 — runtime-narrow the union-typed `value` instead of
      // casting it via `as boolean`. Same rationale as the `category`
      // case above.
      if (typeof value !== 'boolean') return c.json({ error: 'up_next requires a boolean value' }, 400);
      await batchUpdateTickets(ids, { up_next: value }, { keepRead });
      for (const id of ids) void onTicketChanged(id, { up_next: value }).catch(() => {});
      break;
    }
    case 'mark_read':
      await batchUpdateTickets(ids, { last_read_at: new Date().toISOString() });
      break;
    case 'mark_unread':
      // Use epoch date so updated_at > last_read_at evaluates to true (shows unread dot)
      await batchUpdateTickets(ids, { last_read_at: '1970-01-01T00:00:00Z' });
      break;
  }

  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// --- Duplicate ---

ticketRoutes.post('/tickets/duplicate', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(DuplicateSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const created = await duplicateTickets(parsed.data.ids);
  notifyMutation(c.get('dataDir'));
  return c.json(created, 201);
});

// --- Restore from trash ---

ticketRoutes.post('/tickets/:id/restore', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const ticket = await restoreTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json(ticket);
});

// --- Empty trash ---

ticketRoutes.post('/trash/empty', async (c) => {
  const deleted = await getTickets({ status: 'deleted' as TicketStatus });
  for (const ticket of deleted) {
    const attachments = await getAttachments(ticket.id);
    for (const att of attachments) deleteAttachmentFile(att);
  }
  await emptyTrash();
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// --- Up Next toggle ---

ticketRoutes.post('/tickets/:id/up-next', async (c) => {
  const id = parseIntParam(c);
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const ticket = await toggleUpNext(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  void onTicketChanged(id, { up_next: ticket.up_next }).catch(() => {});
  return c.json(ticket);
});

// --- Custom view query ---

ticketRoutes.post('/tickets/query', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(QueryTicketsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const { logic, conditions, sort_by, sort_dir, required_tag, include_archived } = parsed.data;
  const tickets = await queryTickets(logic, conditions, sort_by, sort_dir, required_tag, include_archived);
  return c.json(tickets);
});
