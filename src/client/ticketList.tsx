import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { syncDetailPanel, updateStats } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, getPriorityColor, getPriorityIcon, getStatusIcon, VERIFIED_SVG, state } from './state.js';
import { recordTextChange, trackedBatch, trackedDelete, trackedPatch, trackedRestore } from './undo/actions.js';

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function cancelPendingSave() {
  if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
}
let suppressFocusSelect = false;
let draftCategory: string | null = null;
let draftTitle = '';

// Module-level drag state — avoids reliance on dataTransfer custom MIME types
// which can be silently stripped by WebKit/WKWebView
export let draggedTicketIds: number[] = [];

function getCategoryShortcuts(): { key: string; value: string; label: string }[] {
  return state.categories.map(c => ({ key: c.shortcutKey, value: c.id, label: c.label }));
}

const PRIORITY_SHORTCUTS: { key: string; value: string; label: string }[] = [
  { key: '1', value: 'highest', label: 'Highest' },
  { key: '2', value: 'high', label: 'High' },
  { key: '3', value: 'default', label: 'Default' },
  { key: '4', value: 'low', label: 'Low' },
  { key: '5', value: 'lowest', label: 'Lowest' },
];

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
  suppressFocusSelect = true;
  if (ticketId === 'draft') {
    focusDraftInput();
  } else {
    const el = document.querySelector<HTMLInputElement>(`.ticket-row[data-id="${ticketId}"] .ticket-title-input`);
    (el as HTMLElement | null)?.focus();
  }
  suppressFocusSelect = false;
}

// --- List rendering ---

export function canUseColumnView(): boolean {
  const view = state.view;
  return view !== 'completed' && view !== 'verified' && view !== 'trash' && view !== 'backlog' && view !== 'archive';
}

function getColumnsForView(): { status: string; label: string }[] {
  if (state.view === 'up-next' || state.view === 'open') {
    return [
      { status: 'not_started', label: 'Not Started' },
      { status: 'started', label: 'Started' },
    ];
  }
  if (state.view === 'non-verified') {
    return [
      { status: 'not_started', label: 'Not Started' },
      { status: 'started', label: 'Started' },
      { status: 'completed', label: 'Completed' },
    ];
  }
  return [
    { status: 'not_started', label: 'Not Started' },
    { status: 'started', label: 'Started' },
    { status: 'completed', label: 'Completed' },
    { status: 'verified', label: 'Verified' },
  ];
}

export function renderTicketList() {
  const isPreview = !!state.backupPreview?.active;

  if (state.layout === 'columns' && canUseColumnView()) {
    if (isPreview) { renderPreviewColumnView(); return; }
    renderColumnView();
    return;
  }

  const isTrash = state.view === 'trash';
  const focusedId = isPreview ? null : getFocusedTicketId();

  // Preserve in-progress title edits for existing tickets (HS-199)
  let editingValue: string | null = null;
  if (focusedId != null && focusedId !== 'draft') {
    const input = document.querySelector<HTMLInputElement>(`.ticket-row[data-id="${focusedId}"] .ticket-title-input`);
    if (input) editingValue = input.value;
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
    // Restore in-progress title edit if the user was editing (HS-199)
    if (focusedId != null && focusedId !== 'draft' && editingValue != null) {
      const input = document.querySelector<HTMLInputElement>(`.ticket-row[data-id="${focusedId}"] .ticket-title-input`);
      if (input && input.value !== editingValue) {
        input.value = editingValue;
      }
    }
    restoreFocus(focusedId);
    updateBatchToolbar();
  }
  void updateStats();
}

function createPreviewRow(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);
  const isDone = ticket.status === 'completed' || ticket.status === 'verified';
  const isVerified = ticket.status === 'verified';

  const row = toElement(
    <div
      className={`ticket-row${isSelected ? ' selected' : ''}${isDone ? ' completed' : ''}${ticket.up_next ? ' up-next' : ''}`}
      data-id={String(ticket.id)}
    >
      <span className="ticket-checkbox-spacer"></span>
      <span className="ticket-category-badge" style={`background-color:${getCategoryColor(ticket.category)};cursor:default`} title={ticket.category}>
        {getCategoryLabel(ticket.category)}
      </span>
      <span className="ticket-number">{ticket.ticket_number}</span>
      <span className={`ticket-status-btn${isVerified ? ' verified' : ''}`} style="cursor:default">
        {raw(isVerified ? VERIFIED_SVG : getStatusIcon(ticket.status))}
      </span>
      <span className="ticket-title-input" style="cursor:default">{ticket.title}</span>
      <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)};cursor:default`} title={ticket.priority}>
        {raw(getPriorityIcon(ticket.priority))}
      </span>
      <span className={`ticket-star${ticket.up_next ? ' active' : ''}`} style="cursor:default">
        {ticket.up_next ? '\u2605' : '\u2606'}
      </span>
    </div>
  );

  // Click to select for detail panel inspection (single select only)
  row.addEventListener('click', () => {
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    updateSelectionClasses();
    syncDetailPanel();
  });

  return row;
}

function saveColumnScrollState(container: HTMLElement): { scrollLeft: number; columns: Record<string, number> } {
  const result = { scrollLeft: 0, columns: {} as Record<string, number> };
  const columnsContainer = container.querySelector('.columns-container');
  if (columnsContainer) {
    result.scrollLeft = columnsContainer.scrollLeft;
    columnsContainer.querySelectorAll('.column[data-status]').forEach(col => {
      const status = (col as HTMLElement).dataset.status!;
      const body = col.querySelector('.column-body');
      if (body) result.columns[status] = body.scrollTop;
    });
  }
  return result;
}

function restoreColumnScrollState(container: HTMLElement, saved: { scrollLeft: number; columns: Record<string, number> }) {
  const columnsContainer = container.querySelector('.columns-container');
  if (columnsContainer) {
    columnsContainer.scrollLeft = saved.scrollLeft;
    columnsContainer.querySelectorAll('.column[data-status]').forEach(col => {
      const status = (col as HTMLElement).dataset.status!;
      const body = col.querySelector('.column-body');
      if (body && saved.columns[status] != null) {
        body.scrollTop = saved.columns[status];
      }
    });
  }
}

function renderPreviewColumnView() {
  const container = document.getElementById('ticket-list')!;
  const savedScrolls = saveColumnScrollState(container);
  container.innerHTML = '';
  container.classList.add('ticket-list-columns');

  const columns = getColumnsForView();
  const columnsContainer = toElement(<div className="columns-container"></div>);

  for (const col of columns) {
    const colTickets = state.tickets.filter(t => t.status === col.status);
    const column = toElement(
      <div className="column" data-status={col.status}>
        <div className="column-header">
          <span className="column-title">{col.label}</span>
          <span className="column-count">{String(colTickets.length)}</span>
        </div>
        <div className="column-body"></div>
      </div>
    );

    const body = column.querySelector('.column-body')!;
    for (const ticket of colTickets) {
      body.appendChild(createPreviewColumnCard(ticket));
    }

    columnsContainer.appendChild(column);
  }

  container.appendChild(columnsContainer);
  restoreColumnScrollState(container, savedScrolls);

  const toolbar = document.getElementById('batch-toolbar');
  if (toolbar) toolbar.style.display = 'none';
  void updateStats();
}

function createPreviewColumnCard(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);

  const card = toElement(
    <div
      className={`column-card${isSelected ? ' selected' : ''}${ticket.up_next ? ' up-next' : ''}`}
      data-id={String(ticket.id)}
    >
      <div className="column-card-header">
        <span className="ticket-category-badge" style={`background-color:${getCategoryColor(ticket.category)}`}>
          {getCategoryLabel(ticket.category)}
        </span>
        <span className="ticket-number">{ticket.ticket_number}</span>
        <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)};cursor:default`}>
          {raw(getPriorityIcon(ticket.priority))}
        </span>
        <span className={`ticket-star${ticket.up_next ? ' active' : ''}`} style="cursor:default">
          {ticket.up_next ? '\u2605' : '\u2606'}
        </span>
      </div>
      <div className="column-card-title">{ticket.title}</div>
    </div>
  );

  card.addEventListener('click', () => {
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    updateColumnSelectionClasses();
    syncDetailPanel();
  });

  return card;
}

function renderColumnView() {
  const container = document.getElementById('ticket-list')!;
  const savedScrolls = saveColumnScrollState(container);
  container.innerHTML = '';
  container.classList.add('ticket-list-columns');

  container.appendChild(createDraftRow());

  const columns = getColumnsForView();
  const columnsContainer = toElement(<div className="columns-container"></div>);

  for (const col of columns) {
    const colTickets = state.tickets.filter(t => t.status === col.status);
    const column = toElement(
      <div className="column" data-status={col.status}>
        <div className="column-header">
          <span className="column-title">{col.label}</span>
          <span className="column-count">{String(colTickets.length)}</span>
        </div>
        <div className="column-body"></div>
      </div>
    );

    const body = column.querySelector('.column-body')!;
    for (const ticket of colTickets) {
      body.appendChild(createColumnCard(ticket));
    }

    // Drop target for status changes
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = 'move';
      column.classList.add('column-drop-target');
    });
    body.addEventListener('dragleave', (e) => {
      const related = (e as DragEvent).relatedTarget as Node | null;
      if (!related || !body.contains(related)) {
        column.classList.remove('column-drop-target');
      }
    });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('column-drop-target');
      const ids = draggedTicketIds;
      draggedTicketIds = [];
      if (ids.length === 0) return;
      const affected = state.tickets.filter(t => ids.includes(t.id));
      void trackedBatch(
        affected,
        { ids, action: 'status', value: col.status },
        'Change status',
      ).then(() => void loadTickets());
    });

    columnsContainer.appendChild(column);
  }

  container.appendChild(columnsContainer);
  restoreColumnScrollState(container, savedScrolls);
  updateBatchToolbar();
  void updateStats();
}

function createColumnCard(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);

  const card = toElement(
    <div
      className={`column-card${isSelected ? ' selected' : ''}${ticket.up_next ? ' up-next' : ''}`}
      data-id={String(ticket.id)}
    >
      <div className="column-card-header">
        <span className="ticket-category-badge" style={`background-color:${getCategoryColor(ticket.category)}`}>
          {getCategoryLabel(ticket.category)}
        </span>
        <span className="ticket-number">{ticket.ticket_number}</span>
        <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)}`}>
          {raw(getPriorityIcon(ticket.priority))}
        </span>
        <button className={`ticket-star${ticket.up_next ? ' active' : ''}`} title={ticket.up_next ? 'Remove from Up Next' : 'Add to Up Next'}>
          {ticket.up_next ? '\u2605' : '\u2606'}
        </button>
      </div>
      <div className="column-card-title">{ticket.title}</div>
    </div>
  );

  // Category menu
  const catBadge = card.querySelector('.ticket-category-badge') as HTMLElement;
  catBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    showCategoryMenu(catBadge, ticket);
  });

  // Priority menu
  const priSpan = card.querySelector('.ticket-priority-indicator') as HTMLElement;
  priSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    showPriorityMenu(priSpan, ticket);
  });

  // Star toggle
  card.querySelector('.ticket-star')!.addEventListener('click', (e) => {
    e.stopPropagation();
    void toggleUpNext(ticket);
  });

  // Draggable
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    if (state.selectedIds.has(ticket.id) && state.selectedIds.size > 1) {
      draggedTicketIds = Array.from(state.selectedIds);
    } else {
      draggedTicketIds = [ticket.id];
    }
    e.dataTransfer!.setData('text/plain', JSON.stringify(draggedTicketIds));
    e.dataTransfer!.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => { draggedTicketIds = []; });

  // Click to select (with multi-select support)
  card.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) {
      // Toggle individual selection
      if (state.selectedIds.has(ticket.id)) state.selectedIds.delete(ticket.id);
      else state.selectedIds.add(ticket.id);
      state.lastClickedId = ticket.id;
    } else if (e.shiftKey && state.lastClickedId != null) {
      // Range select — only within the same column (same status)
      const anchorTicket = state.tickets.find(t => t.id === state.lastClickedId);
      if (anchorTicket && anchorTicket.status === ticket.status) {
        const colTickets = state.tickets.filter(t => t.status === ticket.status);
        const colIds = colTickets.map(t => t.id);
        const anchorIdx = colIds.indexOf(state.lastClickedId!);
        const targetIdx = colIds.indexOf(ticket.id);
        if (anchorIdx !== -1 && targetIdx !== -1) {
          const from = Math.min(anchorIdx, targetIdx);
          const to = Math.max(anchorIdx, targetIdx);
          state.selectedIds.clear();
          for (let i = from; i <= to; i++) state.selectedIds.add(colIds[i]);
        }
      } else {
        // Cross-column shift-click — treat as single select
        state.selectedIds.clear();
        state.selectedIds.add(ticket.id);
        state.lastClickedId = ticket.id;
      }
    } else {
      // Single select
      state.selectedIds.clear();
      state.selectedIds.add(ticket.id);
      state.lastClickedId = ticket.id;
    }
    updateColumnSelectionClasses();
    updateBatchToolbar();
  });

  return card;
}

function updateColumnSelectionClasses() {
  document.querySelectorAll('.column-card[data-id]').forEach(card => {
    const id = parseInt((card as HTMLElement).dataset.id!, 10);
    if (state.selectedIds.has(id)) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
}

// --- Draft row ---

function createDraftRow(): HTMLElement {
  const draftCat = getDraftCategory();
  const inCategoryView = state.view.startsWith('category:');

  const row = toElement(
    <div className="ticket-row draft-row">
      <span className="ticket-checkbox-spacer"></span>
      <span className="ticket-status-btn draft-placeholder">{'\u25CB'}</span>
      <span
        className="ticket-category-badge draft-badge"
        style={`background-color:${getCategoryColor(draftCat)}${!inCategoryView ? ';cursor:pointer;opacity:1' : ''}`}
      >
        {getCategoryLabel(draftCat)}
      </span>
      <span className="ticket-number draft-number"></span>
      <input type="text" className="ticket-title-input draft-input" placeholder="New ticket..." value={draftTitle} />
      <span className="ticket-priority-indicator draft-placeholder"></span>
      <span className="ticket-star draft-placeholder"></span>
    </div>
  );

  if (!inCategoryView) {
    const catBadge = row.querySelector('.ticket-category-badge') as HTMLElement;
    catBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      showDraftCategoryMenu(catBadge);
    });
  }

  const titleInput = row.querySelector('.draft-input') as HTMLInputElement;
  titleInput.addEventListener('input', () => {
    draftTitle = titleInput.value;
  });
  titleInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && titleInput.value.trim()) {
      e.preventDefault();
      const title = titleInput.value.trim();
      draftTitle = '';
      titleInput.value = '';
      const defaults = getDefaultsFromView();
      if (draftCategory && !state.view.startsWith('category:')) {
        defaults.category = draftCategory;
      }
      const created = await api<Ticket>('/tickets', { method: 'POST', body: { title, defaults } });
      // Auto-select the newly created ticket (HS-202)
      if (created) {
        state.selectedIds.clear();
        state.selectedIds.add(created.id);
      }
      await loadTickets();
      focusDraftInput();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.tickets.length > 0) {
        const el = document.querySelector<HTMLElement>(`.ticket-row[data-id="${state.tickets[0].id}"] .ticket-title-input`);
        el?.focus();
      }
    }
  });

  return row;
}

export function focusDraftInput() {
  const input = document.querySelector<HTMLInputElement>('.draft-row .draft-input');
  input?.focus();
}

function getDefaultsFromView(): Record<string, unknown> {
  const view = state.view;
  if (view === 'up-next') return { up_next: true };
  if (view === 'open') return {};
  if (view === 'completed') return { status: 'completed' };
  if (view === 'backlog') return { status: 'backlog' };
  if (view === 'archive') return { status: 'archive' };
  if (view.startsWith('category:')) return { category: view.split(':')[1] };
  if (view.startsWith('priority:')) return { priority: view.split(':')[1] };
  return {};
}

function getDraftCategory(): string {
  if (draftCategory) return draftCategory;
  const view = state.view;
  if (view.startsWith('category:')) return view.split(':')[1];
  return 'issue';
}

function showDraftCategoryMenu(anchor: HTMLElement) {
  closeAllMenus();
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '\u2318' : 'Ctrl+';
  const currentCat = getDraftCategory();
  const menu = createDropdown(anchor, getCategoryShortcuts().map(s => ({
    label: s.label,
    key: s.key,
    shortcut: `${mod}${s.key.toUpperCase()}`,
    color: getCategoryColor(s.value),
    active: currentCat === s.value,
    action: () => {
      draftCategory = s.value;
      renderTicketList();
      focusDraftInput();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

// --- Ticket row ---

function createTicketRow(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);
  const isDone = ticket.status === 'completed' || ticket.status === 'verified';
  const isVerified = ticket.status === 'verified';

  const row = toElement(
    <div
      className={`ticket-row${isSelected ? ' selected' : ''}${isDone ? ' completed' : ''}${ticket.up_next ? ' up-next' : ''}`}
      data-id={String(ticket.id)}
    >
      <input type="checkbox" className="ticket-checkbox" checked={isSelected} />
      <span className="ticket-category-badge" style={`background-color:${getCategoryColor(ticket.category)}`} title={ticket.category}>
        {getCategoryLabel(ticket.category)}
      </span>
      <span className="ticket-number">{ticket.ticket_number}</span>
      <button className={`ticket-status-btn${isVerified ? ' verified' : ''}`} title={ticket.status.replace('_', ' ')}>
        {raw(isVerified ? VERIFIED_SVG : getStatusIcon(ticket.status))}
      </button>
      <input type="text" className="ticket-title-input" value={ticket.title} />
      <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)}`} title={ticket.priority}>
        {raw(getPriorityIcon(ticket.priority))}
      </span>
      <button className={`ticket-star${ticket.up_next ? ' active' : ''}`} title={ticket.up_next ? 'Remove from Up Next' : 'Add to Up Next'}>
        {ticket.up_next ? '\u2605' : '\u2606'}
      </button>
    </div>
  );

  // Drag support — enable only when not interacting with inputs/buttons
  row.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON') {
      row.draggable = true;
    }
  });
  row.addEventListener('mouseup', () => { row.draggable = false; });
  row.addEventListener('dragend', () => { row.draggable = false; draggedTicketIds = []; });
  row.addEventListener('dragstart', (e) => {
    if (state.selectedIds.has(ticket.id) && state.selectedIds.size > 1) {
      draggedTicketIds = Array.from(state.selectedIds);
    } else {
      draggedTicketIds = [ticket.id];
    }
    e.dataTransfer!.setData('text/plain', JSON.stringify(draggedTicketIds));
    e.dataTransfer!.effectAllowed = 'move';
  });

  // Row-level modifier click for selection
  row.addEventListener('mousedown', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault();
      if (handleRowClick(e, ticket)) e.stopPropagation();
    }
  });

  // Checkbox
  const checkbox = row.querySelector('.ticket-checkbox') as HTMLInputElement;
  checkbox.addEventListener('click', (e) => e.stopPropagation());
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedIds.add(ticket.id);
    else state.selectedIds.delete(ticket.id);
    state.lastClickedId = ticket.id;
    renderTicketList();
  });

  // Status cycle
  row.querySelector('.ticket-status-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    void cycleStatus(ticket);
  });

  // Category menu
  const catBadge = row.querySelector('.ticket-category-badge') as HTMLElement;
  catBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    showCategoryMenu(catBadge, ticket);
  });

  // Title input
  const titleInput = row.querySelector('.ticket-title-input') as HTMLInputElement;
  titleInput.addEventListener('focus', () => {
    if (suppressFocusSelect) return;
    if (state.selectedIds.size === 1 && state.selectedIds.has(ticket.id)) return;
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    updateSelectionClasses();
    updateBatchToolbar();
  });
  titleInput.addEventListener('input', () => {
    recordTextChange(ticket, 'title', titleInput.value);
    debouncedSave(ticket.id, { title: titleInput.value });
  });
  titleInput.addEventListener('keydown', (e) => {
    handleTicketKeydown(e, ticket, titleInput);
  });

  // Priority menu
  const priSpan = row.querySelector('.ticket-priority-indicator') as HTMLElement;
  priSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    showPriorityMenu(priSpan, ticket);
  });

  // Star toggle
  row.querySelector('.ticket-star')!.addEventListener('click', (e) => {
    e.stopPropagation();
    void toggleUpNext(ticket);
  });

  return row;
}

// --- Trash row ---

function createTrashRow(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);
  const deletedDate = ticket.deleted_at ? new Date(ticket.deleted_at) : null;

  const row = toElement(
    <div className={`ticket-row trash-row${isSelected ? ' selected' : ''}`} data-id={String(ticket.id)}>
      <input type="checkbox" className="ticket-checkbox" checked={isSelected} />
      <span className="ticket-category-badge" style={`background-color:${getCategoryColor(ticket.category)}`}>
        {getCategoryLabel(ticket.category)}
      </span>
      <span className="ticket-number">{ticket.ticket_number}</span>
      <span className="ticket-title-input trash-title" style="cursor:default">{ticket.title}</span>
      <span className="ticket-number" title={deletedDate ? `Deleted: ${deletedDate.toLocaleString()}` : ''}>
        {deletedDate ? deletedDate.toLocaleDateString() : ''}
      </span>
      <button className="btn btn-sm" title="Restore from trash">Restore</button>
    </div>
  );

  row.addEventListener('mousedown', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault();
      if (handleRowClick(e, ticket)) e.stopPropagation();
    }
  });

  const checkbox = row.querySelector('.ticket-checkbox') as HTMLInputElement;
  checkbox.addEventListener('click', (e) => e.stopPropagation());
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedIds.add(ticket.id);
    else state.selectedIds.delete(ticket.id);
    state.lastClickedId = ticket.id;
    renderTicketList();
  });

  row.querySelector('.trash-title')!.addEventListener('click', () => {
    if (state.selectedIds.size === 1 && state.selectedIds.has(ticket.id)) return;
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    updateSelectionClasses();
    updateBatchToolbar();
  });

  row.querySelector('.btn')!.addEventListener('click', async (e) => {
    e.stopPropagation();
    await trackedRestore(ticket);
    void loadTickets();
  });

  return row;
}

// --- Row selection ---

function handleRowClick(e: MouseEvent, ticket: Ticket) {
  const isMeta = e.metaKey || e.ctrlKey;
  const isShift = e.shiftKey;

  if (isMeta) {
    if (state.selectedIds.has(ticket.id)) state.selectedIds.delete(ticket.id);
    else state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    renderTicketList();
  } else if (isShift && state.lastClickedId != null) {
    const ids = state.tickets.map(t => t.id);
    const anchorIdx = ids.indexOf(state.lastClickedId);
    const targetIdx = ids.indexOf(ticket.id);
    if (anchorIdx !== -1 && targetIdx !== -1) {
      const from = Math.min(anchorIdx, targetIdx);
      const to = Math.max(anchorIdx, targetIdx);
      state.selectedIds.clear();
      for (let i = from; i <= to; i++) state.selectedIds.add(ids[i]);
    }
    renderTicketList();
  } else {
    return false;
  }
  return true;
}

// --- Keyboard handling ---

function handleTicketKeydown(e: KeyboardEvent, ticket: Ticket, input: HTMLInputElement) {
  if (e.key === 'Enter') {
    e.preventDefault();
    focusDraftInput();
  } else if (e.key === 'Backspace' && input.value === '') {
    e.preventDefault();
    void deleteTicketAndFocus(ticket.id);
  } else if (e.key === 'ArrowDown' && e.shiftKey) {
    e.preventDefault();
    shiftSelectTo(ticket.id, 1);
  } else if (e.key === 'ArrowUp' && e.shiftKey) {
    e.preventDefault();
    shiftSelectTo(ticket.id, -1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusNextTicket(ticket.id);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusPrevTicket(ticket.id);
  } else if ((e.metaKey || e.ctrlKey) && !e.altKey && getCategoryShortcuts().some(s => s.key === e.key)) {
    e.preventDefault();
    const cat = getCategoryShortcuts().find(s => s.key === e.key)!;
    void setTicketField(ticket, 'category', cat.value);
  } else if (e.altKey && !e.metaKey && !e.ctrlKey && PRIORITY_SHORTCUTS.some(s => s.key === e.key)) {
    e.preventDefault();
    const pri = PRIORITY_SHORTCUTS.find(s => s.key === e.key)!;
    void setTicketField(ticket, 'priority', pri.value);
  }
}

function focusNextTicket(currentId: number) {
  const idx = state.tickets.findIndex(t => t.id === currentId);
  if (idx < state.tickets.length - 1) {
    const el = document.querySelector(`.ticket-row[data-id="${state.tickets[idx + 1].id}"] .ticket-title-input`);
    (el as HTMLElement | null)?.focus();
  }
}

function focusPrevTicket(currentId: number) {
  const idx = state.tickets.findIndex(t => t.id === currentId);
  if (idx > 0) {
    const el = document.querySelector(`.ticket-row[data-id="${state.tickets[idx - 1].id}"] .ticket-title-input`);
    (el as HTMLElement | null)?.focus();
  } else {
    focusDraftInput();
  }
}

function shiftSelectTo(currentId: number, direction: 1 | -1) {
  const idx = state.tickets.findIndex(t => t.id === currentId);
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= state.tickets.length) return;
  const targetId = state.tickets[targetIdx].id;

  state.selectedIds.add(currentId);
  if (state.selectedIds.has(targetId)) state.selectedIds.delete(currentId);
  else state.selectedIds.add(targetId);

  suppressFocusSelect = true;
  const el = document.querySelector<HTMLElement>(`.ticket-row[data-id="${targetId}"] .ticket-title-input`);
  el?.focus();
  suppressFocusSelect = false;
  updateSelectionClasses();
  updateBatchToolbar();
}

// --- Ticket operations ---

async function cycleStatus(ticket: Ticket) {
  const cycle: Record<string, string> = {
    not_started: 'started',
    started: 'completed',
    completed: 'verified',
    verified: 'not_started',
    backlog: 'not_started',
    archive: 'not_started',
  };
  const newStatus = cycle[ticket.status] || 'not_started';
  const updated = await trackedPatch(ticket, { status: newStatus }, 'Change status');
  Object.assign(ticket, updated);
  renderTicketList();
}

async function toggleUpNext(ticket: Ticket) {
  if (!ticket.up_next && (ticket.status === 'completed' || ticket.status === 'verified')) {
    // Reopen done ticket and add to Up Next
    await trackedPatch(ticket, { status: 'not_started', up_next: true }, 'Toggle up next');
  } else {
    await trackedPatch(ticket, { up_next: !ticket.up_next }, 'Toggle up next');
  }
  void loadTickets();
}

async function setTicketField(ticket: Ticket, field: string, value: string) {
  const updated = await trackedPatch(ticket, { [field]: value }, `Change ${field}`);
  Object.assign(ticket, updated);
  renderTicketList();
}

async function deleteTicketAndFocus(id: number) {
  const idx = state.tickets.findIndex(t => t.id === id);
  const ticket = state.tickets.find(t => t.id === id);
  if (ticket) {
    await trackedDelete(ticket);
  } else {
    await api(`/tickets/${id}`, { method: 'DELETE' });
  }
  state.tickets = state.tickets.filter(t => t.id !== id);
  state.selectedIds.delete(id);
  renderTicketList();

  if (idx > 0 && state.tickets.length > 0) {
    const targetIdx = Math.min(idx - 1, state.tickets.length - 1);
    const el = document.querySelector(`.ticket-row[data-id="${state.tickets[targetIdx].id}"] .ticket-title-input`);
    (el as HTMLElement | null)?.focus();
  } else {
    focusDraftInput();
  }
}

function debouncedSave(id: number, updates: Record<string, unknown>) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    void api(`/tickets/${id}`, { method: 'PATCH', body: updates });
  }, 300);
}

// --- Context menus ---

function showCategoryMenu(anchor: HTMLElement, ticket: Ticket) {
  closeAllMenus();
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '\u2318' : 'Ctrl+';
  const menu = createDropdown(anchor, getCategoryShortcuts().map(s => ({
    label: s.label,
    key: s.key,
    shortcut: `${mod}${s.key.toUpperCase()}`,
    color: getCategoryColor(s.value),
    active: ticket.category === s.value,
    action: async () => {
      const updated = await trackedPatch(ticket, { category: s.value }, 'Change category');
      Object.assign(ticket, updated);
      renderTicketList();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

function showPriorityMenu(anchor: HTMLElement, ticket: Ticket) {
  closeAllMenus();
  const menu = createDropdown(anchor, PRIORITY_SHORTCUTS.map(s => ({
    label: s.label,
    key: s.key,
    shortcut: `Alt+${s.key}`,
    icon: getPriorityIcon(s.value),
    iconColor: getPriorityColor(s.value),
    active: ticket.priority === s.value,
    action: async () => {
      const updated = await trackedPatch(ticket, { priority: s.value }, 'Change priority');
      Object.assign(ticket, updated);
      renderTicketList();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
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
      toolbar.insertBefore(restoreBtn, document.getElementById('batch-count')!);
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
      toolbar.insertBefore(emptyBtn, document.getElementById('batch-count')!);
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
  if (state.backupPreview?.active) {
    loadPreviewTickets();
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
  if (state.search) {
    const q = state.search.toLowerCase();
    tickets = tickets.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.ticket_number.toLowerCase().includes(q) ||
      (t.details && t.details.toLowerCase().includes(q))
    );
  }

  state.tickets = tickets;
  renderTicketList();
}
