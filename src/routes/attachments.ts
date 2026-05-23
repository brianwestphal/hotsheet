import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { basename, extname, join, resolve } from 'path';

import { promoteDraftAttachments } from '../db/attachments.js';
import {
  addAttachment,
  addDraftAttachment,
  deleteAttachment,
  getAttachment,
  getTicket,
} from '../db/queries.js';
import { getMimeType } from '../mime-types.js';
import { revealInFileManager } from '../open-in-file-manager.js';
import type { AppEnv } from '../types.js';
import { parseIntParam } from './helpers.js';
import { notifyMutation } from './notify.js';

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.post('/tickets/:id/attachments', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ticket ID' }, 400);
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
  writeFileSync(storedPath, buffer);

  const attachment = await addAttachment(id, originalName, storedPath);
  notifyMutation(c.get('dataDir'));
  return c.json(attachment, 201);
});

/**
 * HS-8428 — POST /api/tickets/:id/feedback-drafts/:draftId/attachments.
 * Same multipart shape as the regular attachment upload route above,
 * but stamps `draft_id` on the inserted row so the attachment is
 * hidden from the ticket's main attachment list until the feedback
 * dialog's submit handler promotes the whole batch via
 * `POST /api/tickets/:id/feedback-drafts/:draftId/promote-attachments`.
 *
 * No requirement that the `feedback_drafts` row already exist — the
 * client uploads at file-select time, which is typically BEFORE the
 * user clicks Save Draft (which is when the draft row gets created).
 * Orphaned attachments (uploaded but never promoted, draft never
 * persisted, dialog closed without the client's cleanup ping firing)
 * are GC'd by the cleanup sweep, see src/cleanup.ts.
 */
attachmentRoutes.post('/tickets/:id/feedback-drafts/:draftId/attachments', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ticket ID' }, 400);
  const draftId = c.req.param('draftId');
  if (draftId === '') return c.json({ error: 'Invalid draft ID' }, 400);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const dataDir = c.get('dataDir');
  const body = await c.req.parseBody();
  const file = body['file'];
  if (typeof file === 'string') return c.json({ error: 'No file uploaded' }, 400);

  const originalName = file.name;
  const ext = extname(originalName);
  const baseName = basename(originalName, ext);
  // HS-8428 — prefix with `draft_` + the short draft id so a directory
  // scan can spot which attachments belong to a draft without hitting
  // the DB. Falls inside the same `attachments/` dir as real attachments
  // so the serving route works without change.
  const storedName = `${ticket.ticket_number}_draft_${draftId}_${baseName}${ext}`;
  const attachDir = join(dataDir, 'attachments');
  mkdirSync(attachDir, { recursive: true });
  const storedPath = join(attachDir, storedName);

  const buffer = Buffer.from(await file.arrayBuffer());
  writeFileSync(storedPath, buffer);

  const attachment = await addDraftAttachment(id, draftId, originalName, storedPath);
  notifyMutation(dataDir);
  return c.json(attachment, 201);
});

/**
 * HS-8428 — POST /api/tickets/:id/feedback-drafts/:draftId/promote-attachments.
 * Flips `draft_id` to NULL on every attachment linked to the draft,
 * making them visible to the ticket's main attachment list. Single
 * UPDATE statement so the transition is atomic. Called by the
 * feedback dialog's Submit handler right before the note text PATCH.
 * No-op (returns `{ promoted: 0 }`) if the draft has no attachments,
 * which is the common case.
 */
attachmentRoutes.post('/tickets/:id/feedback-drafts/:draftId/promote-attachments', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const draftId = c.req.param('draftId');
  if (draftId === '') return c.json({ error: 'Invalid draft ID' }, 400);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const promoted = await promoteDraftAttachments(draftId);
  notifyMutation(c.get('dataDir'));
  return c.json({ promoted: promoted.length, attachments: promoted });
});

attachmentRoutes.delete('/attachments/:id', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ID' }, 400);
  const attachment = await deleteAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);

  // Remove the file
  try { rmSync(attachment.stored_path, { force: true }); } catch { /* ignore */ }

  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// Reveal attachment in OS file manager
attachmentRoutes.post('/attachments/:id/reveal', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ID' }, 400);
  const attachment = await getAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);
  if (!existsSync(attachment.stored_path)) return c.json({ error: 'File not found on disk' }, 404);

  await revealInFileManager(attachment.stored_path);
  return c.json({ ok: true });
});

// Serve attachment files
attachmentRoutes.get('/attachments/file/*', (c) => {
  const filePath = c.req.path.replace('/api/attachments/file/', '');
  const dataDir = c.get('dataDir');
  const attachDir = resolve(join(dataDir, 'attachments'));
  const fullPath = resolve(join(attachDir, filePath));

  // Prevent directory traversal — resolved path must stay within attachments dir
  if (!fullPath.startsWith(attachDir + '/') && fullPath !== attachDir) {
    return c.json({ error: 'Invalid path' }, 403);
  }

  if (!existsSync(fullPath)) {
    return c.json({ error: 'File not found' }, 404);
  }

  const content = readFileSync(fullPath);
  const ext = extname(fullPath).toLowerCase();
  const contentType = getMimeType(ext);

  return new Response(content, {
    headers: { 'Content-Type': contentType },
  });
});
