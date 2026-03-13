import { existsSync, mkdirSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { basename, extname, join, relative } from 'path';

import {
  addAttachment,
  batchDeleteTickets,
  batchRestoreTickets,
  batchUpdateTickets,
  createTicket,
  deleteAttachment,
  deleteTicket,
  emptyTrash,
  getAttachments,
  getSettings,
  getTicket,
  getTickets,
  getTicketStats,
  hardDeleteTicket,
  restoreTicket,
  toggleUpNext,
  updateSetting,
  updateTicket,
} from '../db/queries.js';
import { consumeSkillsCreatedFlag, ensureSkills } from '../skills.js';
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv, TicketCategory, TicketFilters, TicketPriority, TicketStatus } from '../types.js';

export const apiRoutes = new Hono<AppEnv>();

// --- Change tracking for long-poll ---
let changeVersion = 0;
let pollWaiters: Array<(version: number) => void> = [];

function notifyChange() {
  changeVersion++;
  const waiters = pollWaiters;
  pollWaiters = [];
  for (const resolve of waiters) {
    resolve(changeVersion);
  }
}

apiRoutes.get('/poll', async (c) => {
  const clientVersion = parseInt(c.req.query('version') || '0', 10);
  if (changeVersion > clientVersion) {
    return c.json({ version: changeVersion });
  }
  // Wait for a change or timeout after 30s
  const version = await Promise.race([
    new Promise<number>((resolve) => { pollWaiters.push(resolve); }),
    new Promise<number>((resolve) => { setTimeout(() => resolve(changeVersion), 30000); }),
  ]);
  return c.json({ version });
});

// --- Tickets ---

apiRoutes.get('/tickets', async (c) => {
  const filters: TicketFilters = {};

  const category = c.req.query('category');
  if (category !== undefined && category !== '') filters.category = category as TicketCategory;

  const priority = c.req.query('priority');
  if (priority !== undefined && priority !== '') filters.priority = priority as TicketPriority;

  const status = c.req.query('status');
  if (status !== undefined && status !== '') filters.status = status as TicketStatus | 'open' | 'non_verified';

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

apiRoutes.post('/tickets', async (c) => {
  const body = await c.req.json<{ title: string; defaults?: Record<string, unknown> }>();
  const ticket = await createTicket(body.title || '', body.defaults as Parameters<typeof createTicket>[1]);
  scheduleAllSync(); notifyChange();
  return c.json(ticket, 201);
});

apiRoutes.get('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  const attachments = await getAttachments(id);
  return c.json({ ...ticket, attachments });
});

apiRoutes.patch('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<Partial<{
    title: string;
    details: string;
    notes: string;
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

apiRoutes.delete('/tickets/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await deleteTicket(id);
  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

apiRoutes.delete('/tickets/:id/hard', async (c) => {
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

apiRoutes.post('/tickets/batch', async (c) => {
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

// --- Restore from trash ---

apiRoutes.post('/tickets/:id/restore', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await restoreTicket(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(ticket);
});

// --- Empty trash ---

apiRoutes.post('/trash/empty', async (c) => {
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

apiRoutes.post('/tickets/:id/up-next', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await toggleUpNext(id);
  if (!ticket) return c.json({ error: 'Not found' }, 404);
  scheduleAllSync(); notifyChange();
  return c.json(ticket);
});

// --- Attachments ---

apiRoutes.post('/tickets/:id/attachments', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const dataDir = c.get('dataDir');
  const body = await c.req.parseBody();
  const file = body['file'];

  if (typeof file === 'string') {
    return c.json({ error: 'No file uploaded' }, 400);
  }

  const originalName = file.name;
  const ext = extname(originalName);
  const baseName = basename(originalName, ext);
  const storedName = `${ticket.ticket_number}_${baseName}${ext}`;
  const attachDir = join(dataDir, 'attachments');
  mkdirSync(attachDir, { recursive: true });
  const storedPath = join(attachDir, storedName);

  // Write the file
  const buffer = Buffer.from(await file.arrayBuffer());
  const { writeFileSync } = await import('fs');
  writeFileSync(storedPath, buffer);

  const attachment = await addAttachment(id, originalName, storedPath);
  scheduleAllSync(); notifyChange();
  return c.json(attachment, 201);
});

apiRoutes.delete('/attachments/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const attachment = await deleteAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);

  // Remove the file
  try { rmSync(attachment.stored_path, { force: true }); } catch { /* ignore */ }

  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

// Serve attachment files
apiRoutes.get('/attachments/file/*', async (c) => {
  const filePath = c.req.path.replace('/api/attachments/file/', '');
  const dataDir = c.get('dataDir');
  const fullPath = join(dataDir, 'attachments', filePath);

  if (!existsSync(fullPath)) {
    return c.json({ error: 'File not found' }, 404);
  }

  const { readFileSync } = await import('fs');
  const content = readFileSync(fullPath);
  const ext = extname(fullPath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  return new Response(content, {
    headers: { 'Content-Type': contentType },
  });
});

// --- Stats ---

apiRoutes.get('/stats', async (c) => {
  const stats = await getTicketStats();
  return c.json(stats);
});

// --- Settings ---

apiRoutes.get('/settings', async (c) => {
  const settings = await getSettings();
  return c.json(settings);
});

apiRoutes.patch('/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  for (const [key, value] of Object.entries(body)) {
    await updateSetting(key, value);
  }
  return c.json({ ok: true });
});

// --- File-based settings (settings.json) ---

apiRoutes.get('/file-settings', async (c) => {
  const { readFileSettings } = await import('../file-settings.js');
  const dataDir = c.get('dataDir');
  return c.json(readFileSettings(dataDir));
});

apiRoutes.patch('/file-settings', async (c) => {
  const { writeFileSettings } = await import('../file-settings.js');
  const dataDir = c.get('dataDir');
  const body = await c.req.json<Record<string, string>>();
  const updated = writeFileSettings(dataDir, body);
  return c.json(updated);
});

// --- Worklist info & Claude skill ---

apiRoutes.get('/worklist-info', (c) => {
  const dataDir = c.get('dataDir');
  const cwd = process.cwd();
  const worklistRel = relative(cwd, join(dataDir, 'worklist.md'));
  const prompt = `Read ${worklistRel} for current work items.`;

  // Ensure skills are up-to-date (version/port changes)
  ensureSkills();
  const skillCreated = consumeSkillsCreatedFlag();

  return c.json({ prompt, skillCreated });
});

// --- Gitignore ---

apiRoutes.get('/gitignore/status', async (c) => {
  const { isGitRepo, isHotsheetGitignored } = await import('../gitignore.js');
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) return c.json({ inGitRepo: false, ignored: false });
  return c.json({ inGitRepo: true, ignored: isHotsheetGitignored(cwd) });
});

apiRoutes.post('/gitignore/add', async (c) => {
  const { ensureGitignore } = await import('../gitignore.js');
  ensureGitignore(process.cwd());
  return c.json({ ok: true });
});
