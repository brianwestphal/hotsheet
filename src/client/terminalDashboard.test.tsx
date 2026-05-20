// @vitest-environment happy-dom
//
// HS-7948 / HS-8176 / HS-8290 — pure unit tests for the persisted-column-
// count parser used by the terminal dashboard's scale-slider hydration
// path. Post-HS-8290 the value lives in global config under
// `dashboard.columnsPerRow`; the legacy `dashboard_slider_value` 0..100
// shape was dropped (no migration since the feature wasn't public).
//
// HS-8341 — DOM-level tests for `attachDedicatedBarSearch`, the helper
// that mounts the terminal-search widget into the dedicated-view top bar
// (the fixed-position `.terminal-dashboard-dedicated-bar`). Pre-fix the
// widget mounted into a slot in the app-header that was always occluded
// by the dedicated overlay, so the user never saw it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toElement } from './dom.js';
import { attachDedicatedBarSearch, parsePersistedColumnCount } from './terminalDashboard.js';
import { _resetTerminalSearchForTests } from './terminalSearch.js';

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
    onDidChangeResults = (): { dispose: () => void } => ({ dispose: vi.fn() });
  },
}));

describe('parsePersistedColumnCount (HS-8290)', () => {
  it('accepts the column-count value (integer 1..10)', () => {
    expect(parsePersistedColumnCount(1)).toBe(1);
    expect(parsePersistedColumnCount(4)).toBe(4);
    expect(parsePersistedColumnCount(10)).toBe(10);
  });

  it('accepts a stringified integer', () => {
    expect(parsePersistedColumnCount('5')).toBe(5);
    expect(parsePersistedColumnCount('1')).toBe(1);
  });

  it('rejects out-of-range values', () => {
    expect(parsePersistedColumnCount(0)).toBeNull();
    expect(parsePersistedColumnCount(11)).toBeNull();
    expect(parsePersistedColumnCount(99)).toBeNull();
    expect(parsePersistedColumnCount(-3)).toBeNull();
  });

  it('rejects non-numeric strings', () => {
    expect(parsePersistedColumnCount('abc')).toBeNull();
    expect(parsePersistedColumnCount('')).toBeNull();
  });

  it('rejects NaN / Infinity', () => {
    expect(parsePersistedColumnCount(Number.NaN)).toBeNull();
    expect(parsePersistedColumnCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rejects undefined / null', () => {
    expect(parsePersistedColumnCount(undefined)).toBeNull();
    expect(parsePersistedColumnCount(null)).toBeNull();
  });

  it('rejects non-scalar inputs', () => {
    expect(parsePersistedColumnCount({})).toBeNull();
    expect(parsePersistedColumnCount([])).toBeNull();
    expect(parsePersistedColumnCount(true)).toBeNull();
  });
});

describe('attachDedicatedBarSearch (HS-8341)', () => {
  function makeTermStub(): { focus: () => void; loadAddon: ReturnType<typeof vi.fn> } {
    return { focus: () => { /* noop */ }, loadAddon: vi.fn() };
  }

  beforeEach(() => {
    _resetTerminalSearchForTests();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1; });
    // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
    document.body.replaceChildren(toElement(<div className="terminal-dashboard-dedicated-bar"></div>));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('appends the search widget root to the dedicated bar element', () => {
    const bar = document.querySelector<HTMLElement>('.terminal-dashboard-dedicated-bar')!;
    const term = makeTermStub();
    const { handle } = attachDedicatedBarSearch(bar, term as never, 'my-terminal');
    // The widget root sits inside the bar, so the right-aligned `margin-
    // left:auto` rule on `.terminal-dashboard-dedicated-bar > .terminal-
    // search-box` can resolve. Pre-fix the root lived in the app-header.
    expect(bar.querySelector('.terminal-search-box')).toBe(handle.root);
    expect(handle.root.parentElement).toBe(bar);
  });

  it('threads the entry label into the input placeholder', () => {
    const bar = document.querySelector<HTMLElement>('.terminal-dashboard-dedicated-bar')!;
    const term = makeTermStub();
    const { handle } = attachDedicatedBarSearch(bar, term as never, 'claude');
    const input = handle.root.querySelector<HTMLInputElement>('.terminal-search-input')!;
    expect(input.placeholder).toBe('Search claude');
  });

  it('loads a SearchAddon onto the live xterm exactly once', () => {
    const bar = document.querySelector<HTMLElement>('.terminal-dashboard-dedicated-bar')!;
    const term = makeTermStub();
    attachDedicatedBarSearch(bar, term as never, 'my-terminal');
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('dispose() removes the widget root from the bar (idempotent)', () => {
    const bar = document.querySelector<HTMLElement>('.terminal-dashboard-dedicated-bar')!;
    const term = makeTermStub();
    const { dispose } = attachDedicatedBarSearch(bar, term as never, 'my-terminal');
    expect(bar.querySelector('.terminal-search-box')).not.toBeNull();
    dispose();
    expect(bar.querySelector('.terminal-search-box')).toBeNull();
    // Idempotent — a second dispose is a no-op (already-removed root +
    // already-disposed handle both swallow gracefully).
    expect(() => { dispose(); }).not.toThrow();
  });
});
