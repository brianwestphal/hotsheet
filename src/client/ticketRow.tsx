import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { getCutTicketIds } from './clipboard.js';
import { showTicketContextMenu } from './contextMenu.js';
import { syncDetailPanel } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { parseJsonArrayOr } from './json.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, getPriorityColor, getPriorityIcon, getStatusIcon, shouldResetStatusOnUpNext, state, syncedTicketMap, VERIFIED_SVG } from './state.js';
import {
  callFocusDraftInput, callLoadTickets, callRenderTicketList,
  callUpdateBatchToolbar, callUpdateSelectionClasses,
  draggedTicketIds, getCategoryShortcuts,
  PRIORITY_SHORTCUTS,   saveTimeout, setDraggedTicketIds,
setSaveTimeout,
setSuppressFocusSelect,
  suppressFocusSelect, } from './ticketListState.js';
import { recordTextChange, trackedDelete, trackedPatch, trackedRestore } from './undo/actions.js';

/** Check if a ticket has pending feedback (last note is a FEEDBACK NEEDED prefix). */
export function hasPendingFeedback(ticket: Ticket): boolean {
  if (ticket.notes === '' || ticket.notes === '[]') return false;
  // HS-8090 — `parseJsonArrayOr` consolidates the try/catch + Array.isArray
  // dance. Per-element shape stays our responsibility: if a parsed entry
  // doesn't have `.text`, the optional-chain below resolves to undefined
  // and the function returns false (no crash).
  const notes = parseJsonArrayOr(ticket.notes, []) as { text?: unknown }[];
  if (notes.length === 0) return false;
  const lastText = notes[notes.length - 1].text;
  if (typeof lastText !== 'string') return false;
  const trimmed = lastText.trim();
  return trimmed.startsWith('FEEDBACK NEEDED:') || trimmed.startsWith('IMMEDIATE FEEDBACK NEEDED:');
}

/** Returns the indicator dot type: 'feedback' (purple, highest priority), 'unread' (blue), or null. */
export function getIndicatorDotType(ticket: Ticket): 'feedback' | 'unread' | null {
  if (hasPendingFeedback(ticket)) return 'feedback';
  if (ticket.last_read_at != null && ticket.updated_at > ticket.last_read_at) return 'unread';
  return null;
}

// --- Ticket row ---

export function createTicketRow(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);
  const isDone = ticket.status === 'completed' || ticket.status === 'verified';
  const isVerified = ticket.status === 'verified';
  const isCut = getCutTicketIds().has(ticket.id);

  const row = toElement(
    <div
      className={`ticket-row${isSelected ? ' selected' : ''}${isDone ? ' completed' : ''}${ticket.up_next ? ' up-next' : ''}${isCut ? ' cut-pending' : ''}`}
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
      {ticket.id in syncedTicketMap ? <span className="ticket-sync-icon" title={`Synced via ${syncedTicketMap[ticket.id].pluginId}`}>{raw(syncedTicketMap[ticket.id].icon ?? '')}</span> : null}
      {getIndicatorDotType(ticket) != null ? <span className={`ticket-unread-dot${getIndicatorDotType(ticket) === 'feedback' ? ' feedback' : ''}`} title={getIndicatorDotType(ticket) === 'feedback' ? 'Feedback needed' : 'Unread changes'}></span> : null}
      <input type="text" className="ticket-title-input" value={ticket.title} spellCheck="true" />
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
  row.addEventListener('dragend', () => { row.draggable = false; setDraggedTicketIds([]); });
  row.addEventListener('contextmenu', (e) => { showTicketContextMenu(e, ticket); });
  row.addEventListener('dragstart', (e) => {
    if (state.selectedIds.has(ticket.id) && state.selectedIds.size > 1) {
      setDraggedTicketIds(Array.from(state.selectedIds));
    } else {
      setDraggedTicketIds([ticket.id]);
    }
    e.dataTransfer!.setData('text/plain', JSON.stringify(draggedTicketIds));
    e.dataTransfer!.effectAllowed = 'move';
  });

  // Row-level click: select ticket and open detail panel (HS-2147)
  row.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Skip if clicking interactive elements that have their own handlers
    if (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.closest('button')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // handled by mousedown below
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    callUpdateSelectionClasses();
    callUpdateBatchToolbar();
    syncDetailPanel();
  });

  // Row-level modifier click for multi-selection
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
    callRenderTicketList();
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
    // Don't clear multi-selection when this ticket is already selected (e.g., right-click on a selected row)
    if (state.selectedIds.has(ticket.id)) return;
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    callUpdateSelectionClasses();
    callUpdateBatchToolbar();
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

export function createTrashRow(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);
  const deletedDate = ticket.deleted_at !== null && ticket.deleted_at !== '' ? new Date(ticket.deleted_at) : null;

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
    callRenderTicketList();
  });

  row.querySelector('.trash-title')!.addEventListener('click', () => {
    if (state.selectedIds.size === 1 && state.selectedIds.has(ticket.id)) return;
    state.selectedIds.clear();
    state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    callUpdateSelectionClasses();
    callUpdateBatchToolbar();
  });

  row.querySelector('.btn')!.addEventListener('click', async (e) => {
    e.stopPropagation();
    await trackedRestore(ticket);
    void callLoadTickets();
  });

  return row;
}

// --- Preview row ---

export function createPreviewRow(ticket: Ticket): HTMLElement {
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
    callUpdateSelectionClasses();
    syncDetailPanel();
  });

  return row;
}

// --- Row selection ---

export function handleRowClick(e: MouseEvent, ticket: Ticket) {
  const isMeta = e.metaKey || e.ctrlKey;
  const isShift = e.shiftKey;

  if (isMeta) {
    if (state.selectedIds.has(ticket.id)) state.selectedIds.delete(ticket.id);
    else state.selectedIds.add(ticket.id);
    state.lastClickedId = ticket.id;
    callRenderTicketList();
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
    callRenderTicketList();
  } else {
    return false;
  }
  return true;
}

// --- Keyboard handling ---

function handleTicketKeydown(e: KeyboardEvent, ticket: Ticket, input: HTMLInputElement) {
  if (e.key === 'Enter') {
    e.preventDefault();
    callFocusDraftInput();
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
    callFocusDraftInput();
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

  setSuppressFocusSelect(true);
  const el = document.querySelector<HTMLElement>(`.ticket-row[data-id="${targetId}"] .ticket-title-input`);
  el?.focus();
  setSuppressFocusSelect(false);
  callUpdateSelectionClasses();
  callUpdateBatchToolbar();
}

// --- Ticket operations ---

export async function cycleStatus(ticket: Ticket) {
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
  callRenderTicketList();
}

export async function toggleUpNext(ticket: Ticket) {
  // HS-7998 — adding a backlog / archive ticket to Up Next now also
  // resets its status, just like completed / verified did pre-fix. The
  // status set lives in `shouldResetStatusOnUpNext` so the three
  // toggle-up-next callsites (this row handler, `bindDetailUpNext` in
  // `app.tsx`, and `actions.ts`'s batch path) stay in sync.
  if (!ticket.up_next && shouldResetStatusOnUpNext(ticket.status)) {
    await trackedPatch(ticket, { status: 'not_started', up_next: true }, 'Toggle up next');
  } else {
    await trackedPatch(ticket, { up_next: !ticket.up_next }, 'Toggle up next');
  }
  void callLoadTickets();
  document.dispatchEvent(new CustomEvent('hotsheet:upnext-changed'));
}

async function setTicketField(ticket: Ticket, field: string, value: string) {
  const updated = await trackedPatch(ticket, { [field]: value }, `Change ${field}`);
  Object.assign(ticket, updated);
  callRenderTicketList();
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
  callRenderTicketList();

  if (idx > 0 && state.tickets.length > 0) {
    const targetIdx = Math.min(idx - 1, state.tickets.length - 1);
    const el = document.querySelector(`.ticket-row[data-id="${state.tickets[targetIdx].id}"] .ticket-title-input`);
    (el as HTMLElement | null)?.focus();
  } else {
    callFocusDraftInput();
  }
}

export function debouncedSave(id: number, updates: Record<string, unknown>) {
  if (saveTimeout) clearTimeout(saveTimeout);
  setSaveTimeout(setTimeout(() => {
    void api(`/tickets/${id}`, { method: 'PATCH', body: updates });
  }, 300));
}

export function cancelPendingSave() {
  if (saveTimeout) { clearTimeout(saveTimeout); setSaveTimeout(null); }
}

// --- Context menus ---

export function showCategoryMenu(anchor: HTMLElement, ticket: Ticket) {
  closeAllMenus();
  const isMac = navigator.userAgent.includes('Mac');
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
      callRenderTicketList();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

export function showPriorityMenu(anchor: HTMLElement, ticket: Ticket) {
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
      callRenderTicketList();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}
