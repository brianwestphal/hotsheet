import { createTicket, putTicketNotesBulk, updateTicket } from '../api/index.js';
import { TicketSchema } from '../schemas.js';
import type { Ticket } from './state.js';

/**
 * HS-8663 — copy (or move, when `opts.move` is true) tickets into another
 * project, identified by `targetSecret`. Powers both the drag-onto-tab and
 * the drag-onto-"+"-button (new project) flows.
 *
 * Source tickets are the user's current (active-project) selection, so the
 * create calls run against `targetSecret` while the move-delete runs against
 * `opts.sourceSecret` (the active project at drop time) — passed explicitly so
 * a subsequent project switch (the "+"-button flow switches to the freshly-
 * created project) can't redirect the delete to the wrong project.
 *
 * Field mapping mirrors the internal clipboard `pasteTickets`
 * (`src/client/clipboard.ts`): title / details / notes / category / priority /
 * status / up_next / tags. **Attachments are NOT carried** — the same gap the
 * existing cross-project clipboard paste has; tracked as a follow-up.
 *
 * Pure data operation: it does NOT reload the ticket list, clear selection, or
 * toast. Callers own UI side effects (the tab-drop path reloads + toasts; the
 * "+"-button path switches to the new project, which reloads).
 *
 * Returns the IDs of the tickets created in the target project.
 */
export async function transferTicketsToProject(
  tickets: readonly Ticket[],
  targetSecret: string,
  opts: { move: boolean; sourceSecret?: string },
): Promise<number[]> {
  const createdIds: number[] = [];

  for (const source of tickets) {
    // Narrow the loose client `Ticket` (priority / status are `string`) through
    // the SSOT schema so the typed `createTicket` accepts them; `.catch(...)`
    // keeps a sane default if a value is ever out of range (runtime-safe, no
    // `as`). A transferred copy of a trashed ticket re-enters as `not_started`.
    const priority = TicketSchema.shape.priority.catch('default').parse(source.priority);
    const rawStatus = source.status === 'deleted' ? 'not_started' : source.status;
    const status = TicketSchema.shape.status.catch('not_started').parse(rawStatus);

    const created = await createTicket(
      {
        title: source.title,
        defaults: {
          category: source.category,
          priority,
          status,
          up_next: source.up_next,
          details: source.details,
          tags: source.tags,
        },
      },
      { secret: targetSecret },
    );

    if (source.notes && source.notes !== '' && source.notes !== '[]') {
      await putTicketNotesBulk(created.id, source.notes, { secret: targetSecret });
    }

    createdIds.push(created.id);
  }

  if (opts.move) {
    // Soft-delete the originals from the SOURCE project. `sourceSecret` is
    // threaded explicitly so the delete is unambiguous even after the caller
    // switches the active project to the transfer target.
    for (const t of tickets) {
      if (opts.sourceSecret !== undefined && opts.sourceSecret !== '') {
        await updateTicket(t.id, { status: 'deleted' }, { secret: opts.sourceSecret });
      } else {
        await updateTicket(t.id, { status: 'deleted' });
      }
    }
  }

  return createdIds;
}
