// @vitest-environment happy-dom
/**
 * HS-7983 / HS-8015 / HS-8318 / HS-8324 — Commands Log streaming partial-output
 * happy-dom integration tests. Pre-HS-8324 these tests used hand-crafted DOM
 * (`<pre data-shell-partial-id="…">` directly under `<div id="command-log-entries">`)
 * and verified that `applyShellPartialEvent` / `hydrateRenderedShellPartials`
 * mutated the matching pres. Post-HS-8324 those functions delegate ENTIRELY
 * through `commandLogStore` + the per-row bindList effect — there's no
 * legacy DOM-write fallback anymore. The new tests drive through the real
 * pipeline: register a running-shell entry via the store, mount the
 * bindList, fire `applyShellPartialEvent`, assert against the rows the
 * bindList rendered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _mountEntriesBindListForTesting,
  _unmountEntriesBindListForTesting,
  applyShellPartialEvent,
  shouldAutoScrollToBottom,
  writePartialIntoPre,
} from './commandLog.js';
import {
  _clearPerEntrySignalsForTesting,
  _commandLogStoreForTesting,
  type CommandLogEntry,
  commandLogStore,
} from './commandLogStore.js';
import { state } from './state.js';

describe('shouldAutoScrollToBottom (HS-7983)', () => {
  it('returns true when scrolled exactly to the bottom', () => {
    expect(shouldAutoScrollToBottom(500, 200, 700)).toBe(true);
  });

  it('returns true within the default 8 px threshold', () => {
    expect(shouldAutoScrollToBottom(498, 200, 700)).toBe(true);
  });

  it('returns false when the user has scrolled up past the threshold', () => {
    expect(shouldAutoScrollToBottom(400, 200, 700)).toBe(false);
  });

  it('honours a custom threshold (zero — exact-bottom only)', () => {
    expect(shouldAutoScrollToBottom(499, 200, 700, 0)).toBe(false);
    expect(shouldAutoScrollToBottom(500, 200, 700, 0)).toBe(true);
  });

  it('returns true when content fits without scrolling', () => {
    expect(shouldAutoScrollToBottom(0, 500, 200)).toBe(true);
  });

  it('returns false at the very top of a long scroll', () => {
    expect(shouldAutoScrollToBottom(0, 200, 5000)).toBe(false);
  });

  it('handles fractional scrollTop (sub-pixel rounding)', () => {
    expect(shouldAutoScrollToBottom(499.7, 200, 700)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HS-8324 — applyShellPartialEvent (bindList integration)
// ---------------------------------------------------------------------------

/**
 * Mount `<div id="command-log-entries">`, register the supplied ids as
 * running-shell entries in `commandLogStore`, mount the bindList. The
 * bindList renders running-shell rows whose inner DOM includes the
 * `<pre data-shell-partial-id>` twin-pre layout. Returns the container
 * for query convenience.
 */
function mountTestFixture(entryIds: number[]): HTMLElement {
  const container = document.createElement('div');
  container.id = 'command-log-entries';
  document.body.appendChild(container);
  const entries: CommandLogEntry[] = entryIds.map(id => ({
    id,
    event_type: 'shell_command',
    direction: 'outgoing',
    summary: `shell ${id}`,
    detail: '',
    created_at: '2026-05-11T00:00:00Z',
  }));
  commandLogStore.actions.setEntries(entries, entryIds);
  _mountEntriesBindListForTesting();
  return container;
}

beforeEach(() => {
  state.settings.shell_streaming_enabled = true;
  _commandLogStoreForTesting.reset();
  _clearPerEntrySignalsForTesting();
  _unmountEntriesBindListForTesting();
  document.body.innerHTML = '';
});

afterEach(() => {
  _unmountEntriesBindListForTesting();
  _commandLogStoreForTesting.reset();
  _clearPerEntrySignalsForTesting();
  document.body.innerHTML = '';
});

describe('applyShellPartialEvent (HS-7983 / HS-8324 bindList integration)', () => {
  it('writes the stripped partial into the matching <pre data-shell-partial-id>', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 42, partial: '\x1b[31mERROR\x1b[0m: oops' });
    // Preview pre (line-clamped, 3 trailing lines) — for a 1-line input that's
    // the full string. Full pre receives the entire stripped buffer.
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('ERROR: oops');
  });

  it('overwrites existing partial text on subsequent chunks (no double-paint)', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 42, partial: 'Stage 1\n' });
    applyShellPartialEvent({ id: 42, partial: 'Stage 1\nStage 2\n' });
    applyShellPartialEvent({ id: 42, partial: 'Stage 1\nStage 2\nStage 3\n' });
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('Stage 1\nStage 2\nStage 3\n');
  });

  it('no-ops when no entry matches the event id', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 999, partial: 'orphan' });
    // Id-42 row's `<pre>` is unchanged.
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('');
  });

  it('only updates the entry whose id matches when multiple entries are mounted', () => {
    const container = mountTestFixture([42, 43]);
    applyShellPartialEvent({ id: 43, partial: 'second runs' });
    const e42 = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    const e43 = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="43"]');
    expect(e42?.textContent).toBe('');
    expect(e43?.textContent).toBe('second runs');
  });
});

// ---------------------------------------------------------------------------
// HS-7984 — Phase 4 setting gate
// ---------------------------------------------------------------------------

describe('applyShellPartialEvent — shell_streaming_enabled gate (HS-7984)', () => {
  it('applies the partial when streaming is enabled (sanity)', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 42, partial: 'live output' });
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('live output');
  });

  it('no-ops when streaming is disabled — the live <pre> stays empty', () => {
    const container = mountTestFixture([42]);
    state.settings.shell_streaming_enabled = false;
    applyShellPartialEvent({ id: 42, partial: 'this should not render' });
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// HS-8015 — flicker-free re-render
//
// Pre-HS-8324 these tests verified `hydrateRenderedShellPartials` repainted
// the live `<pre>` from a separate module cache after a wholesale re-render
// wiped the textContent. Post-HS-8324 there's no separate cache and no
// wholesale re-render — the bindList preserves DOM identity across polls
// and the per-row partial effect writes the current partial whenever the
// signal fires. The behavior the original tests guarded against (live
// preview flickering empty between ticks) is now structurally impossible.
//
// These replacement tests verify the new contract directly: the per-row
// partial effect's content persists across simulated poll ticks.
// ---------------------------------------------------------------------------

describe('per-row partial-output persistence (HS-8015 / HS-8324)', () => {
  it('the rendered <pre> retains the latest partial across re-poll setEntries()', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 42, partial: 'first chunk' });
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('first chunk');

    // Simulate a poll tick that includes the same entry in the server
    // response. Pre-HS-8318 this rebuilt every row from scratch; post-
    // HS-8318 the bindList + structural-compare keeps the row stable
    // and the per-entry signal doesn't re-fire because nothing changed.
    commandLogStore.actions.setEntries(
      [{
        id: 42,
        event_type: 'shell_command',
        direction: 'outgoing',
        summary: 'shell 42',
        detail: '',
        created_at: '2026-05-11T00:00:00Z',
      }],
      [42],
    );

    // Same DOM node, same content — no flicker.
    const sameFullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(sameFullPre).toBe(fullPre);
    expect(sameFullPre?.textContent).toBe('first chunk');
  });

  it('strips ANSI before writing into the rendered <pre>', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 42, partial: '\x1b[31mFAIL\x1b[0m\n' });
    const fullPre = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(fullPre?.textContent).toBe('FAIL\n');
  });

  it('updates only the matching id when multiple entries are mounted', () => {
    const container = mountTestFixture([42, 43]);
    applyShellPartialEvent({ id: 42, partial: 'foo' });
    applyShellPartialEvent({ id: 43, partial: 'bar' });
    const e42 = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    const e43 = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="43"]');
    expect(e42?.textContent).toBe('foo');
    expect(e43?.textContent).toBe('bar');
  });
});

// ---------------------------------------------------------------------------
// HS-8015 follow-up #2 — twin-pre running-shell layout
// ---------------------------------------------------------------------------

describe('writePartialIntoPre (HS-8015 follow-up #2)', () => {
  it('writes the trailing 3 lines into a preview pre (data-shell-partial-mode="preview")', () => {
    const pre = document.createElement('pre');
    pre.dataset.shellPartialMode = 'preview';
    writePartialIntoPre(pre, 'a\nb\nc\nd\ne\n');
    expect(pre.textContent).toBe('c\nd\ne');
  });

  it('writes the full stripped buffer into a full pre (data-shell-partial-mode="full")', () => {
    const pre = document.createElement('pre');
    pre.dataset.shellPartialMode = 'full';
    writePartialIntoPre(pre, '\x1b[31mline1\x1b[0m\nline2\nline3\nline4\nline5\n');
    expect(pre.textContent).toBe('line1\nline2\nline3\nline4\nline5\n');
  });

  it('falls through to full-buffer when no mode attribute is set (back-compat)', () => {
    const pre = document.createElement('pre');
    writePartialIntoPre(pre, 'a\nb\nc\nd\n');
    expect(pre.textContent).toBe('a\nb\nc\nd\n');
  });

  it('strips ANSI from the buffer in both modes', () => {
    const preview = document.createElement('pre');
    preview.dataset.shellPartialMode = 'preview';
    writePartialIntoPre(preview, '\x1b[31mfoo\x1b[0m\n\x1b[32mbar\x1b[0m\n');
    expect(preview.textContent).toBe('foo\nbar');

    const full = document.createElement('pre');
    full.dataset.shellPartialMode = 'full';
    writePartialIntoPre(full, '\x1b[31mfoo\x1b[0m\n\x1b[32mbar\x1b[0m\n');
    expect(full.textContent).toBe('foo\nbar\n');
  });
});

describe('applyShellPartialEvent — twin-pre wiring (HS-8015 follow-up #2)', () => {
  it('updates BOTH preview and full pres for a single event', () => {
    const container = mountTestFixture([42]);
    const partial = 'a\nb\nc\nd\ne\nf\n';
    applyShellPartialEvent({ id: 42, partial });
    const preview = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="preview"][data-shell-partial-id="42"]');
    const full = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    // Preview: trailing 3 lines (no trailing empty line since the buffer ends in \n).
    expect(preview?.textContent).toBe('d\ne\nf');
    // Full: entire stripped buffer including the trailing \n.
    expect(full?.textContent).toBe(partial);
  });

  it('twin pres stay in sync across multiple chunks', () => {
    const container = mountTestFixture([42]);
    applyShellPartialEvent({ id: 42, partial: 'one\n' });
    applyShellPartialEvent({ id: 42, partial: 'one\ntwo\n' });
    applyShellPartialEvent({ id: 42, partial: 'one\ntwo\nthree\n' });
    applyShellPartialEvent({ id: 42, partial: 'one\ntwo\nthree\nfour\n' });
    const preview = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="preview"][data-shell-partial-id="42"]');
    const full = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"][data-shell-partial-id="42"]');
    expect(preview?.textContent).toBe('two\nthree\nfour');
    expect(full?.textContent).toBe('one\ntwo\nthree\nfour\n');
  });
});

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
    document.body.innerHTML = `
      <div id="command-log-panel" class="command-log-panel" style="display:none"></div>
      <button id="command-log-btn" type="button"></button>
      <button id="command-log-expand-btn" type="button"></button>
      <div id="drawer-tabs-container"></div>
      <div id="drawer-terminal-tabs-wrap" style="display:none"></div>
      <div id="command-log-entries"></div>
    `;
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
        return Promise.resolve(new Response(JSON.stringify({ ids: [], outputs: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Default: empty 200 JSON for any other endpoint the boot path touches.
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as typeof globalThis.fetch;

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
