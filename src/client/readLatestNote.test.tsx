// @vitest-environment happy-dom
/**
 * HS-8830 — `openLatestNoteReader` (shared by the "Read Latest Note" context-menu
 * item and the space-bar shortcut) opens the §49 reader on a ticket's latest
 * non-empty note, falling back to its Details, and reports which it opened.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ReaderOverlayModule from './readerOverlay.js';
import type { OpenReaderOverlayOptions } from './readerOverlay.js';
import type { Ticket } from './state.js';

const openReaderOverlay = vi.fn<(opts: OpenReaderOverlayOptions) => void>();
vi.mock('./readerOverlay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaderOverlayModule>();
  return { ...actual, openReaderOverlay };
});

const { openLatestNoteReader } = await import('./readLatestNote.js');

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    ticket_number: 'HS-1',
    title: 'My Ticket',
    details: '',
    category: 'feature',
    priority: 'default',
    status: 'not_started',
    up_next: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    verified_at: null,
    deleted_at: null,
    notes: '',
    tags: '[]',
    last_read_at: null,
    ...overrides,
  };
}

function notesWith(...texts: string[]): string {
  return JSON.stringify(texts.map((text, i) => ({ id: `n_${i}`, text, created_at: `2026-05-1${i}T00:00:00Z` })));
}

afterEach(() => { openReaderOverlay.mockClear(); });

describe('openLatestNoteReader (HS-8830)', () => {
  it('opens the latest non-empty note and returns "note"', () => {
    const t = makeTicket({ notes: notesWith('## First', '## Second') });
    expect(openLatestNoteReader(t)).toBe('note');
    expect(openReaderOverlay).toHaveBeenCalledTimes(1);
    expect(openReaderOverlay.mock.calls[0][0].markdown).toBe('## Second');
  });

  it('skips trailing empty notes and anchors on the last NON-empty note', () => {
    const t = makeTicket({ notes: notesWith('## Real', '', '   ') });
    expect(openLatestNoteReader(t)).toBe('note');
    expect(openReaderOverlay.mock.calls[0][0].markdown).toBe('## Real');
  });

  it('falls back to Details when there are no non-empty notes, returning "details"', () => {
    const t = makeTicket({ notes: '', details: 'The description.' });
    expect(openLatestNoteReader(t)).toBe('details');
    expect(openReaderOverlay).toHaveBeenCalledTimes(1);
    expect(openReaderOverlay.mock.calls[0][0].markdown).toBe('The description.');
  });

  it('returns null and opens nothing when there is neither a note nor a description', () => {
    const t = makeTicket({ notes: '', details: '   ' });
    expect(openLatestNoteReader(t)).toBe(null);
    expect(openReaderOverlay).not.toHaveBeenCalled();
  });

  it('provides reader navigation when there is more than one entry (note + details)', () => {
    const t = makeTicket({ notes: notesWith('## Note'), details: 'Desc' });
    openLatestNoteReader(t);
    const opts = openReaderOverlay.mock.calls[0][0];
    expect(opts.navigation).toBeDefined();
    expect(opts.navigation?.entries.length).toBe(2);
  });
});
