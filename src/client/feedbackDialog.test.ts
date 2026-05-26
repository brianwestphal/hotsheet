// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getFeedbackDrafts } from '../api/index.js';
import {
  buildOverlay,
  openFeedbackDialogForNote,
  pickDraftForFeedbackNote,
  resetAutoShownFeedback,
  shouldAutoShowFeedback,
  suppressNextAutoShowFeedback,
  toDraftSeed,
} from './feedbackDialog.js';
import type { FeedbackDraft } from './noteRenderer.js';
import { _resetPrefixesForTesting } from './ticketRefs.js';

// HS-8603 — `openFeedbackDialogForNote` fetches the ticket's drafts.
// HS-8642 — that now routes through the typed `getFeedbackDrafts`; mock the
// typed-API layer so the test controls what the drafts endpoint returns. The
// other typed callers feedbackDialog imports are stubbed so the module loads.
vi.mock('./api.js', () => ({ api: vi.fn(), apiUpload: vi.fn(), apiWithSecret: vi.fn() }));
vi.mock('../api/index.js', () => ({
  getFeedbackDrafts: vi.fn(),
  createFeedbackDraft: vi.fn(),
  updateFeedbackDraft: vi.fn(),
  deleteFeedbackDraft: vi.fn(),
  promoteFeedbackDraftAttachments: vi.fn(),
  updateTicket: vi.fn(),
}));

/**
 * HS-7822 — pickDraftForFeedbackNote pure-helper tests. The helper drives
 * the auto-show flow on detail-panel open: when the latest note is a
 * FEEDBACK NEEDED request and a saved draft exists for it, the dialog
 * should open with the draft pre-loaded instead of the original prompt.
 */
describe('pickDraftForFeedbackNote', () => {
  it('returns null when there are no drafts', () => {
    expect(pickDraftForFeedbackNote([], 'note-1')).toBeNull();
  });

  it('matches the parentNoteId-bound draft over a floating one', () => {
    const drafts = [
      { id: 'd1', parentNoteId: null, updatedAt: '2026-04-26T10:00:00Z' },
      { id: 'd2', parentNoteId: 'note-1', updatedAt: '2026-04-26T08:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('d2');
  });

  it('picks the most recently updated draft when several match the same parent note', () => {
    const drafts = [
      { id: 'old', parentNoteId: 'note-1', updatedAt: '2026-04-25T10:00:00Z' },
      { id: 'newer', parentNoteId: 'note-1', updatedAt: '2026-04-26T10:00:00Z' },
      { id: 'oldest', parentNoteId: 'note-1', updatedAt: '2026-04-24T10:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('newer');
  });

  it('falls back to the most recent free-floating draft when no parent-matching draft exists', () => {
    // Free-floating drafts (parentNoteId === null) survive when their
    // original parent FEEDBACK note is deleted — see docs/21-feedback.md
    // §21.2.3.
    const drafts = [
      { id: 'd1', parentNoteId: 'other-note', updatedAt: '2026-04-26T10:00:00Z' },
      { id: 'free-old', parentNoteId: null, updatedAt: '2026-04-25T10:00:00Z' },
      { id: 'free-newer', parentNoteId: null, updatedAt: '2026-04-26T11:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('free-newer');
  });

  it('returns null when no draft matches the active note nor floats free', () => {
    const drafts = [
      { id: 'd1', parentNoteId: 'other-note', updatedAt: '2026-04-26T10:00:00Z' },
    ];
    expect(pickDraftForFeedbackNote(drafts, 'note-1')).toBeNull();
  });

  it('preserves the input draft shape — extra fields on the input pass through to the returned reference', () => {
    interface FullDraft {
      id: string;
      parentNoteId: string | null;
      updatedAt: string;
      promptText: string;
    }
    const drafts: FullDraft[] = [
      { id: 'd1', parentNoteId: 'note-1', updatedAt: '2026-04-26T10:00:00Z', promptText: 'Saved' },
    ];
    const picked = pickDraftForFeedbackNote<FullDraft>(drafts, 'note-1');
    expect(picked?.promptText).toBe('Saved');
  });

  it('handles missing updatedAt fields gracefully (treats as oldest)', () => {
    const drafts = [
      { id: 'no-ts', parentNoteId: 'note-1' },
      { id: 'with-ts', parentNoteId: 'note-1', updatedAt: '2026-04-26T10:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('with-ts');
  });
});

/**
 * HS-8416 — right-click selection cascades through
 * `renderTicketList → updateBatchToolbar → syncDetailPanel`, and pre-fix
 * the cascade auto-opened the feedback dialog on top of the context menu
 * whenever the just-selected ticket had a pending FEEDBACK NEEDED note.
 * `suppressNextAutoShowFeedback` is the one-shot guard the context menu
 * sets before the selection re-render so the cascade's
 * `shouldAutoShowFeedback` call returns false without recording the
 * noteId in `lastAutoShownKey` — preserving the auto-show for a later
 * normal click on the ticket.
 */
describe('shouldAutoShowFeedback — suppression guard (HS-8416)', () => {
  beforeEach(() => {
    resetAutoShownFeedback();
  });

  it('returns true on the first call for a (ticketId, noteId) pair (baseline)', () => {
    expect(shouldAutoShowFeedback(1, 'n_1')).toBe(true);
  });

  it('returns false on the second call for the same pair (one-shot per pair)', () => {
    expect(shouldAutoShowFeedback(1, 'n_1')).toBe(true);
    expect(shouldAutoShowFeedback(1, 'n_1')).toBe(false);
  });

  it('returns false on the next call after suppressNextAutoShowFeedback()', () => {
    suppressNextAutoShowFeedback();
    expect(shouldAutoShowFeedback(1, 'n_1')).toBe(false);
  });

  it('only suppresses ONE call — a later legitimate navigation still auto-shows', () => {
    // The whole point of HS-8416's "one-shot" suppression: right-click
    // dismisses the auto-show for the right-click cascade only. A later
    // normal click on the same ticket (after the user dismisses the
    // menu) must still pop the feedback dialog on first arrival, since
    // that's the legitimate user-initiated path.
    suppressNextAutoShowFeedback();
    expect(shouldAutoShowFeedback(1, 'n_1')).toBe(false);
    // Suppression consumed; next call follows normal first-time-true rule.
    expect(shouldAutoShowFeedback(1, 'n_1')).toBe(true);
  });

  it('suppression does NOT mark the (ticketId, noteId) pair as already-shown', () => {
    // Without this guarantee the user would right-click a feedback
    // ticket (suppressed), then click it normally — and the dialog
    // would silently skip because the pair was recorded by the
    // suppressed call. We have to NOT touch `lastAutoShownKey` while
    // suppressing.
    suppressNextAutoShowFeedback();
    shouldAutoShowFeedback(2, 'n_42'); // suppressed → false, no record
    expect(shouldAutoShowFeedback(2, 'n_42')).toBe(true); // first real call
  });

  it('resetAutoShownFeedback clears the suppress flag too', () => {
    suppressNextAutoShowFeedback();
    resetAutoShownFeedback();
    // After reset the suppress flag is gone, so the next call honors
    // the normal first-true rule.
    expect(shouldAutoShowFeedback(3, 'n_x')).toBe(true);
  });
});

describe('buildOverlay ticket-ref linkification (HS-8338)', () => {
  beforeEach(() => {
    // Pre-seed the prefix cache so `linkifyWithCachedPrefixes` sees the
    // `HS` prefix without an awaited `/api/tickets/prefixes` round-trip.
    _resetPrefixesForTesting(['HS']);
  });

  it('renders the dialog title ticket number as a clickable `.ticket-ref` anchor', () => {
    // The whole point of HS-8338 is that the user wants to re-open the
    // originating ticket while composing a response — the anchor wraps the
    // ticket number in the header so the global capture-phase click
    // handler dispatches to `openTicketRefDialog(ticketNumber)`.
    const overlay = buildOverlay('HS-9001', []);
    const headerAnchor = overlay.querySelector<HTMLAnchorElement>('.custom-view-editor-header .ticket-ref');
    expect(headerAnchor).not.toBeNull();
    expect(headerAnchor!.dataset.ticketNumber).toBe('HS-9001');
    expect(headerAnchor!.textContent).toBe('HS-9001');
  });

  it('preserves the header label prefix so the title still reads "Feedback Needed — HS-9001"', () => {
    const overlay = buildOverlay('HS-9001', []);
    const header = overlay.querySelector<HTMLElement>('.custom-view-editor-header > span');
    expect(header).not.toBeNull();
    // Normalize whitespace — the toElement output may carry incidental
    // spacing between text and the anchor.
    const flat = header!.textContent.replace(/\s+/g, ' ').trim();
    expect(flat).toBe('Feedback Needed — HS-9001');
  });

  it('linkifies HS-NNNN refs inside the rendered prompt body blocks', () => {
    const overlay = buildOverlay('HS-9001', [
      { markdown: '', html: '<p>See <strong>HS-1234</strong> and HS-5678 for context.</p>' },
    ]);
    const blockAnchors = overlay.querySelectorAll<HTMLAnchorElement>('.feedback-prompt-block .ticket-ref');
    const numbers = Array.from(blockAnchors).map(a => a.dataset.ticketNumber);
    expect(numbers).toEqual(['HS-1234', 'HS-5678']);
  });

  it('does NOT skip self-references in the prompt body', () => {
    // The user explicitly wants to be able to navigate to the originating
    // ticket while in the dialog — so a prompt that mentions its own
    // ticket number should still produce a clickable anchor. Confirmed by
    // passing no `currentTicketNumber` argument to `linkifyWithCachedPrefixes`.
    const overlay = buildOverlay('HS-9001', [
      { markdown: '', html: '<p>This is HS-9001 itself.</p>' },
    ]);
    const anchors = overlay.querySelectorAll<HTMLAnchorElement>('.feedback-prompt-block .ticket-ref');
    expect(anchors.length).toBe(1);
    expect(anchors[0].dataset.ticketNumber).toBe('HS-9001');
  });

  it('renders an empty-prompt placeholder block with no ticket-ref anchors', () => {
    const overlay = buildOverlay('HS-9001', []);
    expect(overlay.querySelector('.feedback-prompt-empty')).not.toBeNull();
    expect(overlay.querySelectorAll('.feedback-prompt-block .ticket-ref').length).toBe(0);
  });
});

describe('toDraftSeed (HS-8603)', () => {
  function draft(over: Partial<FeedbackDraft> = {}): FeedbackDraft {
    return {
      id: 'd1', ticketId: 5, parentNoteId: 'note-1', promptText: 'Q?',
      partitions: { blocks: [{ markdown: 'a', html: '<p>a</p>' }], inlineResponses: [{ blockIndex: 0, text: 'r' }], catchAll: 'c' },
      createdAt: '2026-01-01', updatedAt: '2026-01-02', ...over,
    };
  }

  it('maps the draft fields straight through to the seed', () => {
    const seed = toDraftSeed(draft());
    expect(seed.id).toBe('d1');
    expect(seed.parentNoteId).toBe('note-1');
    expect(seed.promptText).toBe('Q?');
    expect(seed.partitions.catchAll).toBe('c');
    expect(seed.partitions.inlineResponses).toEqual([{ blockIndex: 0, text: 'r' }]);
  });

  it('defaults attachments to [] when the draft has none (older-server payload)', () => {
    expect(toDraftSeed(draft({ attachments: undefined })).attachments).toEqual([]);
  });

  it('passes through attachments when present', () => {
    const seed = toDraftSeed(draft({ attachments: [{ id: 7, ticket_id: 5, draft_id: 'd1', original_filename: 'a.png', stored_path: '/x', created_at: '' }] }));
    expect(seed.attachments).toEqual([{ id: 7, ticket_id: 5, draft_id: 'd1', original_filename: 'a.png', stored_path: '/x', created_at: '' }]);
  });
});

describe('openFeedbackDialogForNote (HS-8603)', () => {
  beforeEach(() => {
    _resetPrefixesForTesting(['HS']);
    vi.mocked(getFeedbackDrafts).mockReset();
    document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());
  });
  afterEach(() => {
    document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());
  });

  function draftRow(over: Partial<FeedbackDraft> = {}): FeedbackDraft {
    return {
      id: 'd1', ticketId: 5, parentNoteId: 'note-1', promptText: 'Q?',
      partitions: { blocks: [], inlineResponses: [], catchAll: 'my saved answer' },
      createdAt: '2026-01-01', updatedAt: '2026-01-02', ...over,
    };
  }

  function catchAllValue(): string | null {
    const ta = document.querySelector<HTMLTextAreaElement>('#feedback-catchall-text');
    return ta === null ? null : ta.value;
  }

  it('auto-loads the matching draft into the dialog when one exists', async () => {
    vi.mocked(getFeedbackDrafts).mockResolvedValue([draftRow()]);
    await openFeedbackDialogForNote(5, 'HS-5', 'Q?', 'note-1');
    expect(getFeedbackDrafts).toHaveBeenCalledWith(5);
    expect(document.querySelector('.feedback-dialog-overlay')).not.toBeNull();
    expect(catchAllValue()).toBe('my saved answer');
  });

  it('opens the bare prompt when the ticket has no matching draft', async () => {
    vi.mocked(getFeedbackDrafts).mockResolvedValue([]);
    await openFeedbackDialogForNote(5, 'HS-5', 'Q?', 'note-1');
    expect(document.querySelector('.feedback-dialog-overlay')).not.toBeNull();
    expect(catchAllValue()).toBe('');
  });

  it('does not fetch drafts (and opens bare) when there is no note id', async () => {
    await openFeedbackDialogForNote(5, 'HS-5', 'Q?', undefined);
    expect(getFeedbackDrafts).not.toHaveBeenCalled();
    expect(document.querySelector('.feedback-dialog-overlay')).not.toBeNull();
    expect(catchAllValue()).toBe('');
  });

  it('falls back to the bare prompt (no throw) when the drafts fetch fails', async () => {
    vi.mocked(getFeedbackDrafts).mockRejectedValue(new Error('network down'));
    await openFeedbackDialogForNote(5, 'HS-5', 'Q?', 'note-1');
    expect(document.querySelector('.feedback-dialog-overlay')).not.toBeNull();
    expect(catchAllValue()).toBe('');
  });
});
