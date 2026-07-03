// @vitest-environment happy-dom
// HS-9145 — branch coverage for the command-log type filter (multi-select dropdown).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_FILTER_TYPES,
  dismissFilterDropdown,
  getFilterLabel,
  showFilterDropdown,
} from './commandLogFilter.js';
import { commandLogStore } from './commandLogStore.js';

const ALL = new Set(ALL_FILTER_TYPES.map(t => t.value));
const setTypes = (values: string[]) => commandLogStore.actions.setFilterTypes(new Set(values));

afterEach(() => {
  dismissFilterDropdown(); // reset the module-level `filterDropdownOpen` between tests
  setTypes([...ALL]);
  document.body.replaceChildren();
});

describe('getFilterLabel', () => {
  it('"All types" when every type is selected', () => {
    setTypes([...ALL]);
    expect(getFilterLabel()).toBe('All types');
  });
  it('"None" when nothing is selected', () => {
    setTypes([]);
    expect(getFilterLabel()).toBe('None');
  });
  it('the single type\'s label when exactly one is selected', () => {
    setTypes(['trigger']);
    expect(getFilterLabel()).toBe('Triggers');
  });
  it('the raw value when the single selected type is unknown', () => {
    setTypes(['mystery']);
    expect(getFilterLabel()).toBe('mystery');
  });
  it('"N types" when several (but not all) are selected', () => {
    setTypes(['trigger', 'done']);
    expect(getFilterLabel()).toBe('2 types');
  });
});

function installButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'command-log-filter-btn';
  btn.appendChild(document.createElement('span'));
  document.body.appendChild(btn);
  return btn;
}

describe('showFilterDropdown / dismissFilterDropdown', () => {
  beforeEach(() => setTypes([...ALL]));

  it('is a no-op when the filter button is absent', () => {
    const onChange = vi.fn();
    expect(() => showFilterDropdown(onChange)).not.toThrow();
    expect(document.querySelector('.command-log-filter-dropdown')).toBeNull();
  });

  it('opens a dropdown with one option per type + a "Deselect All" toggle when all selected', () => {
    const btn = installButton();
    showFilterDropdown(vi.fn());
    const dropdown = document.querySelector('.command-log-filter-dropdown');
    expect(dropdown).not.toBeNull();
    expect(dropdown!.querySelectorAll('.filter-option')).toHaveLength(ALL_FILTER_TYPES.length);
    expect(dropdown!.querySelector('.filter-toggle-all')!.textContent).toBe('Deselect All');
    expect(btn.classList.contains('active')).toBe(true);
  });

  it('shows "Select All" when not everything is selected', () => {
    setTypes(['trigger']);
    installButton();
    showFilterDropdown(vi.fn());
    expect(document.querySelector('.filter-toggle-all')!.textContent).toBe('Select All');
  });

  it('a second call while open dismisses (toggle behavior)', () => {
    installButton();
    showFilterDropdown(vi.fn());
    expect(document.querySelector('.command-log-filter-dropdown')).not.toBeNull();
    showFilterDropdown(vi.fn());
    expect(document.querySelector('.command-log-filter-dropdown')).toBeNull();
  });

  it('clicking an option toggles that type off + fires onFilterChange', () => {
    installButton();
    const onChange = vi.fn();
    showFilterDropdown(onChange);
    const triggerOpt = document.querySelector('.filter-option[data-type="trigger"]') as HTMLElement;
    triggerOpt.click();
    expect(commandLogStore.state.value.filter.types.has('trigger')).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
    // toggle label flips off "Deselect All" once the set is no longer full
    expect(document.querySelector('.filter-toggle-all')!.textContent).toBe('Select All');
  });

  it('clicking an unchecked option toggles it back on', () => {
    setTypes(['done']);
    installButton();
    showFilterDropdown(vi.fn());
    const triggerOpt = document.querySelector('.filter-option[data-type="trigger"]') as HTMLElement;
    triggerOpt.click();
    expect(commandLogStore.state.value.filter.types.has('trigger')).toBe(true);
  });

  it('"Deselect All" clears every type; then "Select All" restores them', () => {
    installButton();
    const onChange = vi.fn();
    showFilterDropdown(onChange);
    const toggle = document.querySelector('.filter-toggle-all') as HTMLElement;
    toggle.click(); // deselect all
    expect(commandLogStore.state.value.filter.types.size).toBe(0);
    expect(toggle.textContent).toBe('Select All');
    toggle.click(); // select all
    expect(commandLogStore.state.value.filter.types.size).toBe(ALL_FILTER_TYPES.length);
    expect(toggle.textContent).toBe('Deselect All');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('dismissFilterDropdown removes the dropdown + the button active class', () => {
    const btn = installButton();
    showFilterDropdown(vi.fn());
    dismissFilterDropdown();
    expect(document.querySelector('.command-log-filter-dropdown')).toBeNull();
    expect(btn.classList.contains('active')).toBe(false);
  });
});
