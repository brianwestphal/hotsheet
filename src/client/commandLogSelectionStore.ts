/**
 * §61 Phase 3b follow-up / HS-8324 — small kerf `defineStore` lifting
 * the row-selection + expansion state out of `commandLog.tsx`'s
 * imperative `selectedLogIds: Set<number>` + `lastClickedId: number | null`
 * + `expandedEntryIds: Set<number>` Sets. Paired with new per-row
 * effects inside `commandLog.tsx::renderEntryRow` that flip the
 * `.selected` and `.expanded` classes declaratively — replaces the
 * imperative `updateSelectionClasses()` sweep + the post-shape-rebuild
 * `applyExpansion` re-apply.
 *
 * Why a separate store from `commandLogStore`: selection / expansion
 * are user-driven row state; entries / filter / partial-output are
 * server-driven log state. Keeping them in separate stores makes the
 * dependency graph cleaner — bindList re-runs only on
 * `filteredEntriesSignal`, not on every click that toggles a selection
 * class. And the lifetimes differ — `commandLogStore` GCs entries that
 * age off the rolling-100 buffer; selection state can outlive a single
 * GC if the user kept the row selected via shift+click then the server
 * rolled it off.
 *
 * **Does NOT reset on project switch** (matches `commandLogStore` —
 * the data is local, not cross-project).
 */
import type { ReadonlySignal } from './reactive.js';
import { computed, defineStore } from './reactive.js';

export interface CommandLogSelectionState {
  /** Selected entry ids — drives the `.selected` class on each row. */
  selected: ReadonlySet<number>;
  /** Last-clicked entry id (shift+click range anchor). Null when the
   *  selection was cleared via a non-click path (`clearSelected()` or
   *  the `clear log` button). */
  lastClicked: number | null;
  /** Expanded entry ids — drives the `.expanded` class on each row. */
  expanded: ReadonlySet<number>;
}

export const commandLogSelectionStore = defineStore({
  initial: (): CommandLogSelectionState => ({
    selected: new Set<number>(),
    lastClicked: null,
    expanded: new Set<number>(),
  }),
  actions: (set, get) => ({
    /** Cmd/Ctrl-click toggle: flip the entry's selected-state and pin
     *  the range anchor on it. */
    toggleSelected: (id: number) => {
      const cur = get();
      const next = new Set(cur.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ ...cur, selected: next, lastClicked: id });
    },
    /** Shift+click range expansion: union the supplied ids into the
     *  current selection. Range-anchor is preserved (caller already
     *  pinned it via `toggleSelected` or `selectOnly`). */
    addToSelection: (ids: readonly number[]) => {
      const cur = get();
      const next = new Set(cur.selected);
      for (const id of ids) next.add(id);
      set({ ...cur, selected: next });
    },
    /** Plain click: drop all prior selection + select this row only.
     *  Pins range anchor on the clicked id. */
    selectOnly: (id: number) => {
      set({ ...get(), selected: new Set([id]), lastClicked: id });
    },
    /** Drop every selection bit. Used by the clear-log button + the
     *  permission-flow's auto-highlight-then-clear teardown. */
    clearSelected: () => {
      const cur = get();
      if (cur.selected.size === 0 && cur.lastClicked === null) return;
      set({ ...cur, selected: new Set<number>(), lastClicked: null });
    },
    /** Toggle a row's expanded state. The per-row effect in
     *  `commandLog.tsx` flips the `.expanded` class + child `style.display`
     *  swaps off this signal. */
    toggleExpanded: (id: number) => {
      const cur = get();
      const next = new Set(cur.expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ ...cur, expanded: next });
    },
    /** Force-expand a row (used by `showLogEntryById` so an external
     *  jump-to-log path can reveal the target row's full detail). */
    setExpanded: (id: number, on: boolean) => {
      const cur = get();
      if (on === cur.expanded.has(id)) return;
      const next = new Set(cur.expanded);
      if (on) next.add(id);
      else next.delete(id);
      set({ ...cur, expanded: next });
    },
  }),
});

/** Derived signal — true when an entry id is currently selected. The
 *  per-row `.selected` class effect reads from a closure over the
 *  store's signal directly (avoids creating N derived signals); this
 *  helper is exported for consumers that want a tiny pure check. */
export const selectedSignal: ReadonlySignal<ReadonlySet<number>> = computed(() =>
  commandLogSelectionStore.state.value.selected,
);

/** Derived signal — true when an entry id is currently expanded. */
export const expandedSignal: ReadonlySignal<ReadonlySet<number>> = computed(() =>
  commandLogSelectionStore.state.value.expanded,
);

/** **HS-8324 — TEST ONLY.** Direct handle on the underlying store for
 *  unit tests to call `.reset()` between cases. Production code goes
 *  through the named actions above. */
export const _commandLogSelectionStoreForTesting = commandLogSelectionStore;
