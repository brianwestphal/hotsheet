// HS-9323 — shared, pure selection logic for the settings list editors
// (auto-context entries + custom-command items) so the Copy button can copy a
// SELECTED subset instead of always copying everything. Plain/Cmd/Shift click
// semantics mirror the OS list convention (macOS Finder / Windows Explorer):
//   - plain click  → select only that item; clicking the sole selected item clears it
//   - Cmd/Ctrl     → toggle that item in/out, keeping the rest
//   - Shift        → add the contiguous range from the anchor to the clicked item
// The default (nothing selected) copies ALL — so the feature is purely additive.
//
// This module is DOM-free + deterministic so the click state machine is fully
// unit-testable; the editors own the rendering + event wiring.

export interface SelectionState {
  /** The currently-selected item ids. */
  readonly selected: ReadonlySet<string>;
  /** The last item a plain/Cmd click landed on — the origin for Shift ranges. */
  readonly anchor: string | null;
}

/** Modifier keys for a click, normalized by the caller (`meta = metaKey || ctrlKey`). */
export interface ClickMods {
  readonly meta: boolean;
  readonly shift: boolean;
}

/** An empty selection (nothing selected → "Copy All"). */
export function emptySelection(): SelectionState {
  return { selected: new Set(), anchor: null };
}

/**
 * Pure: the next selection after a click on `id` within `orderedIds` (the items
 * in current render order — needed for Shift ranges). Unknown `id`s (not in
 * `orderedIds`) still work for plain/Cmd; a Shift range is only computed when both
 * the anchor and the clicked id are present in `orderedIds`.
 */
export function applySelectionClick(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
  mods: ClickMods,
): SelectionState {
  // Shift: extend the contiguous range from the anchor to the clicked item,
  // unioned with the existing selection. Anchor is preserved so repeated
  // Shift-clicks re-range from the same origin.
  if (mods.shift && state.anchor !== null) {
    const a = orderedIds.indexOf(state.anchor);
    const b = orderedIds.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const selected = new Set(state.selected);
      for (let i = lo; i <= hi; i++) selected.add(orderedIds[i]);
      return { selected, anchor: state.anchor };
    }
    // anchor or id missing → fall through to plain-click behavior below.
  }

  // Cmd/Ctrl: toggle just this id, keep the others; it becomes the new anchor.
  if (mods.meta) {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id };
  }

  // Plain click: clicking the SOLE selected item clears the selection (the way
  // back to "none selected" / Copy All); otherwise select only this item.
  if (state.selected.size === 1 && state.selected.has(id)) {
    return emptySelection();
  }
  return { selected: new Set([id]), anchor: id };
}

/**
 * Drop any selected ids no longer present (e.g. after an item is deleted or the
 * scope view swaps the list). Clears the anchor if it vanished. Returns the same
 * object when nothing changed so callers can skip a re-render.
 */
export function pruneSelection(state: SelectionState, orderedIds: readonly string[]): SelectionState {
  const present = new Set(orderedIds);
  let changed = false;
  const selected = new Set<string>();
  for (const id of state.selected) {
    if (present.has(id)) selected.add(id);
    else changed = true;
  }
  const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
  if (anchor !== state.anchor) changed = true;
  return changed ? { selected, anchor } : state;
}

/** The Copy button label: "Copy All" when nothing is selected, else "Copy Selected". */
export function copyButtonLabel(state: SelectionState): 'Copy All' | 'Copy Selected' {
  return state.selected.size === 0 ? 'Copy All' : 'Copy Selected';
}

/**
 * The ids to copy, in render order: the selected subset, or ALL when nothing is
 * selected (the default). Callers map these back to their entry objects.
 */
export function idsToCopy(state: SelectionState, orderedIds: readonly string[]): string[] {
  if (state.selected.size === 0) return [...orderedIds];
  return orderedIds.filter(id => state.selected.has(id));
}
