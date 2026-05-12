import { raw } from '../jsx-runtime.js';
import { suppressAnimation } from './animate.js';
import { cutTicketIdsSignal, getCutTicketIds } from './clipboard.js';
import { showTicketContextMenu } from './contextMenu.js';
import { parseTags, syncDetailPanel, updateStats } from './detail.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { createDraftRow } from './draftRow.js';
import type { ReadonlySignal } from './reactive.js';
import { computed, effect } from './reactive.js';
import { bindList, bindText } from './reactive-bind.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, getPriorityColor, getPriorityIcon, state, syncedTicketMap } from './state.js';
import {
  callLoadTickets, callUpdateBatchToolbar, callUpdateColumnSelectionClasses,
  draggedTicketIds, setDraggedTicketIds,
} from './ticketListState.js';
import { getIndicatorDotType, showCategoryMenu, showPriorityMenu, toggleUpNext  } from './ticketRow.js';
import { getTicketSignals, ticketsByStatusSignal } from './ticketsStore.js';
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

// --- Column-view mount manager (HS-8332 §61 Phase 2) ---

/**
 * HS-8332 (2026-05-11) — column-view bindList rewrite. Each visible
 * column owns a `bindList` against a per-column derived signal that
 * pulls from `ticketsByStatusSignal` (the per-status partitioner in
 * `ticketsStore.ts`). The per-column signal applies column-specific
 * fallback logic — the first column also picks up tickets with
 * statuses not in the column set (so nothing is silently dropped),
 * and the `hide_verified_column` setting causes the `completed`
 * column to absorb the `verified` bucket.
 *
 * Mount is idempotent: when called with the same columns config + the
 * same preview-vs-live mode, no-op. When the config changes (view
 * change, `hide_verified_column` toggle, preview enter/exit), tear
 * down all per-column bindLists + column-count effects + drop
 * handlers and rebuild.
 *
 * On the per-row freshness limitation: when a ticket's data changes
 * but its id + status stay the same (e.g., category / priority /
 * up_next / title edit), the bindList re-uses the existing card DOM
 * (same key). The card's content reflects the value at
 * `createColumnCard` time and goes stale until the next status
 * change (which moves the card to a different column = new bindList
 * = fresh card) or a column-view remount. Same limitation as the
 * HS-8331 list-view bindList — both filled by HS-8335's per-row
 * effects on the column card.
 */
type ColumnConfig = ReturnType<typeof getColumnsForView>;

let columnDisposers: Array<() => void> = [];
let mountedColumnsKey: string | null = null;

function computeColumnsKey(columns: ColumnConfig, isPreview: boolean): string {
  const hideVerified = state.settings.hide_verified_column ? '1' : '0';
  return `${isPreview ? 'preview' : 'live'}|hv${hideVerified}|${columns.map(c => c.status).join(',')}`;
}

export function unmountColumnView(): void {
  for (const dispose of columnDisposers) {
    try { dispose(); } catch { /* swallow — caller's bug, don't block teardown */ }
  }
  columnDisposers = [];
  mountedColumnsKey = null;
}

function makeColumnSignal(
  col: { status: string },
  isFirstCol: boolean,
  knownStatuses: ReadonlySet<string>,
  includeVerifiedHere: boolean,
): ReadonlySignal<readonly Ticket[]> {
  return computed(() => {
    const grouped = ticketsByStatusSignal.value;
    const result: Ticket[] = [];
    const main = grouped[col.status];
    if (main !== undefined) result.push(...main);
    if (isFirstCol) {
      for (const status of Object.keys(grouped)) {
        if (!knownStatuses.has(status)) {
          const extras = grouped[status];
          if (extras !== undefined) result.push(...extras);
        }
      }
    }
    if (includeVerifiedHere) {
      const verified = grouped.verified;
      if (verified !== undefined) result.push(...verified);
    }
    return result;
  });
}

// --- Preview column view ---

export function renderPreviewColumnView() {
  const container = byId('ticket-list');
  const columns = getColumnsForView();
  const key = computeColumnsKey(columns, true);
  if (mountedColumnsKey === key) {
    // Same config — bindLists are still live + reacting to data; no rebuild.
    const toolbar = byIdOrNull('batch-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    void updateStats();
    return;
  }
  const savedScrolls = saveColumnScrollState(container);
  unmountColumnView();
  // HS-8365 — `replaceChildren()` (no args) is the ESLint-compliant
  // equivalent of `innerHTML = ''`. `morph()` isn't a good fit here:
  // the column layout's inner `<div class="column-body">` elements are
  // each handed to a per-column `bindList`, and morphing across that
  // ownership boundary would require the `ownedItems` escape hatch +
  // a refactor of the mount sequence. The transition is also rare
  // (column-count change, hide-verified toggle, project switch), so
  // focus / selection preservation isn't user-visible.
  container.replaceChildren();
  container.classList.add('ticket-list-columns');

  const knownStatuses = new Set(columns.map(c => c.status));
  // When verified column is hidden, verified items go into the completed column
  if (state.settings.hide_verified_column) knownStatuses.add('verified');
  const columnsContainer = toElement(<div className="columns-container"></div>);

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const isFirstCol = i === 0;
    const includeVerifiedHere = state.settings.hide_verified_column && col.status === 'completed';
    const columnSignal = makeColumnSignal(col, isFirstCol, knownStatuses, includeVerifiedHere);

    const column = toElement(
      <div className="column" data-status={col.status}>
        <div className="column-header">
          <span className="column-title">{col.label}</span>
          <span className="column-count"></span>
        </div>
        <div className="column-body"></div>
      </div>
    );

    const body = column.querySelector('.column-body')!;
    const countEl = column.querySelector('.column-count')!;

    // Per-column bindList against the derived signal.
    const bindListDispose = bindList(
      body,
      columnSignal,
      (ticket) => ticket.id,
      (ticket) => ({ el: createPreviewColumnCard(ticket) }),
    );
    columnDisposers.push(bindListDispose);

    // Reactive count display — derives length from the same signal the
    // bindList subscribes to so column-count stays in sync with the
    // rendered cards without a second computed.
    const countSignal = computed(() => String(columnSignal.value.length));
    const countDispose = bindText(countEl, countSignal);
    columnDisposers.push(countDispose);

    columnsContainer.appendChild(column);
  }

  container.appendChild(columnsContainer);
  restoreColumnScrollState(container, savedScrolls);

  const toolbar = byIdOrNull('batch-toolbar');
  if (toolbar) toolbar.style.display = 'none';
  void updateStats();
  mountedColumnsKey = key;
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
      <div className="column-card-title">{ticket.id in syncedTicketMap ? <span className="ticket-sync-icon">{raw(syncedTicketMap[ticket.id].icon ?? '')}</span> : null}{getIndicatorDotType(ticket) != null ? <span className={`ticket-unread-dot${getIndicatorDotType(ticket) === 'feedback' ? ' feedback' : ''}`}></span> : null}{ticket.title}</div>
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
  const container = byId('ticket-list');
  const columns = getColumnsForView();
  const key = computeColumnsKey(columns, false);
  if (mountedColumnsKey === key) {
    // Same config — bindLists still live + reacting; no rebuild.
    callUpdateBatchToolbar();
    void updateStats();
    return;
  }
  const savedScrolls = saveColumnScrollState(container);
  unmountColumnView();
  // HS-8365 — see the matching `replaceChildren()` rationale on
  // `renderPreviewColumnView` above. Same bindList-ownership-boundary
  // limitation applies here.
  container.replaceChildren();
  container.classList.add('ticket-list-columns');

  container.appendChild(createDraftRow());

  const knownStatuses = new Set(columns.map(c => c.status));
  // When verified column is hidden, verified items go into the completed column
  if (state.settings.hide_verified_column) knownStatuses.add('verified');
  const columnsContainer = toElement(<div className="columns-container"></div>);

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const isFirstCol = i === 0;
    const includeVerifiedHere = state.settings.hide_verified_column && col.status === 'completed';
    const columnSignal = makeColumnSignal(col, isFirstCol, knownStatuses, includeVerifiedHere);

    const column = toElement(
      <div className="column" data-status={col.status}>
        <div className="column-header">
          <span className="column-title">{col.label}</span>
          <span className="column-count"></span>
        </div>
        <div className="column-body"></div>
      </div>
    );

    // Click column header to select/deselect all tickets in this column.
    // Reads `columnSignal.value` at click time so the selection reflects
    // the live narrowed set, not a snapshot from column-mount time.
    column.querySelector('.column-header')!.addEventListener('click', (ev) => {
      const e = ev as MouseEvent;
      const colTickets = columnSignal.value;
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

    const body: HTMLElement = column.querySelector('.column-body')!;
    const countEl = column.querySelector('.column-count')!;

    // Per-column bindList against the derived signal. Surviving row ids
    // preserve DOM identity; status changes move cards between columns
    // (tear down in old column's bindList, fresh create in new column).
    // HS-8335 — each card installs per-row effects via
    // `setupColumnCardEffects` so category / priority / up_next /
    // title in-place edits update the SAME-column card without
    // requiring a column-view rebuild.
    const bindListDispose = bindList(
      body,
      columnSignal,
      (ticket) => ticket.id,
      (ticket) => {
        const el = createColumnCard(ticket);
        return { el, dispose: setupColumnCardEffects(el, ticket) };
      },
    );
    columnDisposers.push(bindListDispose);

    // Reactive count display.
    const countSignal = computed(() => String(columnSignal.value.length));
    const countDispose = bindText(countEl, countSignal);
    columnDisposers.push(countDispose);

    // Drop target for status changes. HS-7492: skip when the drag carries
    // Files — the document-level handler in app.tsx takes care of file
    // drops onto individual cards, and we don't want the whole column lit
    // up as a reorder target for a file-attachment drop.
    body.addEventListener('dragover', (e) => {
      const de = e;
      if (de.dataTransfer?.types.includes('Files') === true) return;
      e.preventDefault();
      de.dataTransfer!.dropEffect = 'move';
      column.classList.add('column-drop-target');
    });
    body.addEventListener('dragleave', (e) => {
      const related = (e).relatedTarget as Node | null;
      if (!related || !body.contains(related)) {
        column.classList.remove('column-drop-target');
      }
    });
    body.addEventListener('drop', (e) => {
      const de = e;
      if (de.dataTransfer?.types.includes('Files') === true) return;
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
  mountedColumnsKey = key;
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
      <div className="column-card-title">{ticket.id in syncedTicketMap ? <span className="ticket-sync-icon">{raw(syncedTicketMap[ticket.id].icon ?? '')}</span> : null}{getIndicatorDotType(ticket) != null ? <span className={`ticket-unread-dot${getIndicatorDotType(ticket) === 'feedback' ? ' feedback' : ''}`}></span> : null}{ticket.title}</div>
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

/**
 * HS-8335 — `setupColumnCardEffects(card, ticket)` mirrors
 * `setupTicketRowEffects` from `ticketRow.tsx` but targets the
 * column-card DOM shape: category badge color + label, priority
 * indicator color + icon, star button active class + ★/☆ text +
 * title, `.up-next` / `.cut-pending` classes on the card root,
 * unread / feedback dot inside `.column-card-title`, title text. The
 * `status-X` class on the card root is NOT made reactive — a status
 * change moves the card to a different column (different per-column
 * signal in `ticketsByStatusSignal`'s consumer), which tears down
 * the old card and creates a fresh one in the destination column
 * with the correct `status-X` class at JSX-literal time. The
 * `.selected` class stays imperative (driven by `state.selectedIds`
 * via `updateColumnSelectionClasses()`).
 */
export function setupColumnCardEffects(card: HTMLElement, ticket: Ticket): () => void {
  const sigs = getTicketSignals(ticket.id);
  if (sigs === undefined) return () => { /* no-op */ };

  const disposers: Array<() => void> = [];
  let firstRun = true;
  let lastAppliedTitle: string = ticket.title;

  const catBadge = card.querySelector<HTMLElement>('.ticket-category-badge');
  const priIndicator = card.querySelector<HTMLElement>('.ticket-priority-indicator');
  const starBtn = card.querySelector<HTMLElement>('.ticket-star');
  const titleHost = card.querySelector<HTMLElement>('.column-card-title');

  disposers.push(effect(() => {
    const t = sigs.ticket.value;
    if (firstRun) {
      firstRun = false;
      lastAppliedTitle = t.title;
      return;
    }

    // .up-next class on the card root
    card.classList.toggle('up-next', t.up_next);

    // Category badge
    if (catBadge !== null) {
      const color = getCategoryColor(t.category);
      if (catBadge.style.backgroundColor !== color) catBadge.style.backgroundColor = color;
      const label = getCategoryLabel(t.category);
      if (catBadge.textContent !== label) catBadge.textContent = label;
    }

    // Priority indicator — color + icon via createContextualFragment
    if (priIndicator !== null) {
      const color = getPriorityColor(t.priority);
      if (priIndicator.style.color !== color) priIndicator.style.color = color;
      const frag = document.createRange().createContextualFragment(getPriorityIcon(t.priority));
      priIndicator.replaceChildren(frag);
    }

    // Star button
    if (starBtn !== null) {
      starBtn.classList.toggle('active', t.up_next);
      const starTitle = t.up_next ? 'Remove from Up Next' : 'Add to Up Next';
      if (starBtn.getAttribute('title') !== starTitle) starBtn.setAttribute('title', starTitle);
      const starText = t.up_next ? '★' : '☆';
      if (starBtn.textContent !== starText) starBtn.textContent = starText;
    }

    // Column-card title — rebuild children when the title text changes;
    // otherwise just sync the unread/feedback dot. Column cards have
    // no inline title editing so there's no cursor / focus state to
    // preserve through the rebuild.
    if (titleHost !== null && t.title !== lastAppliedTitle) {
      rebuildColumnCardTitleHost(titleHost, t);
      lastAppliedTitle = t.title;
    } else if (titleHost !== null) {
      syncColumnCardUnreadDot(titleHost, t);
    }
  }));

  // .cut-pending — separate signal, separate effect.
  disposers.push(effect(() => {
    const cutIds = cutTicketIdsSignal.value;
    card.classList.toggle('cut-pending', cutIds.has(ticket.id));
  }));

  return () => {
    for (const d of disposers) {
      try { d(); } catch { /* swallow */ }
    }
  };
}

/** Rebuild `.column-card-title` children — sync icon (if any), unread
 *  dot (if any), then the title text. Matches the JSX literal
 *  ordering in `createColumnCard`. */
function rebuildColumnCardTitleHost(host: HTMLElement, ticket: Ticket): void {
  host.replaceChildren();
  if (ticket.id in syncedTicketMap) {
    host.appendChild(toElement(<span className="ticket-sync-icon">{raw(syncedTicketMap[ticket.id].icon ?? '')}</span>));
  }
  const dotType = getIndicatorDotType(ticket);
  if (dotType !== null) {
    host.appendChild(toElement(<span className={`ticket-unread-dot${dotType === 'feedback' ? ' feedback' : ''}`}></span>));
  }
  host.appendChild(document.createTextNode(ticket.title));
}

/** Sync the `.ticket-unread-dot` element inside a column-card title
 *  host without disturbing the surrounding sync-icon / title text. */
function syncColumnCardUnreadDot(host: HTMLElement, ticket: Ticket): void {
  const dotType = getIndicatorDotType(ticket);
  const existing = host.querySelector<HTMLElement>('.ticket-unread-dot');
  if (dotType === null) {
    if (existing !== null) existing.remove();
    return;
  }
  if (existing !== null) {
    existing.classList.toggle('feedback', dotType === 'feedback');
    return;
  }
  const syncIcon = host.querySelector('.ticket-sync-icon');
  const dot = toElement(<span className={`ticket-unread-dot${dotType === 'feedback' ? ' feedback' : ''}`}></span>);
  if (syncIcon !== null && syncIcon.nextSibling !== null) {
    host.insertBefore(dot, syncIcon.nextSibling);
  } else if (host.firstChild !== null) {
    host.insertBefore(dot, host.firstChild);
  } else {
    host.appendChild(dot);
  }
}
