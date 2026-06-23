import { existsSync, readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAttachments } from '../../db/attachments.js';
import { createTicket } from '../../db/tickets.js';
import { cleanupTestDb, setupTestDb } from '../../test-helpers.js';
import type { TicketingBackend } from '../types.js';
import { imageMarker, syncImagesFromBody } from './imageAttachments.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

let dataDir: string;
beforeEach(async () => { dataDir = await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(dataDir); });

function backendWithDownload(impl: TicketingBackend['downloadAttachment']): TicketingBackend {
  return { id: 'gh-test', downloadAttachment: impl } as unknown as TicketingBackend;
}

describe('syncImagesFromBody (HS-8952)', () => {
  it('downloads a body image and stores it as a ticket attachment', async () => {
    const ticket = await createTicket('with image');
    const url = 'https://github.com/user-attachments/assets/abc-123';
    const download = vi.fn().mockResolvedValue({ content: PNG, filename: 'shot.png', mimeType: 'image/png' });
    const backend = backendWithDownload(download);

    await syncImagesFromBody(backend, ticket.id, ticket.ticket_number, dataDir, `<img src="${url}">`);

    const atts = await getAttachments(ticket.id);
    expect(atts).toHaveLength(1);
    expect(atts[0].original_filename).toBe('shot.png');
    expect(atts[0].stored_path).toContain(`${ticket.ticket_number}_shot.png`);
    expect(existsSync(atts[0].stored_path)).toBe(true);
    expect(readFileSync(atts[0].stored_path).equals(PNG)).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across re-syncs (no duplicate attachment, no re-download)', async () => {
    const ticket = await createTicket('with image');
    const url = 'https://x.test/img.png';
    const download = vi.fn().mockResolvedValue({ content: PNG, filename: 'img.png', mimeType: 'image/png' });
    const backend = backendWithDownload(download);
    const body = `![](${url})`;

    await syncImagesFromBody(backend, ticket.id, ticket.ticket_number, dataDir, body);
    await syncImagesFromBody(backend, ticket.id, ticket.ticket_number, dataDir, body); // re-sync

    expect(await getAttachments(ticket.id)).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1); // marker short-circuits the second pull
  });

  it('no-ops when the backend cannot download', async () => {
    const ticket = await createTicket('with image');
    const backend = { id: 'gh-test' } as unknown as TicketingBackend; // no downloadAttachment
    await syncImagesFromBody(backend, ticket.id, ticket.ticket_number, dataDir, '<img src="https://x.test/a.png">');
    expect(await getAttachments(ticket.id)).toHaveLength(0);
  });

  it('skips (and will retry) when a download returns null — no attachment, no marker', async () => {
    const ticket = await createTicket('with image');
    const download = vi.fn().mockResolvedValue(null);
    const backend = backendWithDownload(download);
    await syncImagesFromBody(backend, ticket.id, ticket.ticket_number, dataDir, '<img src="https://x.test/a.png">');
    expect(await getAttachments(ticket.id)).toHaveLength(0);
    // A second pass tries again (no marker was written for a failed download).
    await syncImagesFromBody(backend, ticket.id, ticket.ticket_number, dataDir, '<img src="https://x.test/a.png">');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('imageMarker is stable + url-specific', () => {
    expect(imageMarker('https://a/1')).toBe(imageMarker('https://a/1'));
    expect(imageMarker('https://a/1')).not.toBe(imageMarker('https://a/2'));
    expect(imageMarker('https://a/1').startsWith('img_')).toBe(true);
  });
});
