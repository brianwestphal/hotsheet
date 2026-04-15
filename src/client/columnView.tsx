import { raw } from '../jsx-runtime.js';
import { suppressAnimation } from './animate.js';
import { getCutTicketIds } from './clipboard.js';
import { showTicketContextMenu } from './contextMenu.js';
import { parseTags, syncDetailPanel, updateStats } from './detail.js';
import { toElement } from './dom.js';
import { createDraftRow } from './draftRow.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, getPriorityColor, getPriorityIcon, state, syncedTicketMap } from './state.js';
import {
  callLoadTickets, callUpdateBatchToolbar, callUpdateColumnSelectionClasses,
  draggedTicketIds, setDraggedTicketIds,
} from './ticketListState.js';
import { showCategoryMenu, showPriorityMenu, showsIndicatorDot, toggleUpNext  } from './ticketRow.js';
import { trackedBatch } from './undo/actions.js';

// --- Column scroll state ---

export function saveColumnScrollState(container: HTMLElement): { scrollLeft: number; columns: Partial<Record<string, number>> } {
  const result = { scrollLeft: 0, columns: {} as Partial<Record<string, number>> };
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

export function restoreColumnScrollState(container: HTMLElement, saved: { scrollLeft: number; columns: Partial<Record<string, number>> }) {
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

export function updateColumnSelectionClasses() {
  document.querySelectorAll('.column-card[data-id]').forEach(card => {
    const id = parseInt((card as HTMLElement).dataset.id!, 10);
    if (state.selectedIds.has(id)) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
}

export function getColumnsForView(): { status: string; label: string }[] {
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

  // Check if active custom view has includeArchived
  const customViewIncludesArchived = state.view.startsWith('custom:') &&
    state.customViews.find(v => v.id === state.view.slice(7))?.includeArchived === true;

  if (state.settings.hide_verified_column) {
    const cols = [
      { status: 'not_started', label: 'Not Started' },
      { status: 'started', label: 'Started' },
      { status: 'completed', label: 'Completed' },  // Will also include verified items
    ];
    if (customViewIncludesArchived) cols.push({ status: 'archive', label: 'Archived' });
    return cols;
  }
  const cols = [
    { status: 'not_started', label: 'Not Started' },
    { status: 'started', label: 'Started' },
    { status: 'completed', label: 'Completed' },
    { status: 'verified', label: 'Verified' },
  ];
  if (customViewIncludesArchived) cols.push({ status: 'archive', label: 'Archived' });
  return cols;
}

// --- Preview column view ---

export function renderPreviewColumnView() {
  const container = document.getElementById('ticket-list')!;
  const savedScrolls = saveColumnScrollState(container);
  container.innerHTML = '';
  container.classList.add('ticket-list-columns');

  const columns = getColumnsForView();
  const knownStatuses = new Set(columns.map(c => c.status));
  // When verified column is hidden, verified items go into the completed column
  if (state.settings.hide_verified_column) knownStatuses.add('verified');
  const columnsContainer = toElement(<div className="columns-container"></div>);

  for (const col of columns) {
    const includeVerified = state.settings.hide_verified_column && col.status === 'completed';
    const colTickets = col === columns[0]
      ? state.tickets.filter(t => t.status === col.status || !knownStatuses.has(t.status))
      : state.tickets.filter(t => t.status === col.status || (includeVerified && t.status === 'verified'));
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

export function createPreviewColumnCard(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);

  const card = toElement(
    <div
      className={`column-card${isSelected ? ' selected' : ''}${ticket.up_next ? ' up-next' : ''}${getCutTicketIds().has(ticket.id) ? ' cut-pending' : ''} status-${ticket.status}`}
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
      <div className="column-card-title">{ticket.id in syncedTicketMap ? <span className="ticket-sync-icon">{raw(syncedTicketMap[ticket.id].icon ?? '')}</span> : null}{showsIndicatorDot(ticket) ? <span className="ticket-unread-dot"></span> : null}{ticket.title}</div>
      {parseTags(ticket.tags).length > 0 ? (
        <div className="column-card-tags">
          {parseTags(ticket.tags).map(tag => (
            <span className="column-card-tag">{tag}</span>
          ))}
        </div>
      ) : null}
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

// --- Interactive column view ---

export function renderColumnView() {
  const container = document.getElementById('ticket-list')!;
  const savedScrolls = saveColumnScrollState(container);
  container.innerHTML = '';
  container.classList.add('ticket-list-columns');

  container.appendChild(createDraftRow());

  const columns = getColumnsForView();
  const knownStatuses = new Set(columns.map(c => c.status));
  // When verified column is hidden, verified items go into the completed column
  if (state.settings.hide_verified_column) knownStatuses.add('verified');
  const columnsContainer = toElement(<div className="columns-container"></div>);

  for (const col of columns) {
    // First column also gets tickets with unrecognized statuses so nothing is silently dropped
    const includeVerified = state.settings.hide_verified_column && col.status === 'completed';
    const colTickets = col === columns[0]
      ? state.tickets.filter(t => t.status === col.status || !knownStatuses.has(t.status))
      : state.tickets.filter(t => t.status === col.status || (includeVerified && t.status === 'verified'));
    const column = toElement(
      <div className="column" data-status={col.status}>
        <div className="column-header">
          <span className="column-title">{col.label}</span>
          <span className="column-count">{String(colTickets.length)}</span>
        </div>
        <div className="column-body"></div>
      </div>
    );

    // Click column header to select/deselect all tickets in this column
    column.querySelector('.column-header')!.addEventListener('click', (ev) => {
      const e = ev as MouseEvent;
      const colIds = new Set(colTickets.map(t => t.id));
      const allSelected = colIds.size > 0 && [...colIds].every(id => state.selectedIds.has(id));

      // Without modifier keys, clear selection from other columns first
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
        for (const id of [...state.selectedIds]) {
          if (!colIds.has(id)) state.selectedIds.delete(id);
        }
      }

      if (allSelected) {
        for (const id of colIds) state.selectedIds.delete(id);
      } else {
        for (const id of colIds) state.selectedIds.add(id);
      }
      callUpdateColumnSelectionClasses();
      callUpdateBatchToolbar();
      syncDetailPanel();
    });

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
      setDraggedTicketIds([]);
      if (ids.length === 0) return;
      const affected = state.tickets.filter(t => ids.includes(t.id));
      suppressAnimation();
      void trackedBatch(
        affected,
        { ids, action: 'status', value: col.status },
        'Change status',
      ).then(() => void callLoadTickets());
    });

    columnsContainer.appendChild(column);
  }

  container.appendChild(columnsContainer);
  restoreColumnScrollState(container, savedScrolls);
  callUpdateBatchToolbar();
  void updateStats();
}

export function createColumnCard(ticket: Ticket): HTMLElement {
  const isSelected = state.selectedIds.has(ticket.id);

  const card = toElement(
    <div
      className={`column-card${isSelected ? ' selected' : ''}${ticket.up_next ? ' up-next' : ''}${getCutTicketIds().has(ticket.id) ? ' cut-pending' : ''} status-${ticket.status}`}
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
      <div className="column-card-title">{ticket.id in syncedTicketMap ? <span className="ticket-sync-icon">{raw(syncedTicketMap[ticket.id].icon ?? '')}</span> : null}{showsIndicatorDot(ticket) ? <span className="ticket-unread-dot"></span> : null}{ticket.title}</div>
      {parseTags(ticket.tags).length > 0 ? (
        <div className="column-card-tags">
          {parseTags(ticket.tags).map(tag => (
            <span className="column-card-tag">{tag}</span>
          ))}
        </div>
      ) : null}
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

  // Context menu
  card.addEventListener('contextmenu', (e) => { showTicketContextMenu(e, ticket); });

  // Draggable
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    if (state.selectedIds.has(ticket.id) && state.selectedIds.size > 1) {
      setDraggedTicketIds(Array.from(state.selectedIds));
    } else {
      setDraggedTicketIds([ticket.id]);
    }
    e.dataTransfer!.setData('text/plain', JSON.stringify(draggedTicketIds));
    e.dataTransfer!.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => { setDraggedTicketIds([]); });

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
        const anchorIdx = colIds.indexOf(state.lastClickedId);
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
    callUpdateColumnSelectionClasses();
    callUpdateBatchToolbar();
    syncDetailPanel();
  });

  return card;
}
