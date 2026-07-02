// @vitest-environment happy-dom
/**
 * HS-9293 (docs/111) — the detail-panel "Review Proof" section: presence-gated
 * light list of a ticket's Glassbox `.pr-notes/` notes, each expandable to its
 * attachment chips, with poll-safe repainting (unchanged reload preserves an
 * expanded row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewProofNote } from '../api/reviewProof.js';

const getReviewProof = vi.fn<(t: string) => Promise<{ notes: ReviewProofNote[] }>>();
vi.mock('../api/index.js', () => ({ getReviewProof: (t: string) => getReviewProof(t) }));

const { loadAndRenderReviewProof, clearReviewProof, _resetReviewProofForTests } = await import('./reviewProofSection.js');

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
});
afterEach(() => { document.body.innerHTML = ''; });

describe('reviewProofSection (HS-9293)', () => {
  it('renders the light list with kind + file:line + summary', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().querySelector('.review-proof-label')?.textContent).toBe('Review Proof (1)');
    expect(container().querySelector('.review-proof-kind')?.textContent).toBe('proof');
    expect(container().querySelector('.review-proof-loc')?.textContent).toBe('src/x.ts:3–9');
    expect(container().querySelector('.review-proof-summary')?.textContent).toBe('proved it');
  });

  it('is presence-gated: empty container when there are no notes', async () => {
    getReviewProof.mockResolvedValue({ notes: [] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().childElementCount).toBe(0);
  });

  it('expands a note on click to show its attachment chips', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    const head = container().querySelector<HTMLElement>('.review-proof-note-head')!;
    const detail = container().querySelector<HTMLElement>('.review-proof-note-detail')!;
    expect(detail.hasAttribute('hidden')).toBe(true);
    head.click();
    expect(detail.hasAttribute('hidden')).toBe(false);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(container().querySelector('.review-proof-attachment-name')?.textContent).toBe('shot.png');
    expect(container().querySelector('.review-proof-attachment-desc')?.textContent).toBe('screenshot');
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

  it('clearReviewProof empties the section', async () => {
    getReviewProof.mockResolvedValue({ notes: [note()] });
    await loadAndRenderReviewProof('HS-1234');
    expect(container().childElementCount).toBeGreaterThan(0);
    clearReviewProof();
    expect(container().childElementCount).toBe(0);
  });
});
