/**
 * HS-7826 → HS-8290 — wires a `<select>` element to the global
 * visibility-groupings state. Used in two places:
 *
 * - Dashboard header: `#terminal-dashboard-grouping-select`.
 * - Drawer-grid toolbar: `#drawer-grid-grouping-select`.
 *
 * Pre-HS-8290 the groupings were per-project and this module accepted a
 * `getSecret` + optional `getAdditionalSecrets` to fan the active-id swap
 * out across every registered project. Post-HS-8290 the groupings are
 * global so a single read + a single write covers every surface — both
 * options just route through the same global state.
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
  const activeId = getActiveGroupingId();
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
    setActiveGrouping(opts.selectEl.value);
  });
  subscribeToHiddenChanges(() => { refreshGroupingSelect(opts); });
}
