import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { syncDetailPanel, updateStats } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, getPriorityColor, getPriorityIcon, getStatusIcon, VERIFIED_SVG, state } from './state.js';

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let suppressFocusSelect = false;
let draftCategory: string | null = null;

const CATEGORY_SHORTCUTS: { key: string; value: string; label: string }[] = [
  { key: 'i', value: 'issue', label: 'Issue' },
  { key: 'b', value: 'bug', label: 'Bug' },
  { key: 'f', value: 'feature', label: 'Feature' },
  { key: 'r', value: 'requirement_change', label: 'Req Change' },
  { key: 'k', value: 'task', label: 'Task' },
  { key: 'g', value: 'investigation', label: 'Investigation' },
];

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

export function renderTicketList() {
  const isTrash = state.view === 'trash';
  const focusedId = getFocusedTicketId();

  const container = document.getElementById('ticket-list')!;
  container.innerHTML = '';

  if (!isTrash) {
    container.appendChild(createDraftRow());
  }

  if (isTrash && state.tickets.length === 0) {
    container.appendChild(toElement(<div className="ticket-list-empty">Trash is empty</div>));
  }

  for (const ticket of state.tickets) {
    container.appendChild(isTrash ? createTrashRow(ticket) : createTicketRow(ticket));
  }

  restoreFocus(focusedId);
  updateBatchToolbar();
  void updateStats();
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
      <input type="text" className="ticket-title-input draft-input" placeholder="New ticket..." />
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
  titleInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && titleInput.value.trim()) {
      e.preventDefault();
      const title = titleInput.value.trim();
      titleInput.value = '';
      const defaults = getDefaultsFromView();
      if (draftCategory && !state.view.startsWith('category:')) {
        defaults.category = draftCategory;
      }
      await api<Ticket>('/tickets', { method: 'POST', body: { title, defaults } });
      draftCategory = null;
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
  const menu = createDropdown(anchor, CATEGORY_SHORTCUTS.map(s => ({
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
      <button className={`ticket-status-btn${isVerified ? ' verified' : ''}`} title={ticket.status.replace('_', ' ')}>
        {isVerified ? raw(VERIFIED_SVG) : getStatusIcon(ticket.status)}
      </button>
      <span className="ticket-category-badge" style={`background-color:${getCategoryColor(ticket.category)}`} title={ticket.category}>
        {getCategoryLabel(ticket.category)}
      </span>
      <span className="ticket-number">{ticket.ticket_number}</span>
      <input type="text" className="ticket-title-input" value={ticket.title} />
      <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)}`} title={ticket.priority}>
        {getPriorityIcon(ticket.priority)}
      </span>
      <button className={`ticket-star${ticket.up_next ? ' active' : ''}`} title={ticket.up_next ? 'Remove from Up Next' : 'Add to Up Next'}>
        {ticket.up_next ? '\u2605' : '\u2606'}
      </button>
    </div>
  );

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
    await api(`/tickets/${ticket.id}/restore`, { method: 'POST' });
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
  } else if ((e.metaKey || e.ctrlKey) && !e.altKey && CATEGORY_SHORTCUTS.some(s => s.key === e.key)) {
    e.preventDefault();
    const cat = CATEGORY_SHORTCUTS.find(s => s.key === e.key)!;
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
  };
  const newStatus = cycle[ticket.status] || 'not_started';
  const updated = await api<Ticket>(`/tickets/${ticket.id}`, {
    method: 'PATCH',
    body: { status: newStatus },
  });
  Object.assign(ticket, updated);
  renderTicketList();
}

async function toggleUpNext(ticket: Ticket) {
  if (!ticket.up_next && (ticket.status === 'completed' || ticket.status === 'verified')) {
    if (!confirm('This ticket is already done. Would you like to reopen it and add it to Up Next?')) return;
    const updated = await api<Ticket>(`/tickets/${ticket.id}`, {
      method: 'PATCH',
      body: { status: 'not_started', up_next: true },
    });
    Object.assign(ticket, updated);
    renderTicketList();
    return;
  }
  const updated = await api<Ticket>(`/tickets/${ticket.id}/up-next`, { method: 'POST' });
  Object.assign(ticket, updated);
  renderTicketList();
}

async function setTicketField(ticket: Ticket, field: string, value: string) {
  const updated = await api<Ticket>(`/tickets/${ticket.id}`, {
    method: 'PATCH',
    body: { [field]: value },
  });
  Object.assign(ticket, updated);
  renderTicketList();
}

async function deleteTicketAndFocus(id: number) {
  const idx = state.tickets.findIndex(t => t.id === id);
  await api(`/tickets/${id}`, { method: 'DELETE' });
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
  const menu = createDropdown(anchor, CATEGORY_SHORTCUTS.map(s => ({
    label: s.label,
    key: s.key,
    shortcut: `${mod}${s.key.toUpperCase()}`,
    color: getCategoryColor(s.value),
    active: ticket.category === s.value,
    action: async () => {
      const updated = await api<Ticket>(`/tickets/${ticket.id}`, {
        method: 'PATCH',
        body: { category: s.value },
      });
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
    color: getPriorityColor(s.value),
    active: ticket.priority === s.value,
    action: async () => {
      const updated = await api<Ticket>(`/tickets/${ticket.id}`, {
        method: 'PATCH',
        body: { priority: s.value },
      });
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

  const normalControls = ['batch-category', 'batch-priority', 'batch-status', 'batch-upnext', 'batch-delete'];
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
        if (!confirm('Permanently delete all items in trash? This cannot be undone.')) return;
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
  const params = new URLSearchParams();

  if (state.view === 'trash') {
    params.set('status', 'deleted');
  } else if (state.view === 'up-next') {
    params.set('up_next', 'true');
  } else if (state.view === 'open') {
    params.set('status', 'open');
  } else if (state.view === 'completed') {
    params.set('status', 'completed');
  } else if (state.view === 'verified') {
    params.set('status', 'verified');
  } else if (state.view.startsWith('category:')) {
    params.set('category', state.view.split(':')[1]);
  } else if (state.view.startsWith('priority:')) {
    params.set('priority', state.view.split(':')[1]);
  }

  if (state.search) params.set('search', state.search);

  params.set('sort_by', state.sortBy);
  params.set('sort_dir', state.sortDir);

  const query = params.toString();
  state.tickets = await api<Ticket[]>(`/tickets${query ? '?' + query : ''}`);
  renderTicketList();
}
