/**
 * HS-8232 — Tests for `terminal.tsx` core lifecycle. Pre-HS-8232 the
 * file (~1853 lines after HS-8194 / HS-8195 / HS-8221 / HS-8224
 * extractions) had zero direct test coverage. The extracted concerns
 * (gutterPopover / tabContextMenu / stallIndicator / renameDialog /
 * terminalCheckout / terminalReplay / terminalAppearance / etc.) all
 * have tests; the remaining surface tested here is the public-API
 * lifecycle exports + the bundled `terminalState` HS-8224 reset.
 *
 * Scope (per the ticket, "smaller scope to start"):
 * - `_resetStateForTesting` clears `instances` + swaps in fresh state.
 * - `getLastKnownTerminalConfigs` reads from the bundled state.
 * - `onProjectSwitch` resets `currentProjectSecret` + `lastKnownConfigs`
 *   + clears `instances`.
 * - `loadAndRenderTerminalTabs` Tauri-only gate (web returns early).
 * - `initTerminal` bell-subscription idempotency (HS-8224
 *   `terminalState.bellSubscribed` flag).
 *
 * The xterm mount path (`activateTerminal`, `ensureInstanceForEntry`,
 * `mountInstanceViaCheckout`) requires real `Terminal()` construction +
 * WebSocket attach, so it's left for a follow-up.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toElement } from './dom.js';
import { setActiveProject } from './state.js';
import type * as tauriIntegrationModule from './tauriIntegration.js';
import {
  _resetStateForTesting,
  getLastKnownTerminalConfigs,
  initTerminal,
  loadAndRenderTerminalTabs,
  onProjectSwitch,
} from './terminal.js';

const {
  getTauriInvokeMock,
  apiMock,
  subscribeToBellStateMock,
  bellUnsubMock,
} = vi.hoisted(() => ({
  getTauriInvokeMock: vi.fn<() => unknown>(() => null),
  apiMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  subscribeToBellStateMock: vi.fn(),
  bellUnsubMock: vi.fn(),
}));

vi.mock('./tauriIntegration.js', async () => {
  const actual = await vi.importActual<typeof tauriIntegrationModule>('./tauriIntegration.js');
  return {
    ...actual,
    getTauriInvoke: () => getTauriInvokeMock(),
  };
});

vi.mock('./api.js', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiWithSecret: (...args: unknown[]) => apiMock(...args),
  apiUpload: vi.fn(),
}));

vi.mock('./bellPoll.js', () => ({
  subscribeToBellState: (cb: unknown) => {
    subscribeToBellStateMock(cb);
    return bellUnsubMock;
  },
  fireToastsForActiveProject: vi.fn(),
}));

vi.mock('./drawerTerminalGrid.js', () => ({
  exitDrawerGridMode: vi.fn(),
  isDrawerGridActive: vi.fn<() => boolean>(() => false),
  onTerminalListUpdated: vi.fn(),
}));

const ACTIVE_SECRET = 'sec-terminal-tests';

function setupDom(): void {
  // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
  document.body.replaceChildren(
    toElement(<div id="drawer-terminal-tabs"></div>),
    toElement(<div id="drawer-terminal-panes"></div>),
    toElement(<button id="drawer-add-terminal-btn"></button>),
  );
}

beforeEach(() => {
  setupDom();
  setActiveProject({ name: 'Active', dataDir: '/tmp/active', secret: ACTIVE_SECRET });
  _resetStateForTesting();
});

afterEach(() => {
  _resetStateForTesting();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('_resetStateForTesting (HS-8224 / HS-8232)', () => {
  it('returns lastKnownConfigs to the empty default after reset', () => {
    expect(getLastKnownTerminalConfigs()).toEqual({ configured: [], dynamic: [] });
  });

  it('is idempotent — multiple resets in a row are safe', () => {
    _resetStateForTesting();
    _resetStateForTesting();
    expect(getLastKnownTerminalConfigs()).toEqual({ configured: [], dynamic: [] });
  });
});

describe('getLastKnownTerminalConfigs (HS-8232)', () => {
  it('returns the bundled-state snapshot', () => {
    const result = getLastKnownTerminalConfigs();
    expect(result).toHaveProperty('configured');
    expect(result).toHaveProperty('dynamic');
    expect(Array.isArray(result.configured)).toBe(true);
    expect(Array.isArray(result.dynamic)).toBe(true);
  });
});

describe('onProjectSwitch (HS-6309 / HS-8232)', () => {
  it('resets the bundled state to the empty default', () => {
    onProjectSwitch();
    expect(getLastKnownTerminalConfigs()).toEqual({ configured: [], dynamic: [] });
  });

  it('is idempotent — multiple calls in a row are safe', () => {
    onProjectSwitch();
    onProjectSwitch();
    expect(getLastKnownTerminalConfigs()).toEqual({ configured: [], dynamic: [] });
  });
});

describe('loadAndRenderTerminalTabs Tauri-only gate (HS-7977)', () => {
  it('returns early without calling the api when getTauriInvoke is null (web build)', async () => {
    getTauriInvokeMock.mockReturnValue(null);
    await loadAndRenderTerminalTabs();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('calls /terminal/list when getTauriInvoke returns a stub function (Tauri build)', async () => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
    apiMock.mockResolvedValue({ configured: [], dynamic: [], home: '/Users/test' });
    await loadAndRenderTerminalTabs();
    expect(apiMock).toHaveBeenCalledWith('/terminal/list');
  });

  it('persists the response to lastKnownConfigs', async () => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
    const list = {
      configured: [{ id: 't1', name: 'sh', command: 'sh' }],
      dynamic: [],
      home: '/Users/test',
    };
    apiMock.mockResolvedValue(list);
    await loadAndRenderTerminalTabs();
    const stored = getLastKnownTerminalConfigs();
    // The stored configs match the API response shape.
    expect(stored.configured).toEqual(list.configured);
    expect(stored.dynamic).toEqual(list.dynamic);
  });

  it('swallows api failures gracefully without throwing', async () => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
    apiMock.mockRejectedValue(new Error('network down'));
    await expect(loadAndRenderTerminalTabs()).resolves.toBeUndefined();
  });
});

describe('initTerminal — bell subscription idempotency (HS-8224)', () => {
  beforeEach(() => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
    subscribeToBellStateMock.mockClear();
  });

  it('subscribes to bell state on first init', () => {
    initTerminal();
    expect(subscribeToBellStateMock).toHaveBeenCalledOnce();
  });

  it('does NOT re-subscribe on a second init call (idempotent)', () => {
    initTerminal();
    initTerminal();
    initTerminal();
    expect(subscribeToBellStateMock).toHaveBeenCalledOnce();
  });

  it('re-subscribes after _resetStateForTesting (the bellSubscribed flag is cleared)', () => {
    initTerminal();
    expect(subscribeToBellStateMock).toHaveBeenCalledOnce();
    _resetStateForTesting();
    initTerminal();
    expect(subscribeToBellStateMock).toHaveBeenCalledTimes(2);
  });
});

describe('initTerminal — DOM wiring (HS-8232)', () => {
  beforeEach(() => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
  });

  it('binds a click handler to #drawer-add-terminal-btn for dynamic-terminal creation', () => {
    initTerminal();
    const btn = document.getElementById('drawer-add-terminal-btn') as HTMLButtonElement;
    apiMock.mockResolvedValue({ config: { id: 'dyn-1', command: 'sh', dynamic: true } });
    btn.click();
    // The click handler dispatches POST /terminal/create. Just assert that
    // the api fetch was invoked — full dynamic-terminal lifecycle (incl.
    // the subsequent xterm mount) is out of scope for this minimal test
    // suite; that's tracked in the HS-8232 ticket for a follow-up scope.
    expect(apiMock).toHaveBeenCalled();
    const calls = apiMock.mock.calls.map(c => c[0]);
    expect(calls).toContain('/terminal/create');
  });
});

/**
 * HS-8312 — drawer tab strip + pane container reconciled via parallel
 * bindLists. Pre-fix `loadAndRenderTerminalTabs` did
 * `tabStrip.innerHTML = '' + for-loop appendChild` on every poll tick,
 * churning DOM positions even when the terminal list was unchanged.
 * Post-fix surviving ids keep their `inst.tabBtn` / `inst.pane`
 * elements across rebuilds; removed ids drop; reorder shuffles via
 * `insertBefore` without destroying nodes.
 *
 * Tests use mocked `/terminal/list` responses to drive
 * `loadAndRenderTerminalTabs` without spinning up real xterm
 * instances. `createInstance` itself only builds DOM (no `Terminal()`
 * yet — that lands in `activateTerminal`), so it's safe under
 * happy-dom.
 */
describe('loadAndRenderTerminalTabs — drawer bindList identity (HS-8312)', () => {
  beforeEach(() => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
  });

  it('renders one tabBtn + pane per configured terminal in order', async () => {
    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    const tabs = document.querySelectorAll('#drawer-terminal-tabs > *');
    const panes = document.querySelectorAll('#drawer-terminal-panes > *');
    expect(tabs.length).toBe(2);
    expect(panes.length).toBe(2);
    expect((tabs[0] as HTMLElement).dataset.terminalId).toBe('t1');
    expect((tabs[1] as HTMLElement).dataset.terminalId).toBe('t2');
  });

  it('preserves tabBtn + pane DOM identity across a rebuild with the same list', async () => {
    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    const tabsBefore = Array.from(document.querySelectorAll('#drawer-terminal-tabs > *'));
    const panesBefore = Array.from(document.querySelectorAll('#drawer-terminal-panes > *'));

    // Second poll tick — same list, fresh response object.
    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();

    const tabsAfter = Array.from(document.querySelectorAll('#drawer-terminal-tabs > *'));
    const panesAfter = Array.from(document.querySelectorAll('#drawer-terminal-panes > *'));
    // Pre-fix every element would be a fresh node (innerHTML='' + re-append
    // had nuked the children). Post-fix the bindList preserves identity
    // for surviving ids → same element references survive the rebuild.
    expect(tabsAfter[0]).toBe(tabsBefore[0]);
    expect(tabsAfter[1]).toBe(tabsBefore[1]);
    expect(panesAfter[0]).toBe(panesBefore[0]);
    expect(panesAfter[1]).toBe(panesBefore[1]);
  });

  it('reorders surviving rows via insertBefore — same element instances, new positions', async () => {
    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    const t1Before = document.querySelector('#drawer-terminal-tabs > [data-terminal-id="t1"]');
    const t2Before = document.querySelector('#drawer-terminal-tabs > [data-terminal-id="t2"]');

    // Reorder.
    apiMock.mockResolvedValue({
      configured: [
        { id: 't2', name: 'two', command: 'sh' },
        { id: 't1', name: 'one', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();

    const tabsAfter = Array.from(document.querySelectorAll('#drawer-terminal-tabs > *'));
    expect(tabsAfter[0]).toBe(t2Before);
    expect(tabsAfter[1]).toBe(t1Before);
  });

  it('drops the tabBtn + pane for an id that disappears from the response', async () => {
    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    expect(document.querySelectorAll('#drawer-terminal-tabs > *').length).toBe(2);

    apiMock.mockResolvedValue({
      configured: [{ id: 't1', name: 'one', command: 'sh' }],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    const tabs = document.querySelectorAll('#drawer-terminal-tabs > *');
    const panes = document.querySelectorAll('#drawer-terminal-panes > *');
    expect(tabs.length).toBe(1);
    expect(panes.length).toBe(1);
    expect((tabs[0] as HTMLElement).dataset.terminalId).toBe('t1');
  });

  it('appends a freshly-added id to the end of the strip without disturbing existing tabs', async () => {
    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    const t1Before = document.querySelector('#drawer-terminal-tabs > [data-terminal-id="t1"]');
    const t2Before = document.querySelector('#drawer-terminal-tabs > [data-terminal-id="t2"]');

    apiMock.mockResolvedValue({
      configured: [
        { id: 't1', name: 'one', command: 'sh' },
        { id: 't2', name: 'two', command: 'sh' },
        { id: 't3', name: 'three', command: 'sh' },
      ],
      dynamic: [],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();

    const tabsAfter = Array.from(document.querySelectorAll('#drawer-terminal-tabs > *'));
    expect(tabsAfter.length).toBe(3);
    expect(tabsAfter[0]).toBe(t1Before);
    expect(tabsAfter[1]).toBe(t2Before);
    expect((tabsAfter[2] as HTMLElement).dataset.terminalId).toBe('t3');
  });
});
