// @vitest-environment happy-dom
/**
 * HS-8614 — the category settings row list moved its per-row `input` /
 * delete-`click` listeners off per-element attachment and onto a single set of
 * `delegate()` handlers on the stable `#category-list` container, reading the
 * row index from each row's `data-index`. These tests lock in:
 *   - a delegated edit on row N writes the correct `state.categories[N]` field
 *   - the delegation survives a full list rebuild (the migration's whole point)
 *   - after a delete shifts the rows, an edit on a now-different row targets the
 *     correct category — the stale-closure-index class the migration removes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindCategorySettings, renderCategoryList } from './settingsCategories.js';
import { type CategoryDef, state } from './state.js';

vi.mock('../api/index.js', () => ({
  getCategoryPresets: vi.fn(() => Promise.resolve([])),
  updateCategories: vi.fn(() => Promise.resolve({})),
}));

function cat(over: Partial<CategoryDef>): CategoryDef {
  return { id: 'x', label: 'X', shortLabel: 'X', color: '#000000', shortcutKey: '', description: '', ...over };
}

function setupDom(): void {
  document.body.innerHTML = `
    <button id="settings-btn"></button>
    <button id="category-add-btn"></button>
    <select id="category-preset-select"></select>
    <div id="category-list"></div>
  `;
}

function rowInput(index: number, cls: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`.category-row[data-index="${index}"] .${cls}`);
  if (el === null) throw new Error(`no .${cls} at row ${index}`);
  return el;
}

describe('settingsCategories — delegated row handlers (HS-8614)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDom();
    bindCategorySettings(() => { /* rebuildCategoryUI no-op */ });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
    state.categories = [];
  });

  it('a delegated input on row 1 writes state.categories[1], not [0]', () => {
    state.categories = [cat({ id: 'a', color: '#111111' }), cat({ id: 'b', color: '#222222' })];
    renderCategoryList(() => { /* no-op */ });

    const colorInput = rowInput(1, 'category-color-input');
    colorInput.value = '#abcdef';
    colorInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(state.categories[1].color).toBe('#abcdef');
    expect(state.categories[0].color).toBe('#111111');
  });

  it('short-label input uppercases and key input truncates to one lowercased char', () => {
    state.categories = [cat({ id: 'a' })];
    renderCategoryList(() => { /* no-op */ });

    const short = rowInput(0, 'category-short-input');
    short.value = 'bug';
    short.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.categories[0].shortLabel).toBe('BUG');

    const key = rowInput(0, 'category-key-input');
    key.value = 'KK';
    key.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.categories[0].shortcutKey).toBe('k');
    expect(key.value).toBe('k');
  });

  it('label input auto-generates an id for a new (id-less) category', () => {
    state.categories = [cat({ id: '', label: '' })];
    renderCategoryList(() => { /* no-op */ });

    const label = rowInput(0, 'category-label-input');
    label.value = 'Tech Debt!';
    label.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.categories[0].label).toBe('Tech Debt!');
    expect(state.categories[0].id).toBe('tech_debt');
  });

  it('delegation survives a rebuild: editing after re-render still fires', () => {
    state.categories = [cat({ id: 'a', color: '#111111' })];
    renderCategoryList(() => { /* no-op */ });
    // Force a fresh row set (same container, brand-new child nodes).
    renderCategoryList(() => { /* no-op */ });

    const colorInput = rowInput(0, 'category-color-input');
    colorInput.value = '#0f0f0f';
    colorInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.categories[0].color).toBe('#0f0f0f');
  });

  it('STALE-INDEX REGRESSION: after deleting row 0, an edit on the new row 0 targets the shifted category', () => {
    state.categories = [cat({ id: 'a', label: 'Alpha' }), cat({ id: 'b', label: 'Beta' })];
    renderCategoryList(() => { /* no-op */ });

    // Delete the first row → categories becomes [Beta]; list re-renders with
    // Beta now at data-index 0.
    document.querySelector<HTMLButtonElement>('.category-row[data-index="0"] .category-delete-btn')!.click();
    expect(state.categories.map(c => c.id)).toEqual(['b']);

    // Edit the (now) row-0 label. A stale closure-captured index would have
    // written the deleted category; delegation reads data-index and hits Beta.
    const label = rowInput(0, 'category-label-input');
    label.value = 'Beta edited';
    label.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.categories[0].id).toBe('b');
    expect(state.categories[0].label).toBe('Beta edited');
  });
});
