// @vitest-environment happy-dom
/**
 * §61 Phase 3b follow-up / HS-8324 — unit tests for `commandLogSelectionStore`.
 * The store lifts the imperative `selectedLogIds: Set<number>` +
 * `lastClickedId: number | null` + `expandedEntryIds: Set<number>` out
 * of `commandLog.tsx`. These tests pin the action contract; per-row
 * effect-driven class flips against the bindList view-layer are
 * exercised in `commandLog.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _commandLogSelectionStoreForTesting,
  commandLogSelectionStore,
  expandedSignal,
  selectedSignal,
} from './commandLogSelectionStore.js';

beforeEach(() => {
  _commandLogSelectionStoreForTesting.reset();
});

afterEach(() => {
  _commandLogSelectionStoreForTesting.reset();
});

describe('commandLogSelectionStore — initial state', () => {
  it('starts empty', () => {
    expect(commandLogSelectionStore.state.value.selected.size).toBe(0);
    expect(commandLogSelectionStore.state.value.lastClicked).toBeNull();
    expect(commandLogSelectionStore.state.value.expanded.size).toBe(0);
  });

  it('reset() returns to initial after mutations', () => {
    commandLogSelectionStore.actions.selectOnly(1);
    commandLogSelectionStore.actions.toggleExpanded(2);
    _commandLogSelectionStoreForTesting.reset();
    expect(commandLogSelectionStore.state.value.selected.size).toBe(0);
    expect(commandLogSelectionStore.state.value.lastClicked).toBeNull();
    expect(commandLogSelectionStore.state.value.expanded.size).toBe(0);
  });
});

describe('commandLogSelectionStore — selection actions', () => {
  it('toggleSelected adds an id and pins the range anchor', () => {
    commandLogSelectionStore.actions.toggleSelected(7);
    expect([...commandLogSelectionStore.state.value.selected]).toEqual([7]);
    expect(commandLogSelectionStore.state.value.lastClicked).toBe(7);
  });

  it('toggleSelected removes the id when it is already in the set', () => {
    commandLogSelectionStore.actions.toggleSelected(7);
    commandLogSelectionStore.actions.toggleSelected(7);
    expect(commandLogSelectionStore.state.value.selected.size).toBe(0);
    // Range anchor pins to the last toggle target regardless of add/remove.
    expect(commandLogSelectionStore.state.value.lastClicked).toBe(7);
  });

  it('selectOnly drops every prior selection + pins the range anchor', () => {
    commandLogSelectionStore.actions.toggleSelected(1);
    commandLogSelectionStore.actions.toggleSelected(2);
    commandLogSelectionStore.actions.selectOnly(3);
    expect([...commandLogSelectionStore.state.value.selected]).toEqual([3]);
    expect(commandLogSelectionStore.state.value.lastClicked).toBe(3);
  });

  it('addToSelection unions the supplied ids without touching the range anchor', () => {
    commandLogSelectionStore.actions.selectOnly(10);
    commandLogSelectionStore.actions.addToSelection([11, 12, 13]);
    expect([...commandLogSelectionStore.state.value.selected].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect(commandLogSelectionStore.state.value.lastClicked).toBe(10);
  });

  it('clearSelected drops the set + the range anchor', () => {
    commandLogSelectionStore.actions.selectOnly(5);
    commandLogSelectionStore.actions.clearSelected();
    expect(commandLogSelectionStore.state.value.selected.size).toBe(0);
    expect(commandLogSelectionStore.state.value.lastClicked).toBeNull();
  });

  it('clearSelected is a no-op when already clear (no spurious churn)', () => {
    const ref1 = commandLogSelectionStore.state.value;
    commandLogSelectionStore.actions.clearSelected();
    expect(commandLogSelectionStore.state.value).toBe(ref1);
  });
});

describe('commandLogSelectionStore — expansion actions', () => {
  it('toggleExpanded flips an id in and out of the set', () => {
    commandLogSelectionStore.actions.toggleExpanded(42);
    expect(commandLogSelectionStore.state.value.expanded.has(42)).toBe(true);
    commandLogSelectionStore.actions.toggleExpanded(42);
    expect(commandLogSelectionStore.state.value.expanded.has(42)).toBe(false);
  });

  it('setExpanded(true) force-adds; setExpanded(false) force-removes', () => {
    commandLogSelectionStore.actions.setExpanded(1, true);
    expect(commandLogSelectionStore.state.value.expanded.has(1)).toBe(true);
    commandLogSelectionStore.actions.setExpanded(1, true); // idempotent
    expect(commandLogSelectionStore.state.value.expanded.has(1)).toBe(true);
    commandLogSelectionStore.actions.setExpanded(1, false);
    expect(commandLogSelectionStore.state.value.expanded.has(1)).toBe(false);
  });

  it('setExpanded is a no-op when the target state matches current (no churn)', () => {
    commandLogSelectionStore.actions.setExpanded(1, true);
    const ref1 = commandLogSelectionStore.state.value;
    commandLogSelectionStore.actions.setExpanded(1, true);
    expect(commandLogSelectionStore.state.value).toBe(ref1);
  });
});

describe('selectedSignal / expandedSignal — derived', () => {
  it('mirror the underlying sets', () => {
    commandLogSelectionStore.actions.selectOnly(9);
    commandLogSelectionStore.actions.setExpanded(8, true);
    expect(selectedSignal.value.has(9)).toBe(true);
    expect(expandedSignal.value.has(8)).toBe(true);
  });
});
