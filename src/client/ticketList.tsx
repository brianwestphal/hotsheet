import { captureSnapshot, flipAnimate } from './animate.js';
import { api } from './api.js';
import { renderColumnView, renderPreviewColumnView, updateColumnSelectionClasses } from './columnView.js';
import { syncDetailPanel, updateStats } from './detail.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { createDraftRow, focusDraftInput as _focusDraftInput } from './draftRow.js';
import { bindList } from './reactive-bind.js';
import { renderSearchExtraRows } from './searchExtraRows.js';
import type { SyncedTicketInfo,Ticket  } from './state.js';
import { setSyncedTicketMap, state } from './state.js';
import {
  draggedTicketIds as _draggedTicketIds,
registerCallbacks,
setDraftTitle, setSuppressFocusSelect} from './ticketListState.js';
import { cancelPendingSave as _cancelPendingSave, createPreviewRow, createTicketRow, createTrashRow } from './ticketRow.js';
import { ticketsSignal, ticketsStore } from './ticketsStore.js';

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

/**
 * HS-8331 / §61 Phase 2 default-list-view bindList rewrite. The
 * `<div class="ticket-list-rows">` sub-container inside `#ticket-list`
 * is owned by a persistent bindList against `ticketsSignal`. Surviving
 * row ids preserve DOM identity across re-renders, which makes the
 * focus / cursor / editing-value preservation dance below nearly
 * trivial — the input element survives unchanged.
 *
 * The bindList is mounted exactly once per default-list-view
 * lifetime — `ensureListViewMount` is idempotent. Transitions from
 * column / trash / preview views dispose the bindList via
 * `unmountListViewBindList`, and the next `ensureListViewMount` call
 * re-creates everything.
 *
 * Trash and backup-preview views are deferred to HS-8333 (sub #3 of
 * the HS-8326 umbrella); for now they keep the pre-fix wholesale
 * rebuild path (container.innerHTML = '' + for-loop). Column view is
 * HS-8332 (sub #2).
 *
 * FLIP animation in the default branch is a known regression in this
 * ticket — the bindList reconciles synchronously inside the
 * `ticketsStore.actions.setTickets(...)` call (which runs BEFORE
 * `renderTicketList` is invoked by the call site), so the snapshot
 * captured at the top of `renderTicketList` is taken AFTER the
 * reconcile and `flipAnimate` is a no-op. Restoring FLIP requires a
 * `setTicketsAnimated` wrapper that captures snapshot, mutates, then
 * animates — filed as a follow-up.
 */
let listViewBindListDispose: (() => void) | null = null;

function unmountListViewBindList(): void {
  if (listViewBindListDispose !== null) {
    try { listViewBindListDispose(); } catch { /* swallow */ }
    listViewBindListDispose = null;
  }
}

function ensureListViewMount(container: HTMLElement): void {
  let rowsContainer = container.querySelector<HTMLElement>(':scope > .ticket-list-rows');
  if (rowsContainer !== null && listViewBindListDispose !== null) {
    // Already mounted. Ensure the draft row is in place at the top.
    if (container.querySelector(':scope > .draft-row') === null) {
      container.insertBefore(createDraftRow(), rowsContainer);
    }
    return;
  }

  // First mount or transition from column / trash / preview — wipe
  // the container, lay out the structure (draft row + rows sub-
  // container), and mount the bindList against the sub-container.
  unmountListViewBindList();
  container.innerHTML = '';
  container.classList.remove('ticket-list-columns');
  container.appendChild(createDraftRow());
  rowsContainer = toElement(<div className="ticket-list-rows"></div>);
  container.appendChild(rowsContainer);
  listViewBindListDispose = bindList(
    rowsContainer,
    ticketsSignal,
    (ticket) => ticket.id,
    (ticket) => ({ el: createTicketRow(ticket) }),
  );
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
    // Column view path — tear down the list-view bindList if it was
    // mounted from a prior default-list-view render.
    unmountListViewBindList();
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

  const container = byId('ticket-list');
  const scrollTop = container.scrollTop;

  if (isTrash || isPreview) {
    // HS-8333 (deferred) — trash + backup-preview views keep the pre-fix
    // wholesale rebuild path. Tear down the list-view bindList if it was
    // mounted from a prior default-list-view render.
    unmountListViewBindList();
    container.innerHTML = '';
    container.classList.remove('ticket-list-columns');
    if (state.tickets.length === 0) {
      const emptyMsg = isTrash ? 'Trash is empty' : 'No tickets match this view';
      container.appendChild(toElement(<div className="ticket-list-empty">{emptyMsg}</div>));
    }
    for (const ticket of state.tickets) {
      if (isPreview) container.appendChild(createPreviewRow(ticket));
      else container.appendChild(createTrashRow(ticket));
    }
  } else {
    // HS-8331 — default list view: bindList path. The rows sub-container
    // + its bindList survive across `renderTicketList` calls; the
    // ticketsSignal (which fires inside `ticketsStore.actions.setTickets(...)`)
    // drives row reconciliation. This call updates the draft row +
    // empty state at the parent level only.
    ensureListViewMount(container);
  }

  container.scrollTop = scrollTop;

  if (isPreview) {
    // Hide batch toolbar in preview mode
    const toolbar = byIdOrNull('batch-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    updateSelectionClasses();
    syncDetailPanel();
  } else {
    const toolbar = byIdOrNull('batch-toolbar');
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

  const selectAll = byId<HTMLInputElement>('batch-select-all');
  selectAll.checked = total > 0 && count === total;
  selectAll.indeterminate = count > 0 && count < total;

  byId('batch-count').textContent = hasSelection ? `${count} selected` : '';

  const normalControls = ['batch-category', 'batch-priority', 'batch-status', 'batch-upnext', 'batch-delete', 'batch-more'];
  for (const id of normalControls) {
    const el = byId(id);
    el.style.display = isTrash ? 'none' : '';
    if (!isTrash) (el as HTMLButtonElement | HTMLSelectElement).disabled = !hasSelection;
  }

  let restoreBtn = byIdOrNull<HTMLButtonElement>('batch-restore');
  let emptyBtn = byIdOrNull<HTMLButtonElement>('batch-empty-trash');

  if (isTrash) {
    const toolbar = byId('batch-toolbar');

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
      toolbar.insertBefore(restoreBtn, byId('batch-count'));
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
      toolbar.insertBefore(emptyBtn, byId('batch-count'));
    }
    emptyBtn.disabled = total === 0;
    emptyBtn.style.display = '';
  } else {
    if (restoreBtn) restoreBtn.style.display = 'none';
    if (emptyBtn) emptyBtn.style.display = 'none';
  }

  // Star icon state
  const starIcon = document.querySelector('.batch-star-icon');
  const starBtn = byId<HTMLButtonElement>('batch-upnext');
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
      ticketsStore.actions.setTickets(await api<Ticket[]>('/tickets/query', {
        method: 'POST',
        body: {
          logic: view.logic,
          conditions: view.conditions,
          sort_by: state.sortBy,
          sort_dir: state.sortDir,
          ...(viewTag !== undefined && viewTag !== '' ? { required_tag: viewTag } : {}),
          ...(view.includeArchived === true ? { include_archived: true } : {}),
        },
      }));
    } else {
      ticketsStore.actions.setTickets([]);
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

  // HS-7756 — clear the search-include flags + restore the pre-include
  // view mode whenever the search becomes empty. This handles every clear
  // path (`×` button, programmatic reset, project switch to a project with
  // no saved query) without each one needing to know about includes.
  if (state.search === '') {
    const { clearSearchIncludeState } = await import('./searchExtraRows.js');
    clearSearchIncludeState();
  }

  if (state.search) params.set('search', state.search);
  // HS-7756 — opt-in extra-bucket inclusion when the user has clicked
  // the "Include {N} ..." rows. Server-side OR's these into the WHERE
  // clause, so the merged result set comes back already-sorted.
  if (state.includeBacklogInSearch) params.set('include_backlog', 'true');
  if (state.includeArchiveInSearch) params.set('include_archive', 'true');

  params.set('sort_by', state.sortBy);
  params.set('sort_dir', state.sortDir);

  const query = params.toString();
  ticketsStore.actions.setTickets(await api<Ticket[]>(`/tickets${query ? '?' + query : ''}`));
  // Fetch sync map before rendering so icons appear on first render
  try {
    setSyncedTicketMap(await api<Record<number, SyncedTicketInfo>>('/sync/tickets'));
  } catch { /* non-critical */ }
  renderTicketList();
  // HS-7756 — fetch + render the per-bucket search counts. Done after the
  // main render so the user sees their tickets immediately and the
  // "Include {N} ..." rows pop in a moment later if applicable. Empty
  // search clears the counts inline.
  if (state.search === '') {
    state.searchExtraCounts = { backlog: 0, archive: 0 };
    renderSearchExtraRows(() => { void loadTickets(); });
  } else {
    void api<{ backlog: number; archive: number }>(`/tickets/search-counts?search=${encodeURIComponent(state.search)}`)
      .then(counts => {
        state.searchExtraCounts = counts;
        renderSearchExtraRows(() => { void loadTickets(); });
      })
      .catch(() => { /* non-critical */ });
  }
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

  ticketsStore.actions.setTickets(tickets);
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
