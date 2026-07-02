import { batchTickets, emptyTrash, getSyncedTickets, getTicketSearchCounts, listTickets, queryTickets } from '../api/index.js';
import { raw } from '../jsx-runtime.js';
import { isExactTicketIdSearch } from '../ticketNumber.js';
import { captureSnapshot, flipAnimate } from './animate.js';
import { renderColumnView, renderPreviewColumnView, unmountColumnView, updateColumnSelectionClasses } from './columnView.js';
import { syncDetailPanel, updateStats } from './detail.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { focusDraftInput as _focusDraftInput, syncNewTicketHost } from './draftRow.js';
import { effect } from './reactive.js';
import { bindListVirtualized } from './reactive-bind.js';
import { renderSearchExtraRows } from './searchExtraRows.js';
import type { SyncedTicketInfo,Ticket  } from './state.js';
import { getActiveProject, getProjectViewScrollTop, LIST_PAGE_SIZE, setProjectViewScrollTop, setSyncedTicketMap, state } from './state.js';
import {
  draggedTicketIds as _draggedTicketIds,
registerCallbacks,
setDraftTitle, setSuppressFocusSelect} from './ticketListState.js';
import { cancelPendingSave as _cancelPendingSave, createPreviewRow, createTicketRow, createTrashRow, setupTicketRowEffects } from './ticketRow.js';
import { effectiveView, filteredTickets, ticketsStore } from './ticketsStore.js';

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

/** HS-8374 — the last `(secret, view, preview-mode)` triple we rendered.
 *  Tracked so `renderTicketList` can detect cross-pair transitions and
 *  save the OLD pair's scrollTop + restore the NEW pair's scrollTop
 *  in the same render pass. Empty string before the first render (no
 *  previous pair). */
let lastScrollKey: string = '';

/** HS-8374 — build the cache key for the project / view / preview-mode
 *  triple. Matches the format used by `state.tsx::getProjectViewScrollTop`
 *  / `setProjectViewScrollTop`. Returns null when there's no active
 *  project (boot-time pre-handshake state) — the caller skips the
 *  save/restore dance in that case. */
function computeScrollKey(): { secret: string; view: string; preview: boolean; key: string } | null {
  const project = getActiveProject();
  if (project === null) return null;
  const view = state.view;
  const preview = state.backupPreview?.active === true;
  return {
    secret: project.secret,
    view,
    preview,
    key: `${project.secret}::${view}::${preview ? 'preview' : 'live'}`,
  };
}

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

export function unmountBindList(): void {
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
  // HS-8504 — the bindList's rowsContainer can get detached out from
  // under us when a non-list view (analytics dashboard, telemetry
  // dashboard) wipes `#ticket-list`'s contents via `innerHTML = ''`
  // / `replaceChildren()` without going through `unmountBindList`.
  // When the user returns to a list view, `mountedVariant` is still
  // set + `listViewBindListDispose` is non-null, but the rows
  // container is gone — taking the same-variant early-return path
  // would leave the visible `#ticket-list` empty until a variant
  // switch forces a rebuild. Detecting the detached rows container
  // and falling through to the full remount path fixes the bug
  // without coupling every non-list entry point to the bindList
  // lifecycle.
  // HS-8796 — the "New ticket…" draft row lives in `#new-ticket-host` ABOVE the
  // batch toolbar (not inside `#ticket-list`). Show it only for the default list
  // variant; clear it for trash/preview. Driven on every mount path.
  syncNewTicketHost(variant === 'default');

  const liveRows = container.querySelector<HTMLElement>(':scope > .ticket-list-rows');
  // Same variant + already mounted — the rows container + (host-managed) draft
  // row are already in place, so nothing structural to do.
  if (mountedVariant === variant && listViewBindListDispose !== null && liveRows !== null) {
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
  // HS-8796 — the draft row is no longer a child of `#ticket-list`; it lives in
  // `#new-ticket-host` (synced above), so the list starts straight at the rows.
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

  // HS-8371 (Phase 1) + HS-8372 (Phase 2) — virtualize all three list
  // variants. All three (`default`, `trash`, `preview`) share the same
  // `.ticket-row` base class + fixed-height row design, so the same
  // `rowHeight: 32` parameter works for all of them. `bindListVirtualized`
  // short-circuits to plain `bindList` when the ticket count is below
  // the threshold (100), so small-project users see zero overhead — no
  // scroll-listener, no padding side-effects, no derived-signal
  // computation. The variants are still routed through `rowFactoryFor`
  // / `renderRow` separately so the per-row effects (`setupTicketRowEffects`
  // for the default variant only) stay variant-specific; the virtualization
  // wrapper just controls WHEN those factories run.
  listViewBindListDispose = bindListVirtualized(
    rowsContainer,
    filteredTickets,
    (ticket) => ticket.id,
    renderRow,
    // Row height is fixed at 32 px for every `.ticket-row` variant
    // (one-line title + badges). Locked here so a future CSS edit
    // that changes the row height fails the `bindListVirtualized.test.ts`
    // unit assertion loud.
    { rowHeight: 32, buffer: 10, threshold: 100 },
  );

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

  // HS-8337 — Load More button. Always mounted (so `updateLoadMoreButton`
  // can toggle visibility without a re-mount roundtrip), hidden by default.
  // The variant doesn't matter here: pagination is gated server-side by
  // the request shape, and `loadTickets` sets `hasMoreTickets = false` for
  // the preview / custom-view / column-layout / trash / backlog / archive
  // sub-cases that should never show the button. (The trash and preview
  // variants ALSO hide it via `updateLoadMoreButton`'s extra guard, just
  // to be safe in case a future code path forgets to set the flag.)
  const loadMoreBtn = toElement(
    <button className="ticket-list-load-more" style="display:none" type="button">Load More</button>
  );
  loadMoreBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    void loadMoreTickets();
  });
  container.appendChild(loadMoreBtn);

  mountedVariant = variant;
  // Update visibility immediately on (re)mount in case `hasMoreTickets`
  // was set by a fetch that completed before the new variant's container
  // was in the DOM.
  updateLoadMoreButton();
}

/** HS-8337 — bumps `state.listLimit` by the page size and re-fetches.
 *  Lives on the same async fetch path as `loadTickets`, just with a
 *  pre-bump of the limit. The scope key matches the previous fetch's,
 *  so `loadTickets` won't reset the limit. */
async function loadMoreTickets(): Promise<void> {
  state.listLimit += LIST_PAGE_SIZE;
  await loadTickets();
}

/** HS-8337 — apply `state.hasMoreTickets` to the Load More button's
 *  visibility. Called from every `loadTickets` exit path. Safe to call
 *  before the button exists (no-ops). */
function updateLoadMoreButton(): void {
  const container = byIdOrNull('ticket-list');
  if (container === null) return;
  const btn = container.querySelector<HTMLElement>(':scope > .ticket-list-load-more');
  if (btn === null) return;
  // Only the `default` variant shows the button — trash + preview load
  // their full result sets and Load More wouldn't make sense.
  const showable = state.hasMoreTickets && mountedVariant === 'default' && state.layout === 'list';
  btn.style.display = showable ? '' : 'none';
}

/**
 * HS-8552 — snapshot of the in-progress draft / title-edit state that
 * `renderTicketList` captures BEFORE any DOM teardown (HS-2148) so the
 * post-render path can re-focus the right input + restore its cursor.
 * `editingValue` is the input's `.value` at capture time — needed
 * because the bindList rebuild can race with a `state.tickets` update
 * that overwrites the title with the server's older value.
 */
interface EditFocusSnapshot {
  focusedId: number | 'draft' | null;
  editingValue: string | null;
  editingSelStart: number | null;
  editingSelEnd: number | null;
  /** Draft-row cursor positions captured separately because the column-
   *  view branch needs them too but doesn't capture the full
   *  `editingValue` (the title-input restore logic only runs in the
   *  list-view branch). */
  draftSelStart: number | null;
  draftSelEnd: number | null;
}

/**
 * HS-8552 — extracted from `renderTicketList`. Capture which input is
 * focused + the in-progress edit value + the cursor position so we can
 * restore them after the bindList / column-view rebuild. Returns a
 * snapshot with all fields nulled out when the user isn't editing
 * anything (the common case).
 */
function captureEditFocusSnapshot(isPreview: boolean): EditFocusSnapshot {
  const snapshot: EditFocusSnapshot = {
    focusedId: isPreview ? null : getFocusedTicketId(),
    editingValue: null,
    editingSelStart: null,
    editingSelEnd: null,
    draftSelStart: null,
    draftSelEnd: null,
  };
  if (snapshot.focusedId === 'draft') {
    const input = document.querySelector<HTMLInputElement>('.draft-row .draft-input');
    if (input) {
      setDraftTitle(input.value);
      snapshot.draftSelStart = input.selectionStart;
      snapshot.draftSelEnd = input.selectionEnd;
    }
  }
  // Preserve in-progress title edits and cursor position (HS-199, HS-1454, HS-2113)
  if (snapshot.focusedId != null) {
    const selector = snapshot.focusedId === 'draft'
      ? '.draft-row .draft-input'
      : `.ticket-row[data-id="${String(snapshot.focusedId)}"] .ticket-title-input`;
    const input = document.querySelector<HTMLInputElement>(selector);
    if (input) {
      snapshot.editingValue = input.value;
      snapshot.editingSelStart = input.selectionStart;
      snapshot.editingSelEnd = input.selectionEnd;
      // Keep draftTitle in sync so the recreated draft row has the latest value
      if (snapshot.focusedId === 'draft') setDraftTitle(input.value);
    }
  }
  return snapshot;
}

/**
 * HS-8552 — extracted from `renderTicketList`'s list-view branch. After
 * the bindList rebuild, restore the focused input's `.value` (if it
 * was overwritten mid-render by a `state.tickets` update with a stale
 * server value) + re-focus it + restore the cursor position.
 */
function restoreEditFocus(snapshot: EditFocusSnapshot): void {
  if (snapshot.focusedId != null && snapshot.editingValue != null) {
    const selector = snapshot.focusedId === 'draft'
      ? '.draft-row .draft-input'
      : `.ticket-row[data-id="${String(snapshot.focusedId)}"] .ticket-title-input`;
    const input = document.querySelector<HTMLInputElement>(selector);
    if (input && input.value !== snapshot.editingValue) {
      input.value = snapshot.editingValue;
    }
    restoreFocus(snapshot.focusedId);
    // Restore cursor position after focus is set.
    if (input && snapshot.editingSelStart != null) {
      input.selectionStart = snapshot.editingSelStart;
      input.selectionEnd = snapshot.editingSelEnd;
    }
  } else {
    restoreFocus(snapshot.focusedId);
  }
}

/**
 * HS-8552 — extracted from `renderTicketList`'s column-view branch. The
 * column-view path tears down the list-view bindList (the column-
 * view's own mount manager from HS-8332 is idempotent), dispatches to
 * the preview / live column renderer, then restores draft-row focus
 * (only the draft path; the title-input edits inside individual cards
 * are handled by columnView's own renderer).
 */
function renderColumnVariant(snapshot: ReturnType<typeof captureSnapshot>, isPreview: boolean, editFocus: EditFocusSnapshot): void {
  // Column view path — tear down the list-view bindList if it was
  // mounted from a prior list-view render. The column-view's own
  // mount manager (HS-8332) is idempotent: `renderColumnView` /
  // `renderPreviewColumnView` no-op on same-config re-renders and
  // rebuild on view / preview / hide_verified_column changes.
  unmountBindList();
  if (isPreview) { renderPreviewColumnView(); flipAnimate(snapshot); return; }
  renderColumnView();
  // Restore draft focus after column view rebuild
  if (editFocus.focusedId === 'draft') {
    restoreFocus('draft');
    const input = document.querySelector<HTMLInputElement>('.draft-row .draft-input');
    if (input && editFocus.draftSelStart != null) {
      input.selectionStart = editFocus.draftSelStart;
      input.selectionEnd = editFocus.draftSelEnd;
    }
  }
  flipAnimate(snapshot);
}

/**
 * HS-8552 — extracted from `renderTicketList`'s scroll-management
 * block. Detects cross-`(project, view, preview-mode)` transitions
 * (HS-8374) and persists / restores the scrollTop per-pair. Same-pair
 * re-renders fall through with the current in-call scrollTop (the
 * pre-HS-8374 in-call save+restore semantics). The save fires BEFORE
 * `ensureBindListMount` because the post-mount `scrollHeight` for the
 * NEW pair may differ (different ticket count under virtualization)
 * and we want the OLD pair's captured scrollTop unmodified.
 */
function resolveScrollTopForRender(container: HTMLElement): number {
  const keyInfo = computeScrollKey();
  const inCallScrollTop = container.scrollTop;
  if (keyInfo === null || keyInfo.key === lastScrollKey) return inCallScrollTop;
  if (lastScrollKey !== '') {
    // Save the OLD pair's scrollTop. We can't reverse-parse the key
    // back to secret/view because the OLD project might have been
    // removed; instead the lastScrollKey already holds the full
    // composite, so a direct Map.set bypasses the helper. Keep public
    // state.tsx setter signature focused on setting-from-current-pair;
    // this is the previous-pair store.
    const parts = lastScrollKey.split('::');
    if (parts.length === 3) {
      const [prevSecret, prevView, prevMode] = parts;
      setProjectViewScrollTop(prevSecret, prevView, prevMode === 'preview', inCallScrollTop);
    }
  }
  // Restore the NEW pair's scrollTop (or 0 — natural top-of-list
  // default for a project/view the user hasn't scrolled before).
  const restoreScrollTop = getProjectViewScrollTop(keyInfo.secret, keyInfo.view, keyInfo.preview);
  lastScrollKey = keyInfo.key;
  return restoreScrollTop;
}

export function renderTicketList() {
  // HS-8641 — no-op when the list container isn't mounted. While the terminal
  // dashboard / cross-project view is active (or mid-project-switch, before
  // `restoreTicketList` rebuilds it), `#ticket-list` doesn't exist, yet
  // `closeDetail()` synchronously dispatches `hotsheet:render` (e.g. during
  // `switchProject`), whose listener calls this. Both the column path
  // (`renderColumnView`) and the list path below call `byId('ticket-list')`,
  // which throws on a missing element ("byId: no element with id ticket-list").
  // Rendering a list with no container is meaningless — dashboard exit
  // (`restoreTicketList`) recreates the element and re-renders.
  if (byIdOrNull('ticket-list') === null) return;
  const snapshot = captureSnapshot();
  const isPreview = state.backupPreview?.active === true;
  const editFocus = captureEditFocusSnapshot(isPreview);

  if (state.layout === 'columns' && canUseColumnView()) {
    renderColumnVariant(snapshot, isPreview, editFocus);
    return;
  }

  const container = byId('ticket-list');
  const restoreScrollTop = resolveScrollTopForRender(container);

  // HS-8331 (default) / HS-8333 (trash + preview) / HS-8334 (signal
  // switched to `filteredTickets`) — all three list-view variants are
  // bindList-driven against the narrowed `filteredTickets`. The mount
  // manager tears down + remounts on variant transitions so each
  // variant gets its correct row factory + empty-state message.
  // HS-8332 (2026-05-11) — also tear down any column-view bindLists
  // left over from a prior column-view render. Symmetric with the
  // column branch's `unmountBindList()` in `renderColumnVariant`.
  unmountColumnView();
  ensureBindListMount(container, computeTargetVariant());

  // HS-8374 — clamp the restored scrollTop to the new scrollHeight in
  // case the saved value exceeds the new project's list height (fewer
  // tickets means smaller scrollHeight). Browsers clamp scrollTop
  // assignments automatically but doing it explicitly here keeps the
  // bindListVirtualized window-math from briefly computing a window
  // past the end of the list during the first reconcile pass.
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(restoreScrollTop, maxScrollTop);

  if (isPreview) {
    // Hide batch toolbar in preview mode
    const toolbar = byIdOrNull('batch-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    updateSelectionClasses();
    syncDetailPanel();
  } else {
    // Toolbar visibility is restored by `updateBatchToolbar()` below (the
    // HS-8623 chokepoint), so no explicit `display:''` is needed here.
    restoreEditFocus(editFocus);
    // Symmetric with the preview branch above. Pre-HS-8331 the
    // non-preview path re-created rows on every render so `.selected`
    // came back through the JSX literal's `isSelected ? ' selected' : ''`
    // ternary. Post-HS-8331 the bindList preserves DOM identity by
    // ticket id, so a row created while it was unselected keeps its
    // pre-existing class set when selection changes. The shift- and
    // cmd-click paths in `ticketRow.tsx::handleRowClick` route through
    // `callRenderTicketList()` to apply the selection change — without
    // this call the bulk toolbar correctly read "N selected" but only
    // the row painted at row-creation time wore `.selected`.
    updateSelectionClasses();
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
  // HS-8623 — restore the selection toolbar's visibility here, as the single
  // chokepoint every LIVE view funnels through on a selection change (list
  // non-preview branch + both `renderColumnView` paths + every row/column
  // click handler). Preview mode (`renderPreviewColumnView` / the preview
  // branch of `renderTicketList`) and dashboard mode set the toolbar to
  // `display:none` and never call this function, so they stay hidden.
  // Pre-fix, `renderColumnView` (unlike `renderTicketList`) never restored
  // `display:''`, so exiting backup preview or the dashboard while in column
  // view — or any path that left the toolbar hidden — kept the selection
  // toolbar missing in column view. Centralizing it here fixes every such
  // path at once.
  const toolbar = byIdOrNull('batch-toolbar');
  if (toolbar) toolbar.style.display = '';

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
        await batchTickets({ ids: Array.from(state.selectedIds), action: 'restore' });
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
        await emptyTrash();
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

/** HS-8337 — fingerprint of the filter scope. `loadTickets` resets
 *  `state.listLimit` to the page size whenever this changes between
 *  calls, so a sidebar/search/sort/layout change drops the user back to
 *  the first page (the Load More button only ever grows the current
 *  scope's window). The `loadMoreTickets` entry point below skips the
 *  reset by bumping `state.listLimit` first — the scope key is unchanged,
 *  so loadTickets keeps the grown window. */
function buildScopeKey(): string {
  return [
    state.view, state.search, state.sortBy, state.sortDir, state.layout,
    state.includeBacklogInSearch ? '1' : '0',
    state.includeArchiveInSearch ? '1' : '0',
  ].join('|');
}
let lastScopeKey: string | null = null;

/** HS-8520 / HS-8660 — convert the server's synced-tickets wire map into the
 *  client `syncedTicketMap` shape, converting each plugin-manifest SVG string
 *  to `SafeHtml` once (so list / column consumers render via `{info.icon}`
 *  rather than `raw(info.icon)` per row). Exported for unit coverage of the
 *  icon-mapping shape. */
export function buildSyncedIconMap(wire: Awaited<ReturnType<typeof getSyncedTickets>>): Record<number, SyncedTicketInfo> {
  const mapped: Record<number, SyncedTicketInfo> = {};
  for (const [idStr, info] of Object.entries(wire)) {
    const id = Number(idStr);
    mapped[id] = info.icon != null && info.icon !== ''
      ? {
          pluginId: info.pluginId,
          // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- plugin-supplied SVG string from a registered plugin's manifest (trusted plugin data).
          icon: raw(info.icon),
        }
      : { pluginId: info.pluginId };
  }
  return mapped;
}

/**
 * HS-8681 — build the URL-search-params for the standard /tickets fetch. Pure
 * (no I/O). Captures the §40 search-include flags, the HS-8334 coarse-scope
 * mapping, and the HS-8337 list-layout pagination shape into one place. The
 * standard views (`all` / `up-next` / `open` / `completed` / `non-verified` /
 * `verified` / `category:*` / `priority:*`) all collapse to the active coarse
 * scope; per-view narrowing happens client-side in `filteredTickets`. HS-8618 —
 * a search collapses every standard view to 'all' via `effectiveView`, so
 * backlog/archive matches surface as §40 include-rows rather than being
 * confined to that bucket.
 */
function buildTicketsQuery(isListLayout: boolean): string {
  const params = new URLSearchParams();
  const scopeView = effectiveView(state.view, state.search);
  if (scopeView === 'trash') params.set('status', 'deleted');
  else if (scopeView === 'backlog') params.set('status', 'backlog');
  else if (scopeView === 'archive') params.set('status', 'archive');
  else params.set('status', 'active');

  if (state.search) params.set('search', state.search);
  // HS-7756 — opt-in extra-bucket inclusion when the user has clicked the
  // "Include {N} ..." rows. Server-side OR's these into the WHERE clause.
  if (state.includeBacklogInSearch) params.set('include_backlog', 'true');
  if (state.includeArchiveInSearch) params.set('include_archive', 'true');

  params.set('sort_by', state.sortBy);
  params.set('sort_dir', state.sortDir);

  // HS-8337 — list layout requests `listLimit + 1` rows so we can detect
  // whether more rows exist without a second roundtrip (the extra row is
  // trimmed before installing). Column view groups by status and would orphan
  // a column under a partial fetch, so it fetches the full set.
  if (isListLayout) params.set('limit', String(state.listLimit + 1));

  return params.toString();
}

/**
 * HS-8681 — custom-view fetch branch. HS-8337: custom views still fetch
 * everything (the query endpoint doesn't paginate), so the Load More button
 * stays hidden regardless of layout.
 */
async function loadCustomViewTickets(viewId: string): Promise<void> {
  const view = state.customViews.find(v => v.id === viewId);
  if (view) {
    const viewTag = view.tag;
    setTicketsAnimated(await queryTickets({
      logic: view.logic,
      conditions: view.conditions,
      sort_by: state.sortBy,
      sort_dir: state.sortDir === 'desc' ? 'desc' : 'asc',
      ...(viewTag !== undefined && viewTag !== '' ? { required_tag: viewTag } : {}),
      ...(view.includeArchived === true ? { include_archived: true } : {}),
    }));
  } else {
    setTicketsAnimated([]);
  }
  state.hasMoreTickets = false;
  updateLoadMoreButton();
  renderTicketList();
}

/**
 * HS-8681 / HS-7756 — refresh the per-bucket search-include counts after the
 * main render. The user sees their tickets immediately and the
 * `Include {N} …` rows pop in a moment later if applicable; an empty search
 * clears the counts inline so the rows disappear synchronously.
 */
function refreshSearchExtraCounts(): void {
  if (state.search === '') {
    state.searchExtraCounts = { backlog: 0, archive: 0 };
    renderSearchExtraRows(() => { void loadTickets(); });
    return;
  }
  void getTicketSearchCounts(state.search)
    .then(counts => {
      state.searchExtraCounts = counts;
      renderSearchExtraRows(() => { void loadTickets(); });
    })
    .catch(() => { /* non-critical */ });
}

export async function loadTickets() {
  // Preview mode: filter backup tickets locally instead of querying the API.
  if (state.backupPreview?.active === true) {
    state.hasMoreTickets = false;
    updateLoadMoreButton();
    loadPreviewTickets();
    return;
  }

  // HS-8337 — reset the list-mode pagination window whenever the filter scope
  // changes between calls (view / search / sort / layout). The Load More entry
  // point bumps `listLimit` BEFORE calling `loadTickets` with the same scope
  // key, so it doesn't get clobbered here.
  const scopeKey = buildScopeKey();
  if (lastScopeKey !== scopeKey) {
    state.listLimit = LIST_PAGE_SIZE;
    lastScopeKey = scopeKey;
  }

  // Custom views use the dedicated query endpoint — early return.
  if (state.view.startsWith('custom:')) {
    await loadCustomViewTickets(state.view.slice(7));
    return;
  }

  // HS-7756 — clear search-include flags + restore the pre-include view mode
  // whenever the search becomes empty (× button, programmatic reset, project
  // switch). Handled once here rather than at every clear path.
  if (state.search === '') {
    const { clearSearchIncludeState } = await import('./searchExtraRows.js');
    clearSearchIncludeState();
  }

  // HS-8660 — fetch the sync-icon map IN PARALLEL with the ticket list and
  // install it BEFORE `setTicketsAnimated`, so the plugin icon is baked into
  // each row on its first render. (bindList preserves rows by ticket id, so a
  // map installed AFTER setTicketsAnimated never reaches freshly-created rows.)
  const syncMapPromise = getSyncedTickets()
    .then(buildSyncedIconMap)
    .catch(() => null);

  // Captured into a local so an in-flight layout toggle doesn't cause the
  // post-await trim path to disagree with the request shape.
  const isListLayout = state.layout === 'list';
  const rows = await listTickets(buildTicketsQuery(isListLayout));
  if (isListLayout && rows.length > state.listLimit) {
    state.hasMoreTickets = true;
    rows.length = state.listLimit;
  } else {
    state.hasMoreTickets = false;
  }
  updateLoadMoreButton();

  const syncMap = await syncMapPromise;
  if (syncMap !== null) setSyncedTicketMap(syncMap);
  setTicketsAnimated(rows);
  renderTicketList();

  refreshSearchExtraCounts();
}

/**
 * HS-9241 — after an exact ticket-id search, scroll the exact-match ticket into
 * view (`block: 'nearest'`, so it's a no-op when already on screen). The exact
 * match is `filteredTickets`'s first entry (force-included at the front); it may
 * sit far down — e.g. in the "Not Started" column (column view absorbs its
 * archive/backlog status into the first column) or mixed into a long list.
 * Called by the search-input handler after the debounced reload renders; a rAF
 * lets the reactive list/column bindList paint the row first. Non-exact searches
 * (and no-match ids) no-op.
 */
export function scrollSearchMatchIntoView(): void {
  if (!isExactTicketIdSearch(state.search)) return;
  const target = state.search.trim().toLowerCase();
  const match = filteredTickets.value.find(t => t.ticket_number.toLowerCase() === target);
  if (match === undefined) return;
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      `.ticket-row[data-id="${String(match.id)}"], .column-card[data-id="${String(match.id)}"]`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
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

/** HS-8574 — test-only escape hatch exposing pure-logic helpers that
 *  would otherwise be module-private. Not exported to production
 *  callers — these don't appear in any non-test import. */
export const _testing = {
  computeTargetVariant,
  computeScrollKey,
  buildScopeKey,
  rowFactoryFor,
  getMountedVariant(): BindListVariant | null { return mountedVariant; },
  resetScopeKeyForTests(): void { lastScopeKey = null; },
  resetScrollKeyForTests(): void { lastScrollKey = ''; },
};
