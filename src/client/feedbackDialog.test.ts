// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getFeedbackDrafts } from '../api/index.js';
import { buildClaimReclaimNote } from '../systemNotes.js';
import {
  buildFeedbackNav,
  buildOverlay,
  getTicketFeedbackState,
  openFeedbackDialogForNote,
  parseFeedbackPrefix,
  pickDraftForFeedbackNote,
  resetAutoShownFeedback,
  shouldAutoShowFeedback,
  suppressNextAutoShowFeedback,
  toDraftSeed,
} from './feedbackDialog.js';
import type { FeedbackDraft, NoteEntry } from './noteRenderer.js';
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
 * HS-8702 — parseFeedbackPrefix matches the all-caps phrase ANYWHERE in the
 * note (not just as a strict leading prefix), with the trailing colon
 * optional, because AIs don't always follow the exact formatting. Matching is
 * case-sensitive; the prompt is the text after the phrase.
 */
describe('parseFeedbackPrefix (HS-8702)', () => {
  it('parses a standard leading prefix and strips the colon', () => {
    expect(parseFeedbackPrefix('FEEDBACK NEEDED: which color?')).toEqual({ type: 'standard', prompt: 'which color?' });
  });

  it('parses an immediate leading prefix (and prefers it over the standard substring)', () => {
    expect(parseFeedbackPrefix('IMMEDIATE FEEDBACK NEEDED: ship it?')).toEqual({ type: 'immediate', prompt: 'ship it?' });
  });

  it('matches the phrase embedded mid-text and extracts the trailing question', () => {
    expect(parseFeedbackPrefix('Some context. FEEDBACK NEEDED: pick one?')).toEqual({ type: 'standard', prompt: 'pick one?' });
  });

  it('matches without the trailing colon', () => {
    expect(parseFeedbackPrefix('FEEDBACK NEEDED which approach?')).toEqual({ type: 'standard', prompt: 'which approach?' });
  });

  it('returns an empty prompt when the phrase is the last thing in the note', () => {
    expect(parseFeedbackPrefix('done — FEEDBACK NEEDED')).toEqual({ type: 'standard', prompt: '' });
  });

  it('is case-sensitive: lowercase prose is not a feedback note', () => {
    expect(parseFeedbackPrefix('I think feedback needed from you')).toBeNull();
  });

  it('returns null when the phrase is absent', () => {
    expect(parseFeedbackPrefix('just a normal note')).toBeNull();
  });
});

// HS-9289 — a claim-reclaim SYSTEM note appended after a FEEDBACK NEEDED note
// must NOT make the ticket look resolved. getTicketFeedbackState reads the last
// MEANINGFUL note (trailing system notes skipped).
describe('getTicketFeedbackState (HS-9289)', () => {
  const note = (id: string, text: string): NoteEntry => ({ id, text, created_at: '2026-05-13T11:00:00Z' });

  it('reads feedback state from a trailing FEEDBACK NEEDED note', () => {
    expect(getTicketFeedbackState([note('n1', 'FEEDBACK NEEDED: which?')]))
      .toEqual({ type: 'standard', prompt: 'which?', noteId: 'n1' });
  });

  it('skips claim-reclaim system notes appended AFTER the feedback note', () => {
    const notes = [
      note('n1', 'FEEDBACK NEEDED: which option?'),
      note('sys1', buildClaimReclaimNote('owner')),
      note('sys2', buildClaimReclaimNote('null')),
    ];
    expect(getTicketFeedbackState(notes)).toEqual({ type: 'standard', prompt: 'which option?', noteId: 'n1' });
  });

  it('returns null when a real (non-system) response follows the feedback note', () => {
    const notes = [
      note('n1', 'FEEDBACK NEEDED: which option?'),
      note('n2', 'Use a Map.'),
      note('sys1', buildClaimReclaimNote('owner')),
    ];
    expect(getTicketFeedbackState(notes)).toBeNull();
  });

  it('returns null for empty / all-system note lists', () => {
    expect(getTicketFeedbackState([])).toBeNull();
    expect(getTicketFeedbackState([note('s', buildClaimReclaimNote('x'))])).toBeNull();
  });
});

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

// HS-8644 — auto-show must never fire over an already-open feedback dialog:
// `showFeedbackDialog` removes + recreates the overlay, so a poll-driven
// re-fire mid-typing destroys the user's in-progress input (the reported
// data-loss bug). This is the robust guard that doesn't depend on the
// (fragile, regenerated-per-parse) note-id key.
describe('shouldAutoShowFeedback — never clobbers an open dialog (HS-8644)', () => {
  beforeEach(() => {
    resetAutoShownFeedback();
    document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());
  });
  afterEach(() => {
    document.querySelectorAll('.feedback-dialog-overlay').forEach(el => el.remove());
  });

  it('returns false when a dialog overlay is already open — even for a fresh pair that would normally auto-show', () => {
    document.body.appendChild(Object.assign(document.createElement('div'), { className: 'feedback-dialog-overlay' }));
    expect(shouldAutoShowFeedback(99, 'n_new')).toBe(false);
  });

  it('a drifting (unstable) noteId cannot re-show while the dialog is open — the exact data-loss path', () => {
    document.body.appendChild(Object.assign(document.createElement('div'), { className: 'feedback-dialog-overlay' }));
    // Each poll re-parses an id-less FEEDBACK NEEDED note → a fresh client id,
    // so the key drifts. Without the open-dialog guard every distinct key would
    // return true and nuke the open dialog.
    expect(shouldAutoShowFeedback(1, 'cn_a')).toBe(false);
    expect(shouldAutoShowFeedback(1, 'cn_b')).toBe(false);
    expect(shouldAutoShowFeedback(1, 'cn_c')).toBe(false);
  });

  it('does NOT record the skipped pair — once the dialog closes, the pair still auto-shows', () => {
    const overlay = Object.assign(document.createElement('div'), { className: 'feedback-dialog-overlay' });
    document.body.appendChild(overlay);
    expect(shouldAutoShowFeedback(7, 'n_k')).toBe(false); // skipped while open
    overlay.remove();                                     // user closed the dialog
    expect(shouldAutoShowFeedback(7, 'n_k')).toBe(true);  // now it auto-shows (wasn't recorded while open)
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

describe('buildFeedbackNav (HS-8836)', () => {
  const fbNote = { id: 'n-fb', text: 'FEEDBACK NEEDED: confirm the plan?', created_at: '2026-06-17T03:00:00Z' };

  it('returns undefined when there is nothing prior to page to (only the feedback note)', () => {
    const nav = buildFeedbackNav(
      { ticketNumber: 'HS-1', ticketTitle: 'T', detailsMarkdown: '', notes: [fbNote] },
      'n-fb',
    );
    expect(nav).toBeUndefined();
  });

  it('builds [Details, ...notes] entries anchored on the feedback note when there is prior context', () => {
    const nav = buildFeedbackNav(
      {
        ticketNumber: 'HS-1',
        ticketTitle: 'T',
        detailsMarkdown: 'The description.',
        notes: [
          { id: 'n0', text: 'an earlier note', created_at: '2026-06-17T01:00:00Z' },
          fbNote,
        ],
      },
      'n-fb',
    );
    expect(nav).not.toBeUndefined();
    // Details + the two non-empty notes = 3 entries; the feedback note is last.
    expect(nav!.entries.length).toBe(3);
    expect(nav!.activeNoteId).toBe('n-fb');
    expect(nav!.entries[nav!.entries.length - 1].id).toBe('n-fb');
    // Every entry carries a title + markdown for the read-only context render.
    expect(nav!.entries.every(e => typeof e.title === 'string' && typeof e.markdown === 'string')).toBe(true);
  });

  it('skips empty notes (they have no reader entry)', () => {
    const nav = buildFeedbackNav(
      {
        ticketNumber: 'HS-1', ticketTitle: 'T', detailsMarkdown: '',
        notes: [
          { id: 'empty', text: '   ', created_at: '2026-06-17T01:00:00Z' },
          { id: 'n0', text: 'a real earlier note', created_at: '2026-06-17T02:00:00Z' },
          fbNote,
        ],
      },
      'n-fb',
    );
    // Empty note dropped → 2 entries (the earlier note + the feedback note).
    expect(nav!.entries.map(e => e.id)).toEqual(['n0', 'n-fb']);
  });
});

describe('buildOverlay nav chevrons (HS-8836)', () => {
  it('omits the nav chevrons + context view by default (single-entry / no nav)', () => {
    const overlay = buildOverlay('HS-9001', []);
    expect(overlay.querySelector('.feedback-nav-controls')).toBeNull();
    expect(overlay.querySelector('.feedback-context-view')).toBeNull();
    expect(overlay.querySelector('.feedback-nav-caption')).toBeNull();
  });

  it('renders prev/next chevrons + a hidden context view when showNav is true', () => {
    const overlay = buildOverlay('HS-9001', [], true);
    expect(overlay.querySelector('.feedback-nav-prev')).not.toBeNull();
    expect(overlay.querySelector('.feedback-nav-next')).not.toBeNull();
    const contextView = overlay.querySelector<HTMLElement>('.feedback-context-view');
    const caption = overlay.querySelector<HTMLElement>('.feedback-nav-caption');
    expect(contextView).not.toBeNull();
    expect(caption).not.toBeNull();
    // Both start hidden — the dialog opens on the interactive prompt-stack.
    expect(contextView!.hidden).toBe(true);
    expect(caption!.hidden).toBe(true);
    // The response box + buttons still render (Option 1 — pinned below).
    expect(overlay.querySelector('#feedback-catchall-text')).not.toBeNull();
    expect(overlay.querySelector('#feedback-submit')).not.toBeNull();
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
