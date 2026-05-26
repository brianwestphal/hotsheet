/**
 * HS-8553 — extracted from `src/client/app.tsx`. Up-next star toggle for
 * the detail panel. HS-7998 resets the status to `not_started` when
 * starring a backlog / archive / completed / verified ticket so it
 * re-enters the user's active queue.
 */
import { toggleUpNext } from '../../api/index.js';
import { channelAutoTrigger } from '../channelUI.js';
import { openDetail } from '../detail.js';
import { byId } from '../dom.js';
import { shouldResetStatusOnUpNext, state } from '../state.js';
import { loadTickets } from '../ticketList.js';
import { trackedPatch } from '../undo/actions.js';

export function bindDetailUpNext(): void {
  byId('detail-upnext').addEventListener('click', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) {
      // HS-7998 — see `shouldResetStatusOnUpNext` for the canonical
      // status set; backlog / archive items now reset to `not_started`
      // alongside completed / verified ones.
      if (!ticket.up_next && shouldResetStatusOnUpNext(ticket.status)) {
        await trackedPatch(ticket, { status: 'not_started', up_next: true }, 'Toggle up next');
      } else {
        await trackedPatch(ticket, { up_next: !ticket.up_next }, 'Toggle up next');
      }
    } else {
      await toggleUpNext(state.activeTicketId);
    }
    void loadTickets();
    channelAutoTrigger();
    openDetail(state.activeTicketId);
  });
}
