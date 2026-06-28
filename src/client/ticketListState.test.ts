/** HS-9131 — shared ticketList state slots + callback registry
 *  (`ticketListState.ts`). */
import { describe, expect, it, vi } from 'vitest';

import { PRIORITY_ITEMS, state } from './state.js';
import {
  callFocusDraftInput,
  callLoadTickets,
  callRenderTicketList,
  callUpdateBatchToolbar,
  callUpdateColumnSelectionClasses,
  callUpdateSelectionClasses,
  draftCategory,
  draftTitle,
  draggedTicketIds,
  getCategoryShortcuts,
  PRIORITY_SHORTCUTS,
  registerCallbacks,
  saveTimeout,
  setDraftCategory,
  setDraftTitle,
  setDraggedTicketIds,
  setSaveTimeout,
  setSuppressFocusSelect,
  suppressFocusSelect,
} from './ticketListState.js';

describe('mutable state setters (ES live bindings)', () => {
  it('round-trip each slot through its setter', () => {
    const t = setTimeout(() => {}, 0);
    setSaveTimeout(t);
    expect(saveTimeout).toBe(t);
    setSaveTimeout(null);
    expect(saveTimeout).toBeNull();

    setSuppressFocusSelect(true);
    expect(suppressFocusSelect).toBe(true);

    setDraftCategory('bug');
    expect(draftCategory).toBe('bug');

    setDraftTitle('hello');
    expect(draftTitle).toBe('hello');

    setDraggedTicketIds([1, 2, 3]);
    expect(draggedTicketIds).toEqual([1, 2, 3]);
  });
});

describe('shortcuts', () => {
  it('PRIORITY_SHORTCUTS aliases PRIORITY_ITEMS', () => {
    expect(PRIORITY_SHORTCUTS).toBe(PRIORITY_ITEMS);
  });
  it('getCategoryShortcuts maps the live category list', () => {
    const prev = state.categories;
    state.categories = [
      { id: 'bug', shortcutKey: 'b', label: 'Bug', shortLabel: 'BUG', description: '', color: '#f00' },
      { id: 'task', shortcutKey: 't', label: 'Task', shortLabel: 'TSK', description: '', color: '#0f0' },
    ];
    try {
      expect(getCategoryShortcuts()).toEqual([
        { key: 'b', value: 'bug', label: 'Bug' },
        { key: 't', value: 'task', label: 'Task' },
      ]);
    } finally {
      state.categories = prev;
    }
  });
});

describe('callback registry', () => {
  it('each call* delegates to the registered callback', async () => {
    const cbs = {
      renderTicketList: vi.fn(),
      loadTickets: vi.fn(() => Promise.resolve()),
      updateSelectionClasses: vi.fn(),
      updateBatchToolbar: vi.fn(),
      updateColumnSelectionClasses: vi.fn(),
      focusDraftInput: vi.fn(),
    };
    registerCallbacks(cbs);
    callRenderTicketList();
    await callLoadTickets();
    callUpdateSelectionClasses();
    callUpdateBatchToolbar();
    callUpdateColumnSelectionClasses();
    callFocusDraftInput();
    expect(cbs.renderTicketList).toHaveBeenCalledTimes(1);
    expect(cbs.loadTickets).toHaveBeenCalledTimes(1);
    expect(cbs.updateSelectionClasses).toHaveBeenCalledTimes(1);
    expect(cbs.updateBatchToolbar).toHaveBeenCalledTimes(1);
    expect(cbs.updateColumnSelectionClasses).toHaveBeenCalledTimes(1);
    expect(cbs.focusDraftInput).toHaveBeenCalledTimes(1);
  });
});
