import type { SafeHtml } from '../jsx-runtime.js';
import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { cutTicketIdsSignal, getCutTicketIds } from './clipboard.js';
import { showTicketContextMenu } from './contextMenu.js';
import { parseTags, syncDetailPanel } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { parseJsonArrayOr } from './json.js';
import { effect } from './reactive.js';
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
import { getTicketSignals, ticketsStore } from './ticketsStore.js';
import { recordTextChange, trackedDelete, trackedPatch, trackedRestore } from './undo/actions.js';

/**
 * HS-8335 — replace an element's children with the DOM parsed from
 * an SVG-or-HTML string, without using `innerHTML =` directly (which
 * the ESLint `no-restricted-syntax` rule from HS-8243 / §62.6 flags
 * for production client files). `createContextualFragment` parses in
 * the document's context, which preserves the SVG xmlns from the
 * source string.
 */
function replaceWithSvg(el: Element, content: string | SafeHtml): void {
  if (typeof content === 'string') {
    el.textContent = content;
  } else {
    el.replaceChildren(toElement(content));
  }
}

/**
 * HS-8335 (2026-05-11) — per-row reactive effects for `createTicketRow`.
 * Subscribes to the per-ticket signal exposed by `ticketsStore.ts`
 * (the kerf signal that fires when a ticket's status / category /
 * priority / up_next / title / tags / last_read_at / notes /
 * updated_at change) and the `cutTicketIdsSignal` from `clipboard.ts`,
 * then mutates the row's DOM slots in place. The returned disposer is
 * called when the row is removed from the list (via `bindList`'s
 * per-row dispose hook) so the effects don't leak after row teardown.
 *
 * Skipped — `.selected` class: still updated imperatively via
 * `updateSelectionClasses()` (selection is not part of the per-ticket
 * signal). Sync icon (`syncedTicketMap`): rarely changes mid-render
 * and isn't part of the per-ticket signal; pre-existing
 * `setSyncedTicketMap` triggers `renderTicketList` which is now a
 * near-no-op, so sync-icon staleness is a separate small bug; not in
 * HS-8335's scope.
 */
export function setupTicketRowEffects(row: HTMLElement, ticket: Ticket): () => void {
  const sigs = getTicketSignals(ticket.id);
  if (sigs === undefined) return () => { /* no-op — race with mid-render GC */ };

  const disposers: Array<() => void> = [];
  let firstRun = true;

  // Track the last-applied title so we know what the server-side state
  // was at the last effect fire; if the input.value differs from this
  // AND the user is focused, they're mid-edit and we shouldn't clobber.
  let lastAppliedTitle: string = ticket.title;

  // HS-8307 — cheap dirty-check for tag changes. Tracks the raw JSON
  // string from the store so the parse + DOM rebuild only runs when the
  // string actually changes (parity with `setupColumnCardEffects` from
  // HS-8409 — different surface, same reactive shape).
  let lastAppliedTagsRaw: string = ticket.tags;

  const catBadge = row.querySelector<HTMLElement>('.ticket-category-badge');
  const statusBtn = row.querySelector<HTMLElement>('.ticket-status-btn');
  const titleInput = row.querySelector<HTMLInputElement>('.ticket-title-input');
  const priIndicator = row.querySelector<HTMLElement>('.ticket-priority-indicator');
  const starBtn = row.querySelector<HTMLElement>('.ticket-star');

  // Single combined effect — reads sigs.ticket.value once and updates
  // every dependent DOM slot. Splitting into per-slot effects would
  // give finer per-field re-fire control, but every field already
  // funnels through one signal write, so a single effect fires the
  // same number of times either way. Keeping it consolidated saves
  // ~7× effect-overhead per row update.
  disposers.push(effect(() => {
    const t = sigs.ticket.value;
    if (firstRun) {
      // The initial DOM render in the JSX literal below already
      // reflects the current ticket state — no need to re-write the
      // same values back. Skipping the first run avoids ~9 DOM writes
      // per row at mount time on a list of ~100 tickets.
      firstRun = false;
      lastAppliedTitle = t.title;
      return;
    }

    // .completed class
    const done = t.status === 'completed' || t.status === 'verified';
    row.classList.toggle('completed', done);

    // .up-next class
    row.classList.toggle('up-next', t.up_next);

    // Category badge — color + title attr + textContent
    if (catBadge !== null) {
      const color = getCategoryColor(t.category);
      if (catBadge.style.backgroundColor !== color) catBadge.style.backgroundColor = color;
      if (catBadge.getAttribute('title') !== t.category) catBadge.setAttribute('title', t.category);
      const label = getCategoryLabel(t.category);
      if (catBadge.textContent !== label) catBadge.textContent = label;
    }

    // Status button — verified class + title attr + icon SVG
    if (statusBtn !== null) {
      const isVerified = t.status === 'verified';
      statusBtn.classList.toggle('verified', isVerified);
      const statusTitle = t.status.replace('_', ' ');
      if (statusBtn.getAttribute('title') !== statusTitle) statusBtn.setAttribute('title', statusTitle);
      replaceWithSvg(statusBtn, isVerified ? VERIFIED_SVG : getStatusIcon(t.status));
    }

    // Title input — write only when the user isn't editing the input.
    // Comparing to `lastAppliedTitle` (last server-pushed value) rather
    // than to `titleInput.value` (current input) lets us detect "server
    // changed AND user has not made local changes since the last
    // server-push" — that's when we want to update. If both server and
    // user changed, the user's edit wins until they blur (which fires
    // the debounced save, eventually reconciling).
    if (titleInput !== null) {
      const newTitle = t.title;
      const focused = document.activeElement === titleInput;
      if (newTitle !== lastAppliedTitle && !focused && titleInput.value !== newTitle) {
        titleInput.value = newTitle;
      }
      lastAppliedTitle = newTitle;
    }

    // Priority indicator — color + title attr + icon SVG
    if (priIndicator !== null) {
      const color = getPriorityColor(t.priority);
      if (priIndicator.style.color !== color) priIndicator.style.color = color;
      if (priIndicator.getAttribute('title') !== t.priority) priIndicator.setAttribute('title', t.priority);
      replaceWithSvg(priIndicator, getPriorityIcon(t.priority));
    }

    // Star button — active class + title attr + ★/☆ text
    if (starBtn !== null) {
      starBtn.classList.toggle('active', t.up_next);
      const starTitle = t.up_next ? 'Remove from Up Next' : 'Add to Up Next';
      if (starBtn.getAttribute('title') !== starTitle) starBtn.setAttribute('title', starTitle);
      const starText = t.up_next ? '★' : '☆';
      if (starBtn.textContent !== starText) starBtn.textContent = starText;
    }

    // Unread / feedback dot — toggle DOM element presence + variant class
    syncUnreadDot(row, t);

    // HS-8307 — tag chips. The JSX literal only renders `.ticket-row-tags`
    // when the tag list is non-empty, so the in-place sync mirrors the
    // HS-8409 column-card path: add the container on empty → non-empty,
    // remove it on non-empty → empty, rebuild children in place on
    // non-empty → different non-empty. Dirty-checked against the raw
    // JSON string so a server-poll round-trip whose tags didn't change
    // doesn't thrash the DOM.
    if (t.tags !== lastAppliedTagsRaw) {
      syncTicketRowTags(row, t);
      lastAppliedTagsRaw = t.tags;
    }
  }));

  // Cut-pending class — separate effect because it subscribes to a
  // different signal (`cutTicketIdsSignal` from `clipboard.ts`), not
  // the per-ticket signal. Firing the combined effect on cut-state
  // changes would re-write 8 unrelated DOM slots; isolating this
  // effect keeps the cut-toggle a single class flip.
  disposers.push(effect(() => {
    const cutIds = cutTicketIdsSignal.value;
    row.classList.toggle('cut-pending', cutIds.has(ticket.id));
  }));

  return () => {
    for (const d of disposers) {
      try { d(); } catch { /* swallow — kerf cleanup */ }
    }
  };
}

/** Insert / update / remove the `.ticket-unread-dot` element on a row
 *  based on the ticket's current indicator-dot type. The dot's
 *  presence + variant class are reactive via the parent combined
 *  effect above. */
function syncUnreadDot(row: HTMLElement, ticket: Ticket): void {
  const dotType = getIndicatorDotType(ticket);
  const existing = row.querySelector<HTMLElement>('.ticket-unread-dot');
  if (dotType === null) {
    if (existing !== null) existing.remove();
    return;
  }
  const titleText = dotType === 'feedback' ? 'Feedback needed' : 'Unread changes';
  if (existing !== null) {
    existing.classList.toggle('feedback', dotType === 'feedback');
    if (existing.getAttribute('title') !== titleText) existing.setAttribute('title', titleText);
    return;
  }
  // Insert before the title input (matches the JSX literal ordering).
  const titleInput = row.querySelector('.ticket-title-input');
  const dot = toElement(<span className={`ticket-unread-dot${dotType === 'feedback' ? ' feedback' : ''}`} title={titleText}></span>);
  if (titleInput !== null) row.insertBefore(dot, titleInput);
  else row.appendChild(dot);
}

/** HS-8307 — keep the `.ticket-row-tags` chip container in sync with
 *  the ticket's current tag list. Handles all three transitions: empty
 *  → non-empty (insert the container before the priority indicator —
 *  matches the JSX literal sibling order), non-empty → empty (remove
 *  the container), non-empty → different non-empty (rebuild children
 *  in place so the container element identity is preserved). Mirrors
 *  `syncColumnCardTags` in `columnView.tsx` line-for-line — same
 *  reactive shape, different surface. */
function syncTicketRowTags(row: HTMLElement, ticket: Ticket): void {
  const newTags = parseTags(ticket.tags);
  const existing = row.querySelector<HTMLElement>('.ticket-row-tags');
  if (newTags.length === 0) {
    if (existing !== null) existing.remove();
    return;
  }
  if (existing !== null) {
    existing.replaceChildren(...newTags.map(tag => toElement(<span className="ticket-row-tag">{tag}</span>)));
    return;
  }
  const container = toElement(
    <div className="ticket-row-tags">
      {newTags.map(tag => <span className="ticket-row-tag">{tag}</span>)}
    </div>
  );
  // Insert before the priority indicator to match the JSX-literal order
  // (title-input → tags → priority → star). Falls back to appending when
  // the indicator is somehow absent — defensive only; the indicator is
  // always rendered in `createTicketRow`.
  const priIndicator = row.querySelector<HTMLElement>('.ticket-priority-indicator');
  if (priIndicator !== null) row.insertBefore(container, priIndicator);
  else row.appendChild(container);
}

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
        {isVerified ? VERIFIED_SVG : getStatusIcon(ticket.status)}
      </button>
      {ticket.id in syncedTicketMap ? <span className="ticket-sync-icon" title={`Synced via ${syncedTicketMap[ticket.id].pluginId}`}>{raw(syncedTicketMap[ticket.id].icon ?? '')}</span> : null}
      {getIndicatorDotType(ticket) != null ? <span className={`ticket-unread-dot${getIndicatorDotType(ticket) === 'feedback' ? ' feedback' : ''}`} title={getIndicatorDotType(ticket) === 'feedback' ? 'Feedback needed' : 'Unread changes'}></span> : null}
      <input type="text" className="ticket-title-input" value={ticket.title} spellCheck="true" />
      {parseTags(ticket.tags).length > 0 ? (
        <div className="ticket-row-tags">
          {parseTags(ticket.tags).map(tag => (
            <span className="ticket-row-tag">{tag}</span>
          ))}
        </div>
      ) : null}
      <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)}`} title={ticket.priority}>
        {getPriorityIcon(ticket.priority)}
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
        {isVerified ? VERIFIED_SVG : getStatusIcon(ticket.status)}
      </span>
      <span className="ticket-title-input" style="cursor:default">{ticket.title}</span>
      <span className="ticket-priority-indicator" style={`color:${getPriorityColor(ticket.priority)};cursor:default`} title={ticket.priority}>
        {getPriorityIcon(ticket.priority)}
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
  // HS-8367 — route through the store BEFORE mutating the closure's
  // `ticket` reference. The store's per-ticket signal value (HS-8335)
  // is the SAME object reference as `ticket` here; if we `Object.assign`
  // first, the store's structural-equal check in `applyServerUpdate`
  // (and the later `reconcilePerTicketSignals` walk on `loadTickets`'s
  // `setTickets`) sees `signal.value === updated` and SKIPS firing —
  // so the per-row effect from HS-8335 never re-paints the status icon /
  // title attr / category badge / etc. Pre-fix the row stayed visually
  // pinned to the pre-click state until a different rebuild trigger
  // (variant switch, project switch) tore the row down.
  ticketsStore.actions.applyServerUpdate(updated);
  Object.assign(ticket, updated);
  callRenderTicketList();
}

export async function toggleUpNext(ticket: Ticket) {
  // HS-7998 — adding a backlog / archive ticket to Up Next now also
  // resets its status, just like completed / verified did pre-fix. The
  // status set lives in `shouldResetStatusOnUpNext` so the three
  // toggle-up-next callsites (this row handler, `bindDetailUpNext` in
  // `app.tsx`, and `actions.ts`'s batch path) stay in sync.
  let updated: Ticket;
  if (!ticket.up_next && shouldResetStatusOnUpNext(ticket.status)) {
    updated = await trackedPatch(ticket, { status: 'not_started', up_next: true }, 'Toggle up next');
  } else {
    updated = await trackedPatch(ticket, { up_next: !ticket.up_next }, 'Toggle up next');
  }
  // HS-8367 — fire the per-ticket signal BEFORE mutating the closure's
  // `ticket` reference. Without this `Object.assign` happening AFTER
  // `applyServerUpdate`, the next click on the same star would read the
  // stale `ticket.up_next` from the closure (the prior `await
  // trackedPatch` flipped the server but never updated the closure),
  // toggle to the same value, and the server-side no-op leaves the star
  // class stuck. The `callLoadTickets()` round trip would eventually
  // update `state.tickets[i]` but the closure's `ticket` reference is
  // independent — that's why `cycleStatus` / `setTicketField` / the
  // category + priority menu callbacks all carry the same applyServer-
  // Update-then-Object.assign ordering.
  ticketsStore.actions.applyServerUpdate(updated);
  Object.assign(ticket, updated);
  void callLoadTickets();
  document.dispatchEvent(new CustomEvent('hotsheet:upnext-changed'));
}

async function setTicketField(ticket: Ticket, field: string, value: string) {
  const updated = await trackedPatch(ticket, { [field]: value }, `Change ${field}`);
  // HS-8367 — same applyServerUpdate-before-mutate ordering as
  // `cycleStatus`; see the rationale there.
  ticketsStore.actions.applyServerUpdate(updated);
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
  // HS-8239 — use the typed `removeTicket` action instead of an
  // imperative `state.tickets = state.tickets.filter(...)`. Matches
  // `applyServerUpdate` / `optimisticUpdate` in shape so future
  // single-ticket mutation paths can swap in similarly.
  ticketsStore.actions.removeTicket(id);
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
      // HS-8367 — applyServerUpdate before mutate; see `cycleStatus`.
      ticketsStore.actions.applyServerUpdate(updated);
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
      // HS-8367 — applyServerUpdate before mutate; see `cycleStatus`.
      ticketsStore.actions.applyServerUpdate(updated);
      Object.assign(ticket, updated);
      callRenderTicketList();
    },
  })));
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}
