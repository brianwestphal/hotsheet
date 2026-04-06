import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { ICON_ARCHIVE, ICON_CALENDAR, ICON_COPY, ICON_TAG, ICON_TRASH } from './icons.js';
import type { Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, state, STATUS_ITEMS } from './state.js';
import { loadTickets, renderTicketList } from './ticketList.js';
import { trackedBatch, trackedDelete, trackedPatch } from './undo/actions.js';

export function showTicketContextMenu(e: MouseEvent, ticket: Ticket) {
  e.preventDefault();
  closeContextMenu();

  // Ensure the ticket is selected
  if (!state.selectedIds.has(ticket.id)) {
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    renderTicketList();
  }

  const menu = toElement(<div className="context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}></div>);

  // Category submenu
  addSubmenuItem(menu, 'Category', state.categories.map(c => ({
    label: c.label,
    icon: `<span class="dropdown-dot" style="background-color:${c.color}"></span>`,
    active: ticket.category === c.id,
    action: () => applyToSelected('category', c.id),
  })));

  // Priority submenu
  addSubmenuItem(menu, 'Priority', PRIORITY_ITEMS.map(p => ({
    label: p.label,
    icon: getPriorityIcon(p.value),
    iconColor: getPriorityColor(p.value),
    active: ticket.priority === p.value,
    action: () => applyToSelected('priority', p.value),
  })));

  // Status submenu (context menu only shows the 4 main statuses)
  const contextStatuses = STATUS_ITEMS.filter(s =>
    s.value === 'not_started' || s.value === 'started' || s.value === 'completed' || s.value === 'verified'
  );
  addSubmenuItem(menu, 'Status', contextStatuses.map(s => ({
    label: s.label,
    icon: getStatusIcon(s.value),
    active: ticket.status === s.value,
    action: () => applyToSelected('status', s.value),
  })));

  // Up Next toggle
  addActionItem(menu, ticket.up_next ? '\u2605 Up Next' : '\u2606 Up Next', () => {
    void applyToSelected('up_next', !ticket.up_next);
  });

  addSeparator(menu);

  // Tags
  addActionItem(menu, 'Tags...', () => {
    document.dispatchEvent(new CustomEvent('hotsheet:show-tags-dialog'));
  }, { icon: ICON_TAG });

  // Duplicate
  addActionItem(menu, 'Duplicate', async () => {
    const ids = Array.from(state.selectedIds);
    const created = await api<Ticket[]>('/tickets/duplicate', { method: 'POST', body: { ids } });
    state.selectedIds.clear();
    for (const t of created) state.selectedIds.add(t.id);
    void loadTickets();
  }, { icon: ICON_COPY });

  addSeparator(menu);

  // Move to Backlog
  addActionItem(menu, 'Move to Backlog', () => applyToSelected('status', 'backlog'), {
    icon: ICON_CALENDAR,
  });
  // Archive
  addActionItem(menu, 'Archive', () => applyToSelected('status', 'archive'), {
    icon: ICON_ARCHIVE,
  });

  addSeparator(menu);

  // Delete
  addActionItem(menu, 'Delete', async () => {
    if (state.selectedIds.size === 1) {
      await trackedDelete(ticket);
    } else {
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      await trackedBatch(affected, { ids, action: 'delete' }, 'Delete');
    }
    state.selectedIds.clear();
    void loadTickets();
  }, { danger: true, icon: ICON_TRASH });

  document.body.appendChild(menu);
  clampToViewport(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('contextmenu', closeContextMenu);
  }, 0);
}

function closeContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  document.removeEventListener('click', closeContextMenu);
  document.removeEventListener('contextmenu', closeContextMenu);
}

function clampToViewport(menu: HTMLElement) {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

async function applyToSelected(action: string, value: unknown) {
  const ids = Array.from(state.selectedIds);
  const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
  if (ids.length === 1) {
    const ticket = affected[0];
    await trackedPatch(ticket, { [action]: value }, `Change ${action}`);
  } else {
    await trackedBatch(affected, { ids, action, value }, `Change ${action}`);
  }
  void loadTickets();
}

interface SubItem {
  label: string;
  icon?: string;
  iconColor?: string;
  active?: boolean;
  action: () => void;
}

function addSubmenuItem(menu: HTMLElement, label: string, items: SubItem[]) {
  const item = toElement(
    <div className="context-menu-item has-submenu">
      <span className="context-menu-label">{label}</span>
      <span className="context-menu-arrow">{'\u25B8'}</span>
    </div>
  );

  const submenu = toElement(<div className="context-submenu"></div>);
  for (const sub of items) {
    const subItem = toElement(
      <div className={`context-menu-item${sub.active === true ? ' active' : ''}`}>
        {sub.icon !== undefined && sub.icon !== '' ? <span className="dropdown-icon" style={sub.iconColor !== undefined && sub.iconColor !== '' ? `color:${sub.iconColor}` : ''}>{raw(sub.icon)}</span> : null}
        <span className="context-menu-label">{sub.label}</span>
      </div>
    );
    subItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      sub.action();
      closeContextMenu();
    });
    submenu.appendChild(subItem);
  }

  item.appendChild(submenu);
  menu.appendChild(item);
}

function addActionItem(menu: HTMLElement, label: string, action: () => void, options?: { danger?: boolean; icon?: string }) {
  const item = toElement(
    <div className={`context-menu-item${options?.danger === true ? ' danger' : ''}`}>
      {options?.icon !== undefined ? <span className="dropdown-icon">{raw(options.icon)}</span> : null}
      <span className="context-menu-label">{label}</span>
    </div>
  );
  item.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeContextMenu();
    action();
  });
  menu.appendChild(item);
}

function addSeparator(menu: HTMLElement) {
  menu.appendChild(toElement(<div className="context-menu-separator"></div>));
}
