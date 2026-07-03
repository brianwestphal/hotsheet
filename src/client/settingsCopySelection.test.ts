// HS-9323 — the pure selection state machine for the Copy-selected feature.
import { describe, expect, it } from 'vitest';

import {
  applySelectionClick,
  type ClickMods,
  copyButtonLabel,
  emptySelection,
  idsToCopy,
  pruneSelection,
  type SelectionState,
} from './settingsCopySelection.js';

const IDS = ['a', 'b', 'c', 'd', 'e'];
const plain: ClickMods = { meta: false, shift: false };
const meta: ClickMods = { meta: true, shift: false };
const shift: ClickMods = { meta: false, shift: true };

/** Convenience: selection as a sorted array for stable assertions. */
const sel = (s: SelectionState): string[] => [...s.selected].sort();

describe('applySelectionClick — plain click', () => {
  it('selects only the clicked item, clearing others, and sets the anchor', () => {
    const s = applySelectionClick(emptySelection(), IDS, 'c', plain);
    expect(sel(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('a plain click on a different item replaces the selection (not additive)', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'b', plain);
    s = applySelectionClick(s, IDS, 'd', plain);
    expect(sel(s)).toEqual(['d']);
    expect(s.anchor).toBe('d');
  });

  it('clicking the SOLE selected item clears the selection (→ Copy All)', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'b', plain);
    s = applySelectionClick(s, IDS, 'b', plain);
    expect(sel(s)).toEqual([]);
    expect(s.anchor).toBeNull();
    expect(copyButtonLabel(s)).toBe('Copy All');
  });

  it('plain-clicking one of several selected collapses to just that one', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'a', plain);
    s = applySelectionClick(s, IDS, 'c', meta); // {a,c}
    s = applySelectionClick(s, IDS, 'c', plain); // plain click on c → only c
    expect(sel(s)).toEqual(['c']);
  });
});

describe('applySelectionClick — Cmd/Ctrl toggle', () => {
  it('adds an item to the selection, keeping the rest', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'a', plain);
    s = applySelectionClick(s, IDS, 'c', meta);
    expect(sel(s)).toEqual(['a', 'c']);
    expect(s.anchor).toBe('c');
  });

  it('toggles an already-selected item back out', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'a', plain);
    s = applySelectionClick(s, IDS, 'c', meta); // {a,c}
    s = applySelectionClick(s, IDS, 'a', meta); // remove a → {c}
    expect(sel(s)).toEqual(['c']);
  });

  it('Cmd-click can empty the selection entirely (→ Copy All)', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'a', meta); // {a}
    s = applySelectionClick(s, IDS, 'a', meta); // {}
    expect(sel(s)).toEqual([]);
    expect(copyButtonLabel(s)).toBe('Copy All');
  });
});

describe('applySelectionClick — Shift range', () => {
  it('selects the contiguous range from the anchor to the clicked item', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'b', plain); // anchor b
    s = applySelectionClick(s, IDS, 'd', shift); // b..d
    expect(sel(s)).toEqual(['b', 'c', 'd']);
    expect(s.anchor).toBe('b'); // anchor preserved for re-ranging
  });

  it('ranges upward too (clicked before the anchor)', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'd', plain); // anchor d
    s = applySelectionClick(s, IDS, 'b', shift); // b..d
    expect(sel(s)).toEqual(['b', 'c', 'd']);
  });

  it('a second Shift-click re-ranges from the same anchor (unions)', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'b', plain); // anchor b
    s = applySelectionClick(s, IDS, 'c', shift); // b,c
    s = applySelectionClick(s, IDS, 'e', shift); // b..e
    expect(sel(s)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('Shift with no anchor behaves like a plain click (selects just the item)', () => {
    const s = applySelectionClick(emptySelection(), IDS, 'c', shift);
    expect(sel(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('Cmd then Shift extends the range while keeping earlier picks', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'a', plain); // {a} anchor a
    s = applySelectionClick(s, IDS, 'c', meta); // {a,c} anchor c
    s = applySelectionClick(s, IDS, 'e', shift); // c..e added → {a,c,d,e}
    expect(sel(s)).toEqual(['a', 'c', 'd', 'e']);
  });
});

describe('pruneSelection', () => {
  it('drops ids no longer present and clears a vanished anchor', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'b', plain);
    s = applySelectionClick(s, IDS, 'd', meta); // {b,d} anchor d
    const pruned = pruneSelection(s, ['a', 'b', 'c']); // d gone
    expect(sel(pruned)).toEqual(['b']);
    expect(pruned.anchor).toBeNull();
  });

  it('returns the SAME object when nothing changed (no needless re-render)', () => {
    const s = applySelectionClick(emptySelection(), IDS, 'b', plain);
    expect(pruneSelection(s, IDS)).toBe(s);
  });
});

describe('copyButtonLabel + idsToCopy', () => {
  it('empty selection → Copy All + every id in render order', () => {
    const s = emptySelection();
    expect(copyButtonLabel(s)).toBe('Copy All');
    expect(idsToCopy(s, IDS)).toEqual(IDS);
  });

  it('non-empty selection → Copy Selected + the subset in render order', () => {
    let s = applySelectionClick(emptySelection(), IDS, 'd', plain);
    s = applySelectionClick(s, IDS, 'b', meta); // {b,d}
    expect(copyButtonLabel(s)).toBe('Copy Selected');
    expect(idsToCopy(s, IDS)).toEqual(['b', 'd']); // render order, not click order
  });
});
