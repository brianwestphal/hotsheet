import { api } from '../api.js';
import { refreshDetail, setSuppressAutoRead } from '../detail.js';
import type { Ticket } from '../state.js';
import { state } from '../state.js';
import { loadTickets, renderTicketList } from '../ticketList.js';
import { undoStack } from './stack.js';
import type { TicketSnapshot, UndoEntry } from './types.js';

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

/** Record and apply a single-ticket field change. */
export async function trackedPatch(
  ticket: Ticket,
  updates: Record<string, unknown>,
  label: string,
): Promise<Ticket> {
  const before = snapshot(ticket);
  const updated = await api<Ticket>(`/tickets/${ticket.id}`, {
    method: 'PATCH',
    body: updates,
  });
  const after = snapshot(updated);
  undoStack.push({ label, timestamp: Date.now(), before: [before], after: [after] });
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

  if (!undoStack.coalesce(entry)) {
    undoStack.push(entry);
  }
}

/** Record and apply a batch operation. */
export async function trackedBatch(
  tickets: Ticket[],
  batchBody: { ids: number[]; action: string; value?: unknown },
  label: string,
): Promise<void> {
  const befores = tickets.map(t => snapshot(t));

  await api('/tickets/batch', { method: 'POST', body: batchBody });

  // Construct after-state from the batch action
  const afters = befores.map(b => {
    const a = { ...b };
    if (batchBody.action === 'category') a.category = batchBody.value as string;
    else if (batchBody.action === 'priority') a.priority = batchBody.value as string;
    else if (batchBody.action === 'status') a.status = batchBody.value as string;
    else if (batchBody.action === 'up_next') a.up_next = batchBody.value as boolean;
    else if (batchBody.action === 'delete') a.status = 'deleted';
    else if (batchBody.action === 'mark_read') a.last_read_at = new Date().toISOString();
    else if (batchBody.action === 'mark_unread') a.last_read_at = '1970-01-01T00:00:00Z';
    return a;
  });

  undoStack.push({ label, timestamp: Date.now(), before: befores, after: afters });
}

/** Record and apply a compound batch operation (e.g. reopen + toggle up_next). */
export async function trackedCompoundBatch(
  tickets: Ticket[],
  operations: Array<{ ids: number[]; action: string; value?: unknown }>,
  label: string,
): Promise<void> {
  const befores = tickets.map(t => snapshot(t));

  for (const op of operations) {
    await api('/tickets/batch', { method: 'POST', body: op });
  }

  // Construct after-state by applying all operations in order
  const afters = befores.map(b => {
    const a = { ...b };
    for (const op of operations) {
      if (!op.ids.includes(b.id)) continue;
      if (op.action === 'status') a.status = op.value as string;
      else if (op.action === 'up_next') a.up_next = op.value as boolean;
      else if (op.action === 'category') a.category = op.value as string;
      else if (op.action === 'priority') a.priority = op.value as string;
      else if (op.action === 'delete') a.status = 'deleted';
    }
    return a;
  });

  undoStack.push({ label, timestamp: Date.now(), before: befores, after: afters });
}

/** Record and apply a single-ticket deletion. */
export async function trackedDelete(ticket: Ticket): Promise<void> {
  const before = snapshot(ticket);
  await api(`/tickets/${ticket.id}`, { method: 'DELETE' });
  const after = { ...before, status: 'deleted' };
  undoStack.push({ label: 'Delete ticket', timestamp: Date.now(), before: [before], after: [after] });
}

/** Record and apply a trash restore. */
export async function trackedRestore(ticket: Ticket): Promise<void> {
  const before = snapshot(ticket);
  await api(`/tickets/${ticket.id}/restore`, { method: 'POST' });
  // Restore sets status back to not_started
  const after = { ...before, status: 'not_started' };
  undoStack.push({ label: 'Restore ticket', timestamp: Date.now(), before: [before], after: [after] });
}

/** Apply a snapshot array via PATCH calls. */
async function applySnapshots(snapshots: TicketSnapshot[]): Promise<void> {
  for (const s of snapshots) {
    if (s.status === 'deleted') {
      // Soft-delete via DELETE endpoint
      await api(`/tickets/${s.id}`, { method: 'DELETE' });
    } else {
      await api(`/tickets/${s.id}`, {
        method: 'PATCH',
        body: {
          title: s.title,
          details: s.details,
          category: s.category,
          priority: s.priority,
          status: s.status,
          up_next: s.up_next,
        },
      });
      // Restore notes if snapshot includes them
      if (s.notes !== undefined) {
        await api(`/tickets/${s.id}/notes-bulk`, { method: 'PUT', body: { notes: s.notes } });
      }
    }
  }
}

let undoRedoInFlight = false;

export async function performUndo(): Promise<void> {
  if (undoRedoInFlight) return;
  const entry = undoStack.popUndo();
  if (!entry) return;
  undoRedoInFlight = true;
  try {
    await applySnapshots(entry.before);
    await loadTickets();
    // Force detail panel to re-fetch after the render cycle settles
    setTimeout(() => refreshDetail(), 50);
  } finally {
    undoRedoInFlight = false;
  }
}

export async function performRedo(): Promise<void> {
  if (undoRedoInFlight) return;
  const entry = undoStack.popRedo();
  if (!entry) return;
  undoRedoInFlight = true;
  try {
    await applySnapshots(entry.after);
    await loadTickets();
    setTimeout(() => refreshDetail(), 50);
  } finally {
    undoRedoInFlight = false;
  }
}

/** Push a notes-only undo entry. Call before modifying notes. */
export function pushNotesUndo(ticket: Ticket, label: string, afterNotes: string) {
  const before = snapshot(ticket, true);
  const after = { ...snapshot(ticket, true), notes: afterNotes };
  undoStack.push({ label, timestamp: Date.now(), before: [before], after: [after] });
}

export function canUndo(): boolean {
  return undoStack.canUndo();
}

export function canRedo(): boolean {
  return undoStack.canRedo();
}

// --- Shared batch operations ---

/** Toggle up-next for the given tickets, reopening completed/verified ones if setting up-next. */
export async function toggleUpNext(tickets: Ticket[]): Promise<void> {
  const allUpNext = tickets.every(t => t.up_next);
  const settingUpNext = !allUpNext;
  const ids = tickets.map(t => t.id);

  if (settingUpNext) {
    const doneTickets = tickets.filter(t => t.status === 'completed' || t.status === 'verified');
    if (doneTickets.length > 0) {
      await trackedCompoundBatch(tickets, [
        { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
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
  if (hasUnread) {
    setSuppressAutoRead(false);
    const readAt = new Date().toISOString();
    for (const t of affected) t.last_read_at = readAt;
    await trackedBatch(affected, { ids: ticketIds, action: 'mark_read' }, 'Mark as Read');
  } else {
    setSuppressAutoRead(true);
    const epoch = '1970-01-01T00:00:00Z';
    for (const t of affected) t.last_read_at = epoch;
    await trackedBatch(affected, { ids: ticketIds, action: 'mark_unread' }, 'Mark as Unread');
  }
  renderTicketList();
}
