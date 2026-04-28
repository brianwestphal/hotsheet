/**
 * HS-7826 — wires a `<select>` element to the visibility-groupings state
 * for one project. Used in two places:
 *
 * - Dashboard header: `#terminal-dashboard-grouping-select`, scoped to a
 *   `(secret)` chosen by the dashboard module (typically the first
 *   project in registered order, since groupings are per-project and the
 *   global dashboard's tab bar in the dialog already scopes to that
 *   project).
 * - Drawer-grid toolbar: `#drawer-grid-grouping-select`, scoped to the
 *   active project.
 *
 * Visibility rule: the `<select>` is hidden when the scoped project has
 * only one grouping (the Default). Once the user creates a second
 * grouping, the select reveals automatically via the change subscription.
 */

import {
  getActiveGroupingId,
  getGroupings,
  setActiveGroupingForProject,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';

export interface GroupingSelectOptions {
  /** The `<select>` element in the DOM. */
  selectEl: HTMLSelectElement;
  /** Returns the project secret to scope the selector to. Called every
   *  refresh — for the drawer-grid this is the active project, which can
   *  change without us being told (project switch). */
  getSecret: () => string | null;
  /** HS-7826 follow-up — optional list of additional secrets to fan a
   *  grouping change out to. The dashboard uses this to keep every
   *  registered project's `activeId` in sync with what the dropdown shows
   *  (otherwise picking a tab in the dropdown only flipped the first
   *  project's filter and the rest stayed on their previous active ids). */
  getAdditionalSecrets?: () => string[];
}

/** Re-render a grouping select against the current state. Returns the
 *  list of grouping ids in the order they're displayed (caller can use
 *  the count to decide on related UI changes). Hides the select when
 *  there's only one grouping (per the §39 dropdown-only-with-multiple rule). */
export function refreshGroupingSelect(opts: GroupingSelectOptions): { count: number } {
  const secret = opts.getSecret();
  if (secret === null || secret === '') {
    opts.selectEl.style.display = 'none';
    opts.selectEl.replaceChildren();
    return { count: 0 };
  }
  const groupings = getGroupings(secret);
  if (groupings.length <= 1) {
    opts.selectEl.style.display = 'none';
    opts.selectEl.replaceChildren();
    return { count: groupings.length };
  }
  opts.selectEl.style.display = '';
  // Rebuild options. Cheap (small N), avoids partial-update races.
  opts.selectEl.replaceChildren();
  const activeId = getActiveGroupingId(secret);
  for (const g of groupings) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    if (g.id === activeId) opt.selected = true;
    opts.selectEl.appendChild(opt);
  }
  return { count: groupings.length };
}

/** One-time wiring: attach a `change` listener that flips the active
 *  grouping for the current scope, AND subscribes the select to hidden-
 *  state changes so it refreshes on every state mutation (e.g. when
 *  `initPersistedHiddenTerminals` finishes hydrating from `/file-settings`
 *  on app boot). Idempotent — caller's responsibility to call once per
 *  `selectEl`. When `getAdditionalSecrets` is supplied, the active
 *  grouping is also flipped for those secrets so the dashboard's
 *  cross-project filter agrees with the dropdown.
 *
 *  HS-7970 — the boot-time subscription is what fixes "the grouping
 *  dropdown is missing after app restore": before HS-7970 the select was
 *  refreshed only by the dashboard / drawer-grid's own subscriptions,
 *  which were attached AFTER the user explicitly entered dashboard / grid
 *  mode — so a hydration-completes-before-enter race left the select stuck
 *  on the pre-hydration single-Default state. The subscription here is
 *  wider: it's attached the moment the select is wired (typically inside
 *  `init*` at app boot) and stays alive for the lifetime of the page.
 */
export function wireGroupingSelectChange(opts: GroupingSelectOptions): void {
  opts.selectEl.addEventListener('change', () => {
    const primary = opts.getSecret();
    if (primary === null || primary === '') return;
    const value = opts.selectEl.value;
    setActiveGroupingForProject(primary, value);
    if (opts.getAdditionalSecrets !== undefined) {
      const seen = new Set<string>([primary]);
      for (const s of opts.getAdditionalSecrets()) {
        if (s === '' || seen.has(s)) continue;
        seen.add(s);
        setActiveGroupingForProject(s, value);
      }
    }
  });
  // HS-7970 — refresh the select whenever ANY hidden-state mutation lands.
  // Covers the boot-time hydration race + per-project grouping add / remove
  // / rename (the dashboard + drawer-grid subscriptions only fire while
  // their respective views are active; this one is always-on).
  subscribeToHiddenChanges(() => { refreshGroupingSelect(opts); });
}
