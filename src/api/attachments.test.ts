/**
 * HS-8633 — attachments typed-API module. The two uploads route through the
 * dedicated multipart transport (`setApiUploadTransport` / `apiUploadCall`);
 * delete + reveal use the JSON transport (`setApiTransport` / `apiCall`). This
 * exercises both injection points, the `AttachmentSchema` accept/reject, and
 * each caller's path / method.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ApiCallOpts, type ApiTransport, type ApiUploadTransport,
  setApiTransport, setApiUploadTransport,
} from './_runner.js';
import {
  AttachmentSchema, CopyAttachmentsReqSchema,
copyTicketAttachments,   deleteAttachment, revealAttachment, uploadAttachment, uploadDraftAttachment,
} from './attachments.js';

const attachment = {
  id: 7, ticket_id: 42, original_filename: 'shot.png',
  stored_path: '/d/attachments/HS-42_shot.png', created_at: '2026-05-27T00:00:00Z', draft_id: null,
};

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
let lastUpload: { path: string; file: File } | undefined;

function stubJson(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
function stubUpload(result: unknown): void {
  setApiUploadTransport(vi.fn<ApiUploadTransport>((path, file) => { lastUpload = { path, file }; return Promise.resolve(result); }));
}
function fakeFile(): File {
  return new File(['x'], 'shot.png', { type: 'image/png' });
}

afterEach(() => {
  setApiTransport(null as unknown as ApiTransport);
  setApiUploadTransport(null as unknown as ApiUploadTransport);
  lastCall = undefined; lastUpload = undefined;
});

describe('attachments schema (HS-8633)', () => {
  it('accepts a full attachment (regular + draft) and rejects a malformed one', () => {
    expect(AttachmentSchema.safeParse(attachment).success).toBe(true);
    expect(AttachmentSchema.safeParse({ ...attachment, draft_id: 'fd_1' }).success).toBe(true);
    // .loose() tolerates a future extra column.
    expect(AttachmentSchema.safeParse({ ...attachment, mime: 'image/png' }).success).toBe(true);
    // id must be a number.
    expect(AttachmentSchema.safeParse({ ...attachment, id: '7' }).success).toBe(false);
    // draft_id is required-but-nullable, not absent.
    const { draft_id: _d, ...noDraft } = attachment;
    expect(AttachmentSchema.safeParse(noDraft).success).toBe(false);
  });
});

describe('attachments callers (HS-8633)', () => {
  it('uploadAttachment → multipart POST /tickets/:id/attachments', async () => {
    stubUpload(attachment);
    const file = fakeFile();
    expect(await uploadAttachment(42, file)).toEqual(attachment);
    expect(lastUpload).toEqual({ path: '/tickets/42/attachments', file });
  });

  it('uploadDraftAttachment → multipart POST /tickets/:id/feedback-drafts/:draftId/attachments (encoded)', async () => {
    stubUpload({ ...attachment, draft_id: 'fd 1' });
    const file = fakeFile();
    await uploadDraftAttachment(42, 'fd 1', file);
    expect(lastUpload?.path).toBe('/tickets/42/feedback-drafts/fd%201/attachments');
  });

  it('uploadAttachment rejects a malformed multipart response', async () => {
    stubUpload({ id: 'nope' });
    await expect(uploadAttachment(42, fakeFile())).rejects.toThrow(/response shape mismatch/);
  });

  it('deleteAttachment → DELETE /attachments/:id (JSON transport)', async () => {
    stubJson({ ok: true });
    await deleteAttachment(7);
    expect(lastCall).toEqual({ path: '/attachments/7', opts: { method: 'DELETE' } });
  });

  it('revealAttachment → POST /attachments/:id/reveal (JSON transport)', async () => {
    stubJson({ ok: true });
    await revealAttachment(7);
    expect(lastCall).toEqual({ path: '/attachments/7/reveal', opts: { method: 'POST' } });
  });

  it('copyTicketAttachments → POST /tickets/:id/attachments/copy-from with the target secret + source body (HS-8739)', async () => {
    stubJson({ copied: 2, attachments: [attachment, attachment] });
    const res = await copyTicketAttachments(99, { sourceSecret: 'src', sourceTicketId: 5 }, { secret: 'tgt' });
    expect(res.copied).toBe(2);
    expect(lastCall).toEqual({
      path: '/tickets/99/attachments/copy-from',
      opts: { method: 'POST', body: { sourceSecret: 'src', sourceTicketId: 5 }, secret: 'tgt' },
    });
  });

  it('CopyAttachmentsReqSchema rejects an empty source secret / non-int ticket id (HS-8739)', () => {
    expect(CopyAttachmentsReqSchema.safeParse({ sourceSecret: 's', sourceTicketId: 5 }).success).toBe(true);
    expect(CopyAttachmentsReqSchema.safeParse({ sourceSecret: '', sourceTicketId: 5 }).success).toBe(false);
    expect(CopyAttachmentsReqSchema.safeParse({ sourceSecret: 's', sourceTicketId: 1.5 }).success).toBe(false);
  });

  it('apiUploadCall throws a clear error when no upload transport is wired', async () => {
    // No stubUpload this run — the afterEach reset leaves it null.
    setApiUploadTransport(null as unknown as ApiUploadTransport);
    await expect(uploadAttachment(1, fakeFile())).rejects.toThrow(/no upload transport configured/);
  });
});
