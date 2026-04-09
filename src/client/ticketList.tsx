import { captureSnapshot, flipAnimate } from './animate.js';
import { api } from './api.js';
import { renderColumnView, renderPreviewColumnView, updateColumnSelectionClasses } from './columnView.js';
import { syncDetailPanel, updateStats } from './detail.js';
import { toElement } from './dom.js';
import { createDraftRow, focusDraftInput as _focusDraftInput } from './draftRow.js';
import type { Ticket } from './state.js';
import { state } from './state.js';
import {
  draggedTicketIds as _draggedTicketIds,
registerCallbacks,
setDraftTitle, setSuppressFocusSelect} from './ticketListState.js';
import { cancelPendingSave as _cancelPendingSave, createPreviewRow, createTicketRow, createTrashRow } from './ticketRow.js';

// --- Re-exports (preserves the public API of this module) ---

export function cancelPendingSave() { _cancelPendingSave(); }
export function focusDraftInput() { _focusDraftInput(); }
export { canUseColumnView };

// Re-export draggedTicketIds as a getter so external consumers see live values
export { _draggedTicketIds as draggedTicketIds };

// --- Focus management ---

function getFocusedTicketId(): number | 'draft' | null {
  const active = document.activeElement;
  if (!active || !(active instanceof HTMLElement)) return null;
  const row = active.closest('.ticket-row');
  if (!row) return null;
  if (row.classList.contains('draft-row')) return 'draft';
  const id = (row as HTMLElement).dataset.id;
  return id !== undefined && id !== '' ? parseInt(id, 10) : null;
}

function restoreFocus(ticketId: number | 'draft' | null) {
  if (ticketId == null) return;
  setSuppressFocusSelect(true);
  if (ticketId === 'draft') {
    _focusDraftInput();
  } else {
    const el = document.querySelector<HTMLInputElement>(`.ticket-row[data-id="${ticketId}"] .ticket-title-input`);
    (el as HTMLElement | null)?.focus();
  }
  setSuppressFocusSelect(false);
}

// --- List rendering ---

function canUseColumnView(): boolean {
  const view = state.view;
  if (view.startsWith('custom:')) return true;
  return view !== 'completed' && view !== 'verified' && view !== 'trash' && view !== 'backlog' && view !== 'archive';
}

export function renderTicketList() {
  const snapshot = captureSnapshot();
  const isPreview = state.backupPreview?.active === true;

  // Capture draft focus state before any path destroys the DOM (HS-2148)
  const focusedId = isPreview ? null : getFocusedTicketId();
  let draftSelStart: number | null = null;
  let draftSelEnd: number | null = null;
  if (focusedId === 'draft') {
    const input = document.querySelector<HTMLInputElement>('.draft-row .draft-input');
    if (input) {
      setDraftTitle(input.value);
      draftSelStart = input.selectionStart;
      draftSelEnd = input.selectionEnd;
    }
  }

  if (state.layout === 'columns' && canUseColumnView()) {
    if (isPreview) { renderPreviewColumnView(); flipAnimate(snapshot); return; }
    renderColumnView();
    // Restore draft focus after column view rebuild
    if (focusedId === 'draft') {
      restoreFocus('draft');
      const input = document.querySelector<HTMLInputElement>('.draft-row .draft-input');
      if (input && draftSelStart != null) {
        input.selectionStart = draftSelStart;
        input.selectionEnd = draftSelEnd;
      }
    }
    flipAnimate(snapshot);
    return;
  }

  const isTrash = state.view === 'trash';

  // Preserve in-progress title edits and cursor position (HS-199, HS-1454, HS-2113)
  let editingValue: string | null = null;
  let editingSelStart: number | null = null;
  let editingSelEnd: number | null = null;
  if (focusedId != null) {
    const selector = focusedId === 'draft'
      ? '.draft-row .draft-input'
      : `.ticket-row[data-id="${focusedId}"] .ticket-title-input`;
    const input = document.querySelector<HTMLInputElement>(selector);
    if (input) {
      editingValue = input.value;
      editingSelStart = input.selectionStart;
      editingSelEnd = input.selectionEnd;
      // Keep draftTitle in sync so the recreated draft row has the latest value
      if (focusedId === 'draft') setDraftTitle(input.value);
    }
  }

  const container = document.getElementById('ticket-list')!;
  const scrollTop = container.scrollTop;
  container.innerHTML = '';
  container.classList.remove('ticket-list-columns');

  if (!isTrash && !isPreview) {
    container.appendChild(createDraftRow());
  }

  if (state.tickets.length === 0) {
    const emptyMsg = isTrash ? 'Trash is empty' : isPreview ? 'No tickets match this view' : '';
    if (emptyMsg) container.appendChild(toElement(<div className="ticket-list-empty">{emptyMsg}</div>));
  }

  for (const ticket of state.tickets) {
    if (isPreview) {
      container.appendChild(createPreviewRow(ticket));
    } else if (isTrash) {
      container.appendChild(createTrashRow(ticket));
    } else {
      container.appendChild(createTicketRow(ticket));
    }
  }

  container.scrollTop = scrollTop;

  if (isPreview) {
    // Hide batch toolbar in preview mode
    const toolbar = document.getElementById('batch-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    updateSelectionClasses();
    syncDetailPanel();
  } else {
    const toolbar = document.getElementById('batch-toolbar');
    if (toolbar) toolbar.style.display = '';
    // Restore in-progress title edit and cursor position (HS-199, HS-1454, HS-2113)
    if (focusedId != null && editingValue != null) {
      const selector = focusedId === 'draft'
        ? '.draft-row .draft-input'
        : `.ticket-row[data-id="${focusedId}"] .ticket-title-input`;
      const input = document.querySelector<HTMLInputElement>(selector);
      if (input && input.value !== editingValue) {
        input.value = editingValue;
      }
      restoreFocus(focusedId);
      // Restore cursor position after focus is set
      if (input && editingSelStart != null) {
        input.selectionStart = editingSelStart;
        input.selectionEnd = editingSelEnd;
      }
    } else {
      restoreFocus(focusedId);
    }
    updateBatchToolbar();
  }
  void updateStats();
  flipAnimate(snapshot);
}

// --- Selection & batch toolbar ---

function updateSelectionClasses() {
  document.querySelectorAll('.ticket-row[data-id]').forEach(row => {
    const id = parseInt((row as HTMLElement).dataset.id!, 10);
    const checkbox = row.querySelector('.ticket-checkbox');
    if (state.selectedIds.has(id)) {
      row.classList.add('selected');
      if (checkbox) (checkbox as HTMLInputElement).checked = true;
    } else {
      row.classList.remove('selected');
      if (checkbox) (checkbox as HTMLInputElement).checked = false;
    }
  });
}

function updateBatchToolbar() {
  const count = state.selectedIds.size;
  const total = state.tickets.length;
  const hasSelection = count > 0;
  const isTrash = state.view === 'trash';

  const selectAll = document.getElementById('batch-select-all') as HTMLInputElement;
  selectAll.checked = total > 0 && count === total;
  selectAll.indeterminate = count > 0 && count < total;

  document.getElementById('batch-count')!.textContent = hasSelection ? `${count} selected` : '';

  const normalControls = ['batch-category', 'batch-priority', 'batch-status', 'batch-upnext', 'batch-delete', 'batch-more'];
  for (const id of normalControls) {
    const el = document.getElementById(id) as HTMLElement;
    el.style.display = isTrash ? 'none' : '';
    if (!isTrash) (el as HTMLButtonElement | HTMLSelectElement).disabled = !hasSelection;
  }

  let restoreBtn = document.getElementById('batch-restore') as HTMLButtonElement | null;
  let emptyBtn = document.getElementById('batch-empty-trash') as HTMLButtonElement | null;

  if (isTrash) {
    const toolbar = document.getElementById('batch-toolbar')!;

    if (!restoreBtn) {
      restoreBtn = toElement(<button id="batch-restore" className="btn btn-sm">Restore</button>) as HTMLButtonElement;
      restoreBtn.addEventListener('click', async () => {
        await api('/tickets/batch', {
          method: 'POST',
          body: { ids: Array.from(state.selectedIds), action: 'restore' },
        });
        state.selectedIds.clear();
        void loadTickets();
      });
      toolbar.insertBefore(restoreBtn, document.getElementById('batch-count'));
    }
    restoreBtn.disabled = !hasSelection;
    restoreBtn.style.display = '';

    if (!emptyBtn) {
      emptyBtn = toElement(<button id="batch-empty-trash" className="btn btn-sm btn-danger">Empty Trash</button>) as HTMLButtonElement;
      emptyBtn.addEventListener('click', async () => {
        await api('/trash/empty', { method: 'POST' });
        state.selectedIds.clear();
        void loadTickets();
      });
      toolbar.insertBefore(emptyBtn, document.getElementById('batch-count'));
    }
    emptyBtn.disabled = total === 0;
    emptyBtn.style.display = '';
  } else {
    if (restoreBtn) restoreBtn.style.display = 'none';
    if (emptyBtn) emptyBtn.style.display = 'none';
  }

  // Star icon state
  const starIcon = document.querySelector('.batch-star-icon');
  const starBtn = document.getElementById('batch-upnext') as HTMLButtonElement;
  if (!isTrash && starIcon && hasSelection) {
    const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
    const allUpNext = selectedTickets.every(t => t.up_next);
    const noneUpNext = selectedTickets.every(t => !t.up_next);
    if (allUpNext) {
      starIcon.textContent = '\u2605';
      starBtn.classList.add('active');
      starBtn.classList.remove('mixed');
    } else if (noneUpNext) {
      starIcon.textContent = '\u2606';
      starBtn.classList.remove('active', 'mixed');
    } else {
      starIcon.innerHTML = (<span className="star-mixed-wrap"><span className="star-mixed-fill">{'\u2605'}</span>{'\u2606'}</span>).toString();
      starBtn.classList.remove('active');
      starBtn.classList.add('mixed');
    }
  } else if (starIcon) {
    starIcon.textContent = '\u2606';
    starBtn.classList.remove('active', 'mixed');
  }

  syncDetailPanel();
}

// --- Data loading ---

export async function loadTickets() {
  // In preview mode, filter backup tickets locally instead of querying the API
  if (state.backupPreview?.active === true) {
    loadPreviewTickets();
    return;
  }

  // Custom view: use the query endpoint
  if (state.view.startsWith('custom:')) {
    const viewId = state.view.slice(7);
    const view = state.customViews.find(v => v.id === viewId);
    if (view) {
      const viewTag = view.tag;
      state.tickets = await api<Ticket[]>('/tickets/query', {
        method: 'POST',
        body: {
          logic: view.logic,
          conditions: view.conditions,
          sort_by: state.sortBy,
          sort_dir: state.sortDir,
          ...(viewTag !== undefined && viewTag !== '' ? { required_tag: viewTag } : {}),
          ...(view.includeArchived === true ? { include_archived: true } : {}),
        },
      });
    } else {
      state.tickets = [];
    }
    renderTicketList();
    return;
  }

  const params = new URLSearchParams();

  if (state.view === 'trash') {
    params.set('status', 'deleted');
  } else if (state.view === 'up-next') {
    params.set('up_next', 'true');
  } else if (state.view === 'open') {
    params.set('status', 'open');
  } else if (state.view === 'completed') {
    params.set('status', 'completed');
  } else if (state.view === 'non-verified') {
    params.set('status', 'non_verified');
  } else if (state.view === 'verified') {
    params.set('status', 'verified');
  } else if (state.view === 'backlog') {
    params.set('status', 'backlog');
  } else if (state.view === 'archive') {
    params.set('status', 'archive');
  } else if (state.view.startsWith('category:')) {
    params.set('category', state.view.split(':')[1]);
  } else if (state.view.startsWith('priority:')) {
    params.set('priority', state.view.split(':')[1]);
  } else {
    // 'all' view — exclude backlog, archive, deleted
    params.set('status', 'active');
  }

  if (state.search) params.set('search', state.search);

  params.set('sort_by', state.sortBy);
  params.set('sort_dir', state.sortDir);

  const query = params.toString();
  state.tickets = await api<Ticket[]>(`/tickets${query ? '?' + query : ''}`);
  renderTicketList();
}

function loadPreviewTickets() {
  let tickets = [...(state.backupPreview?.tickets || [])];

  // Apply view filters
  if (state.view === 'trash') {
    tickets = tickets.filter(t => t.status === 'deleted');
  } else if (state.view === 'up-next') {
    tickets = tickets.filter(t => t.up_next && t.status !== 'deleted');
  } else if (state.view === 'open') {
    tickets = tickets.filter(t => t.status === 'not_started' || t.status === 'started');
  } else if (state.view === 'completed') {
    tickets = tickets.filter(t => t.status === 'completed');
  } else if (state.view === 'non-verified') {
    tickets = tickets.filter(t => t.status !== 'verified' && t.status !== 'deleted' && t.status !== 'backlog' && t.status !== 'archive');
  } else if (state.view === 'verified') {
    tickets = tickets.filter(t => t.status === 'verified');
  } else if (state.view === 'backlog') {
    tickets = tickets.filter(t => t.status === 'backlog');
  } else if (state.view === 'archive') {
    tickets = tickets.filter(t => t.status === 'archive');
  } else if (state.view.startsWith('category:')) {
    const cat = state.view.split(':')[1];
    tickets = tickets.filter(t => t.category === cat && t.status !== 'deleted' && t.status !== 'backlog' && t.status !== 'archive');
  } else if (state.view.startsWith('priority:')) {
    const pri = state.view.split(':')[1];
    tickets = tickets.filter(t => t.priority === pri && t.status !== 'deleted' && t.status !== 'backlog' && t.status !== 'archive');
  } else {
    // 'all' view — exclude backlog, archive, deleted
    tickets = tickets.filter(t => t.status !== 'deleted' && t.status !== 'backlog' && t.status !== 'archive');
  }

  // Apply search
  if (state.search !== '') {
    const q = state.search.toLowerCase();
    tickets = tickets.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.ticket_number.toLowerCase().includes(q) ||
      (t.details !== '' && t.details.toLowerCase().includes(q))
    );
  }

  state.tickets = tickets;
  renderTicketList();
}

// --- Register callbacks so sub-modules can call back without circular imports ---

registerCallbacks({
  renderTicketList,
  loadTickets,
  updateSelectionClasses,
  updateBatchToolbar,
  updateColumnSelectionClasses,
  focusDraftInput: _focusDraftInput,
});
