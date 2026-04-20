import { api } from './api.js';
import { channelAutoTrigger } from './channelUI.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { ICON_ARCHIVE, ICON_CALENDAR, ICON_COPY, ICON_EYE, ICON_EYE_OFF, ICON_TAG } from './icons.js';
import { getPluginBatchMenuItems } from './pluginUI.js';
import type { Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, state, STATUS_ITEMS } from './state.js';
import { loadTickets, renderTicketList } from './ticketList.js';
import { toggleReadState, toggleUpNext, trackedBatch } from './undo/actions.js';

export function bindBatchToolbar(showTagsDialog: () => Promise<void>) {
  const batchCategory = document.getElementById('batch-category') as HTMLButtonElement;
  batchCategory.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchCategory, state.categories.map(c => ({
      label: c.label,
      key: c.shortcutKey,
      color: c.color,
      action: async () => {
        const ids = Array.from(state.selectedIds);
        const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
        await trackedBatch(affected, { ids, action: 'category', value: c.id }, 'Batch change category');
        void loadTickets();
      },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, batchCategory);
    menu.style.visibility = '';
  });

  const batchPriority = document.getElementById('batch-priority') as HTMLButtonElement;
  batchPriority.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchPriority, PRIORITY_ITEMS.map(p => ({
      label: p.label,
      key: p.key,
      icon: getPriorityIcon(p.value),
      iconColor: getPriorityColor(p.value),
      action: async () => {
        const ids = Array.from(state.selectedIds);
        const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
        await trackedBatch(affected, { ids, action: 'priority', value: p.value }, 'Batch change priority');
        void loadTickets();
      },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, batchPriority);
    menu.style.visibility = '';
  });

  const batchStatus = document.getElementById('batch-status') as HTMLButtonElement;
  batchStatus.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchStatus, STATUS_ITEMS.map(s => ({
      label: s.label,
      key: s.key,
      icon: getStatusIcon(s.value),
      action: async () => {
        const ids = Array.from(state.selectedIds);
        const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
        await trackedBatch(affected, { ids, action: 'status', value: s.value }, 'Batch change status');
        void loadTickets();
      },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, batchStatus);
    menu.style.visibility = '';
  });

  document.getElementById('batch-upnext')!.addEventListener('click', async () => {
    const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
    await toggleUpNext(selectedTickets);
    void loadTickets();
    channelAutoTrigger();
  });

  document.getElementById('batch-delete')!.addEventListener('click', async () => {
    const ids = Array.from(state.selectedIds);
    const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
    await trackedBatch(affected, { ids, action: 'delete' }, 'Batch delete');
    state.selectedIds.clear();
    void loadTickets();
  });

  // More actions menu
  const batchMore = document.getElementById('batch-more')!;
  batchMore.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const hasUnread = Array.from(state.selectedIds).some(id => {
      const t = state.tickets.find(tk => tk.id === id);
      return t != null && t.last_read_at != null && t.updated_at > t.last_read_at;
    });

    const readUnreadItem = hasUnread
      ? { label: 'Mark as Read', key: 'r', icon: ICON_EYE, action: () => { void toggleReadState(Array.from(state.selectedIds)); } }
      : { label: 'Mark as Unread', key: 'u', icon: ICON_EYE_OFF, action: () => { void toggleReadState(Array.from(state.selectedIds)); } };

    // Build menu items: built-in items + plugin items (if any)
    const pluginItems = getPluginBatchMenuItems(Array.from(state.selectedIds));
    const pluginSection = pluginItems.length > 0
      ? [{ label: '', key: '', separator: true, action: () => {} }, ...pluginItems]
      : [];

    const menu = createDropdown(batchMore, [
      {
        label: 'Tags...',
        key: 't',
        icon: ICON_TAG,
        action: () => { void showTagsDialog(); },
      },
      {
        label: 'Duplicate',
        key: 'd',
        icon: ICON_COPY,
        action: () => {
          void (async () => {
            const ids = Array.from(state.selectedIds);
            const created = await api<Ticket[]>('/tickets/duplicate', {
              method: 'POST',
              body: { ids },
            });
            state.selectedIds.clear();
            for (const t of created) state.selectedIds.add(t.id);
            void loadTickets();
          })();
        },
      },
      readUnreadItem,
      ...pluginSection,
      { label: '', key: '', separator: true, action: () => {} },
      {
        label: 'Move to Backlog',
        key: 'b',
        icon: ICON_CALENDAR,
        action: () => {
          void (async () => {
            const ids = Array.from(state.selectedIds);
            const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
            await trackedBatch(affected, { ids, action: 'status', value: 'backlog' }, 'Move to backlog');
            state.selectedIds.clear();
            void loadTickets();
          })();
        },
      },
      {
        label: 'Archive',
        key: 'a',
        icon: ICON_ARCHIVE,
        action: () => {
          void (async () => {
            const ids = Array.from(state.selectedIds);
            const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
            await trackedBatch(affected, { ids, action: 'status', value: 'archive' }, 'Archive');
            state.selectedIds.clear();
            void loadTickets();
          })();
        },
      },
    ]);
    document.body.appendChild(menu);
    positionDropdown(menu, batchMore);
    menu.style.visibility = '';
  });

  // Select-all checkbox
  document.getElementById('batch-select-all')!.addEventListener('change', (e) => {
    const checkbox = e.target as HTMLInputElement;
    if (checkbox.checked) {
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
    } else {
      state.selectedIds.clear();
    }
    renderTicketList();
  });
}
