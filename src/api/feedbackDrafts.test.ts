/**
 * HS-8642 — feedback-draft typed-API module. Verifies the callers hit the
 * right path + method through the injected transport, and that
 * `FeedbackDraftSchema`-based response validation accepts a real draft /
 * rejects a malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  createFeedbackDraft, deleteFeedbackDraft, FeedbackDraftSchema, getFeedbackDrafts,
  promoteFeedbackDraftAttachments, updateFeedbackDraft,
} from './feedbackDrafts.js';

const draft = {
  id: 'd1', ticketId: 5, parentNoteId: null, promptText: 'Q?',
  partitions: { blocks: [], inlineResponses: [], catchAll: 'answer' },
  createdAt: 'x', updatedAt: 'y',
};

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('FeedbackDraftSchema (HS-8642)', () => {
  it('accepts a valid draft (with + without attachments) and rejects a malformed one', () => {
    expect(FeedbackDraftSchema.safeParse(draft).success).toBe(true);
    expect(FeedbackDraftSchema.safeParse({ ...draft, attachments: [] }).success).toBe(true);
    // Missing partitions → invalid.
    expect(FeedbackDraftSchema.safeParse({ ...draft, partitions: undefined }).success).toBe(false);
    // Wrong-typed id → invalid.
    expect(FeedbackDraftSchema.safeParse({ ...draft, id: 5 }).success).toBe(false);
  });
});

describe('feedback-draft callers route to the right endpoint (HS-8642)', () => {
  it('getFeedbackDrafts → GET /tickets/:id/feedback-drafts', async () => {
    stub([draft]);
    expect(await getFeedbackDrafts(5)).toEqual([draft]);
    expect(lastCall?.path).toBe('/tickets/5/feedback-drafts');
    expect(lastCall?.opts.method).toBeUndefined();
  });

  it('createFeedbackDraft → POST /tickets/:id/feedback-drafts', async () => {
    stub(draft);
    const body = { id: 'd1', parent_note_id: null, prompt_text: 'Q?', partitions: draft.partitions };
    await createFeedbackDraft(5, body);
    expect(lastCall).toEqual({ path: '/tickets/5/feedback-drafts', opts: { method: 'POST', body } });
  });

  it('updateFeedbackDraft → PATCH /tickets/:id/feedback-drafts/:draftId', async () => {
    stub(draft);
    await updateFeedbackDraft(5, 'd1', draft.partitions);
    expect(lastCall).toEqual({
      path: '/tickets/5/feedback-drafts/d1',
      opts: { method: 'PATCH', body: { partitions: draft.partitions } },
    });
  });

  it('deleteFeedbackDraft → DELETE /tickets/:id/feedback-drafts/:draftId', async () => {
    stub({ ok: true, droppedAttachments: 2 });
    expect(await deleteFeedbackDraft(5, 'd1')).toEqual({ ok: true, droppedAttachments: 2 });
    expect(lastCall).toEqual({ path: '/tickets/5/feedback-drafts/d1', opts: { method: 'DELETE' } });
  });

  it('promoteFeedbackDraftAttachments → POST …/promote-attachments', async () => {
    stub({ promoted: 0, attachments: [] });
    expect(await promoteFeedbackDraftAttachments(5, 'd1')).toEqual({ promoted: 0, attachments: [] });
    expect(lastCall).toEqual({
      path: '/tickets/5/feedback-drafts/d1/promote-attachments',
      opts: { method: 'POST', body: {} },
    });
  });

  it('encodes a draft id with special characters in the path', async () => {
    stub({ ok: true, droppedAttachments: 0 });
    await deleteFeedbackDraft(5, 'fd a/b');
    expect(lastCall?.path).toBe('/tickets/5/feedback-drafts/fd%20a%2Fb');
  });
});
