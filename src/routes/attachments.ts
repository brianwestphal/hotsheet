import { existsSync, mkdirSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { basename, extname, join, resolve } from 'path';

import {
  addAttachment,
  deleteAttachment,
  getAttachment,
  getTicket,
} from '../db/queries.js';
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.post('/tickets/:id/attachments', async (c) => {
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

attachmentRoutes.delete('/attachments/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const attachment = await deleteAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);

  // Remove the file
  try { rmSync(attachment.stored_path, { force: true }); } catch { /* ignore */ }

  scheduleAllSync(); notifyChange();
  return c.json({ ok: true });
});

// Reveal attachment in OS file manager
attachmentRoutes.post('/attachments/:id/reveal', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const attachment = await getAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);
  if (!existsSync(attachment.stored_path)) return c.json({ error: 'File not found on disk' }, 404);

  const { execFile } = await import('child_process');
  const { dirname } = await import('path');
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', ['-R', attachment.stored_path]);
  } else if (platform === 'win32') {
    execFile('explorer', ['/select,', attachment.stored_path]);
  } else {
    execFile('xdg-open', [dirname(attachment.stored_path)]);
  }
  return c.json({ ok: true });
});

// Serve attachment files
attachmentRoutes.get('/attachments/file/*', async (c) => {
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
