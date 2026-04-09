import { api } from './api.js';
import type { Ticket } from './state.js';
import { getActiveProject, state } from './state.js';
import { loadTickets, renderTicketList } from './ticketList.js';

/** Internal structured clipboard for cross-project copy/cut/paste. */
interface InternalClipboard {
  tickets: Ticket[];
  cut: boolean;
  sourceProjectSecret?: string;  // Track which project the tickets came from
}

let internalClipboard: InternalClipboard | null = null;

/** Store selected tickets in the internal clipboard. */
export function copyTickets(tickets: Ticket[], cut: boolean): void {
  internalClipboard = {
    tickets: tickets.map(t => ({ ...t })),
    cut,
    sourceProjectSecret: getActiveProject()?.secret,
  };
  // Re-render to show cut styling
  if (cut) renderTicketList();
}

/** Whether there are tickets in the internal clipboard ready to paste. */
export function hasClipboardTickets(): boolean {
  return internalClipboard !== null && internalClipboard.tickets.length > 0;
}

/** Get the IDs of tickets pending cut (for visual styling). */
export function getCutTicketIds(): Set<number> {
  if (internalClipboard === null || !internalClipboard.cut) return new Set();
  // Only show cut styling if we're viewing the source project
  const activeSecret = getActiveProject()?.secret;
  if (activeSecret !== internalClipboard.sourceProjectSecret) return new Set();
  return new Set(internalClipboard.tickets.map(t => t.id));
}

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
  if (!internalClipboard || internalClipboard.tickets.length === 0) return;

  const { tickets: clipboardTickets, cut } = internalClipboard;

  // Collect existing titles for dedup
  const existingTitles = new Set(state.tickets.map(t => t.title.toLowerCase()));

  // Create new tickets via API
  const createdIds: number[] = [];
  for (const source of clipboardTickets) {
    const title = deduplicateTitle(source.title, existingTitles);
    existingTitles.add(title.toLowerCase());

    const created = await api<Ticket>('/tickets', {
      method: 'POST',
      body: {
        title,
        defaults: {
          category: source.category,
          priority: source.priority,
          status: source.status === 'deleted' ? 'not_started' : source.status,
          up_next: source.up_next,
          details: source.details,
          tags: source.tags,
        },
      },
    });

    // Copy notes if the source had any
    if (source.notes && source.notes !== '' && source.notes !== '[]') {
      await api(`/tickets/${created.id}/notes-bulk`, {
        method: 'PUT',
        body: { notes: source.notes },
      });
    }

    createdIds.push(created.id);
  }

  // If cut, delete the originals from the SOURCE project and clear the clipboard
  if (cut && internalClipboard !== null) {
    const ids = clipboardTickets.map(t => t.id);
    const sourceSecret = internalClipboard.sourceProjectSecret;
    // Delete via API with the source project's secret (works cross-project)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sourceSecret !== undefined && sourceSecret !== '') headers['X-Hotsheet-Secret'] = sourceSecret;
    for (const id of ids) {
      await fetch(`/api/tickets/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'deleted' }),
      });
    }
    internalClipboard = null;
  }

  // Reload and select the newly created tickets
  await loadTickets();
  state.selectedIds.clear();
  for (const id of createdIds) {
    state.selectedIds.add(id);
  }
  renderTicketList();
}
