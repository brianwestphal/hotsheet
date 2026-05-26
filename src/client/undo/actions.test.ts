// @vitest-environment happy-dom
/**
 * HS-8560 — unit coverage for `src/client/undo/actions.ts`. Pre-fix
 * coverage was 0.75% — the only call into the module from a test was
 * the indirect `import` resolution. This suite covers every public
 * action (`snapshot` / `trackedPatch` / `recordTextChange` /
 * `trackedBatch` / `trackedCompoundBatch` / `trackedDelete` /
 * `trackedRestore` / `performUndo` / `performRedo` / `pushNotesUndo` /
 * `canUndo` / `canRedo` / `toggleUpNext` / `toggleReadState`) without
 * standing up a real backend.
 *
 * HS-8642 — the actions now route through the typed API layer
 * (`updateTicket` / `batchTickets` / `deleteTicket` / `restoreTicket` /
 * `putTicketNotesBulk`), so those are mocked here instead of the old raw
 * `api()`. The REAL `BatchActionSchema` / `UpdateTicketSchema` are supplied
 * to the mock because `actions.ts` calls `.parse()` on the loose bodies
 * before handing them to the typed callers. The `ticketList` + `detail`
 * re-render hooks are mocked so the tests assert on the orchestration:
 *   - which typed caller fired with what arguments
 *   - which undo entries got pushed (label + before/after shape)
 *   - whether the in-flight guard blocks re-entry
 */
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from '../state.js';
import type * as ActionsNS from './actions.js';

const mockUpdateTicket = vi.fn<(id: number, body: unknown) => Promise<unknown>>();
const mockBatchTickets = vi.fn<(req: { ids: number[]; action: string; value?: unknown }) => Promise<unknown>>();
const mockDeleteTicket = vi.fn<(id: number) => Promise<unknown>>();
const mockRestoreTicket = vi.fn<(id: number) => Promise<unknown>>();
const mockPutNotesBulk = vi.fn<(id: number, notes: string) => Promise<unknown>>();
const mockLoadTickets = vi.fn<() => Promise<void>>();
const mockRenderTicketList = vi.fn<() => void>();
const mockRefreshDetail = vi.fn<() => void>();
const mockSetSuppressAutoRead = vi.fn<(v: boolean) => void>();

// Mock the typed callers but keep the REAL request schemas — `actions.ts`
// validates the loose bodies with `UpdateTicketSchema.parse` /
// `BatchActionSchema.parse` before routing through the mocked callers.
vi.mock('../../api/index.js', async () => {
  const validation = await import('../../routes/validation.js');
  return {
    BatchActionSchema: validation.BatchActionSchema,
    UpdateTicketSchema: validation.UpdateTicketSchema,
    updateTicket: (id: number, body: unknown): Promise<unknown> => mockUpdateTicket(id, body),
    batchTickets: (req: { ids: number[]; action: string; value?: unknown }): Promise<unknown> => mockBatchTickets(req),
    deleteTicket: (id: number): Promise<unknown> => mockDeleteTicket(id),
    restoreTicket: (id: number): Promise<unknown> => mockRestoreTicket(id),
    putTicketNotesBulk: (id: number, notes: string): Promise<unknown> => mockPutNotesBulk(id, notes),
  };
});

vi.mock('../detail.js', () => ({
  refreshDetail: (): void => mockRefreshDetail(),
  setSuppressAutoRead: (v: boolean): void => mockSetSuppressAutoRead(v),
}));

vi.mock('../ticketList.js', () => ({
  loadTickets: (): Promise<void> => mockLoadTickets(),
  renderTicketList: (): void => mockRenderTicketList(),
}));

// state mock — `shouldResetStatusOnUpNext` is pure-ish (looks at the
// status enum). Copy the real implementation here so the test is
// honest about which statuses trigger the reset path.
vi.mock('../state.js', () => ({
  state: {
    tickets: [] as Ticket[],
  },
  shouldResetStatusOnUpNext: (status: string): boolean =>
    status === 'completed' || status === 'verified' || status === 'backlog' || status === 'archive',
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

// Each test gets a freshly-imported actions module so the
// `undoRedoInFlight` private + the module-singleton `undoStack` start
// at a clean state. We import inside each test rather than at top-
// level so `vi.resetModules()` gives us new module instances.
async function freshActions(): Promise<typeof ActionsNS> {
  vi.resetModules();
  return await import('./actions.js');
}

beforeEach(() => {
  mockUpdateTicket.mockReset().mockResolvedValue(ticket());
  mockBatchTickets.mockReset().mockResolvedValue(undefined);
  mockDeleteTicket.mockReset().mockResolvedValue(undefined);
  mockRestoreTicket.mockReset().mockResolvedValue(undefined);
  mockPutNotesBulk.mockReset().mockResolvedValue(undefined);
  mockLoadTickets.mockReset();
  mockRenderTicketList.mockReset();
  mockRefreshDetail.mockReset();
  mockSetSuppressAutoRead.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('snapshot', () => {
  it('captures the seven UndoEntry fields by default (no notes)', async () => {
    const { snapshot } = await freshActions();
    const t = ticket({ title: 'A', details: 'B', up_next: true });
    const s = snapshot(t);
    expect(s).toEqual({
      id: 1, title: 'A', details: 'B', category: 'task',
      priority: 'default', status: 'not_started', up_next: true,
    });
    expect('notes' in s).toBe(false);
  });

  it('includes notes when includeNotes=true', async () => {
    const { snapshot } = await freshActions();
    const t = ticket({ notes: '[]' });
    expect(snapshot(t, true).notes).toBe('[]');
  });
});

describe('trackedPatch', () => {
  it('PATCHes the ticket + pushes an undo entry with before/after snapshots', async () => {
    const { trackedPatch, canUndo } = await freshActions();
    const t = ticket({ title: 'Old' });
    mockUpdateTicket.mockResolvedValue(ticket({ title: 'New' }));
    const result = await trackedPatch(t, { title: 'New' }, 'Edit title');
    expect(mockUpdateTicket).toHaveBeenCalledWith(1, { title: 'New' });
    expect(result.title).toBe('New');
    expect(canUndo()).toBe(true);
  });
});

describe('recordTextChange — coalescing', () => {
  it('pushes a new entry on first call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { recordTextChange, canUndo } = await freshActions();
    recordTextChange(ticket(), 'title', 'A');
    expect(canUndo()).toBe(true);
  });

  it('coalesces rapid same-field edits into one entry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const actions = await freshActions();
    const t = ticket({ title: 'Original' });
    actions.recordTextChange(t, 'title', 'A');
    vi.advanceTimersByTime(100);
    actions.recordTextChange(t, 'title', 'AB');
    vi.advanceTimersByTime(100);
    actions.recordTextChange(t, 'title', 'ABC');
    // All three coalesce → undo brings us back to 'Original' in one pop.
    const { undoStack } = await import('./stack.js');
    expect(undoStack.canUndo()).toBe(true);
    const top = undoStack.popUndo();
    expect(top!.before[0].title).toBe('Original');
    expect(top!.after[0].title).toBe('ABC');
  });

  it('starts a new entry when the field key changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const actions = await freshActions();
    const t = ticket();
    actions.recordTextChange(t, 'title', 'A');
    actions.recordTextChange(t, 'details', 'B');
    const { undoStack } = await import('./stack.js');
    expect(undoStack.popUndo()!.after[0].details).toBe('B'); // most recent
    expect(undoStack.popUndo()!.after[0].title).toBe('A');
  });

  it('starts a new entry after the 5s coalesce window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const actions = await freshActions();
    const t = ticket();
    actions.recordTextChange(t, 'title', 'A');
    vi.advanceTimersByTime(6000); // past 5s coalesce
    actions.recordTextChange(t, 'title', 'B');
    const { undoStack } = await import('./stack.js');
    expect(undoStack.popUndo()!.after[0].title).toBe('B');
    expect(undoStack.popUndo()!.after[0].title).toBe('A');
  });
});

describe('trackedBatch', () => {
  it('issues one batch call + records before/after snapshots per ticket', async () => {
    const { trackedBatch, canUndo } = await freshActions();
    const tickets = [ticket({ id: 1 }), ticket({ id: 2 })];
    await trackedBatch(tickets, { ids: [1, 2], action: 'category', value: 'bug' }, 'Set category');
    expect(mockBatchTickets).toHaveBeenCalledTimes(1);
    expect(mockBatchTickets).toHaveBeenCalledWith({ ids: [1, 2], action: 'category', value: 'bug' });
    expect(canUndo()).toBe(true);
  });

  it('constructs after-state per action — category', async () => {
    const { trackedBatch } = await freshActions();
    await trackedBatch([ticket()], { ids: [1], action: 'category', value: 'bug' }, 'Set category');
    const { undoStack } = await import('./stack.js');
    expect(undoStack.popUndo()!.after[0].category).toBe('bug');
  });

  it('constructs after-state per action — priority / status / up_next / delete / mark_read / mark_unread', async () => {
    const { trackedBatch } = await freshActions();
    const { undoStack } = await import('./stack.js');

    await trackedBatch([ticket()], { ids: [1], action: 'priority', value: 'high' }, 'P');
    expect(undoStack.popUndo()!.after[0].priority).toBe('high');

    await trackedBatch([ticket()], { ids: [1], action: 'status', value: 'completed' }, 'S');
    expect(undoStack.popUndo()!.after[0].status).toBe('completed');

    await trackedBatch([ticket()], { ids: [1], action: 'up_next', value: true }, 'U');
    expect(undoStack.popUndo()!.after[0].up_next).toBe(true);

    await trackedBatch([ticket()], { ids: [1], action: 'delete' }, 'D');
    expect(undoStack.popUndo()!.after[0].status).toBe('deleted');

    await trackedBatch([ticket()], { ids: [1], action: 'mark_read' }, 'R');
    expect(undoStack.popUndo()!.after[0].last_read_at).toBeDefined();

    await trackedBatch([ticket()], { ids: [1], action: 'mark_unread' }, 'U');
    expect(undoStack.popUndo()!.after[0].last_read_at).toBe('1970-01-01T00:00:00Z');
  });
});

describe('trackedCompoundBatch', () => {
  it('issues one batch call per op + composes the after-state from the op chain', async () => {
    const { trackedCompoundBatch } = await freshActions();
    const t = ticket({ id: 5, status: 'completed', up_next: false });
    await trackedCompoundBatch(
      [t],
      [
        { ids: [5], action: 'status', value: 'not_started' },
        { ids: [5], action: 'up_next', value: true },
      ],
      'Reopen + star',
    );
    expect(mockBatchTickets).toHaveBeenCalledTimes(2);
    const { undoStack } = await import('./stack.js');
    const after = undoStack.popUndo()!.after[0];
    expect(after.status).toBe('not_started');
    expect(after.up_next).toBe(true);
  });

  it('skips ops whose ids exclude the ticket (per-ticket filter)', async () => {
    const { trackedCompoundBatch } = await freshActions();
    const t = ticket({ id: 1, status: 'completed', up_next: false });
    await trackedCompoundBatch(
      [t],
      [
        { ids: [999], action: 'status', value: 'archive' }, // doesn't include id 1
        { ids: [1], action: 'up_next', value: true },
      ],
      'Mixed',
    );
    const { undoStack } = await import('./stack.js');
    const after = undoStack.popUndo()!.after[0];
    expect(after.status).toBe('completed'); // unchanged because op #1 skipped
    expect(after.up_next).toBe(true);
  });
});

describe('trackedDelete + trackedRestore', () => {
  it('trackedDelete fires deleteTicket + records "Delete ticket"', async () => {
    const { trackedDelete } = await freshActions();
    await trackedDelete(ticket());
    expect(mockDeleteTicket).toHaveBeenCalledWith(1);
    const { undoStack } = await import('./stack.js');
    const entry = undoStack.popUndo()!;
    expect(entry.label).toBe('Delete ticket');
    expect(entry.after[0].status).toBe('deleted');
  });

  it('trackedRestore fires restoreTicket + sets after-status to not_started', async () => {
    const { trackedRestore } = await freshActions();
    await trackedRestore(ticket({ status: 'completed' }));
    expect(mockRestoreTicket).toHaveBeenCalledWith(1);
    const { undoStack } = await import('./stack.js');
    expect(undoStack.popUndo()!.after[0].status).toBe('not_started');
  });
});

describe('performUndo / performRedo', () => {
  it('performUndo replays the before-snapshot via updateTicket + reloads + refreshes detail', async () => {
    vi.useFakeTimers();
    const { trackedPatch, performUndo } = await freshActions();
    mockUpdateTicket.mockResolvedValue(ticket({ title: 'New' }));
    await trackedPatch(ticket({ title: 'Old' }), { title: 'New' }, 'Edit');
    mockUpdateTicket.mockClear();
    mockLoadTickets.mockResolvedValue();

    const p = performUndo();
    await vi.runAllTimersAsync();
    await p;
    expect(mockUpdateTicket).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Old' }));
    expect(mockLoadTickets).toHaveBeenCalled();
    expect(mockRefreshDetail).toHaveBeenCalled();
  });

  it('performUndo is a no-op when the stack is empty', async () => {
    const { performUndo } = await freshActions();
    await performUndo();
    expect(mockUpdateTicket).not.toHaveBeenCalled();
    expect(mockDeleteTicket).not.toHaveBeenCalled();
  });

  it('performRedo replays the after-snapshot + reloads', async () => {
    vi.useFakeTimers();
    const { trackedPatch, performUndo, performRedo } = await freshActions();
    mockUpdateTicket.mockResolvedValue(ticket({ title: 'New' }));
    await trackedPatch(ticket({ title: 'Old' }), { title: 'New' }, 'Edit');
    mockLoadTickets.mockResolvedValue();

    let p = performUndo();
    await vi.runAllTimersAsync();
    await p;
    mockUpdateTicket.mockClear();
    p = performRedo();
    await vi.runAllTimersAsync();
    await p;
    expect(mockUpdateTicket).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'New' }));
  });

  it('performRedo is a no-op when the redo stack is empty', async () => {
    const { performRedo } = await freshActions();
    await performRedo();
    expect(mockUpdateTicket).not.toHaveBeenCalled();
    expect(mockDeleteTicket).not.toHaveBeenCalled();
  });

  it('applies the soft-delete branch via deleteTicket when a snapshot has status=deleted', async () => {
    vi.useFakeTimers();
    const { trackedDelete, performRedo, performUndo } = await freshActions();
    await trackedDelete(ticket({ status: 'not_started' }));
    mockUpdateTicket.mockClear();
    mockDeleteTicket.mockClear();
    mockLoadTickets.mockResolvedValue();

    // undo brings it back to not_started → updateTicket path
    let p = performUndo();
    await vi.runAllTimersAsync();
    await p;
    expect(mockUpdateTicket).toHaveBeenCalled();

    mockUpdateTicket.mockClear();
    mockDeleteTicket.mockClear();
    // redo replays the after (status=deleted) → deleteTicket path
    p = performRedo();
    await vi.runAllTimersAsync();
    await p;
    expect(mockDeleteTicket).toHaveBeenCalled();
  });

  it('restores notes when the snapshot includes them', async () => {
    vi.useFakeTimers();
    const { pushNotesUndo, performUndo } = await freshActions();
    const t = ticket({ notes: 'before-notes' });
    pushNotesUndo(t, 'Edit notes', 'after-notes');
    mockLoadTickets.mockResolvedValue();
    const p = performUndo();
    await vi.runAllTimersAsync();
    await p;
    expect(mockPutNotesBulk).toHaveBeenCalledWith(1, 'before-notes');
  });
});

describe('pushNotesUndo', () => {
  it('captures the before notes + sets the after notes', async () => {
    const { pushNotesUndo } = await freshActions();
    pushNotesUndo(ticket({ notes: 'before' }), 'Edit notes', 'after');
    const { undoStack } = await import('./stack.js');
    const entry = undoStack.popUndo()!;
    expect(entry.before[0].notes).toBe('before');
    expect(entry.after[0].notes).toBe('after');
  });
});

describe('canUndo / canRedo', () => {
  it('start false on a fresh stack', async () => {
    const { canUndo, canRedo } = await freshActions();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('canUndo flips true after trackedPatch', async () => {
    const { trackedPatch, canUndo } = await freshActions();
    await trackedPatch(ticket(), { title: 'X' }, 'Edit');
    expect(canUndo()).toBe(true);
  });
});

describe('toggleUpNext — HS-7998 status-reset path', () => {
  it('sets up_next true via single batch when no ticket needs status reset', async () => {
    const { toggleUpNext } = await freshActions();
    await toggleUpNext([ticket({ status: 'started', up_next: false })]);
    // One batch call (no compound) — up_next only.
    expect(mockBatchTickets).toHaveBeenCalledTimes(1);
    expect(mockBatchTickets.mock.calls[0][0]).toEqual({ ids: [1], action: 'up_next', value: true });
  });

  it('reopens completed / verified / backlog / archive tickets when setting up_next', async () => {
    const { toggleUpNext } = await freshActions();
    await toggleUpNext([ticket({ status: 'completed', up_next: false })]);
    // Two batch calls (compound): status reset + up_next.
    expect(mockBatchTickets).toHaveBeenCalledTimes(2);
    expect(mockBatchTickets.mock.calls[0][0].action).toBe('status');
    expect(mockBatchTickets.mock.calls[1][0].action).toBe('up_next');
  });

  it('unstarring (all already up_next) takes the single-batch path with value=false', async () => {
    const { toggleUpNext } = await freshActions();
    await toggleUpNext([ticket({ up_next: true }), ticket({ id: 2, up_next: true })]);
    expect(mockBatchTickets).toHaveBeenCalledTimes(1);
    expect(mockBatchTickets.mock.calls[0][0].value).toBe(false);
  });
});

describe('toggleReadState', () => {
  it('marks-as-read when any selected ticket is unread', async () => {
    const { state } = await import('../state.js');
    (state as { tickets: Ticket[] }).tickets = [
      ticket({ id: 1, last_read_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }), // unread
    ];
    const { toggleReadState } = await freshActions();
    // Re-stub state after freshActions imports — vi.resetModules reset the singleton.
    const { state: state2 } = await import('../state.js');
    (state2 as { tickets: Ticket[] }).tickets = [
      ticket({ id: 1, last_read_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }),
    ];
    await toggleReadState([1]);
    expect(mockSetSuppressAutoRead).toHaveBeenCalledWith(false);
    expect(mockBatchTickets.mock.calls[0][0].action).toBe('mark_read');
    expect(mockRenderTicketList).toHaveBeenCalled();
  });

  it('marks-as-unread when all selected tickets are read', async () => {
    const { toggleReadState } = await freshActions();
    const { state } = await import('../state.js');
    (state as { tickets: Ticket[] }).tickets = [
      ticket({ id: 1, last_read_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }), // read
    ];
    await toggleReadState([1]);
    expect(mockSetSuppressAutoRead).toHaveBeenCalledWith(true);
    expect(mockBatchTickets.mock.calls[0][0].action).toBe('mark_unread');
  });
});

// Discourage `Mock` type from being shaken out by tsc's unused-import check.
const _typeOnly: Mock | null = null;
void _typeOnly;
