import { createReadStream, promises as fsp } from 'fs';
import { Hono } from 'hono';
import { basename, extname, join, resolve, sep } from 'path';
import { Readable } from 'stream';

import { CopyAttachmentsReqSchema } from '../api/attachments.js';
import { attachmentBlobsDir, indexExistingManifestEntries, restoreAttachmentBlob } from '../attachmentBackup.js';
import { backupFsFor, isBackupFsAvailable } from '../backupFs.js';
import { promoteDraftAttachments } from '../db/attachments.js';
import { runWithDataDir } from '../db/connection.js';
import {
  addAttachment,
  addDraftAttachment,
  deleteAttachment,
  getAllAttachments,
  getAttachment,
  getAttachments,
  getTicket,
} from '../db/queries.js';
import { getBackupDir } from '../file-settings.js';
import { getMimeType } from '../mime-types.js';
import { revealInFileManager } from '../open-in-file-manager.js';
import { getProjectBySecret } from '../projects.js';
import type { AppEnv } from '../types.js';
import { parseIntParam, tryParseBody } from './helpers.js';
import { notifyMutation } from './notify.js';
import { emitSync } from './syncEmit.js';

export const attachmentRoutes = new Hono<AppEnv>();

/**
 * HS-9570 — async replacement for `existsSync`. `dataDir` is user-chosen, so it
 * can sit on iCloud / Dropbox / a network share, where a synchronous stat is an
 * unbounded block on the event loop (docs/134 §134.10; the same shape as the
 * HS-9527 death).
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Cap on the collision-suffix search below. */
const MAX_NAME_COLLISIONS = 1000;

/**
 * First free `<base><suffix?><ext>` inside `dir`, or `null` if the cap is hit.
 *
 * The cap replaces an unbounded `while (existsSync(...))`. That loop assumed it
 * would terminate quickly, which is true right up until it isn't — and each
 * iteration was a synchronous stat, so a pathological case would have pinned the
 * loop rather than merely being slow. Bounding it costs nothing and removes the
 * question.
 */
async function uniqueAttachmentPath(dir: string, base: string, ext: string): Promise<string | null> {
  for (let n = 0; n <= MAX_NAME_COLLISIONS; n++) {
    const name = n === 0 ? `${base}${ext}` : `${base}_${String(n)}${ext}`;
    const candidate = join(dir, name);
    if (!await fileExists(candidate)) return candidate;
  }
  return null;
}

attachmentRoutes.post('/tickets/:id/attachments', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ticket ID' }, 400);
  const ticket = await getTicket(id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const dataDir = c.get('dataDir');
  const body = await tryParseBody(c);
  if (body === null) return c.json({ error: 'Malformed upload body' }, 400);
  const file = body['file'];

  // Narrow to a real File: a missing field is `undefined` and a text field is a
  // string — both mean no upload (HS-9227 — `undefined` previously fell through
  // to `file.name` and threw).
  if (!(file instanceof File)) {
    return c.json({ error: 'No file uploaded' }, 400);
  }

  const originalName = file.name;
  const ext = extname(originalName);
  const baseName = basename(originalName, ext);
  const storedName = `${ticket.ticket_number}_${baseName}${ext}`;
  const attachDir = join(dataDir, 'attachments');
  await fsp.mkdir(attachDir, { recursive: true });
  const storedPath = join(attachDir, storedName);

  // Write the file. HS-9570 — async: `dataDir` is user-chosen, and a project on
  // a cloud/network mount makes a sync write an unbounded block on the loop.
  const buffer = Buffer.from(await file.arrayBuffer());
  await fsp.writeFile(storedPath, buffer);

  const attachment = await addAttachment(id, originalName, storedPath);
  notifyMutation(c.get('dataDir'));
  emitSync(c, { type: 'attachment-added', ticketId: id, attachment: { ...attachment } });
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
  const body = await tryParseBody(c);
  if (body === null) return c.json({ error: 'Malformed upload body' }, 400);
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'No file uploaded' }, 400);

  const originalName = file.name;
  const ext = extname(originalName);
  const baseName = basename(originalName, ext);
  // HS-8428 — prefix with `draft_` + the short draft id so a directory
  // scan can spot which attachments belong to a draft without hitting
  // the DB. Falls inside the same `attachments/` dir as real attachments
  // so the serving route works without change.
  const storedName = `${ticket.ticket_number}_draft_${draftId}_${baseName}${ext}`;
  const attachDir = join(dataDir, 'attachments');
  await fsp.mkdir(attachDir, { recursive: true });
  const storedPath = join(attachDir, storedName);

  const buffer = Buffer.from(await file.arrayBuffer());
  await fsp.writeFile(storedPath, buffer);

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
  // Promotion makes the (previously draft-hidden) attachments visible on the ticket.
  for (const att of promoted) emitSync(c, { type: 'attachment-added', ticketId: id, attachment: { ...att } });
  return c.json({ promoted: promoted.length, attachments: promoted });
});

/**
 * HS-8739 — POST /api/tickets/:id/attachments/copy-from. Server-side copy of
 * all of a source ticket's non-draft attachments into target ticket `:id`.
 * `:id` is in the TARGET project (resolved from the request's auth context);
 * the source project is named by `sourceSecret` in the body. The bytes are
 * read from the source project's files (their absolute `stored_path`) and
 * re-written into the target project's attachments dir — never round-tripping
 * through the browser. Powers cross-project ticket copy/move (§76 drag + §3
 * clipboard paste): without it, a move silently lost the originals' files.
 */
attachmentRoutes.post('/tickets/:id/attachments/copy-from', async (c) => {
  const targetId = parseIntParam(c, 'id');
  if (targetId === null) return c.json({ error: 'Invalid ticket ID' }, 400);
  const targetTicket = await getTicket(targetId);
  if (!targetTicket) return c.json({ error: 'Ticket not found' }, 404);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = CopyAttachmentsReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  const { sourceSecret, sourceTicketId } = parsed.data;

  const sourceProject = getProjectBySecret(sourceSecret);
  if (!sourceProject) return c.json({ error: 'Source project not found' }, 400);

  // Read the source ticket's (non-draft) attachment rows from the SOURCE
  // project's DB by temporarily binding its dataDir; back to the target context
  // (the outer middleware's) for every write below.
  const sourceAttachments = await runWithDataDir(sourceProject.dataDir, () => getAttachments(sourceTicketId));

  const targetDataDir = c.get('dataDir');
  const attachDir = join(targetDataDir, 'attachments');
  await fsp.mkdir(attachDir, { recursive: true });

  const copied = [];
  for (const att of sourceAttachments) {
    // Skip a row whose on-disk file vanished rather than failing the whole copy.
    if (!await fileExists(att.stored_path)) continue;
    const ext = extname(att.original_filename);
    const base = basename(att.original_filename, ext);
    // Don't clobber an existing target file (duplicate names within the batch
    // or a pre-existing attachment on the target ticket) — suffix until unique.
    const storedPath = await uniqueAttachmentPath(attachDir, `${targetTicket.ticket_number}_${base}`, ext);
    if (storedPath === null) continue; // pathologically many collisions — skip, don't hang
    // HS-9570 — `copyFile` rather than writeFileSync(readFileSync(…)): async, so
    // it cannot block the loop, and the bytes never pass through JS memory at
    // all. The old form allocated the WHOLE file per attachment, in a loop.
    await fsp.copyFile(att.stored_path, storedPath);
    copied.push(await addAttachment(targetId, att.original_filename, storedPath));
  }

  notifyMutation(targetDataDir);
  for (const att of copied) emitSync(c, { type: 'attachment-added', ticketId: targetId, attachment: { ...att } });
  return c.json({ copied: copied.length, attachments: copied });
});

attachmentRoutes.delete('/attachments/:id', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ID' }, 400);
  const attachment = await deleteAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);

  // Remove the file
  try { await fsp.rm(attachment.stored_path, { force: true }); } catch { /* ignore */ }

  notifyMutation(c.get('dataDir'));
  emitSync(c, { type: 'attachment-deleted', ticketId: attachment.ticket_id, attachmentId: id });
  return c.json({ ok: true });
});

// Reveal attachment in OS file manager
attachmentRoutes.post('/attachments/:id/reveal', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid attachment ID' }, 400);
  const attachment = await getAttachment(id);
  if (!attachment) return c.json({ error: 'Not found' }, 404);
  if (!await fileExists(attachment.stored_path)) return c.json({ error: 'File not found on disk' }, 404);

  await revealInFileManager(attachment.stored_path);
  return c.json({ ok: true });
});

// HS-8808 — negative cache for the serve-time self-heal: a path we just FAILED
// to restore (no recoverable blob) is skipped for a short window so a
// hot-looping broken `<img>` doesn't re-walk the manifest store on every retry.
// Keyed by the absolute resolved path (so it's project-scoped); entries expire
// so a later backup that captures the blob can still heal after the TTL. A
// SUCCESSFUL restore self-clears (the file then exists, so the route never
// reaches the heal path again).
const SERVE_HEAL_FAIL_TTL_MS = 30_000;
const recentServeHealFailures = new Map<string, number>();

/**
 * HS-8808 — serve-time self-heal. The file at `fullPath` is missing; if it maps
 * to a known attachment row whose content is still in the backup store, restore
 * the blob back to `fullPath` so the broken image comes back immediately (the
 * HS-8802 startup sweep also heals, but only on the next launch). Returns true
 * if the file is now present. Gated so the (potentially many) manifest reads
 * only run for a genuine missing-attachment request, never for arbitrary 404s.
 */
export async function tryServeTimeRestore(dataDir: string, fullPath: string): Promise<boolean> {
  const failedAt = recentServeHealFailures.get(fullPath);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < SERVE_HEAL_FAIL_TTL_MS) return false;
    recentServeHealFailures.delete(fullPath);
  }
  try {
    const backupRoot = getBackupDir(dataDir);
    // HS-9527 — this runs on the attachment-serving request path, so it must
    // never block on a cloud `backupDir`. An unreachable store simply means no
    // self-heal for this request; the 404 is the correct answer either way.
    if (!isBackupFsAvailable(backupRoot)) return false;
    if (!await backupFsFor(backupRoot).existsOrUnknown(backupRoot)) return false;
    // Gate the manifest walk on the path mapping to a real attachment row.
    const att = (await getAllAttachments()).find(a => resolve(a.stored_path) === fullPath);
    if (att === undefined) return false;
    const xref = (await indexExistingManifestEntries(backupRoot)).get(att.id);
    if (xref === undefined) return false;
    const ok = await restoreAttachmentBlob(attachmentBlobsDir(backupRoot), xref.sha, fullPath);
    if (!ok) recentServeHealFailures.set(fullPath, Date.now());
    return ok;
  } catch {
    recentServeHealFailures.set(fullPath, Date.now());
    return false;
  }
}

// Serve attachment files
attachmentRoutes.get('/attachments/file/*', async (c) => {
  const filePath = c.req.path.replace('/api/attachments/file/', '');
  const dataDir = c.get('dataDir');
  const attachDir = resolve(join(dataDir, 'attachments'));
  const fullPath = resolve(join(attachDir, filePath));

  // Prevent directory traversal — resolved path must stay within attachments dir.
  // HS-8716 — use the platform separator (`sep`), not a hardcoded `/`: on Windows
  // `resolve()` returns backslash paths, so `attachDir + '/'` never prefix-matched
  // and every valid attachment was rejected with 403.
  if (!fullPath.startsWith(attachDir + sep) && fullPath !== attachDir) {
    return c.json({ error: 'Invalid path' }, 403);
  }

  let stat = await statOrNull(fullPath);
  if (stat === null) {
    // HS-8808 — try a serve-time self-heal from the backup store before 404ing.
    const healed = await tryServeTimeRestore(dataDir, fullPath);
    if (!healed) return c.json({ error: 'File not found' }, 404);
    stat = await statOrNull(fullPath);
    if (stat === null) return c.json({ error: 'File not found' }, 404);
  }

  const ext = extname(fullPath).toLowerCase();
  const contentType = getMimeType(ext);

  // HS-9570 — STREAM rather than `readFileSync` into a Buffer. That fixes two
  // things at once: the synchronous read (an unbounded block on the loop when
  // `dataDir` is on a cloud/network mount), and the whole-file allocation — an
  // 80 MB attachment cost 80 MB of `external`/`arrayBuffers` per concurrent
  // serve, against the very budget docs/128 exists to bound.
  // The `as` is a pure type bridge with no runtime component: `Readable.toWeb`
  // is typed against `node:stream/web`'s ReadableStream, while `Response` wants
  // the global (DOM) one. They are the same object at runtime — Node's global
  // ReadableStream IS the stream/web class — so nothing is being asserted about
  // a value's shape here, only about which declaration of it TypeScript sees.
  const body = Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      // Known from the stat we already did — lets the browser show progress and
      // makes range-less video/image loads behave.
      'Content-Length': String(stat.size),
    },
  });
});

/** `stat`, or null when the file is missing. Async — see `fileExists`. */
async function statOrNull(path: string): Promise<{ size: number } | null> {
  try {
    return await fsp.stat(path);
  } catch {
    return null;
  }
}
