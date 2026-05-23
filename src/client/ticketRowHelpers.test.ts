// @vitest-environment happy-dom
/**
 * HS-8560 — coverage backfill for the pure-helper exports of
 * `src/client/ticketRow.tsx`. The existing `ticketRow.test.tsx` is
 * HS-8335 / HS-8357 focused (per-row reactive effects via
 * `setupTicketRowEffects` + `setupColumnCardEffects`). This sibling
 * file picks up the smaller exported helpers that don't depend on a
 * minimal-row DOM scaffold — `hasPendingFeedback`,
 * `getIndicatorDotType`, `debouncedSave`, `cancelPendingSave`. Pre-
 * fix module coverage was 26.8%.
 *
 * `cycleStatus` / `toggleUpNext` are NOT covered here — they reach
 * into the live `ticketsStore` + `trackedPatch` + `callLoadTickets` /
 * `callRenderTicketList` injection points and re-mocking the entire
 * chain at the same depth as the existing `ticketRow.test.tsx` would
 * duplicate that file's HS-8367 fixtures. They're best added later as
 * an extension of `ticketRow.test.tsx` itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from './state.js';

const mockApi = vi.fn<(path: string, opts?: unknown) => Promise<unknown>>();
vi.mock('./api.js', () => ({
  api: (path: string, opts?: unknown): Promise<unknown> => mockApi(path, opts),
}));

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    ticket_number: 'HS-1',
    title: 'Test',
    details: '',
    category: 'task',
    priority: 'default',
    status: 'not_started',
    up_next: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    verified_at: null,
    deleted_at: null,
    notes: '',
    tags: '',
    last_read_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockApi.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hasPendingFeedback', () => {
  it('returns false when notes is empty string', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    expect(hasPendingFeedback(ticket({ notes: '' }))).toBe(false);
  });

  it('returns false when notes is "[]"', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    expect(hasPendingFeedback(ticket({ notes: '[]' }))).toBe(false);
  });

  it('returns false when notes is not valid JSON', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    expect(hasPendingFeedback(ticket({ notes: 'not json' }))).toBe(false);
  });

  it('returns false when the last note is missing a string .text field', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    const notes = JSON.stringify([{ created_at: '2026-01-01' }]);
    expect(hasPendingFeedback(ticket({ notes }))).toBe(false);
  });

  it('returns true when the LAST note starts with "FEEDBACK NEEDED:"', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    const notes = JSON.stringify([
      { text: 'old note' },
      { text: 'FEEDBACK NEEDED: what color?' },
    ]);
    expect(hasPendingFeedback(ticket({ notes }))).toBe(true);
  });

  it('returns true when the LAST note starts with "IMMEDIATE FEEDBACK NEEDED:"', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    const notes = JSON.stringify([{ text: 'IMMEDIATE FEEDBACK NEEDED: ship it?' }]);
    expect(hasPendingFeedback(ticket({ notes }))).toBe(true);
  });

  it('returns false when a NON-LAST note matches but the latest does not', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    const notes = JSON.stringify([
      { text: 'FEEDBACK NEEDED: old question (already answered)' },
      { text: 'thanks!' },
    ]);
    expect(hasPendingFeedback(ticket({ notes }))).toBe(false);
  });

  it('tolerates leading whitespace before the prefix', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    const notes = JSON.stringify([{ text: '   FEEDBACK NEEDED: trimmed?' }]);
    expect(hasPendingFeedback(ticket({ notes }))).toBe(true);
  });

  it('returns false for an empty notes array', async () => {
    const { hasPendingFeedback } = await import('./ticketRow.js');
    const notes = JSON.stringify([]);
    expect(hasPendingFeedback(ticket({ notes }))).toBe(false);
  });
});

describe('getIndicatorDotType', () => {
  it('returns "feedback" when a feedback note is pending (highest priority)', async () => {
    const { getIndicatorDotType } = await import('./ticketRow.js');
    const notes = JSON.stringify([{ text: 'FEEDBACK NEEDED: x' }]);
    expect(getIndicatorDotType(ticket({ notes }))).toBe('feedback');
  });

  it('returns "feedback" even when updated_at is newer than last_read_at', async () => {
    const { getIndicatorDotType } = await import('./ticketRow.js');
    const notes = JSON.stringify([{ text: 'FEEDBACK NEEDED: x' }]);
    expect(getIndicatorDotType(ticket({
      notes,
      last_read_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    }))).toBe('feedback');
  });

  it('returns "unread" when updated_at is newer than last_read_at + no feedback', async () => {
    const { getIndicatorDotType } = await import('./ticketRow.js');
    expect(getIndicatorDotType(ticket({
      last_read_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    }))).toBe('unread');
  });

  it('returns null when last_read_at is null (never opened)', async () => {
    const { getIndicatorDotType } = await import('./ticketRow.js');
    expect(getIndicatorDotType(ticket({ last_read_at: null }))).toBe(null);
  });

  it('returns null when last_read_at >= updated_at', async () => {
    const { getIndicatorDotType } = await import('./ticketRow.js');
    expect(getIndicatorDotType(ticket({
      last_read_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }))).toBe(null);
  });
});

describe('debouncedSave + cancelPendingSave', () => {
  it('fires the PATCH after a 300ms idle window', async () => {
    vi.useFakeTimers();
    const { debouncedSave } = await import('./ticketRow.js');
    debouncedSave(7, { title: 'New' });
    expect(mockApi).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(mockApi).toHaveBeenCalledWith('/tickets/7', { method: 'PATCH', body: { title: 'New' } });
  });

  it('coalesces rapid calls — only the last payload fires', async () => {
    vi.useFakeTimers();
    const { debouncedSave } = await import('./ticketRow.js');
    debouncedSave(7, { title: 'A' });
    vi.advanceTimersByTime(100);
    debouncedSave(7, { title: 'B' });
    vi.advanceTimersByTime(100);
    debouncedSave(7, { title: 'C' });
    vi.advanceTimersByTime(300);
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith('/tickets/7', { method: 'PATCH', body: { title: 'C' } });
  });

  it('cancelPendingSave aborts a pending save before it fires', async () => {
    vi.useFakeTimers();
    const { debouncedSave, cancelPendingSave } = await import('./ticketRow.js');
    debouncedSave(7, { title: 'Maybe' });
    cancelPendingSave();
    vi.advanceTimersByTime(500);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('cancelPendingSave is a no-op when nothing is pending', async () => {
    vi.useFakeTimers();
    const { cancelPendingSave } = await import('./ticketRow.js');
    expect(() => cancelPendingSave()).not.toThrow();
  });
});
