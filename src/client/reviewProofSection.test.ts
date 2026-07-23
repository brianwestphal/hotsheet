// @vitest-environment happy-dom
/**
 * HS-9293 (docs/111) — the detail-panel "Review Proof" section: presence-gated
 * light list of a ticket's Glassbox `.pr-notes/` notes, each expandable to its
 * attachment chips, with poll-safe repainting (unchanged reload preserves an
 * expanded row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewProofNote } from '../api/reviewProof.js';
import type { TicketCommitsResponse } from '../api/ticketCommits.js';

const getReviewProof = vi.fn<(t: string) => Promise<{ notes: ReviewProofNote[] }>>();
const getTicketCommits = vi.fn<(t: string) => Promise<TicketCommitsResponse>>();
const reviewInGlassbox = vi.fn<(req: unknown) => Promise<{ ok: true }>>(() => Promise.resolve({ ok: true as const }));
const launchGlassbox = vi.fn<() => Promise<{ ok: true }>>(() => Promise.resolve({ ok: true as const }));
vi.mock('../api/index.js', () => ({
  getReviewProof: (t: string) => getReviewProof(t),
  getTicketCommits: (t: string) => getTicketCommits(t),
  reviewInGlassbox: (req: unknown) => reviewInGlassbox(req),
  launchGlassbox: () => launchGlassbox(),
}));

const { loadAndRenderReviewProof, clearReviewProof, _resetReviewProofForTests, aggregateReviewAction } = await import('./reviewProofSection.js');

/** No-commit discovery result (the pre-HS-9393 baseline). */
const noCommits = (over: Partial<TicketCommitsResponse> = {}): TicketCommitsResponse => ({
  groups: [], span: null, dirty: false, ticketStatus: 'completed', ...over,
});
const group = (over: Record<string, unknown> = {}): TicketCommitsResponse['groups'][number] => ({
  from: 'aaa^', to: 'bbb', count: 2, subjects: ['HS-1234: two', 'HS-1234: one'],
  earliestDate: '2026-07-20T00:00:00Z', latestDate: '2026-07-23T00:00:00Z', ...over,
});

function note(over: Partial<ReviewProofNote> = {}): ReviewProofNote {
  return {
    noteKind: 'proof', file: 'src/x.ts', startLine: 3, endLine: 9, summary: 'proved it',
    rank: 50, level: 'none',
    attachments: [{ uri: '.pr-notes/artifacts/shot.png', kind: 'image', description: 'screenshot' }],
    sourceFile: '.pr-notes/notes/x.sarif', ...over,
  };
}

const container = (): HTMLElement => document.getElementById('detail-review-proof')!;

beforeEach(() => {
  _resetReviewProofForTests();
  document.body.innerHTML = '<div id="detail-review-proof"></div>';
  getReviewProof.mockReset();
  getTicketCommits.mockReset();
  getTicketCommits.mockResolvedValue(noCommits()); // default: no discovered commits
  reviewInGlassbox.mockClear();
  launchGlassbox.mockClear();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('reviewProofSection (HS-9293)', () => {
  it('renders the light list with kind + file:line + summary', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().querySelector('.review-proof-label')?.textContent).toBe('Code Review'); // HS-9393 rename
    expect(container().querySelector('.code-review-notes-count')?.textContent).toBe('1 review note');
    expect(container().querySelector('.review-proof-kind')?.textContent).toBe('proof');
    expect(container().querySelector('.review-proof-loc')?.textContent).toBe('src/x.ts:3–9');
    expect(container().querySelector('.review-proof-summary')?.textContent).toBe('proved it');
  });

  it('HS-9387 — the expanded row renders the FULL note body, markdown-rendered', async () => {
    const body = '**Why an env marker** rather than parent-pid detection:\n\nthe channel server is spawned by the *agent*, so env propagates transitively.\n\nSee `codexDrive.ts:115`.';
    getReviewProof.mockResolvedValue({ notes: [note({ summary: '**Why an env marker** rather than…', body })] });
    await loadAndRenderReviewProof('HS-1234');
    const el = container().querySelector<HTMLElement>('.review-proof-body')!;
    expect(el).not.toBeNull();
    // Full multi-paragraph text present (not just the truncated first line)...
    expect(el.textContent).toContain('env propagates transitively');
    // ...and markdown actually rendered (bold + inline code, no raw asterisks).
    expect(el.querySelector('strong')?.textContent).toBe('Why an env marker');
    expect(el.querySelector('code')?.textContent).toBe('codexDrive.ts:115');
    expect(el.textContent).not.toContain('**');
  });

  it('HS-9387 — falls back to the one-line summary as the body when `body` is absent (older server)', async () => {
    getReviewProof.mockResolvedValue({ notes: [note({ body: undefined })] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().querySelector('.review-proof-body')?.textContent).toContain('proved it');
  });

  it('is presence-gated: empty container when there are no notes AND no commits', async () => {
    getReviewProof.mockResolvedValue({ notes: [] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().childElementCount).toBe(0);
  });

  it('HS-9393 — commits alone (no notes) still surface the section + aggregate button', async () => {
    getReviewProof.mockResolvedValue({ notes: [] });
    getTicketCommits.mockResolvedValue(noCommits({ groups: [group()] }));
    await loadAndRenderReviewProof('HS-1234');
    expect(container().querySelector('.review-proof-label')?.textContent).toBe('Code Review');
    expect(container().querySelector('.code-review-notes-count')).toBeNull();
    const btn = container().querySelector<HTMLButtonElement>('.code-review-aggregate-btn')!;
    btn.click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'range', from: 'aaa^', to: 'bbb' });
  });

  it('HS-9393 — a single-commit group reviews via commit mode', async () => {
    getReviewProof.mockResolvedValue({ notes: [] });
    getTicketCommits.mockResolvedValue(noCommits({ groups: [group({ count: 1, subjects: ['HS-1234: only'] })] }));
    await loadAndRenderReviewProof('HS-1234');
    container().querySelector<HTMLButtonElement>('.code-review-aggregate-btn')!.click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'commit', sha: 'bbb' });
  });

  it('HS-9393 — interleaved groups open the chooser; the span option carries the unrelated-count caveat', async () => {
    getReviewProof.mockResolvedValue({ notes: [] });
    getTicketCommits.mockResolvedValue(noCommits({
      groups: [group({ from: 'c^', to: 'd', count: 1, subjects: ['HS-1234: newer'] }), group()],
      span: { from: 'aaa^', to: 'd', unrelatedCount: 3 },
    }));
    await loadAndRenderReviewProof('HS-1234');
    const btn = container().querySelector<HTMLButtonElement>('.code-review-aggregate-btn')!;
    expect(btn.textContent).toContain('▾');
    const menu = container().querySelector<HTMLElement>('.code-review-chooser')!;
    expect(menu.hasAttribute('hidden')).toBe(true);
    btn.click();
    expect(menu.hasAttribute('hidden')).toBe(false);
    const options = [...menu.querySelectorAll<HTMLButtonElement>('.code-review-chooser-option')];
    expect(options).toHaveLength(3); // two groups + the span option
    expect(options[2].textContent).toContain('includes 3 unrelated commits');
    options[2].click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'range', from: 'aaa^', to: 'd' });
    expect(menu.hasAttribute('hidden')).toBe(true); // collapses after a pick
  });

  it('HS-9393 — started + dirty + no commits offers the uncommitted review', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    getTicketCommits.mockResolvedValue(noCommits({ dirty: true, ticketStatus: 'started' }));
    await loadAndRenderReviewProof('HS-1234');
    const btn = container().querySelector<HTMLButtonElement>('.code-review-aggregate-btn')!;
    expect(btn.textContent).toBe('Review uncommitted changes');
    btn.click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'uncommitted' });
  });

  it('HS-9393 — no commits at all falls back to a files-mode aggregate over note files', async () => {
    getReviewProof.mockResolvedValue({ notes: [note(), note({ file: 'src/y.ts' })] });
    await loadAndRenderReviewProof('HS-1234');
    container().querySelector<HTMLButtonElement>('.code-review-aggregate-btn')!.click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'files', patterns: ['src/x.ts', 'src/y.ts'] });
  });

  it('HS-9393 — a commits fetch failure degrades to the notes-only view', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    getTicketCommits.mockRejectedValue(new Error('older server'));
    await loadAndRenderReviewProof('HS-1234');
    expect(container().querySelector('.review-proof-label')?.textContent).toBe('Code Review');
    expect(container().querySelector('.review-proof-note')).not.toBeNull();
  });

  it('HS-9393 — aggregateReviewAction labels ref-carrying (integration-branch) groups', () => {
    const action = aggregateReviewAction(noCommits({
      groups: [group(), group({ ref: 'hotsheet/w1', from: 'w^', to: 'w', count: 1, subjects: ['HS-1234: worker part'] })],
    }), []);
    expect(action.kind).toBe('chooser');
    if (action.kind === 'chooser') {
      expect(action.options[1].label).toContain('(on hotsheet/w1)');
      expect(action.options).toHaveLength(2); // no span (branch group isn't spanable) — no span option
    }
  });

  it('expands a note on click to render an inline image + Open-in-Glassbox', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    const head = container().querySelector<HTMLElement>('.review-proof-note-head')!;
    const detail = container().querySelector<HTMLElement>('.review-proof-note-detail')!;
    expect(detail.hasAttribute('hidden')).toBe(true);
    head.click();
    expect(detail.hasAttribute('hidden')).toBe(false);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const img = container().querySelector<HTMLImageElement>('.review-proof-img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain('shot.png'); // points at the artifact route
    expect(img!.getAttribute('src')).toContain('/api/tickets/review-proof/artifact');
    expect(container().querySelector('.review-proof-attachment-desc')?.textContent).toBe('screenshot');
    expect(container().querySelector('.review-proof-open-glassbox')).not.toBeNull();
  });

  it('lazily fetches + inlines a text attachment on first expand', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('test output here', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    getReviewProof.mockResolvedValue({ notes: [note({ attachments: [{ uri: '.pr-notes/artifacts/out.txt', kind: 'text' }] })] });
    await loadAndRenderReviewProof('HS-1234');
    const pre = container().querySelector<HTMLPreElement>('.review-proof-text')!;
    expect(pre.textContent).toBe('Loading…'); // not fetched until expanded
    container().querySelector<HTMLElement>('.review-proof-note-head')!.click();
    await vi.waitFor(() => { expect(pre.textContent).toBe('test output here'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('an unchanged reload does not repaint, so an expanded row survives (poll-safe)', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    container().querySelector<HTMLElement>('.review-proof-note-head')!.click();
    const detailBefore = container().querySelector<HTMLElement>('.review-proof-note-detail')!;
    expect(detailBefore.hasAttribute('hidden')).toBe(false);
    await loadAndRenderReviewProof('HS-1234'); // background reload, identical data
    const detailAfter = container().querySelector<HTMLElement>('.review-proof-note-detail')!;
    expect(detailAfter).toBe(detailBefore); // same node — not repainted
    expect(detailAfter.hasAttribute('hidden')).toBe(false); // still expanded
  });

  it('Open-in-Glassbox deep-links to the note file via a files-mode review (HS-9295)', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] }); // file: 'src/x.ts'
    await loadAndRenderReviewProof('HS-1234');
    container().querySelector<HTMLElement>('.review-proof-open-glassbox')!.click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'files', patterns: ['src/x.ts'] });
    expect(launchGlassbox).not.toHaveBeenCalled();
  });

  it('Open-in-Glassbox falls back to the generic open when the note has no file', async () => {
    getReviewProof.mockResolvedValue({ notes: [note({ file: null })] });
    await loadAndRenderReviewProof('HS-1234');
    container().querySelector<HTMLElement>('.review-proof-open-glassbox')!.click();
    expect(launchGlassbox).toHaveBeenCalled();
    expect(reviewInGlassbox).not.toHaveBeenCalled();
  });

  it('clearReviewProof empties the section', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().childElementCount).toBeGreaterThan(0);
    clearReviewProof();
    expect(container().childElementCount).toBe(0);
  });
});

// HS-9398 (docs/122 §122.3) — the section must not require `.pr-notes/` or a
// working review-proof endpoint: a notes-fetch failure degrades to commits-only.
describe('HS-9398 — notes-fetch failure keeps the commits-only view', () => {
  it('renders the aggregate button when review-proof rejects but commits exist', async () => {
    getReviewProof.mockRejectedValue(new Error('no review-proof route'));
    getTicketCommits.mockResolvedValue({
      groups: [{ from: 'a^', to: 'a', count: 1, subjects: ['HS-1: fix'], earliestDate: '2026-07-23T10:00:00Z', latestDate: '2026-07-23T10:00:00Z' }],
      span: null, dirty: false, ticketStatus: 'completed',
    });
    await loadAndRenderReviewProof('HS-1');
    const container = document.getElementById('detail-review-proof')!;
    expect(container.querySelector('.code-review-aggregate-btn')?.textContent).toBe('Open in Glassbox');
    expect(container.querySelector('.code-review-notes-count')).toBeNull();
  });

  it('keeps whatever is shown when BOTH fetches fail', async () => {
    getReviewProof.mockRejectedValue(new Error('down'));
    getTicketCommits.mockRejectedValue(new Error('down'));
    await loadAndRenderReviewProof('HS-1');
    expect(document.getElementById('detail-review-proof')!.childElementCount).toBe(0);
  });
});
