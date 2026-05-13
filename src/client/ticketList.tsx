import { captureSnapshot, flipAnimate } from './animate.js';
import { api } from './api.js';
import { renderColumnView, renderPreviewColumnView, unmountColumnView, updateColumnSelectionClasses } from './columnView.js';
import { syncDetailPanel, updateStats } from './detail.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { createDraftRow, focusDraftInput as _focusDraftInput } from './draftRow.js';
import { effect } from './reactive.js';
import { bindList, bindListVirtualized } from './reactive-bind.js';
import { renderSearchExtraRows } from './searchExtraRows.js';
import type { SyncedTicketInfo,Ticket  } from './state.js';
import { setSyncedTicketMap, state } from './state.js';
import {
  draggedTicketIds as _draggedTicketIds,
registerCallbacks,
setDraftTitle, setSuppressFocusSelect} from './ticketListState.js';
import { cancelPendingSave as _cancelPendingSave, createPreviewRow, createTicketRow, createTrashRow, setupTicketRowEffects } from './ticketRow.js';
import { filteredTickets, ticketsStore } from './ticketsStore.js';

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
 * HS-8331 / §61 Phase 2 default-list-view bindList rewrite +
 * HS-8333 (2026-05-11) trash + backup-preview bindList rewrite +
 * HS-8334 (2026-05-11) consumer-side switch from `ticketsSignal` to
 * `filteredTickets` (the per-view narrowed signal — now the single
 * source of filter truth). The `<div class="ticket-list-rows">`
 * sub-container inside `#ticket-list` is owned by a persistent
 * bindList against `filteredTickets`. Surviving row ids preserve DOM
 * identity across re-renders, which makes the focus / cursor /
 * editing-value preservation dance below nearly trivial — the input
 * element survives unchanged.
 *
 * The bindList is mounted exactly once per (variant, lifecycle) pair
 * where variant is one of 'default' / 'trash' / 'preview'. The mounted
 * variant is tracked in `mountedVariant`; when `renderTicketList`
 * computes a new variant that doesn't match, `ensureBindListMount`
 * tears down the existing bindList + its empty-state effect and
 * remounts with the appropriate row-factory (`createTicketRow` /
 * `createTrashRow` / `createPreviewRow`). Transitions to column view
 * dispose the bindList via `unmountBindList`, and the next
 * `ensureBindListMount` call re-creates everything.
 *
 * Why variant-at-mount-time instead of dispatching inside the row
 * factory: per-row dispatch would not recreate surviving rows when
 * the view changes (the bindList preserves DOM identity by key). For
 * default ↔ trash transitions the ticket-id sets don't overlap, so
 * dispatch would happen to work, but for default ↔ preview the
 * preview snapshot may include the same ids as the live state; a
 * surviving row would render with the wrong variant. Tearing down on
 * variant transition avoids the class entirely.
 *
 * Trash + preview ticket data lives in the same store —
 * `loadPreviewTickets` writes the full backup snapshot through
 * `ticketsStore.actions.setTickets(...)` exactly like `loadTickets`
 * does for the live view; `filteredTickets`'s `applyViewFilter`
 * branches on `filter.view` to render either the live trash subset or
 * the preview snapshot's deleted subset depending on `state.view`.
 *
 * Column view (HS-8332 sub #2) is still deferred — it has its own
 * status-grouped rebuild loop in `columnView.tsx`. Transitions to /
 * from column view call `unmountBindList` so the list-view bindList
 * doesn't leak.
 *
 * HS-8336 (2026-05-11) — FLIP animation restored via
 * `setTicketsAnimated` wrapper below. The wrapper captures the
 * snapshot BEFORE the setTickets write (so the bindList reconcile
 * sits BETWEEN snapshot and flipAnimate), which is the correct
 * sequencing for the synchronous-reconcile path.
 */
type BindListVariant = 'default' | 'trash' | 'preview';
let listViewBindListDispose: (() => void) | null = null;
let listViewEmptyEffectDispose: (() => void) | null = null;
let mountedVariant: BindListVariant | null = null;

/**
 * HS-8336 — wrapper around `ticketsStore.actions.setTickets(...)` that
 * captures a FLIP snapshot before the store write and animates rows
 * to their new positions after the synchronous bindList reconcile.
 *
 * The bindList reconciles synchronously inside `setTickets` (the kerf
 * signal fires + bindList runs + DOM reorders all on the same call
 * stack), so by the time control returns from `setTickets` the DOM is
 * already in its new layout. Capturing the snapshot BEFORE the call +
 * running `flipAnimate` AFTER gives FLIP its pre/post pair.
 *
 * HS-8333 (2026-05-11) — also handles variant transitions. By the
 * time `loadTickets` / `loadPreviewTickets` calls this, `state.view`
 * /  `state.backupPreview` already reflects the target variant. If
 * that target differs from `mountedVariant`, the existing bindList is
 * using the wrong row factory — reconciling new data through it
 * would create rows with the wrong variant (wasted DOM allocation,
 * wrong click handlers, wrong shape). Preemptive `unmountBindList`
 * disposes the bindList's listener before the store write so the
 * reconcile doesn't happen at all; `renderTicketList`'s subsequent
 * `ensureBindListMount(targetVariant)` does the wipe + remount with
 * the correct factory.
 *
 * The intermediate-DOM (between `setTickets` and `renderTicketList`)
 * never paints — it's all on the same synchronous call stack — so
 * this is a perf optimization, not a correctness fix. But the
 * unmount is also cheap: it's a no-op when the variant doesn't
 * change (the dominant case).
 *
 * For the column branch this wrapper is a slight pessimisation (an
 * extra snapshot capture) but not a correctness problem — that branch
 * doesn't use bindList; the variant check returns 'default' / 'trash'
 * / 'preview' but the column path has already torn down the bindList
 * via `unmountBindList` at the top of `renderTicketList`, so
 * `mountedVariant` is null and the preemptive unmount short-circuits.
 */
export function setTicketsAnimated(tickets: readonly Ticket[]): void {
  const snapshot = captureSnapshot();
  if (mountedVariant !== null && mountedVariant !== computeTargetVariant()) {
    unmountBindList();
  }
  ticketsStore.actions.setTickets(tickets);
  flipAnimate(snapshot);
}

function computeTargetVariant(): BindListVariant {
  if (state.backupPreview?.active === true) return 'preview';
  if (state.view === 'trash') return 'trash';
  return 'default';
}

function unmountBindList(): void {
  if (listViewBindListDispose !== null) {
    try { listViewBindListDispose(); } catch { /* swallow */ }
    listViewBindListDispose = null;
  }
  if (listViewEmptyEffectDispose !== null) {
    try { listViewEmptyEffectDispose(); } catch { /* swallow */ }
    listViewEmptyEffectDispose = null;
  }
  mountedVariant = null;
}

function rowFactoryFor(variant: BindListVariant): (ticket: Ticket) => HTMLElement {
  if (variant === 'trash') return createTrashRow;
  if (variant === 'preview') return createPreviewRow;
  return createTicketRow;
}

function ensureBindListMount(container: HTMLElement, variant: BindListVariant): void {
  // Same variant + already mounted — only ensure the variant-specific
  // structural elements are in place (default needs a draft row at the
  // top; trash + preview have no extra structure).
  if (mountedVariant === variant && listViewBindListDispose !== null) {
    if (variant === 'default' && container.querySelector(':scope > .draft-row') === null) {
      const rows = container.querySelector<HTMLElement>(':scope > .ticket-list-rows');
      if (rows !== null) container.insertBefore(createDraftRow(), rows);
    }
    return;
  }

  // Variant transition or first mount — wipe + relay out + remount.
  // HS-8365 — `replaceChildren()` (no args) is the ESLint-compliant
  // equivalent of `innerHTML = ''`. `morph()` isn't a good fit here:
  // the variant transition is structurally different (default has a
  // draft row + rows container + empty-state; trash + preview don't),
  // and the rows container is then handed to `bindList` which owns its
  // children — morphing across that ownership boundary requires the
  // `ownedItems` escape hatch + a refactor of the mount sequence. The
  // variant transition is also rare (user clicks a sidebar item, which
  // moves focus away from this container), so focus / selection
  // preservation isn't user-visible here.
  unmountBindList();
  container.replaceChildren();
  container.classList.remove('ticket-list-columns');
  if (variant === 'default') {
    container.appendChild(createDraftRow());
  }
  const rowsContainer = toElement(<div className="ticket-list-rows"></div>);
  container.appendChild(rowsContainer);

  // Empty-state element kept always-mounted; an effect toggles its
  // visibility based on `filteredTickets.value.length` (the narrowed
  // signal — HS-8334). Default variant doesn't show one (matches the
  // pre-HS-8333 behavior where the default list just had empty rows);
  // trash + preview each get their own message.
  const emptyEl = toElement(<div className="ticket-list-empty"></div>);
  emptyEl.style.display = 'none';
  container.appendChild(emptyEl);

  // HS-8335 — only the `default` variant installs per-row reactive
  // effects (category badge, priority indicator, status icon, star
  // button, .completed / .up-next / .cut-pending classes, title input
  // with edit-guard, unread/feedback dot). Trash + preview rows are
  // either read-only (preview) or interaction-minimal (trash) — the
  // mutations that would dirty them are rare enough that the cost of
  // installing the effect closures isn't justified.
  const factory = rowFactoryFor(variant);
  const renderRow = variant === 'default'
    ? (ticket: Ticket): { el: Element; dispose?: () => void } => {
        const el = factory(ticket);
        return { el, dispose: setupTicketRowEffects(el, ticket) };
      }
    : (ticket: Ticket): { el: Element } => ({ el: factory(ticket) });

  // HS-8371 — virtualize the default variant. The other two variants
  // (trash, preview) keep plain `bindList` for now; they'll move to
  // virtualization under HS-8372 (Phase 2) once Phase 1's behavior is
  // observed in real use. `bindListVirtualized` short-circuits to plain
  // `bindList` when the ticket count is below the threshold (100), so
  // small-project users see zero overhead — no scroll-listener, no
  // padding side-effects, no derived-signal computation.
  if (variant === 'default') {
    listViewBindListDispose = bindListVirtualized(
      rowsContainer,
      filteredTickets,
      (ticket) => ticket.id,
      renderRow,
      // Row height is fixed at 32 px for the default-list-variant
      // shape (one-line title input + badges). Locked here so a future
      // CSS edit that changes the row height fails the
      // `bindListVirtualized.test.ts` unit assertion loud.
      { rowHeight: 32, buffer: 10, threshold: 100 },
    );
  } else {
    listViewBindListDispose = bindList(
      rowsContainer,
      filteredTickets,
      (ticket) => ticket.id,
      renderRow,
    );
  }

  if (variant !== 'default') {
    const message = variant === 'trash' ? 'Trash is empty' : 'No tickets match this view';
    listViewEmptyEffectDispose = effect(() => {
      const count = filteredTickets.value.length;
      if (count === 0) {
        emptyEl.textContent = message;
        emptyEl.style.display = '';
      } else {
        emptyEl.style.display = 'none';
      }
    });
  }

  mountedVariant = variant;
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
    // mounted from a prior list-view render. The column-view's own
    // mount manager (HS-8332) is idempotent: `renderColumnView` /
    // `renderPreviewColumnView` no-op on same-config re-renders and
    // rebuild on view / preview / hide_verified_column changes.
    unmountBindList();
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

  // HS-8331 (default) / HS-8333 (trash + preview) / HS-8334 (signal
  // switched to `filteredTickets`) — all three list-view variants are
  // bindList-driven against the narrowed `filteredTickets`. The mount
  // manager tears down + remounts on variant transitions so each
  // variant gets its correct row factory + empty-state message.
  // HS-8332 (2026-05-11) — also tear down any column-view bindLists
  // left over from a prior column-view render. Symmetric with the
  // column branch's `unmountBindList()` above.
  unmountColumnView();
  ensureBindListMount(container, computeTargetVariant());

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
      setTicketsAnimated(await api<Ticket[]>('/tickets/query', {
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
      setTicketsAnimated([]);
    }
    renderTicketList();
    return;
  }

  // HS-8334 (2026-05-11) — server fetch is for the COARSE SCOPE only.
  // The per-view narrowing (`up-next` / `open` / `completed` / etc.)
  // and the `category:*` / `priority:*` filters now happen client-side
  // in `filteredTickets`. Three coarse scopes:
  //   - active scope (default for everything in the active-set views)
  //   - trash, backlog, archive (separate scopes, not in active set)
  // Custom views took the early-return branch above and aren't here.
  const params = new URLSearchParams();
  if (state.view === 'trash') {
    params.set('status', 'deleted');
  } else if (state.view === 'backlog') {
    params.set('status', 'backlog');
  } else if (state.view === 'archive') {
    params.set('status', 'archive');
  } else {
    // 'all' / 'up-next' / 'open' / 'completed' / 'non-verified' /
    // 'verified' / 'category:*' / 'priority:*' — all active scope.
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
  setTicketsAnimated(await api<Ticket[]>(`/tickets${query ? '?' + query : ''}`));
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

/**
 * HS-8334 (2026-05-11) — preview path simplified. Pre-fix this
 * function duplicated the entire view-filter switch + search-filter
 * pass from `loadTickets`'s URL-construction site (against the
 * `state.backupPreview.tickets` snapshot instead of the server). Post-
 * fix it just writes the full backup snapshot through `setTicketsAnimated`;
 * `filteredTickets` (the canonical view-narrowing computed) does the
 * view + include + search filtering identically for live + preview
 * data. The `loadPreviewTickets`'s pre-fix client-side filter pass is
 * the single largest dedup HS-8334 ships.
 */
function loadPreviewTickets() {
  setTicketsAnimated([...(state.backupPreview?.tickets ?? [])]);
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
