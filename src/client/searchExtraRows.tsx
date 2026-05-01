/**
 * HS-7756 — render the "Include `{N}` backlog items" / "Include `{N}` archive
 * items" rows under the multi-select toolbar when a search is active and
 * the buckets the active view normally hides have matches.
 *
 * The rows are gray (the same muted-pill styling used elsewhere for
 * "soft" affordances) and span the full ticket-list width. Clicking a
 * row toggles `state.includeBacklogInSearch` / `state.includeArchiveInSearch`
 * and reloads. When either is toggled on, the view auto-switches from
 * column view to list view (column view groups by status and mixing
 * backlog/archive in wouldn't fit) and stashes the previous mode in
 * `state.viewModeBeforeSearchInclude` so it can be restored on clear.
 *
 * State changes:
 * - `state.search` flips to '' → both include flags reset, view restored,
 *   counts cleared. Handled in `loadTickets` (ticketList.tsx).
 * - User clicks an "Include" row → flag flipped, view auto-switched if in
 *   columns, `loadTickets()` called.
 */

import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { ICON_ARCHIVE, ICON_CALENDAR } from './icons.js';
import { state } from './state.js';

/** Re-render the `#search-extra-rows` container based on the current
 *  `state.search` + `state.searchExtraCounts` + per-bucket include flags. */
export function renderSearchExtraRows(reload: () => void): void {
  const container = document.getElementById('search-extra-rows');
  if (container === null) return;
  container.replaceChildren();

  // No search → no rows.
  if (state.search === '') return;

  const counts = state.searchExtraCounts;
  const showBacklog = counts.backlog > 0;
  const showArchive = counts.archive > 0;
  if (!showBacklog && !showArchive) return;

  if (showBacklog) {
    container.appendChild(buildRow({
      icon: ICON_CALENDAR,
      label: backlogLabel(counts.backlog, state.includeBacklogInSearch),
      active: state.includeBacklogInSearch,
      onClick: () => toggleInclude('backlog', reload),
    }));
  }
  if (showArchive) {
    container.appendChild(buildRow({
      icon: ICON_ARCHIVE,
      label: archiveLabel(counts.archive, state.includeArchiveInSearch),
      active: state.includeArchiveInSearch,
      onClick: () => toggleInclude('archive', reload),
    }));
  }
}

function backlogLabel(count: number, active: boolean): string {
  const noun = count === 1 ? 'backlog item' : 'backlog items';
  return active ? `Hide ${count} ${noun}` : `Include ${count} ${noun}`;
}

function archiveLabel(count: number, active: boolean): string {
  const noun = count === 1 ? 'archive item' : 'archive items';
  return active ? `Hide ${count} ${noun}` : `Include ${count} ${noun}`;
}

interface RowOpts {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}

function buildRow(opts: RowOpts): HTMLElement {
  const row = toElement(
    <div className={`search-extra-row${opts.active ? ' is-active' : ''}`} role="button" tabIndex={0}>
      <span className="search-extra-row-icon">{raw(opts.icon)}</span>
      <span className="search-extra-row-label">{opts.label}</span>
    </div>
  );
  row.addEventListener('click', opts.onClick);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      opts.onClick();
    }
  });
  return row;
}

function toggleInclude(bucket: 'backlog' | 'archive', reload: () => void): void {
  // HS-7756 — when toggling the FIRST include on, save the current view
  // mode so we can restore it when the search clears. If column view is
  // active, force list mode since column view groups by status and
  // mixing backlog/archive in wouldn't fit. Subsequent toggles don't
  // re-save (we already remember the pre-include mode).
  const wasOff = !state.includeBacklogInSearch && !state.includeArchiveInSearch;
  if (bucket === 'backlog') state.includeBacklogInSearch = !state.includeBacklogInSearch;
  else state.includeArchiveInSearch = !state.includeArchiveInSearch;
  if (wasOff && state.viewModeBeforeSearchInclude === null) {
    state.viewModeBeforeSearchInclude = state.layout;
    if (state.layout === 'columns') {
      state.layout = 'list';
      void persistLayoutPreference('list');
    }
  }
  reload();
}

/**
 * Reset the HS-7756 include flags + restore the saved view mode. Called
 * by `loadTickets` whenever `state.search` becomes empty so the user
 * doesn't get stuck in list mode with stale "Hide" labels after clearing
 * the query.
 */
export function clearSearchIncludeState(): void {
  let needLayoutRestore = false;
  let restoredLayout: 'list' | 'columns' = 'list';
  if (state.includeBacklogInSearch || state.includeArchiveInSearch) {
    state.includeBacklogInSearch = false;
    state.includeArchiveInSearch = false;
  }
  if (state.viewModeBeforeSearchInclude !== null) {
    restoredLayout = state.viewModeBeforeSearchInclude;
    state.viewModeBeforeSearchInclude = null;
    if (state.layout !== restoredLayout) {
      state.layout = restoredLayout;
      needLayoutRestore = true;
    }
  }
  state.searchExtraCounts = { backlog: 0, archive: 0 };
  if (needLayoutRestore) void persistLayoutPreference(restoredLayout);
}

/**
 * HS-7756 — when the user clicks the column-view layout button while
 * include rows are toggled on, treat that as "restart the search":
 * clear the include flags so column view can render the active-only
 * result set. The search itself stays active and the include rows
 * remain visible (the user can re-toggle them).
 */
export function clearIncludeFlagsOnly(): void {
  if (!state.includeBacklogInSearch && !state.includeArchiveInSearch) return;
  state.includeBacklogInSearch = false;
  state.includeArchiveInSearch = false;
  state.viewModeBeforeSearchInclude = null;
}

async function persistLayoutPreference(layout: 'list' | 'columns'): Promise<void> {
  const { api } = await import('./api.js');
  try { await api('/settings', { method: 'PATCH', body: { layout } }); }
  catch { /* best-effort */ }
}
