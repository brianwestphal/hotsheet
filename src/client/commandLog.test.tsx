// @vitest-environment happy-dom
/**
 * Commands Log drawer-state happy-dom integration tests for
 * `applyPerProjectDrawerState` (the per-project drawer open/closed restore).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toElement } from './dom.js';

/**
 * HS-8443 — `applyPerProjectDrawerState` must NOT clobber a user-driven
 * `openPanel` whose click landed during the async `/api/file-settings`
 * fetch. Pre-fix, the function read `drawer_open: 'false'` from the
 * (e2e-fixture-reset) server, returned to the synchronous restore body,
 * and ran `if (panelOpen) closePanel()` — undoing the user's mid-fetch
 * open. On CI under 375-test load the fetch window stretches to 100+ ms,
 * wide enough for an e2e test to race ahead and trip the assertion.
 *
 * Test shape: stub `globalThis.fetch` to return a controllable Promise.
 * Start `applyPerProjectDrawerState`, simulate the user click via
 * `_openPanelForTesting` during the await, resolve the fetch with
 * `drawer_open: 'false'`, await completion, assert the panel is still
 * open. The pre-fix code path leaves `display: 'none'`; the post-fix
 * mutation-epoch guard short-circuits and `display` stays empty.
 */
describe('applyPerProjectDrawerState — user mid-fetch click wins (HS-8443)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
    document.body.replaceChildren(
      toElement(<div id="command-log-panel" className="command-log-panel" style="display:none"></div>),
      toElement(<button id="command-log-btn" type="button"></button>),
      toElement(<button id="command-log-expand-btn" type="button"></button>),
      toElement(<div id="drawer-tabs-container"></div>),
      toElement(<div id="drawer-terminal-tabs-wrap" style="display:none"></div>),
      toElement(<div id="command-log-entries"></div>),
    );
    const { _resetPanelStateForTesting } = await import('./commandLog.js');
    _resetPanelStateForTesting();
  });

  afterEach(() => {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  it('mid-fetch openPanel is preserved when the restore reads drawer_open: false', async () => {
    // Hand-controlled Promise for `/api/file-settings`. Any other fetch
    // (e.g. `terminal/list` from `loadAndRenderTerminalTabs`) immediately
    // resolves to an empty response so the rest of the restore body can
    // run to completion.
    let resolveFileSettings!: (response: Response) => void;
    const fileSettingsPromise = new Promise<Response>((resolve) => { resolveFileSettings = resolve; });
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('/api/file-settings')) return fileSettingsPromise;
      // `loadEntries` (called from `openPanel`'s `startPolling` path)
      // hits `/command-log` + `/shell/running`. Return the shapes those
      // consumers expect so the per-test unhandled rejection on
      // `commandLogStore.setEntries(serverEntries.map …)` doesn't fire.
      if (url.includes('/api/command-log')) {
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/api/shell/running')) {
        return Promise.resolve(new Response(JSON.stringify({ ids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Default: empty 200 JSON for any other endpoint the boot path touches.
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    const { applyPerProjectDrawerState, _openPanelForTesting } = await import('./commandLog.js');

    // Kick off the restore. It will await the file-settings fetch.
    const restorePromise = applyPerProjectDrawerState();

    // Yield to let the dynamic import + the file-settings fetch issue land.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate the user clicking `#command-log-btn` mid-fetch. The
    // toggle handler routes through `togglePanel → openPanel`; tests
    // skip the click wiring and call `_openPanelForTesting` directly
    // (same code path, same epoch bump).
    _openPanelForTesting();
    expect(document.getElementById('command-log-panel')!.style.display).toBe('');

    // Now resolve the file-settings fetch with `drawer_open: 'false'`.
    // Pre-fix the restore body would run `closePanel()` here.
    resolveFileSettings(new Response(
      JSON.stringify({ drawer_open: 'false', drawer_active_tab: 'commands-log', drawer_expanded: 'false' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await restorePromise;

    // Post-fix: epoch-guard returns early, panel stays open.
    expect(document.getElementById('command-log-panel')!.style.display).toBe('');
  });
});

/**
 * HS-9246 — split the HS-8443 drawer-state guard. A user OPEN/CLOSE toggle
 * mid-fetch stays authoritative for open/close, but the active-tab default must
 * still apply — UNLESS the user explicitly clicked a tab mid-fetch, which now
 * wins over the computed default (incl. the first-open Claude default). Pre-fix,
 * a pure tab switch didn't bump the open/close epoch, so the restore silently
 * overwrote the user's mid-fetch tab choice.
 */
describe('applyPerProjectDrawerState — user mid-fetch tab click wins (HS-9246)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    document.body.replaceChildren(
      toElement(<div id="command-log-panel" className="command-log-panel" style="display:none"></div>),
      toElement(<button id="command-log-btn" type="button"></button>),
      toElement(<button id="command-log-expand-btn" type="button"></button>),
      toElement(<div id="drawer-tabs-container"></div>),
      toElement(<div id="drawer-terminal-tabs-wrap" style="display:none"></div>),
      toElement(<div id="command-log-entries"></div>),
    );
    const { _resetPanelStateForTesting } = await import('./commandLog.js');
    _resetPanelStateForTesting();
  });

  afterEach(() => {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  it('a user tab click during the fetch is preserved over the saved-tab restore', async () => {
    let resolveFileSettings!: (response: Response) => void;
    const fileSettingsPromise = new Promise<Response>((resolve) => { resolveFileSettings = resolve; });
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('/api/file-settings')) return fileSettingsPromise;
      if (url.includes('/api/command-log')) {
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/api/shell/running')) {
        return Promise.resolve(new Response(JSON.stringify({ ids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    const { applyPerProjectDrawerState, _userSwitchDrawerTabForTesting, getActiveDrawerTab } = await import('./commandLog.js');

    const restorePromise = applyPerProjectDrawerState();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // User clicks a specific tab mid-fetch (bumps ONLY the user-tab-switch epoch,
    // not the open/close epoch — so the pre-fix bail would NOT have fired).
    _userSwitchDrawerTabForTesting('terminal:my-choice');
    expect(getActiveDrawerTab()).toBe('terminal:my-choice');

    // Restore reads a DIFFERENT saved tab.
    resolveFileSettings(new Response(
      JSON.stringify({ drawer_open: 'true', drawer_active_tab: 'commands-log', drawer_expanded: 'false' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await restorePromise;

    // The user's mid-fetch choice wins; it was NOT overwritten by the restore.
    expect(getActiveDrawerTab()).toBe('terminal:my-choice');
  });
});

/**
 * HS-8845 — the drawer defaults to OPEN on a project's FIRST use (no saved
 * `drawer_open` setting yet), for discoverability of the Commands Log /
 * terminal. A prior explicit choice is still honored. Drives the real
 * `getFileSettings` by injecting a mock API transport (`setApiTransport`), so
 * the `fs.drawer_open` branch in `applyPerProjectDrawerState` is exercised.
 */
describe('applyPerProjectDrawerState — default open on first use (HS-8845)', () => {
  beforeEach(async () => {
    document.body.replaceChildren(
      toElement(<div id="command-log-panel" className="command-log-panel" style="display:none"></div>),
      toElement(<button id="command-log-btn" type="button"></button>),
      toElement(<button id="command-log-expand-btn" type="button"></button>),
      toElement(<div id="drawer-tabs-container"></div>),
      toElement(<div id="drawer-terminal-tabs-wrap" style="display:none"></div>),
      toElement(<div id="command-log-entries"></div>),
    );
    const { _resetPanelStateForTesting } = await import('./commandLog.js');
    _resetPanelStateForTesting();
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    // Restore the "no transport" state so this block doesn't leak into others.
    const { setApiTransport } = await import('../api/_runner.js');
    setApiTransport(() => { throw new Error('no transport (test cleanup)'); });
  });

  /** Inject a transport so `/file-settings` returns `settings`; every other
   *  boot-path endpoint gets a benign shape (terminal-tab/log errors are
   *  swallowed inside `loadAndRenderTerminalTabs` / `loadEntries`). */
  async function runRestoreWithSettings(settings: Record<string, unknown>): Promise<void> {
    const { setApiTransport } = await import('../api/_runner.js');
    setApiTransport((path: string) => {
      if (path.includes('/file-settings')) return Promise.resolve(settings);
      if (path.includes('/command-log')) return Promise.resolve([]);
      if (path.includes('/shell/running')) return Promise.resolve({ ids: [] });
      return Promise.resolve({ configured: [], dynamic: [] });
    });
    const { applyPerProjectDrawerState } = await import('./commandLog.js');
    await applyPerProjectDrawerState();
  }

  it('opens the drawer when no drawer_open setting is saved (first use)', async () => {
    await runRestoreWithSettings({ /* brand-new project: no drawer_open key */ });
    // Default flipped from closed → open for the never-set case.
    expect(document.getElementById('command-log-panel')!.style.display).toBe('');
  });

  it('stays closed when drawer_open is explicitly "false" (honors a prior choice)', async () => {
    await runRestoreWithSettings({ drawer_open: 'false', drawer_active_tab: 'commands-log', drawer_expanded: 'false' });
    expect(document.getElementById('command-log-panel')!.style.display).toBe('none');
  });

  it('opens when drawer_open is explicitly "true"', async () => {
    await runRestoreWithSettings({ drawer_open: 'true', drawer_active_tab: 'commands-log', drawer_expanded: 'false' });
    expect(document.getElementById('command-log-panel')!.style.display).toBe('');
  });
});
