/**
 * HS-8553 — extracted from `src/client/app.tsx`. Category / priority /
 * status dropdown bindings for the detail panel. Each button opens a
 * dropdown built by `createDropdown`; selecting an item runs the
 * `applyDetailChange` helper which trackedPatches the ticket + reloads
 * the list + re-opens the detail.
 */
import { updateTicket,type UpdateTicketReq } from '../../api/index.js';
import { openDetail, updateDetailCategory, updateDetailPriority, updateDetailStatus } from '../detail.js';
import { byId } from '../dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from '../dropdown.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, state, STATUS_ITEMS } from '../state.js';
import { loadTickets } from '../ticketList.js';
import { trackedPatch } from '../undo/actions.js';

export function bindDetailDropdowns(): void {
  // HS-8642 — takes a typed `UpdateTicketReq` body (the callers build it from
  // already-typed `c.id` / `p.value` / `s.value`), so the trackedPatch + the
  // not-in-state fallback both route through the typed layer — no dynamic-key
  // raw `api()`.
  async function applyDetailChange(body: UpdateTicketReq, label: string): Promise<void> {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) {
      await trackedPatch(ticket, body, label);
    } else {
      await updateTicket(state.activeTicketId, body);
    }
    void loadTickets();
    openDetail(state.activeTicketId);
  }

  function bindDropdown(elementId: string, getItems: (current: string) => Parameters<typeof createDropdown>[1]): void {
    byId(elementId).addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLButtonElement;
      if (btn.disabled) return;
      closeAllMenus();
      const current = btn.dataset.value ?? '';
      const menu = createDropdown(btn, getItems(current));
      document.body.appendChild(menu);
      positionDropdown(menu, btn);
      menu.style.visibility = '';
    });
  }

  bindDropdown('detail-category', (current) => state.categories.map(c => ({
    label: c.label, key: c.shortcutKey, color: c.color, active: c.id === current,
    action: () => { updateDetailCategory(c.id); void applyDetailChange({ category: c.id }, 'Change category'); },
  })));

  bindDropdown('detail-priority', (current) => PRIORITY_ITEMS.map(p => ({
    label: p.label, key: p.key, icon: getPriorityIcon(p.value), iconColor: getPriorityColor(p.value),
    active: p.value === current,
    action: () => { updateDetailPriority(p.value); void applyDetailChange({ priority: p.value }, 'Change priority'); },
  })));

  bindDropdown('detail-status', (current) => STATUS_ITEMS.map(s => ({
    label: s.label, key: s.key, icon: getStatusIcon(s.value), active: s.value === current,
    action: () => { updateDetailStatus(s.value); void applyDetailChange({ status: s.value }, 'Change status'); },
  })));
}
