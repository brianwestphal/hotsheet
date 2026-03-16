import { api } from '../api.js';
import { refreshDetail } from '../detail.js';
import type { Ticket } from '../state.js';
import { loadTickets } from '../ticketList.js';
import { undoStack } from './stack.js';
import type { TicketSnapshot, UndoEntry } from './types.js';

export function snapshot(ticket: Ticket): TicketSnapshot {
  return {
    id: ticket.id,
    title: ticket.title,
    details: ticket.details,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    up_next: ticket.up_next,
  };
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
  const befores = tickets.map(snapshot);

  await api('/tickets/batch', { method: 'POST', body: batchBody });

  // Construct after-state from the batch action
  const afters = befores.map(b => {
    const a = { ...b };
    if (batchBody.action === 'category') a.category = batchBody.value as string;
    else if (batchBody.action === 'priority') a.priority = batchBody.value as string;
    else if (batchBody.action === 'status') a.status = batchBody.value as string;
    else if (batchBody.action === 'up_next') a.up_next = batchBody.value as boolean;
    else if (batchBody.action === 'delete') a.status = 'deleted';
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
  const befores = tickets.map(snapshot);

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
    }
  }
}

let undoRedoInFlight = false;

export async function performUndo(): Promise<void> {
  console.log('[undo] performUndo, inFlight:', undoRedoInFlight, 'canUndo:', undoStack.canUndo());
  if (undoRedoInFlight) { console.log('[undo] skipped — already in flight'); return; }
  const entry = undoStack.popUndo();
  if (!entry) { console.log('[undo] skipped — stack empty'); return; }
  console.log('[undo] applying before-state:', entry.label, JSON.stringify(entry.before));
  undoRedoInFlight = true;
  try {
    await applySnapshots(entry.before);
    console.log('[undo] applySnapshots done, reloading tickets');
    await loadTickets();
    refreshDetail();
  } finally {
    undoRedoInFlight = false;
  }
}

export async function performRedo(): Promise<void> {
  console.log('[undo] performRedo, inFlight:', undoRedoInFlight, 'canRedo:', undoStack.canRedo());
  if (undoRedoInFlight) { console.log('[undo] skipped — already in flight'); return; }
  const entry = undoStack.popRedo();
  if (!entry) { console.log('[undo] skipped — stack empty'); return; }
  console.log('[undo] applying after-state:', entry.label, JSON.stringify(entry.after));
  undoRedoInFlight = true;
  try {
    await applySnapshots(entry.after);
    console.log('[undo] applySnapshots done, reloading tickets');
    await loadTickets();
    refreshDetail();
  } finally {
    undoRedoInFlight = false;
  }
}

export function canUndo(): boolean {
  return undoStack.canUndo();
}

export function canRedo(): boolean {
  return undoStack.canRedo();
}
