import { createTicket, putTicketNotesBulk, updateTicket } from '../api/index.js';
import { TicketSchema } from '../schemas.js';
import type { ReadonlySignal } from './reactive.js';
import { computed, signal } from './reactive.js';
import type { Ticket } from './state.js';
import { getActiveProject, state } from './state.js';
import { loadTickets, renderTicketList } from './ticketList.js';

/** Internal structured clipboard for cross-project copy/cut/paste. */
interface InternalClipboard {
  tickets: Ticket[];
  cut: boolean;
  sourceProjectSecret?: string;  // Track which project the tickets came from
}

/**
 * HS-8335 (2026-05-11) — clipboard state is now a kerf signal so the
 * per-row `.cut-pending` effects in `createTicketRow` /
 * `createColumnCard` react in place. Pre-HS-8335 `copyTickets(_, cut)`
 * called `renderTicketList()` which (post-HS-8331) was a near-no-op on
 * the bindList path → `.cut-pending` toggling was structurally broken.
 * Now writing through this signal fires the per-row effect on each
 * cut/uncut row without touching siblings.
 */
const clipboardSignal = signal<InternalClipboard | null>(null);

/** Store selected tickets in the internal clipboard. */
export function copyTickets(tickets: Ticket[], cut: boolean): void {
  clipboardSignal.value = {
    tickets: tickets.map(t => ({ ...t })),
    cut,
    sourceProjectSecret: getActiveProject()?.secret,
  };
}

/** Whether there are tickets in the internal clipboard ready to paste. */
export function hasClipboardTickets(): boolean {
  const c = clipboardSignal.value;
  return c !== null && c.tickets.length > 0;
}

/** Get the IDs of tickets pending cut (for visual styling). */
export function getCutTicketIds(): Set<number> {
  return new Set(cutTicketIdsSignal.value);
}

/**
 * HS-8335 — reactive Set of cut ticket ids, scoped to the active
 * project (cross-project cut still tracks ids but doesn't render
 * `.cut-pending` since the cut tickets aren't visible). Per-row
 * effects in the row factories subscribe to this and toggle the
 * `.cut-pending` class. `getActiveProject()` is read at compute time
 * but isn't a kerf signal — the cross-project case is rare and the
 * recompute on `clipboardSignal` change handles it for the common
 * single-project flow; full reactivity on project switch falls out
 * because the project switch triggers `loadTickets` which writes
 * fresh tickets to the store, and the row factories are re-mounted
 * by the bindList → fresh effect subscriptions read the current
 * active project anyway.
 */
export const cutTicketIdsSignal: ReadonlySignal<ReadonlySet<number>> = computed(() => {
  const c = clipboardSignal.value;
  if (c === null || !c.cut) return new Set();
  const activeSecret = getActiveProject()?.secret;
  if (activeSecret !== c.sourceProjectSecret) return new Set();
  return new Set(c.tickets.map(t => t.id));
});

/** Generate a deduplicated title by appending " (Copy)", " (Copy 2)", etc. */
function deduplicateTitle(title: string, existingTitles: Set<string>): string {
  if (!existingTitles.has(title.toLowerCase())) return title;

  const baseCopy = `${title} (Copy)`;
  if (!existingTitles.has(baseCopy.toLowerCase())) return baseCopy;

  let n = 2;
  while (existingTitles.has(`${title} (Copy ${n})`.toLowerCase())) {
    n++;
  }
  return `${title} (Copy ${n})`;
}

/** Paste tickets from the internal clipboard into the current project. */
export async function pasteTickets(): Promise<void> {
  const snapshot = clipboardSignal.value;
  if (snapshot === null || snapshot.tickets.length === 0) return;

  const { tickets: clipboardTickets, cut } = snapshot;

  // Collect existing titles for dedup
  const existingTitles = new Set(state.tickets.map(t => t.title.toLowerCase()));

  // Create new tickets via API
  const createdIds: number[] = [];
  for (const source of clipboardTickets) {
    const title = deduplicateTitle(source.title, existingTitles);
    existingTitles.add(title.toLowerCase());

    // HS-8642 — `source` is the loose client `Ticket` (priority / status typed
    // as `string`); narrow both through the `TicketSchema` SSOT so the typed
    // `createTicket` accepts them. `.catch(...)` keeps a sane default if a
    // clipboard ticket ever carried an out-of-range value (runtime-safe, no
    // `as`). A pasted copy of a trashed ticket re-enters as `not_started`.
    const priority = TicketSchema.shape.priority.catch('default').parse(source.priority);
    const rawStatus = source.status === 'deleted' ? 'not_started' : source.status;
    const status = TicketSchema.shape.status.catch('not_started').parse(rawStatus);
    const created = await createTicket({
      title,
      defaults: {
        category: source.category,
        priority,
        status,
        up_next: source.up_next,
        details: source.details,
        tags: source.tags,
      },
    });

    // Copy notes if the source had any
    if (source.notes && source.notes !== '' && source.notes !== '[]') {
      await putTicketNotesBulk(created.id, source.notes);
    }

    createdIds.push(created.id);
  }

  // If cut, delete the originals from the SOURCE project and clear the clipboard
  if (cut) {
    const ids = clipboardTickets.map(t => t.id);
    const sourceSecret = snapshot.sourceProjectSecret;
    // Delete via API with the source project's secret (works cross-project)
    for (const id of ids) {
      if (sourceSecret !== undefined && sourceSecret !== '') {
        await updateTicket(id, { status: 'deleted' }, { secret: sourceSecret });
      } else {
        await updateTicket(id, { status: 'deleted' });
      }
    }
    clipboardSignal.value = null;
  }

  // Reload and select the newly created tickets
  await loadTickets();
  state.selectedIds.clear();
  for (const id of createdIds) {
    state.selectedIds.add(id);
  }
  renderTicketList();
}
