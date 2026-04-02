import { api } from './api.js';
import { channelAutoTrigger } from './channelUI.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import type { Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, state } from './state.js';
import { loadTickets, renderTicketList } from './ticketList.js';
import { trackedBatch, trackedCompoundBatch } from './undo/actions.js';

const PRIORITY_ITEMS = [
  { key: '1', value: 'highest', label: 'Highest' },
  { key: '2', value: 'high', label: 'High' },
  { key: '3', value: 'default', label: 'Default' },
  { key: '4', value: 'low', label: 'Low' },
  { key: '5', value: 'lowest', label: 'Lowest' },
];

const STATUS_ITEMS = [
  { key: 'n', value: 'not_started', label: 'Not Started' },
  { key: 's', value: 'started', label: 'Started' },
  { key: 'c', value: 'completed', label: 'Completed' },
  { key: 'v', value: 'verified', label: 'Verified' },
  { key: 'b', value: 'backlog', label: 'Backlog' },
  { key: 'a', value: 'archive', label: 'Archive' },
];

export { PRIORITY_ITEMS, STATUS_ITEMS };

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
    const allUpNext = selectedTickets.every(t => t.up_next);
    const settingUpNext = !allUpNext;
    const ids = Array.from(state.selectedIds);

    if (settingUpNext) {
      const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
      if (doneTickets.length > 0) {
        const ops = [
          { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
          { ids, action: 'up_next', value: true },
        ];
        await trackedCompoundBatch(selectedTickets, ops, 'Batch toggle up next');
      } else {
        await trackedBatch(selectedTickets, { ids, action: 'up_next', value: true }, 'Batch toggle up next');
      }
    } else {
      await trackedBatch(selectedTickets, { ids, action: 'up_next', value: false }, 'Batch toggle up next');
    }
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
    const menu = createDropdown(batchMore, [
      {
        label: 'Tags...',
        key: 't',
        action: () => { void showTagsDialog(); },
      },
      {
        label: 'Duplicate',
        key: 'd',
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
      { label: '', key: '', separator: true, action: () => {} },
      {
        label: 'Move to Backlog',
        key: 'b',
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
