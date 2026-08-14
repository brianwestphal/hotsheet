import {
  BatchActionSchema, batchTickets, deleteTicket,
  putTicketNotesBulk, restoreTicket, updateTicket, UpdateTicketSchema,
} from '../../api/index.js';
import { refreshDetail, setSuppressAutoRead } from '../detail.js';
import type { Ticket } from '../state.js';
import { getActiveProject, shouldResetStatusOnUpNext, state } from '../state.js';
import { loadTickets, renderTicketList } from '../ticketList.js';
import { ticketsStore } from '../ticketsStore.js';
import { getUndoStack } from './stack.js';
import type { TicketSnapshot, UndoEntry } from './types.js';

/**
 * HS-9335 — the CURRENT project's undo stack. Every record/undo/redo goes through this,
 * so a stack is scoped to one project tab: switching tabs switches the history, and an
 * undo can never reach a ticket in another project. Keyed by the active project secret;
 * `''` (no active project) is a shared fallback stack.
 */
function activeStack() {
  return getUndoStack(getActiveProject()?.secret ?? '');
}

export function snapshot(ticket: Ticket, includeNotes = false): TicketSnapshot {
  const s: TicketSnapshot = {
    id: ticket.id,
    title: ticket.title,
    details: ticket.details,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    up_next: ticket.up_next,
  };
  if (includeNotes) s.notes = ticket.notes;
  return s;
}

/**
 * HS-9652 / HS-9653 — apply a batch op to the ticket store IMMEDIATELY, before the
 * server round-trip, so the column view moves/removes the card instantly. Without this,
 * `trackedBatch`/`trackedPatch` only fired the server call and waited for a full
 * `loadTickets()` refetch (or a `/ws/sync` push, or the long-poll) to bring the change
 * back — which on a busy/large project lagged "excessively", showing a verified→completed
 * move in BOTH columns (9652) or an archive that "did nothing" for a long time (9653).
 * The follow-up refetch the callers already run reconciles the authoritative state; on a
 * server error the caller path here calls `loadTickets()` to revert. Mirrors the HS-9052
 * read-state fix (which gave `mark_read`/`mark_unread` this treatment at the call site).
 */
function applyBatchOptimistic(op: { ids: number[]; action: string; value?: unknown }): void {
  const { ids, action, value } = op;
  for (const id of ids) {
    if (action === 'delete') {
      ticketsStore.actions.removeTicket(id);
    } else if (action === 'status' && typeof value === 'string') {
      ticketsStore.actions.optimisticUpdate(id, { status: value });
    } else if (action === 'category' && typeof value === 'string') {
      ticketsStore.actions.optimisticUpdate(id, { category: value });
    } else if (action === 'priority' && typeof value === 'string') {
      ticketsStore.actions.optimisticUpdate(id, { priority: value });
    } else if (action === 'up_next' && typeof value === 'boolean') {
      ticketsStore.actions.optimisticUpdate(id, { up_next: value });
    }
    // mark_read / mark_unread are applied optimistically by the caller (toggleReadState).
  }
}

/** Record and apply a single-ticket field change. */
export async function trackedPatch(
  ticket: Ticket,
  updates: Record<string, unknown>,
  label: string,
): Promise<Ticket> {
  const before = snapshot(ticket);
  // HS-8642 — `updates` is a loose field bag (callers like ticketRow /
  // contextMenu still build `{ [field]: value }`); validate + narrow it to the
  // typed request shape so we route through the typed `updateTicket` caller.
  const parsed = UpdateTicketSchema.parse(updates);
  // HS-9652/9653 — optimistic store write BEFORE the round-trip so the column view
  // reflects the change instantly (see `applyBatchOptimistic`). `parsed` is a
  // validated UpdateTicketReq, a structural subset of `Ticket`.
  ticketsStore.actions.optimisticUpdate(ticket.id, parsed);
  let updated: Ticket;
  try {
    updated = await updateTicket(ticket.id, parsed);
  } catch (e) {
    void loadTickets(); // revert the optimistic change from the server's truth
    throw e;
  }
  ticketsStore.actions.applyServerUpdate(updated); // authoritative
  const after = snapshot(updated);
  activeStack().push({ label, timestamp: Date.now(), before: [before], after: [after] });
  return updated;
}

/** Record a text field change with coalescing. Call this on each input event, before the debounced save. */
export function recordTextChange(ticket: Ticket, field: string, newValue: string) {
  const key = `${ticket.id}:${field}`;
  const now = Date.now();
  const after: TicketSnapshot = { ...snapshot(ticket), [field]: newValue };
  const entry: UndoEntry = {
    label: `Edit ${field}`,
    timestamp: now,
    before: [snapshot(ticket)],
    after: [after],
    coalescingKey: key,
  };

  if (!activeStack().coalesce(entry)) {
    activeStack().push(entry);
  }
}

/** Record and apply a batch operation. */
export async function trackedBatch(
  tickets: Ticket[],
  batchBody: { ids: number[]; action: string; value?: unknown },
  label: string,
): Promise<void> {
  const befores = tickets.map(t => snapshot(t));

  // HS-8642 — validate + narrow the loose body to `BatchActionReq`, then route
  // through the typed `batchTickets`. The narrowed `action` / `value` also
  // drive the after-state below via `typeof` guards (no more `as string`).
  const parsed = BatchActionSchema.parse(batchBody);

  // Construct after-state from the batch action
  const afters = befores.map(b => {
    const a = { ...b };
    const { action, value } = parsed;
    if (action === 'category' && typeof value === 'string') a.category = value;
    else if (action === 'priority' && typeof value === 'string') a.priority = value;
    else if (action === 'status' && typeof value === 'string') a.status = value;
    else if (action === 'up_next' && typeof value === 'boolean') a.up_next = value;
    else if (action === 'delete') a.status = 'deleted';
    else if (action === 'mark_read') a.last_read_at = new Date().toISOString();
    else if (action === 'mark_unread') a.last_read_at = '1970-01-01T00:00:00Z';
    return a;
  });

  // HS-9652/9653 — apply to the store BEFORE the server round-trip so the column view
  // moves/removes cards instantly; the caller's follow-up `loadTickets()` reconciles.
  applyBatchOptimistic(parsed);
  try {
    await batchTickets(parsed);
  } catch (e) {
    void loadTickets(); // revert the optimistic change from the server's truth
    throw e;
  }

  activeStack().push({ label, timestamp: Date.now(), before: befores, after: afters });
}

/** Record and apply a compound batch operation (e.g. reopen + toggle up_next). */
export async function trackedCompoundBatch(
  tickets: Ticket[],
  operations: Array<{ ids: number[]; action: string; value?: unknown }>,
  label: string,
): Promise<void> {
  const befores = tickets.map(t => snapshot(t));

  // HS-8642 — validate + narrow each op to `BatchActionReq`, then route through
  // the typed `batchTickets`. The same narrowed ops drive the after-state.
  const parsedOps = operations.map(op => BatchActionSchema.parse(op));
  // HS-9652/9653 — apply each op to the store BEFORE the round-trips so the column
  // view updates instantly; the caller's follow-up `loadTickets()` reconciles.
  for (const op of parsedOps) applyBatchOptimistic(op);
  try {
    for (const op of parsedOps) {
      await batchTickets(op);
    }
  } catch (e) {
    void loadTickets(); // revert the optimistic changes from the server's truth
    throw e;
  }

  // Construct after-state by applying all operations in order
  const afters = befores.map(b => {
    const a = { ...b };
    for (const op of parsedOps) {
      if (!op.ids.includes(b.id)) continue;
      const { action, value } = op;
      if (action === 'status' && typeof value === 'string') a.status = value;
      else if (action === 'up_next' && typeof value === 'boolean') a.up_next = value;
      else if (action === 'category' && typeof value === 'string') a.category = value;
      else if (action === 'priority' && typeof value === 'string') a.priority = value;
      else if (action === 'delete') a.status = 'deleted';
    }
    return a;
  });

  activeStack().push({ label, timestamp: Date.now(), before: befores, after: afters });
}

/** Record and apply a single-ticket deletion. */
export async function trackedDelete(ticket: Ticket): Promise<void> {
  const before = snapshot(ticket);
  // HS-9652/9653 — drop from the store immediately so the card disappears now, not
  // after the server round-trip + refetch.
  ticketsStore.actions.removeTicket(ticket.id);
  try {
    await deleteTicket(ticket.id);
  } catch (e) {
    void loadTickets(); // the delete didn't persist — bring the ticket back
    throw e;
  }
  const after = { ...before, status: 'deleted' };
  activeStack().push({ label: 'Delete ticket', timestamp: Date.now(), before: [before], after: [after] });
}

/** Record and apply a trash restore. */
export async function trackedRestore(ticket: Ticket): Promise<void> {
  const before = snapshot(ticket);
  await restoreTicket(ticket.id);
  // Restore sets status back to not_started
  const after = { ...before, status: 'not_started' };
  activeStack().push({ label: 'Restore ticket', timestamp: Date.now(), before: [before], after: [after] });
}

/** Apply a snapshot array via PATCH calls. */
async function applySnapshots(snapshots: TicketSnapshot[]): Promise<void> {
  for (const s of snapshots) {
    if (s.status === 'deleted') {
      // Soft-delete via DELETE endpoint
      await deleteTicket(s.id);
    } else {
      // HS-8642 — `TicketSnapshot` keeps priority / status as loose strings;
      // validate + narrow the whole body to `UpdateTicketReq` before routing
      // through the typed `updateTicket`.
      await updateTicket(s.id, UpdateTicketSchema.parse({
        title: s.title,
        details: s.details,
        category: s.category,
        priority: s.priority,
        status: s.status,
        up_next: s.up_next,
      }));
      // Restore notes if snapshot includes them
      if (s.notes !== undefined) {
        await putTicketNotesBulk(s.id, s.notes);
      }
    }
  }
}

let undoRedoInFlight = false;

export async function performUndo(): Promise<void> {
  if (undoRedoInFlight) return;
  const entry = activeStack().popUndo();
  if (!entry) return;
  undoRedoInFlight = true;
  try {
    await applySnapshots(entry.before);
    await loadTickets();
    // Force detail panel to re-fetch after the render cycle settles.
    // HS-9117 — pass `true` so the title/details fields update even when one is
    // still focused (undo is a deliberate revert, not a background poll).
    setTimeout(() => refreshDetail(true), 50);
  } finally {
    undoRedoInFlight = false;
  }
}

export async function performRedo(): Promise<void> {
  if (undoRedoInFlight) return;
  const entry = activeStack().popRedo();
  if (!entry) return;
  undoRedoInFlight = true;
  try {
    await applySnapshots(entry.after);
    await loadTickets();
    // HS-9117 — force focused text fields to update (deliberate redo revert).
    setTimeout(() => refreshDetail(true), 50);
  } finally {
    undoRedoInFlight = false;
  }
}

/** Push a notes-only undo entry. Call before modifying notes. */
export function pushNotesUndo(ticket: Ticket, label: string, afterNotes: string) {
  const before = snapshot(ticket, true);
  const after = { ...snapshot(ticket, true), notes: afterNotes };
  activeStack().push({ label, timestamp: Date.now(), before: [before], after: [after] });
}

export function canUndo(): boolean {
  return activeStack().canUndo();
}

export function canRedo(): boolean {
  return activeStack().canRedo();
}

// --- Shared batch operations ---

/** Toggle up-next for the given tickets. HS-7998: reopens
 *  completed / verified / backlog / archive tickets to `not_started` when
 *  setting up-next via the canonical `shouldResetStatusOnUpNext`
 *  predicate (shared with the single-ticket toggle in `ticketRow.tsx`
 *  and `app.tsx::bindDetailUpNext`). */
export async function toggleUpNext(tickets: Ticket[]): Promise<void> {
  const allUpNext = tickets.every(t => t.up_next);
  const settingUpNext = !allUpNext;
  const ids = tickets.map(t => t.id);

  if (settingUpNext) {
    const ticketsToReset = tickets.filter(t => shouldResetStatusOnUpNext(t.status));
    if (ticketsToReset.length > 0) {
      await trackedCompoundBatch(tickets, [
        { ids: ticketsToReset.map(t => t.id), action: 'status', value: 'not_started' },
        { ids, action: 'up_next', value: true },
      ], 'Toggle up next');
      return;
    }
  }
  await trackedBatch(tickets, { ids, action: 'up_next', value: settingUpNext }, 'Toggle up next');
}

/** Mark selected tickets as read or unread based on current state.
 *  Also manages suppressAutoRead so the detail panel doesn't override manual unread. */
export async function toggleReadState(ticketIds: number[]): Promise<void> {
  const hasUnread = ticketIds.some(id => {
    const t = state.tickets.find(tk => tk.id === id);
    return t != null && t.last_read_at != null && t.updated_at > t.last_read_at;
  });
  const affected = state.tickets.filter(t => ticketIds.includes(t.id));
  // HS-9052 — apply the read-state change THROUGH the store (`optimisticUpdate`)
  // so each ticket's per-row signal fires and the bindList-preserved list/column
  // rows re-run their `syncUnreadDot` effect immediately. Mutating
  // `t.last_read_at` in place (the old code) updated the store object but never
  // fired the signal, so the blue dot didn't change until the next full reload —
  // the same class of bug fixed for the detail panel in HS-8419. It also kept the
  // old objects intact for `trackedBatch`'s undo `before` snapshot below (the
  // in-place mutation had corrupted that to the post-change value).
  if (hasUnread) {
    setSuppressAutoRead(false);
    const readAt = new Date().toISOString();
    for (const t of affected) ticketsStore.actions.optimisticUpdate(t.id, { last_read_at: readAt });
    await trackedBatch(affected, { ids: ticketIds, action: 'mark_read' }, 'Mark as Read');
  } else {
    setSuppressAutoRead(true);
    const epoch = '1970-01-01T00:00:00Z';
    for (const t of affected) ticketsStore.actions.optimisticUpdate(t.id, { last_read_at: epoch });
    await trackedBatch(affected, { ids: ticketIds, action: 'mark_unread' }, 'Mark as Unread');
  }
  renderTicketList();
}
