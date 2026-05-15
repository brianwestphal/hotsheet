/**
 * HS-7826 → HS-8290 → HS-8406 — wires a `<select>` element to the
 * scope-aware visibility-groupings state. Used in two places:
 *
 * - Dashboard header: `#terminal-dashboard-grouping-select` — scope
 *   `DASHBOARD_SCOPE`.
 * - Drawer-grid toolbar: `#drawer-grid-grouping-select` — scope
 *   `projectScope(secret)` for the active project (re-wired on project
 *   switch).
 *
 * Pre-HS-8290 the groupings were per-project. HS-8290 made the
 * grouping list + active id global. HS-8406 keeps the grouping LIST
 * global but re-introduces per-scope active-id selection so flipping
 * the dropdown in a project's drawer doesn't ripple into the
 * dashboard.
 *
 * Visibility rule: the `<select>` is hidden when there's only one
 * grouping (the Default). Once the user creates a second grouping, the
 * select reveals automatically via the change subscription.
 */

import {
  getActiveGroupingId,
  getGroupings,
  setActiveGrouping,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';

export interface GroupingSelectOptions {
  /** The `<select>` element in the DOM. */
  selectEl: HTMLSelectElement;
  /** Lazy scope-key resolver. Called on every read + write so the
   *  drawer-grid select (whose scope changes on project switch) can
   *  return `projectScope(getActiveProject()?.secret ?? '')` and the
   *  dashboard select can return the constant `DASHBOARD_SCOPE`. Pre-
   *  HS-8406 there was a single global active id so no scope was
   *  threaded; this resolver replaces that. */
  getScopeKey: () => string;
}

/** Re-render a grouping select against the current global state. Returns
 *  the displayed grouping count. Hides the select when there's only one
 *  grouping (per the §39 dropdown-only-with-multiple rule). */
export function refreshGroupingSelect(opts: GroupingSelectOptions): { count: number } {
  const groupings = getGroupings();
  if (groupings.length <= 1) {
    opts.selectEl.style.display = 'none';
    opts.selectEl.replaceChildren();
    return { count: groupings.length };
  }
  opts.selectEl.style.display = '';
  opts.selectEl.replaceChildren();
  const activeId = getActiveGroupingId(opts.getScopeKey());
  for (const g of groupings) {
    const opt = toElement(
      <option value={g.id} selected={g.id === activeId}>{g.name}</option>,
    ) as HTMLOptionElement;
    opts.selectEl.appendChild(opt);
  }
  return { count: groupings.length };
}

/** One-time wiring: attach a `change` listener that flips the active
 *  grouping globally, AND subscribes the select to hidden-state changes
 *  so it refreshes on every state mutation (e.g. when
 *  `initPersistedHiddenTerminals` finishes hydrating). Idempotent —
 *  caller's responsibility to call once per `selectEl`. */
export function wireGroupingSelectChange(opts: GroupingSelectOptions): void {
  opts.selectEl.addEventListener('change', () => {
    setActiveGrouping(opts.getScopeKey(), opts.selectEl.value);
  });
  subscribeToHiddenChanges(() => { refreshGroupingSelect(opts); });
}
