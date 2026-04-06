import { suppressAnimation } from './animate.js';
import { api } from './api.js';
import { state } from './state.js';
import { draggedTicketIds, loadTickets } from './ticketList.js';
import { trackedBatch } from './undo/actions.js';

function getDropAction(view: string): { action: string; value: unknown } | null {
  if (view === 'up-next') return { action: 'up_next', value: true };
  if (view === 'open') return { action: 'status', value: 'not_started' };
  if (view === 'completed') return { action: 'status', value: 'completed' };
  if (view === 'verified') return { action: 'status', value: 'verified' };
  if (view === 'backlog') return { action: 'status', value: 'backlog' };
  if (view === 'archive') return { action: 'status', value: 'archive' };
  if (view === 'trash') return { action: 'delete', value: null };
  if (view.startsWith('category:')) return { action: 'category', value: view.split(':')[1] };
  if (view.startsWith('priority:')) return { action: 'priority', value: view.split(':')[1] };
  return null;
}

async function applyDropAction(view: string, ids: number[]) {
  const drop = getDropAction(view);
  if (!drop) return;
  const affected = state.tickets.filter(t => ids.includes(t.id));

  if (drop.action === 'delete') {
    await trackedBatch(affected, { ids, action: 'delete' }, 'Delete tickets');
  } else {
    await trackedBatch(affected, { ids, action: drop.action, value: drop.value }, `Change ${drop.action}`);
  }
  suppressAnimation();
  void loadTickets();
}

export function bindSidebar(restoreTicketList: () => void, updateLayoutToggle: () => void) {
  const items = document.querySelectorAll('.sidebar-item[data-view]');
  items.forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      state.view = (item as HTMLElement).dataset.view!;
      state.selectedIds.clear();
      // Restore ticket list if coming from dashboard
      restoreTicketList();
      suppressAnimation();
      updateLayoutToggle();
      void loadTickets();
    });

    // Drop target support
    const view = (item as HTMLElement).dataset.view!;
    if (!getDropAction(view)) return;

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = 'move';
      item.classList.add('drop-target');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-target');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-target');
      const ids = [...draggedTicketIds];
      if (ids.length === 0) return;
      void applyDropAction(view, ids);
    });
  });
}

// --- Sort controls ---

export function bindSortControls() {
  const select = document.getElementById('sort-select') as HTMLSelectElement;
  select.addEventListener('change', () => {
    const [sortBy, sortDir] = select.value.split(':');
    state.sortBy = sortBy;
    state.sortDir = sortDir;
    suppressAnimation();
    void loadTickets();
    void api('/settings', { method: 'PATCH', body: { sort_by: sortBy, sort_dir: sortDir } });
  });
}

// --- Search ---

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

export function bindSearchInput() {
  const input = document.getElementById('search-input') as HTMLInputElement;
  const searchBox = input.closest('.search-box') as HTMLElement;

  function updateSearchBoxClass() {
    searchBox.classList.toggle('has-value', input.value !== '');
  }

  input.addEventListener('input', () => {
    updateSearchBoxClass();
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = input.value;
      suppressAnimation();
      void loadTickets();
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.search = '';
      updateSearchBoxClass();
      suppressAnimation();
      void loadTickets();
    }
  });
}
