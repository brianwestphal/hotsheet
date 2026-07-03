// @vitest-environment happy-dom
// HS-9145 — branch coverage for the search "include backlog/archive" rows (HS-7756).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearIncludeFlagsOnly,
  clearSearchIncludeState,
  renderSearchExtraRows,
} from './searchExtraRows.js';
import { state } from './state.js';

const updateSettings = vi.fn(() => Promise.resolve());
vi.mock('../api/index.js', () => ({ updateSettings }));

function resetState(): void {
  state.search = '';
  state.searchExtraCounts = { backlog: 0, archive: 0 };
  state.includeBacklogInSearch = false;
  state.includeArchiveInSearch = false;
  state.viewModeBeforeSearchInclude = null;
  state.layout = 'list';
}

function installContainer(): HTMLElement {
  const c = document.createElement('div');
  c.id = 'search-extra-rows';
  document.body.appendChild(c);
  return c;
}

beforeEach(() => { resetState(); updateSettings.mockClear(); });
afterEach(() => { document.body.replaceChildren(); });

describe('renderSearchExtraRows', () => {
  it('does nothing when the container is absent', () => {
    expect(() => renderSearchExtraRows(vi.fn())).not.toThrow();
  });

  it('renders no rows when there is no active search', () => {
    const c = installContainer();
    state.search = '';
    state.searchExtraCounts = { backlog: 5, archive: 5 };
    renderSearchExtraRows(vi.fn());
    expect(c.children).toHaveLength(0);
  });

  it('renders no rows when both buckets are empty', () => {
    const c = installContainer();
    state.search = 'foo';
    state.searchExtraCounts = { backlog: 0, archive: 0 };
    renderSearchExtraRows(vi.fn());
    expect(c.children).toHaveLength(0);
  });

  it('renders only the backlog row when only backlog has matches (singular label)', () => {
    const c = installContainer();
    state.search = 'foo';
    state.searchExtraCounts = { backlog: 1, archive: 0 };
    renderSearchExtraRows(vi.fn());
    expect(c.children).toHaveLength(1);
    expect(c.querySelector('.search-extra-row-label')!.textContent).toBe('Include 1 backlog item');
  });

  it('renders both rows (plural labels) and reflects the active "Hide" state', () => {
    const c = installContainer();
    state.search = 'foo';
    state.searchExtraCounts = { backlog: 3, archive: 2 };
    state.includeArchiveInSearch = true;
    renderSearchExtraRows(vi.fn());
    const labels = [...c.querySelectorAll('.search-extra-row-label')].map(el => el.textContent);
    expect(labels).toEqual(['Include 3 backlog items', 'Hide 2 archive items']);
    // the active row carries the is-active class
    expect(c.querySelectorAll('.search-extra-row.is-active')).toHaveLength(1);
  });

  it('clicking the backlog row toggles the flag, saves the view mode, and reloads', async () => {
    const c = installContainer();
    state.search = 'foo';
    state.searchExtraCounts = { backlog: 2, archive: 0 };
    state.layout = 'columns';
    const reload = vi.fn();
    renderSearchExtraRows(reload);
    (c.querySelector('.search-extra-row') as HTMLElement).click();
    expect(state.includeBacklogInSearch).toBe(true);
    expect(state.viewModeBeforeSearchInclude).toBe('columns'); // saved the pre-include mode
    expect(state.layout).toBe('list'); // columns → list auto-switch
    expect(reload).toHaveBeenCalledOnce();
    // persistLayoutPreference is a fire-and-forget async dynamic import.
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ layout: 'list' }));
  });

  it('activates a row via keyboard (Enter / Space)', () => {
    const c = installContainer();
    state.search = 'foo';
    state.searchExtraCounts = { backlog: 0, archive: 4 };
    const reload = vi.fn();
    renderSearchExtraRows(reload);
    const row = c.querySelector('.search-extra-row') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(state.includeArchiveInSearch).toBe(true);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(state.includeArchiveInSearch).toBe(false); // toggled back
    // a non-activating key does nothing more
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('clearSearchIncludeState', () => {
  it('resets flags, restores the saved layout, and clears counts', async () => {
    state.includeBacklogInSearch = true;
    state.viewModeBeforeSearchInclude = 'columns';
    state.layout = 'list';
    state.searchExtraCounts = { backlog: 3, archive: 1 };
    clearSearchIncludeState();
    expect(state.includeBacklogInSearch).toBe(false);
    expect(state.viewModeBeforeSearchInclude).toBeNull();
    expect(state.layout).toBe('columns'); // restored
    expect(state.searchExtraCounts).toEqual({ backlog: 0, archive: 0 });
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ layout: 'columns' }));
  });

  it('no layout persist when the saved mode already matches the current layout', () => {
    state.includeArchiveInSearch = true;
    state.viewModeBeforeSearchInclude = 'list';
    state.layout = 'list';
    clearSearchIncludeState();
    expect(state.includeArchiveInSearch).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('is a clean no-op when nothing was toggled', () => {
    clearSearchIncludeState();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(state.searchExtraCounts).toEqual({ backlog: 0, archive: 0 });
  });
});

describe('clearIncludeFlagsOnly', () => {
  it('returns early when no include flag is set', () => {
    state.viewModeBeforeSearchInclude = 'columns';
    clearIncludeFlagsOnly();
    expect(state.viewModeBeforeSearchInclude).toBe('columns'); // untouched
  });

  it('clears the flags + the saved view mode when a flag is set', () => {
    state.includeBacklogInSearch = true;
    state.viewModeBeforeSearchInclude = 'columns';
    clearIncludeFlagsOnly();
    expect(state.includeBacklogInSearch).toBe(false);
    expect(state.viewModeBeforeSearchInclude).toBeNull();
  });
});
