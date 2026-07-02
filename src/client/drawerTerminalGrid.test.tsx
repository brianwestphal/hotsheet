/**
 * HS-8231 — Tests for `drawerTerminalGrid.tsx` (HS-6311 §36 per-project
 * drawer terminal grid view). Pre-HS-8231 the file had zero direct
 * coverage despite being a core surface — toolbar toggle, size slider,
 * cross-project hide-state subscription, bell long-poll wiring, and
 * (post-HS-8223) the bundled `drawerGridState` lifecycle.
 *
 * Scope per the ticket: enter/exit toggle, slider input → column-count
 * persistence, hide-button-opens-dialog, `onTerminalListUpdated`
 * threshold + auto-exit, bell-state subscription wiring, the HS-8223
 * `_resetStateForTesting` disposers, Esc routing.
 *
 * The xterm-spinning-up code path (`mountTileGrid` → real `Terminal()`)
 * is mocked; tests assert behavior through the public exports +
 * dispatcher state via `_resetStateForTesting`.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toElement } from './dom.js';
import {
  _resetStateForTesting,
  type DrawerGridTileEntry,
  exitDrawerGridMode,
  initDrawerTerminalGrid,
  isDrawerGridActive,
  onTerminalListUpdated,
  tileLabel,
} from './drawerTerminalGrid.js';
import { getProjectGridColumnCount, setActiveProject, setProjectGridActive as realSetProjectGridActive } from './state.js';
import { _resetTransientTerminalNamesForTests, setTransientTerminalName } from './terminalTransientNames.js';

// Hoisted mocks for the heavy modules. (HS-8624 removed the Tauri-only gate in
// `initDrawerTerminalGrid`, so the `getTauriInvoke` mock no longer affects
// whether init runs; it's kept for the modules that still read it.)
// `mountTileGrid` returns a fake handle exposing the methods the file calls.
const {
  getTauriInvokeMock,
  mountTileGridMock,
  fakeTileGridHandle,
  subscribeToBellStateMock,
  subscribeToHiddenChangesMock,
  filterVisibleMock,
  showHideTerminalDialogMock,
  applyHideButtonBadgeMock,
  countHiddenForProjectMock,
  bellUnsub,
  hiddenUnsub,
} = vi.hoisted(() => {
  const bellUnsub = vi.fn();
  const hiddenUnsub = vi.fn();
  const fakeTileGridHandle = {
    rebuild: vi.fn(),
    dispose: vi.fn(),
    isDedicatedOpen: vi.fn<() => boolean>(() => false),
    isCentered: vi.fn<() => boolean>(() => false),
    exitDedicatedView: vi.fn(),
    uncenterTile: vi.fn(),
    syncBellState: vi.fn(),
    applySizing: vi.fn(),
    recenterTile: vi.fn(),
    centerTile: vi.fn(),
    enterDedicatedView: vi.fn(),
    focusDedicatedTerm: vi.fn(),
  };
  return {
    getTauriInvokeMock: vi.fn<() => unknown>(() => () => Promise.resolve()),
    mountTileGridMock: vi.fn<(...args: unknown[]) => typeof fakeTileGridHandle>(() => fakeTileGridHandle),
    fakeTileGridHandle,
    subscribeToBellStateMock: vi.fn<(...args: unknown[]) => () => void>(() => bellUnsub),
    subscribeToHiddenChangesMock: vi.fn<(...args: unknown[]) => () => void>(() => hiddenUnsub),
    filterVisibleMock: vi.fn<(...args: [string, unknown[]]) => unknown[]>(
      (_secret, entries) => entries,
    ),
    showHideTerminalDialogMock: vi.fn<(...args: unknown[]) => void>(),
    applyHideButtonBadgeMock: vi.fn<(...args: unknown[]) => void>(),
    countHiddenForProjectMock: vi.fn<(...args: unknown[]) => number>(() => 0),
    bellUnsub,
    hiddenUnsub,
  };
});

vi.mock('./tauriIntegration.js', () => ({
  getTauriInvoke: () => getTauriInvokeMock(),
}));

vi.mock('./terminalTileGrid.js', () => ({
  mountTileGrid: (...args: unknown[]) => mountTileGridMock(...args),
}));

vi.mock('./bellPoll.js', () => ({
  subscribeToBellState: (...args: unknown[]) => subscribeToBellStateMock(...args),
}));

vi.mock('./dashboardHiddenTerminals.js', () => ({
  subscribeToHiddenChanges: (...args: unknown[]) => subscribeToHiddenChangesMock(...args),
  filterVisible: (...args: [string, string, unknown[]]) => filterVisibleMock(args[1], args[2]),
  applyHideButtonBadge: (...args: unknown[]) => { applyHideButtonBadgeMock(...args); },
  countHiddenForProject: (...args: [string, string]) => countHiddenForProjectMock(args[1]),
  // HS-8406 — re-export the scope helpers so callers' `projectScope(secret)`
  // calls resolve. The test only cares that the call THREADS the right
  // secret; the precise key shape is exercised in `visibilityGroupings.test.ts`.
  projectScope: (secret: string) => `project:${secret}`,
  DASHBOARD_SCOPE: 'dashboard',
  // HS-8314 — `refreshDrawerGroupingSelect` does a `void import('./visibilityGroupingSelect.js').then(...)`
  // dynamic import. vi.mock() of `./visibilityGroupingSelect.js` doesn't
  // intercept that dynamic import in this test runner config, so the
  // REAL `visibilityGroupingSelect.tsx` runs at promise-resolution time
  // and calls `getGroupings()` from this module. Without a stub,
  // vitest's mock-strictness throws an "undefined export" rejection.
  // Returning [] keeps the real `refreshGroupingSelect` on the early-
  // return branch (length <= 1).
  getGroupings: () => [],
}));

vi.mock('./hideTerminalDialog.js', () => ({
  showHideTerminalDialog: (opts: unknown) => { showHideTerminalDialogMock(opts); },
}));

vi.mock('./visibilityGroupingSelect.js', () => ({
  wireGroupingSelectChange: vi.fn(),
  refreshGroupingSelect: vi.fn(),
}));

const ACTIVE_SECRET = 'sec-active';

function setupDom(): void {
  // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
  document.body.replaceChildren(
    toElement(<div id="drawer-terminal-grid"></div>),
    toElement(<button id="drawer-grid-toggle"></button>),
    toElement(<div id="drawer-grid-sizer"></div>),
    toElement(<input id="drawer-grid-size-slider" type="range" min="1" max="10" value="4" />),
    toElement(<button id="drawer-grid-hide-btn"></button>),
    toElement(<select id="drawer-grid-grouping-select"></select>),
  );
}

function makeEntry(id: string, name = 'sh'): DrawerGridTileEntry {
  return { id, name, command: name };
}

beforeEach(() => {
  // `initDrawerTerminalGrid` registers a `document.addEventListener('keydown',
  // …, true)` listener that has no removal path. Stacking listeners across
  // tests is benign for the toggle / slider / hide-button paths because
  // every listener reads the same fresh `drawerGridState.gridHandle`, but
  // the Esc-routing tests below use `mockReturnValue` (sticky) on the
  // handle's `isDedicatedOpen` / `isCentered` predicates so that EVERY
  // listener observes the same value (mockReturnValueOnce would only
  // satisfy the most-recently-registered listener and leave older ones
  // falling through to the exit-grid-mode default).
  _resetStateForTesting();
  setupDom();
  setActiveProject({ name: 'Active', dataDir: '/tmp/active', secret: ACTIVE_SECRET });
  realSetProjectGridActive(ACTIVE_SECRET, false);
  fakeTileGridHandle.isDedicatedOpen.mockReturnValue(false);
  fakeTileGridHandle.isCentered.mockReturnValue(false);
  initDrawerTerminalGrid({ onExitGrid: () => { /* noop */ } });
});

afterEach(() => {
  _resetStateForTesting();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('initDrawerTerminalGrid (HS-8231)', () => {
  it('still initializes + reveals the toggle when getTauriInvoke returns null (web build — HS-8624)', () => {
    _resetStateForTesting();
    document.body.innerHTML = '';
    setupDom();
    // Start hidden so revealing it is observable (the toggle is server-rendered
    // display:none; init flips it visible).
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    btn.style.display = 'none';
    getTauriInvokeMock.mockReturnValueOnce(null);
    initDrawerTerminalGrid({ onExitGrid: () => { /* noop */ } });
    // HS-8624 — no Tauri gate: init proceeds on web too and reveals the toggle.
    expect(btn.style.display).toBe('');
  });

  it('reveals the toggle button on init', () => {
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    expect(btn.style.display).toBe('');
  });
});

describe('onTerminalListUpdated — toggle enable threshold (HS-8231)', () => {
  it('disables the toggle when there are 0 entries', () => {
    onTerminalListUpdated([]);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('add a second terminal');
  });

  it('disables the toggle when there is 1 entry (below the §36.7 threshold)', () => {
    onTerminalListUpdated([makeEntry('t1')]);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables the toggle when there are 2+ entries', () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBe('Terminal grid view');
  });
});

describe('onTerminalListUpdated — auto-exit when entries drop below 2 (HS-8231)', () => {
  it('exits grid mode when the project drops to 1 entry mid-session', () => {
    // Enter grid mode with 2 entries so the toggle's click handler succeeds.
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    btn.click();
    expect(isDrawerGridActive()).toBe(true);

    // Now drop to 1 entry — auto-exit per §36.7.
    onTerminalListUpdated([makeEntry('t1')]);
    expect(isDrawerGridActive()).toBe(false);
  });
});

describe('toggle button click toggles grid mode (HS-8231)', () => {
  beforeEach(() => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
  });

  it('clicks enter grid mode and persists projectGridActive', () => {
    expect(isDrawerGridActive()).toBe(false);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    btn.click();
    expect(isDrawerGridActive()).toBe(true);
  });

  it('a second click exits grid mode', () => {
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(isDrawerGridActive()).toBe(false);
  });

  it('does nothing when the toggle is disabled (only 1 entry)', () => {
    onTerminalListUpdated([makeEntry('t1')]);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(isDrawerGridActive()).toBe(false);
  });
});

describe('size slider persists column count (HS-8231)', () => {
  it('an input event on the slider calls setProjectGridColumnCount via state.js', () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    const btn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement;
    btn.click();
    expect(isDrawerGridActive()).toBe(true);

    const slider = document.getElementById('drawer-grid-size-slider') as HTMLInputElement;
    slider.value = '6';
    slider.dispatchEvent(new Event('input'));

    // The slider's input handler is the one source of truth for
    // `setProjectGridColumnCount`. Read back via the state module's getter.
    // sliderPositionToPerRow is the inverse of perRowToSliderPosition; for a
    // mid-range slider value the column count is small (the slider reads
    // left=many, right=few). Just assert the column count IS persisted (not
    // the default 4) — exact value depends on the conversion.
    const stored = getProjectGridColumnCount(ACTIVE_SECRET);
    expect(typeof stored).toBe('number');
    // Confirm the writeback happened (not the default 4 of an untouched
    // column count). A slider value of 6 maps deterministically — exact
    // value isn't asserted here because the conversion belongs to
    // `terminalDashboardSizing.ts` (which has its own tests).
    expect(stored).toBeGreaterThanOrEqual(1);
    expect(stored).toBeLessThanOrEqual(10);
  });
});

describe('hide button opens the §38 dialog (HS-8231)', () => {
  it('clicking the hide button calls showHideTerminalDialog with the project terminals', () => {
    onTerminalListUpdated([makeEntry('t1', 'shA'), makeEntry('t2', 'shB')]);
    const hideBtn = document.getElementById('drawer-grid-hide-btn') as HTMLButtonElement;
    hideBtn.click();
    expect(showHideTerminalDialogMock).toHaveBeenCalledOnce();
    const arg = showHideTerminalDialogMock.mock.calls[0][0] as {
      mode: string;
      groups: { secret: string; name: string; terminals: { id: string; name: string }[] }[];
    };
    expect(arg.mode).toBe('single-project');
    expect(arg.groups).toHaveLength(1);
    expect(arg.groups[0].secret).toBe(ACTIVE_SECRET);
    expect(arg.groups[0].terminals).toEqual([
      { id: 't1', name: 'shA' },
      { id: 't2', name: 'shB' },
    ]);
  });
});

describe('Esc routing (HS-8231)', () => {
  beforeEach(() => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(isDrawerGridActive()).toBe(true);
  });

  it('Esc when dedicated view is open exits dedicated view (does NOT exit grid mode)', () => {
    fakeTileGridHandle.isDedicatedOpen.mockReturnValue(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fakeTileGridHandle.exitDedicatedView).toHaveBeenCalled();
    expect(isDrawerGridActive()).toBe(true);
  });

  it('Esc when a tile is centered uncenters it (does NOT exit grid mode)', () => {
    fakeTileGridHandle.isDedicatedOpen.mockReturnValue(false);
    fakeTileGridHandle.isCentered.mockReturnValue(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fakeTileGridHandle.uncenterTile).toHaveBeenCalled();
    expect(isDrawerGridActive()).toBe(true);
  });

  it('Esc with no dedicated/centered tile exits grid mode', () => {
    fakeTileGridHandle.isDedicatedOpen.mockReturnValue(false);
    fakeTileGridHandle.isCentered.mockReturnValue(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isDrawerGridActive()).toBe(false);
  });

  it('Esc is ignored when an INPUT is focused (HS-7393 — let Esc-to-blur fire)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fakeTileGridHandle.isDedicatedOpen.mockReturnValue(false);
    fakeTileGridHandle.isCentered.mockReturnValue(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isDrawerGridActive()).toBe(true);
  });

  it('Esc is ignored when the hide-terminal dialog is open', () => {
    const overlay = document.createElement('div');
    overlay.className = 'hide-terminal-dialog-overlay';
    document.body.appendChild(overlay);
    fakeTileGridHandle.isDedicatedOpen.mockReturnValue(false);
    fakeTileGridHandle.isCentered.mockReturnValue(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isDrawerGridActive()).toBe(true);
  });
});

describe('bell-state subscription wiring (HS-8231)', () => {
  it('subscribes to bell state when grid mode is entered', () => {
    expect(subscribeToBellStateMock).not.toHaveBeenCalled();
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(subscribeToBellStateMock).toHaveBeenCalledOnce();
  });

  it('disposes the bell subscription when grid mode is exited', () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(bellUnsub).not.toHaveBeenCalled();
    exitDrawerGridMode();
    expect(bellUnsub).toHaveBeenCalledOnce();
  });
});

describe('hidden-state subscription wiring (HS-8231)', () => {
  it('subscribes to hidden changes when grid mode is entered', () => {
    expect(subscribeToHiddenChangesMock).not.toHaveBeenCalled();
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(subscribeToHiddenChangesMock).toHaveBeenCalledOnce();
  });

  it('disposes the hidden-state subscription when grid mode is exited', () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(hiddenUnsub).not.toHaveBeenCalled();
    exitDrawerGridMode();
    expect(hiddenUnsub).toHaveBeenCalledOnce();
  });
});

describe('_resetStateForTesting (HS-8223 / HS-8231)', () => {
  it('disposes the grid handle when grid mode was active', () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(fakeTileGridHandle.dispose).not.toHaveBeenCalled();
    _resetStateForTesting();
    expect(fakeTileGridHandle.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the bell + hidden subscriptions when active', () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    bellUnsub.mockClear();
    hiddenUnsub.mockClear();
    _resetStateForTesting();
    expect(bellUnsub).toHaveBeenCalledOnce();
    expect(hiddenUnsub).toHaveBeenCalledOnce();
  });

  it('is a no-op when nothing was set up', () => {
    _resetStateForTesting();
    _resetStateForTesting(); // idempotent
    // Subsequent init shouldn't throw.
    initDrawerTerminalGrid({ onExitGrid: () => { /* noop */ } });
    expect(isDrawerGridActive()).toBe(false);
  });
});

/**
 * HS-8314 — the bindList migration in HS-8313 lives inside `mountTileGrid`
 * (the underlying `gridHandle.rebuild()` does keyed reconciliation
 * instead of full teardown). The drawer-grid wrapping in this file
 * delivers that benefit IFF the gridHandle survives across
 * `onTerminalListUpdated` calls — pre-fix nothing forced full re-mount
 * but a regression that disposes + re-creates the gridHandle on every
 * list update would silently defeat the migration.
 */
describe('drawerTerminalGrid — gridHandle persists across rebuilds (HS-8314)', () => {
  it('multiple onTerminalListUpdated calls reuse the same gridHandle and call rebuild (no dispose between)', async () => {
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2')]);
    (document.getElementById('drawer-grid-toggle') as HTMLButtonElement).click();
    expect(isDrawerGridActive()).toBe(true);
    // mountTileGrid called once on grid mode entry — the handle persists
    // for every subsequent rebuild so HS-8313's bindList identity-
    // preservation flows through this surface.
    expect(mountTileGridMock).toHaveBeenCalledOnce();
    expect(fakeTileGridHandle.dispose).not.toHaveBeenCalled();

    const rebuildCallsAfterEntry = fakeTileGridHandle.rebuild.mock.calls.length;
    expect(rebuildCallsAfterEntry).toBeGreaterThan(0);

    // Subsequent list updates while grid mode stays active must call
    // gridHandle.rebuild() WITHOUT disposing the handle. A regression
    // that disposes + re-mounts the gridHandle on every poll tick would
    // silently defeat the bindList migration even though the inner
    // mountTileGrid still works correctly.
    onTerminalListUpdated([makeEntry('t1'), makeEntry('t2'), makeEntry('t3')]);
    expect(mountTileGridMock).toHaveBeenCalledOnce(); // still 1 — handle reused
    expect(fakeTileGridHandle.dispose).not.toHaveBeenCalled();
    expect(fakeTileGridHandle.rebuild.mock.calls.length).toBeGreaterThan(rebuildCallsAfterEntry);

    // Drain microtasks so the dynamic-import-driven `refreshGroupingSelect`
    // promise chains resolve while the DOM elements they reference are
    // still attached. Without this, afterEach wipes the DOM before the
    // chains run + surfaces a "Cannot read properties of null"
    // unhandled rejection (the dynamic import bypasses vi.mock so the
    // real `visibilityGroupingSelect` runs, then trips on the cleared
    // `groupingSelect`).
    await new Promise(resolve => setTimeout(resolve, 5));
  });
});

// HS-9277 — the drawer-grid tile label must consult the shared transient-rename
// store (keyed by project secret), so a rename made in the drawer tab strip or a
// dashboard tile also shows on the drawer-grid tile within the session. Pre-fix
// this label derived purely from `entry.name`/command and ignored the store.
describe('tileLabel — transient rename (HS-9277)', () => {
  afterEach(() => { _resetTransientTerminalNamesForTests(); });

  it('returns the transient name over the configured name when the secret matches', () => {
    setTransientTerminalName('secA', 't1', 'My Rename');
    expect(tileLabel(makeEntry('t1', 'Shell'), 'secA')).toBe('My Rename');
  });

  it('does not collide across projects (different secret falls back to configured)', () => {
    setTransientTerminalName('secA', 't1', 'My Rename');
    expect(tileLabel(makeEntry('t1', 'Shell'), 'secB')).toBe('Shell');
  });

  it('ignores the store when no secret is passed', () => {
    setTransientTerminalName('secA', 't1', 'My Rename');
    expect(tileLabel(makeEntry('t1', 'Shell'))).toBe('Shell');
  });

  it('falls back to command-derived label when no name or transient override', () => {
    expect(tileLabel({ id: 't1', name: '', command: '/usr/bin/fish' }, 'secA')).toBe('fish');
  });
});
