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
 * - `loadAndRenderTerminalTabs` loads on web + Tauri (HS-8624 — web terminals).
 * - `initTerminal` bell-subscription idempotency (HS-8224
 *   `terminalState.bellSubscribed` flag).
 *
 * The xterm mount path (`activateTerminal`, `ensureInstanceForEntry`,
 * `mountInstanceViaCheckout`) requires real `Terminal()` construction +
 * WebSocket attach, so it's left for a follow-up.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from '../api/_runner.js';
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
import { initInstanceLifecycle } from './terminalInstanceLifecycle.js';

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
  // HS-8630 — terminal.tsx now calls the typed `listTerminals` / `createTerminal`
  // / `clearTerminalBell`, which route through the `_runner` transport. Wire it
  // to `apiMock` so the existing fixtures + call assertions still drive them.
  setApiTransport((path, opts) => apiMock(path, opts));
  setActiveProject({ name: 'Active', dataDir: '/tmp/active', secret: ACTIVE_SECRET });
  _resetStateForTesting();
});

afterEach(() => {
  _resetStateForTesting();
  vi.clearAllMocks();
  setApiTransport(null as unknown as ApiTransport);
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

describe('loadAndRenderTerminalTabs — web + Tauri (HS-8624)', () => {
  it('loads /terminal/list even when getTauriInvoke is null (web build) — HS-8624 enabled web terminals', async () => {
    getTauriInvokeMock.mockReturnValue(null);
    apiMock.mockResolvedValue({ configured: [], dynamic: [], home: '/Users/test' });
    await loadAndRenderTerminalTabs();
    // Pre-HS-8624 this returned early on web; terminals now work in the browser.
    expect(apiMock.mock.calls.some(c => c[0] === '/terminal/list')).toBe(true);
  });

  it('calls /terminal/list when getTauriInvoke returns a stub function (Tauri build)', async () => {
    getTauriInvokeMock.mockReturnValue(() => Promise.resolve());
    apiMock.mockResolvedValue({ configured: [], dynamic: [], home: '/Users/test' });
    await loadAndRenderTerminalTabs();
    expect(apiMock.mock.calls.some(c => c[0] === '/terminal/list')).toBe(true);
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

  // HS-8562 — the close glyph for dynamic terminals MUST NOT be a real
  // `<button>` nested inside the outer tab `<button>`. HTML5's parser
  // treats nested buttons as a parse error and auto-closes the outer
  // button when it sees the inner one, producing two sibling buttons.
  // happy-dom (this test's environment) does NOT enforce that rule, so
  // a parsed-DOM assertion would silently pass even with the bug. We
  // assert directly on the rendered `outerHTML` string instead — that
  // matches what the real browser parser actually sees.
  //
  // Symptoms before the fix:
  //  - kerfjs 0.12.0's `toElement` returns a `DocumentFragment` for the
  //    multi-root parse (kerfjs 0.11.1 silently dropped the trailing
  //    siblings; the close glyph was missing but the outer button
  //    survived as an `HTMLElement`).
  //  - `DocumentFragment` has no `classList` / `style` / `remove`, so
  //    `activateTerminal`'s `other.tabBtn.classList.toggle('active', …)`
  //    throws — the new pane never mounts and the user sees "creates a
  //    new tab but no terminal ever actually shows up".
  //  - On the next project switch, the bindList tear-down skips the
  //    fragment-cached entry (its `parentNode` is null), but the actual
  //    leftover sibling buttons stay in the DOM, so subsequent rebuilds
  //    interleave fresh + stale tabs and the user's existing terminals
  //    appear to disappear.
  it('renders a dynamic tab without nesting a <button> inside the outer <button> (HS-8562)', async () => {
    apiMock.mockResolvedValue({
      configured: [],
      dynamic: [{ id: 'dyn-1', name: 'sh', command: 'sh', dynamic: true }],
      home: '/Users/test',
    });
    await loadAndRenderTerminalTabs();
    const tab = document.querySelector<HTMLElement>('#drawer-terminal-tabs > [data-terminal-id="dyn-1"]');
    expect(tab).not.toBeNull();
    // The outer tab is itself a <button>; the close glyph must be
    // something else (a span, per the fix) so the rendered HTML has
    // exactly one `<button` opening tag.
    const buttonOpenTags = (tab!.outerHTML.match(/<button\b/gi) ?? []).length;
    expect(buttonOpenTags).toBe(1);
    // And the close glyph is still findable by class (now a span).
    expect(tab!.querySelector('.drawer-tab-close')).not.toBeNull();
  });

  // HS-8562 — surface the bug at the boundary so future maintainers see
  // a clear callsite-named error instead of a silent classList throw
  // halfway through a downstream DOM mutation.
  it('toElement throws when JSX renders multi-root HTML (HS-8562 hardening)', async () => {
    const { toElement } = await import('./dom.js');
    const { raw } = await import('../jsx-runtime.js');
    // Force a multi-root HTML output by handing the runtime two top-
    // level elements via `raw()` — happy-dom's template parser keeps
    // both as siblings (unlike the nested-button case, which happy-dom
    // doesn't split — see test above).
    expect(() => toElement(raw('<span>one</span><span>two</span>'))).toThrow(/DocumentFragment/);
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

/**
 * HS-8657 — middle-click (auxclick button 1) closes a terminal tab, matching
 * macOS Terminal.app + the X button. Gated on `dynamic`: configured terminals
 * aren't closeable. Right-click (button 2) routes to the context menu, not close.
 * The test PTYs aren't alive (no real websocket), so `closeDynamicTerminal`
 * skips the confirm dialog and destroys + removes the tab directly — the
 * alive-only confirm path is covered by the existing X-button / context-menu
 * close coverage.
 */
function auxclick(el: HTMLElement, button: number): void {
  el.dispatchEvent(new MouseEvent('auxclick', { button, bubbles: true, cancelable: true }));
}

describe('middle-click closes a terminal tab (HS-8657)', () => {
  it('middle-click (button 1) on a DYNAMIC tab closes it', async () => {
    apiMock.mockResolvedValue({ configured: [], dynamic: [{ id: 'dyn-1', name: 'sh', command: 'sh', dynamic: true }], home: '/Users/test' });
    await loadAndRenderTerminalTabs();
    const tab = document.querySelector<HTMLElement>('[data-terminal-id="dyn-1"]');
    expect(tab).not.toBeNull();
    auxclick(tab!, 1);
    await vi.waitFor(() => { expect(document.querySelector('[data-terminal-id="dyn-1"]')).toBeNull(); });
  });

  it('middle-click on a CONFIGURED tab is a no-op (configured terminals are not closeable)', async () => {
    apiMock.mockResolvedValue({ configured: [{ id: 'cfg-1', name: 'zsh', command: 'zsh' }], dynamic: [], home: '/Users/test' });
    await loadAndRenderTerminalTabs();
    const tab = document.querySelector<HTMLElement>('[data-terminal-id="cfg-1"]');
    expect(tab).not.toBeNull();
    auxclick(tab!, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-terminal-id="cfg-1"]')).not.toBeNull();
  });

  it('right-click (button 2) on a dynamic tab does NOT close it (that opens the context menu)', async () => {
    apiMock.mockResolvedValue({ configured: [], dynamic: [{ id: 'dyn-1', name: 'sh', command: 'sh', dynamic: true }], home: '/Users/test' });
    await loadAndRenderTerminalTabs();
    const tab = document.querySelector<HTMLElement>('[data-terminal-id="dyn-1"]');
    expect(tab).not.toBeNull();
    auxclick(tab!, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-terminal-id="dyn-1"]')).not.toBeNull();
  });
});

describe('drawer tab double-click → toggle full height (HS-8609)', () => {
  function lifecycleSpies() {
    const toggleDrawerFullHeight = vi.fn();
    const selectDrawerTab = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    initInstanceLifecycle({ selectDrawerTab, toggleDrawerFullHeight });
    return { toggleDrawerFullHeight, selectDrawerTab };
  }

  it('double-clicking a terminal tab toggles the drawer full height', async () => {
    const { toggleDrawerFullHeight } = lifecycleSpies();
    apiMock.mockResolvedValue({ configured: [{ id: 't1', name: 'one', command: 'sh' }], dynamic: [], home: '/Users/test' });
    await loadAndRenderTerminalTabs();

    const tab = document.querySelector<HTMLElement>('#drawer-terminal-tabs [data-terminal-id="t1"]');
    expect(tab).not.toBeNull();
    tab!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(toggleDrawerFullHeight).toHaveBeenCalledTimes(1);

    // Each double-click is one toggle (commandLog flips expanded ↔ normal).
    tab!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(toggleDrawerFullHeight).toHaveBeenCalledTimes(2);
  });

  it('double-clicking the close glyph does NOT toggle height', async () => {
    const { toggleDrawerFullHeight } = lifecycleSpies();
    apiMock.mockResolvedValue({ configured: [], dynamic: [{ id: 'dyn-1', name: 'sh', command: 'sh', dynamic: true }], home: '/Users/test' });
    await loadAndRenderTerminalTabs();

    const closeGlyph = document.querySelector<HTMLElement>('#drawer-terminal-tabs [data-terminal-id="dyn-1"] .drawer-tab-close');
    expect(closeGlyph).not.toBeNull();
    closeGlyph!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(toggleDrawerFullHeight).not.toHaveBeenCalled();
  });
});
