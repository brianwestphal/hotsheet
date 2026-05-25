// @vitest-environment happy-dom
/**
 * HS-8589 — the terminal-dashboard visibility-grouping `<select>` lives in the
 * always-present top toolbar and is driven by the global hidden-change
 * subscription, so a visibility mutation (or boot-time hydration) while the
 * user is in the TICKETS view used to set `display: ''` and leak the dropdown
 * into the ticket toolbar. `refreshGroupingSelect` now gates visibility on the
 * owning surface being active (`isActive()`), not just on grouping count.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetForTests,addGrouping } from './dashboardHiddenTerminals.js';
import { refreshGroupingSelect } from './visibilityGroupingSelect.js';

function makeSelect(): HTMLSelectElement {
  const el = document.createElement('select');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  _resetForTests();
  document.body.innerHTML = '';
});
afterEach(() => {
  _resetForTests();
  document.body.innerHTML = '';
});

describe('refreshGroupingSelect — visibility gating (HS-8589)', () => {
  it('hides the select when only the Default grouping exists, regardless of active state', () => {
    const el = makeSelect();
    refreshGroupingSelect({ selectEl: el, getScopeKey: () => 'dash', isActive: () => true });
    expect(el.style.display).toBe('none');
    expect(el.children.length).toBe(0);
  });

  it('shows the select when the surface is active AND there are 2+ groupings', () => {
    addGrouping('Work');
    const el = makeSelect();
    refreshGroupingSelect({ selectEl: el, getScopeKey: () => 'dash', isActive: () => true });
    expect(el.style.display).toBe('');
    // Default + Work.
    expect(el.children.length).toBe(2);
  });

  it('HIDES the select when 2+ groupings exist but the owning surface is INACTIVE (the leak fix)', () => {
    addGrouping('Work');
    const el = makeSelect();
    // This is the path the hidden-change subscription takes while the user is
    // in the tickets view: 2+ groupings, but the dashboard isn't active.
    refreshGroupingSelect({ selectEl: el, getScopeKey: () => 'dash', isActive: () => false });
    expect(el.style.display).toBe('none');
    expect(el.children.length).toBe(0);
  });

  it('re-hides on a refresh that flips inactive even after a prior active show', () => {
    addGrouping('Work');
    const el = makeSelect();
    refreshGroupingSelect({ selectEl: el, getScopeKey: () => 'dash', isActive: () => true });
    expect(el.style.display).toBe('');
    // Surface exits (e.g. user leaves the dashboard) → next subscription tick.
    refreshGroupingSelect({ selectEl: el, getScopeKey: () => 'dash', isActive: () => false });
    expect(el.style.display).toBe('none');
  });
});
