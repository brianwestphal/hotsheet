/**
 * HS-8952 — pull images referenced in a synced ticket body down as local Hot
 * Sheet attachments.
 *
 * The push half (`attachments.ts`) uploads LOCAL attachments to the remote. This
 * is the PULL half: when a GitHub issue body carries an `<img>` / `![](…)` image
 * (e.g. a pasted `github.com/user-attachments/assets/…` URL), download the bytes
 * via `backend.downloadAttachment` and store them as a real attachment so they
 * appear in the ticket's Attachments list.
 *
 * Idempotent across re-syncs via an `img_<hash-of-url>` row in `note_sync`
 * (mirrors the push side's `att_<id>` markers; comment sync skips both prefixes).
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname, join } from 'path';

import { addAttachment } from '../../db/attachments.js';
import { getNoteSyncRecords, upsertNoteSyncRecord } from '../../db/sync.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import type { TicketingBackend } from '../types.js';
import { extractImageRefs } from './imageRefs.js';

/** Stable, collision-resistant `note_sync` marker id for a pulled image URL. */
export function imageMarker(url: string): string {
  return `img_${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
}

/**
 * Download every not-yet-pulled image referenced in `body` and add each as an
 * attachment on `ticketId`. No-op when the backend can't download, the body has
 * no remote images, or every image is already pulled. Best-effort per image — a
 * single failed download is logged and skipped, never aborting the rest.
 */
export async function syncImagesFromBody(
  backend: TicketingBackend,
  ticketId: number,
  ticketNumber: string,
  dataDir: string,
  body: string | null | undefined,
  remoteId: string,
): Promise<void> {
  if (!backend.downloadAttachment) return;
  const urls = extractImageRefs(body);
  if (urls.length === 0) return;

  // Which image URLs were already pulled — `img_<hash>` rows in note_sync.
  const mappings = await getNoteSyncRecords(ticketId, backend.id);
  const already = new Set(mappings.filter(m => m.note_id.startsWith('img_')).map(m => m.note_id));

  const attachDir = join(dataDir, 'attachments');

  for (const url of urls) {
    const marker = imageMarker(url);
    if (already.has(marker)) continue;
    try {
      const downloaded = await backend.downloadAttachment(url, { remoteId });
      if (downloaded == null) continue;
      mkdirSync(attachDir, { recursive: true });

      // Stored filename: `<TICKET>_<name>`, suffixed to avoid clobbering an
      // existing file (mirrors the upload + copy-from routes).
      const base = sanitizeFilename(downloaded.filename);
      const ext = extname(base);
      const stem = ext === '' ? base : base.slice(0, -ext.length);
      let storedName = `${ticketNumber}_${stem}${ext}`;
      let storedPath = join(attachDir, storedName);
      let n = 1;
      while (existsSync(storedPath)) {
        storedName = `${ticketNumber}_${stem}_${String(n)}${ext}`;
        storedPath = join(attachDir, storedName);
        n++;
      }
      writeFileSync(storedPath, downloaded.content);
      await addAttachment(ticketId, downloaded.filename, storedPath);
      // Record the pull (remote_comment_id holds the source URL for traceability).
      await upsertNoteSyncRecord(ticketId, marker, backend.id, url);
    } catch (e) {
      console.warn(`[sync] Failed to pull image ${url} for ticket ${ticketId}: ${getErrorMessage(e)}`);
    }
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]+/g, '_').trim();
  return cleaned === '' ? 'image' : cleaned;
}
