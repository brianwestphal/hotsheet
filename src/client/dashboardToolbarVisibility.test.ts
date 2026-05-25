// @vitest-environment happy-dom
/**
 * HS-8626 — the header toolbar controls (search / layout / sort /
 * detail-position) "went missing": the analytics dashboard hid them and a
 * surface that supplanted it (the cross-project stats page) failed to restore
 * them. These tests lock the shared hide/restore helpers — the single source
 * of truth both `dashboardMode.tsx` (enter/exit) and
 * `crossProjectStatsPage.tsx` (supplant) now use — so the id list + the
 * wrapper-resolution can't silently drift.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DASHBOARD_HIDDEN_IDS,
  hideDashboardToolbarControls,
  restoreDashboardToolbarControls,
} from './dashboardToolbarVisibility.js';

// Mirrors the relevant `pages.tsx` header structure: `#search-input` lives
// inside a `.search-box` wrapper (the wrapper is what toggles); the toggles
// carry their own ids; `#sort-select` + `#glassbox-btn` have no wrapper.
function mountHeader(): Record<string, HTMLElement> {
  document.body.innerHTML = `
    <div class="header-controls">
      <div class="search-box"><input id="search-input" /></div>
      <div class="layout-toggle" id="layout-toggle"></div>
      <select id="sort-select"></select>
      <div class="layout-toggle" id="detail-position-toggle"></div>
      <button id="glassbox-btn"></button>
    </div>
  `;
  return {
    searchBox: document.querySelector<HTMLElement>('.search-box')!,
    layoutToggle: document.getElementById('layout-toggle')!,
    sortSelect: document.getElementById('sort-select')!,
    detailToggle: document.getElementById('detail-position-toggle')!,
    glassbox: document.getElementById('glassbox-btn')!,
  };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('dashboardToolbarVisibility (HS-8626)', () => {
  it('hides every control — search via its .search-box wrapper, toggles/select/button directly', () => {
    const els = mountHeader();
    hideDashboardToolbarControls();
    // The search wrapper (not just the input) is what gets hidden.
    expect(els.searchBox.style.display).toBe('none');
    expect(els.layoutToggle.style.display).toBe('none');
    expect(els.sortSelect.style.display).toBe('none');
    expect(els.detailToggle.style.display).toBe('none');
    expect(els.glassbox.style.display).toBe('none');
  });

  it('restore brings them all back (the missing supplant-path step)', () => {
    const els = mountHeader();
    hideDashboardToolbarControls();
    restoreDashboardToolbarControls();
    expect(els.searchBox.style.display).toBe('');
    expect(els.layoutToggle.style.display).toBe('');
    expect(els.sortSelect.style.display).toBe('');
    expect(els.detailToggle.style.display).toBe('');
    expect(els.glassbox.style.display).toBe('');
  });

  it('restore is idempotent on already-visible controls (safe to call defensively)', () => {
    const els = mountHeader();
    restoreDashboardToolbarControls();
    expect(els.searchBox.style.display).toBe('');
    expect(els.layoutToggle.style.display).toBe('');
  });

  it('is a no-op (no throw) when the header controls are absent', () => {
    expect(() => hideDashboardToolbarControls()).not.toThrow();
    expect(() => restoreDashboardToolbarControls()).not.toThrow();
  });

  it('covers the documented control ids', () => {
    expect([...DASHBOARD_HIDDEN_IDS]).toEqual([
      'search-input', 'layout-toggle', 'sort-select', 'detail-position-toggle', 'glassbox-btn',
    ]);
  });
});
