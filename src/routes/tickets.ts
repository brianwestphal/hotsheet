import { rmSync } from 'fs';
import { Hono } from 'hono';

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
import { PLUGINS_ENABLED } from '../feature-flags.js';
import { getBackendForPlugin, getPluginById as getPluginMeta } from '../plugins/loader.js';
import { onTicketChanged, onTicketCreated, onTicketDeleted } from '../plugins/syncEngine.js';
import type { AppEnv, TicketFilters, TicketStatus } from '../types.js';
import { notifyMutation } from './notify.js';
import { isPluginEnabledForProject } from './plugins.js';
import {
  BatchActionSchema, CreateTicketSchema, DuplicateSchema,
  NotesBulkSchema, NotesEditSchema,   parseBody,
QueryTicketsSchema,
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

  const tickets = await getTickets(filters);
  return c.json(tickets);
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
      try { existingTags = JSON.parse(defaults.tags) as string[]; } catch { /* ignore */ }
    }
    for (const tag of bracketTags) {
      if (!existingTags.some(t => t.toLowerCase() === tag.toLowerCase())) existingTags.push(tag);
    }
    defaults.tags = JSON.stringify(existingTags);
  }

  // Read custom ticket prefix from project settings
  const { readFileSettings } = await import('../file-settings.js');
  const fileSettings = readFileSettings(c.get('dataDir'));
  const prefix = fileSettings.ticketPrefix !== undefined && fileSettings.ticketPrefix !== '' ? fileSettings.ticketPrefix : undefined;

  const ticket = await createTicket(title, defaults as Parameters<typeof createTicket>[1], prefix);
  notifyMutation(c.get('dataDir'));
  void onTicketCreated(ticket.id).catch(() => {});
  return c.json(ticket, 201);
});

ticketRoutes.get('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  const attachments = await getAttachments(id);
  const notes = parseNotes(ticket.notes);

  // Include sync info if this ticket is synced
  const { getDb: getSyncDb } = await import('../db/connection.js');
  const db = await getSyncDb();
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
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateTicketSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const ticket = await updateTicket(id, parsed.data);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  void onTicketChanged(id, parsed.data as Record<string, unknown>).catch(() => {});
  return c.json(ticket);
});

ticketRoutes.delete('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
  await deleteTicket(id);
  notifyMutation(c.get('dataDir'));
  void onTicketDeleted(id).catch(() => {});
  return c.json({ ok: true });
});

// --- Notes ---

ticketRoutes.put('/tickets/:id/notes-bulk', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(NotesBulkSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const connModule = await import('../db/connection.js');
  const db = await connModule.getDb();
  const result = await db.query(
    `UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
    [parsed.data.notes, id]
  );
  if (result.rows.length === 0) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

ticketRoutes.patch('/tickets/:id/notes/:noteId', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
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
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
  const noteId = c.req.param('noteId');
  const notes = await deleteNote(id, noteId);
  if (!notes) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json(notes);
});

ticketRoutes.delete('/tickets/:id/hard', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
  const attachments = await getAttachments(id);
  for (const att of attachments) {
    try { rmSync(att.stored_path, { force: true }); } catch { /* ignore */ }
  }
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

  switch (action) {
    case 'delete':
      await batchDeleteTickets(ids);
      for (const id of ids) void onTicketDeleted(id).catch(() => {});
      break;
    case 'restore':
      await batchRestoreTickets(ids);
      break;
    case 'category':
      await batchUpdateTickets(ids, { category: value as string });
      for (const id of ids) void onTicketChanged(id, { category: value as string }).catch(() => {});
      break;
    case 'priority': {
      const p = TicketPrioritySchema.safeParse(value);
      if (!p.success) return c.json({ error: `Invalid priority "${value}"` }, 400);
      await batchUpdateTickets(ids, { priority: p.data });
      for (const id of ids) void onTicketChanged(id, { priority: p.data }).catch(() => {});
      break;
    }
    case 'status': {
      const s = TicketStatusSchema.safeParse(value);
      if (!s.success) return c.json({ error: `Invalid status "${value}"` }, 400);
      await batchUpdateTickets(ids, { status: s.data });
      for (const id of ids) void onTicketChanged(id, { status: s.data }).catch(() => {});
      break;
    }
    case 'up_next':
      await batchUpdateTickets(ids, { up_next: value as boolean });
      for (const id of ids) void onTicketChanged(id, { up_next: value as boolean }).catch(() => {});
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
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
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
    for (const att of attachments) {
      try { rmSync(att.stored_path, { force: true }); } catch { /* ignore */ }
    }
  }
  await emptyTrash();
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// --- Up Next toggle ---

ticketRoutes.post('/tickets/:id/up-next', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ticket ID' }, 400);
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
