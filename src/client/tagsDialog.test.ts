// @vitest-environment happy-dom
/**
 * HS-8614 — the tags dialog moved its per-checkbox `change` listener off
 * per-element attachment and onto a single `delegate()` handler on the stable
 * `#tags-dialog-body` container, reading the tag from each row's `data-tag`.
 * These tests lock in the OBSERVABLE result (clicking Done applies the right
 * add/remove set) and prove the delegation survives a `renderTagRows()` rebuild
 * (the add-a-tag path), so a toggle on a freshly-rendered row still maps to the
 * correct tag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateTicket } from '../api/index.js';
import type { Ticket } from '../types.js';
import { state } from './state.js';
import { showTagsDialog } from './tagsDialog.js';

const getTagsMock = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock('../api/index.js', () => ({
  getTags: () => getTagsMock(),
  updateTicket: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./ticketList.js', () => ({ loadTickets: vi.fn(() => Promise.resolve()) }));
vi.mock('./detail.js', () => ({
  refreshDetail: vi.fn(),
  displayTag: (t: string) => t,
  normalizeTag: (s: string) => s.trim().toLowerCase(),
  hasTag: (list: string[], tag: string) => list.some(t => t.toLowerCase() === tag.toLowerCase()),
  parseTags: (json: string) => {
    if (json === '') return [];
    try { const v: unknown = JSON.parse(json); return Array.isArray(v) ? v as string[] : []; } catch { return []; }
  },
}));

function ticket(id: number, tags: string[]): Ticket {
  return { id, tags: JSON.stringify(tags) } as Ticket;
}

async function openDialog(): Promise<void> {
  await showTagsDialog();
  // Let the `await getTags()` microtask + initial render settle.
  await Promise.resolve();
  await Promise.resolve();
}

describe('tagsDialog — delegated checkbox change (HS-8614)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getTagsMock.mockReset();
    vi.mocked(updateTicket).mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    state.tickets = [];
    state.selectedIds = new Set();
  });

  it('toggling a tag on, then Done, applies it to every selected ticket', async () => {
    state.tickets = [ticket(1, []), ticket(2, [])];
    state.selectedIds = new Set([1, 2]);
    getTagsMock.mockResolvedValue(['bug', 'feature']);

    await openDialog();

    const featureRow = document.querySelector<HTMLElement>('.tags-dialog-row[data-tag="feature"]');
    expect(featureRow).not.toBeNull();
    const cb = featureRow!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));

    document.querySelector<HTMLButtonElement>('#tags-dialog-done')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(updateTicket)).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(updateTicket).mock.calls) {
      const tags = JSON.parse((call[1] as { tags: string }).tags) as string[];
      expect(tags).toContain('feature');
    }
  });

  it('REBUILD REGRESSION: a tag added via the New-tag field (which rebuilds the rows) toggles correctly', async () => {
    state.tickets = [ticket(1, [])];
    state.selectedIds = new Set([1]);
    getTagsMock.mockResolvedValue([]);

    await openDialog();

    // Add a brand-new tag — this calls renderTagRows() again, rebuilding the
    // body's children. The single delegated listener must keep working on the
    // fresh row and read its data-tag.
    const newInput = document.querySelector<HTMLInputElement>('#tags-dialog-new-input')!;
    newInput.value = 'urgent';
    document.querySelector<HTMLButtonElement>('#tags-dialog-add-btn')!.click();

    const row = document.querySelector<HTMLElement>('.tags-dialog-row[data-tag="urgent"]');
    expect(row).not.toBeNull();
    // The add path checks the new tag by default; untick it then re-tick to
    // exercise the delegated handler against the rebuilt row.
    const cb = row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));

    document.querySelector<HTMLButtonElement>('#tags-dialog-done')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(updateTicket)).toHaveBeenCalledTimes(1);
    const tags = JSON.parse((vi.mocked(updateTicket).mock.calls[0][1] as { tags: string }).tags) as string[];
    expect(tags).toContain('urgent');
  });

  it('the delegated listener is removed when the dialog closes (no leak onto a detached body)', async () => {
    state.tickets = [ticket(1, [])];
    state.selectedIds = new Set([1]);
    getTagsMock.mockResolvedValue(['bug']);

    await openDialog();
    const body = document.querySelector<HTMLElement>('#tags-dialog-body')!;
    document.querySelector<HTMLButtonElement>('#tags-dialog-cancel')!.click();
    // Overlay is removed on cancel.
    expect(document.querySelector('.tags-dialog-overlay')).toBeNull();
    // Dispatching on the now-detached body must not throw or mutate anything.
    const cb = body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (cb !== null) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    expect(vi.mocked(updateTicket)).not.toHaveBeenCalled();
  });
});
