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
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv, TicketCategory, TicketFilters, TicketPriority, TicketStatus } from '../types.js';
import { notifyChange } from './notify.js';

export const ticketRoutes = new Hono<AppEnv>();

// --- Tickets ---

ticketRoutes.get('/tickets', async (c) => {
  const filters: TicketFilters = {};

  const category = c.req.query('category');
  if (category !== undefined && category !== '') filters.category = category;

  const priority = c.req.query('priority');
  if (priority !== undefined && priority !== '') filters.priority = priority as TicketPriority;

  const status = c.req.query('status');
  if (status !== undefined && status !== '') filters.status = status as TicketStatus | 'open' | 'non_verified' | 'active';

  const upNext = c.req.query('up_next');
  if (upNext !== undefined) filters.up_next = upNext === 'true';

  const search = c.req.query('search');
  if (search !== undefined && search !== '') filters.search = search;

  const sortBy = c.req.query('sort_by');
  if (sortBy !== undefined && sortBy !== '') filters.sort_by = sortBy as TicketFilters['sort_by'];

  const sortDir = c.req.query('sort_dir');
  if (sortDir !== undefined && sortDir !== '') filters.sort_dir = sortDir as 'asc' | 'desc';

  const tickets = await getTickets(filters);
  return c.json(tickets);
});

ticketRoutes.post('/tickets', async (c) => {
  const body = await c.req.json<{ title: string; defaults?: Record<string, unknown> }>();
  let title = body.title || '';
  const defaults = (body.defaults || {});

  // Extract [tag] bracket syntax from title (HS-1750)
  const { title: cleanTitle, tags: bracketTags } = extractBracketTags(title);
  if (bracketTags.length > 0) {
    title = cleanTitle || title;
    // Merge bracket tags with any explicitly provided tags
    let existingTags: string[] = [];
    if (defaults.tags !== undefined && defaults.tags !== null) {
      try { existingTags = JSON.parse(defaults.tags as string) as string[]; } catch { /* ignore */ }
    }
    for (const tag of bracketTags) {
      if (!existingTags.some(t => t.toLowerCase() === tag.toLowerCase())) existingTags.push(tag);
    }
    defaults.tags = JSON.stringify(existingTags);
  }

  const ticket = await createTicket(title, defaults as Parameters<typeof createTicket>[1]);
  scheduleAllSync(); notifyChange();
  return c.json(ticket, 201);
});

ticketRoutes.get('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  const attachments = await getAttachments(id);
  // Normalize notes to ensure IDs are present
  const notes = parseNotes(ticket.notes);
  return c.json({ ...ticket, notes: JSON.stringify(notes), attachments });
});

ticketRoutes.patch('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<Partial<{
    title: string;
    details: string;
    notes: string;
    tags: string;
    category: TicketCategory;
    priority: TicketPriority;
    status: TicketStatus;
    up_next: boolean;
  }>>();
  const ticket = await updateTicket(id, body);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(ticket);
});

ticketRoutes.delete('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await deleteTicket(id);
  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

// --- Notes ---

ticketRoutes.put('/tickets/:id/notes-bulk', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ notes: string }>();
  const connModule = await import('../db/connection.js');
  const db = await connModule.getDb();
  const result = await db.query(
    `UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
    [body.notes, id]
  );
  if (result.rows.length === 0) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

ticketRoutes.patch('/tickets/:id/notes/:noteId', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const noteId = c.req.param('noteId');
  const body = await c.req.json<{ text: string }>();
  const notes = await editNote(id, noteId, body.text);
  if (!notes) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(notes);
});

ticketRoutes.delete('/tickets/:id/notes/:noteId', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const noteId = c.req.param('noteId');
  const notes = await deleteNote(id, noteId);
  if (!notes) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(notes);
});

ticketRoutes.delete('/tickets/:id/hard', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  // Clean up attachment files
  const attachments = await getAttachments(id);
  for (const att of attachments) {
    try { rmSync(att.stored_path, { force: true }); } catch { /* ignore */ }
  }
  await hardDeleteTicket(id);
  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

// --- Batch operations ---

ticketRoutes.post('/tickets/batch', async (c) => {
  const body = await c.req.json<{
    ids: number[];
    action: 'delete' | 'restore' | 'category' | 'priority' | 'status' | 'up_next';
    value?: string | boolean;
  }>();

  switch (body.action) {
    case 'delete':
      await batchDeleteTickets(body.ids);
      break;
    case 'restore':
      await batchRestoreTickets(body.ids);
      break;
    case 'category':
      await batchUpdateTickets(body.ids, { category: body.value as TicketCategory });
      break;
    case 'priority':
      await batchUpdateTickets(body.ids, { priority: body.value as TicketPriority });
      break;
    case 'status':
      await batchUpdateTickets(body.ids, { status: body.value as TicketStatus });
      break;
    case 'up_next':
      await batchUpdateTickets(body.ids, { up_next: body.value as boolean });
      break;
  }

  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

// --- Duplicate ---

ticketRoutes.post('/tickets/duplicate', async (c) => {
  const body = await c.req.json<{ ids: number[] }>();
  const created = await duplicateTickets(body.ids);
  scheduleAllSync(); notifyChange();
  return c.json(created, 201);
});

// --- Restore from trash ---

ticketRoutes.post('/tickets/:id/restore', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await restoreTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(ticket);
});

// --- Empty trash ---

ticketRoutes.post('/trash/empty', async (c) => {
  const deleted = await getTickets({ status: 'deleted' as TicketStatus });
  // Clean up attachment files for all trashed tickets
  for (const ticket of deleted) {
    const attachments = await getAttachments(ticket.id);
    for (const att of attachments) {
      try { rmSync(att.stored_path, { force: true }); } catch { /* ignore */ }
    }
  }
  await emptyTrash();
  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

// --- Up Next toggle ---

ticketRoutes.post('/tickets/:id/up-next', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await toggleUpNext(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(ticket);
});

// --- Custom view query ---

ticketRoutes.post('/tickets/query', async (c) => {
  const body = await c.req.json<{
    logic: 'all' | 'any';
    conditions: { field: string; operator: string; value: string }[];
    sort_by?: string;
    sort_dir?: string;
    required_tag?: string;
  }>();
  const tickets = await queryTickets(body.logic, body.conditions, body.sort_by, body.sort_dir, body.required_tag);
  return c.json(tickets);
});
