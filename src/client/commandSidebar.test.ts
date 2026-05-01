// @vitest-environment happy-dom
/**
 * HS-7983 — pure-helper tests for the streaming-shell-output polling
 * adapter exposed by `commandSidebar.tsx::decideShellPartialEvents`. The
 * adapter takes a `/api/shell/running` response + the per-id last-seen
 * length cache and returns the events to dispatch + the new cache state.
 * These tests pin the dedup-by-length, dropped-id, and missing-outputs
 * paths so a regression doesn't silently start dispatching identical
 * events on every 2 s tick.
 *
 * HS-7984 — also covers the first-use toast helper +
 * localStorage-sentinel logic.
 *
 * HS-8060 — per-button shell-running spinner-with-stop-icon flow. Tests
 * use `vi.hoisted` + `vi.mock('./api.js')` to stub the network layer so
 * `runShellCommand` and the poll body don't escape happy-dom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetRunningButtonsForTesting, _runningButtonsForTesting,commandKey, decideShellPartialEvents, maybeFireShellStreamFirstUseToast, renderChannelCommands } from './commandSidebar.js';
import type { CustomCommand } from './experimentalSettings.js';
import type * as experimentalSettings from './experimentalSettings.js';
import { state } from './state.js';

const { apiMock, getCommandItemsMock, isChannelAliveMock, setShellBusyMock, refreshLogBadgeMock, confirmDialogMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getCommandItemsMock: vi.fn<() => unknown[]>(() => []),
  isChannelAliveMock: vi.fn<() => boolean>(() => false),
  setShellBusyMock: vi.fn<(busy: boolean) => void>(),
  refreshLogBadgeMock: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  confirmDialogMock: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
}));

vi.mock('./api.js', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiWithSecret: (...args: unknown[]) => apiMock(...args),
}));

vi.mock('./experimentalSettings.js', async () => {
  type ExpSettings = typeof experimentalSettings;
  const actual = await vi.importActual<ExpSettings>('./experimentalSettings.js');
  return {
    ...actual,
    getCommandItems: () => getCommandItemsMock(),
  };
});

vi.mock('./channelUI.js', () => ({
  isChannelAlive: () => isChannelAliveMock(),
  setShellBusy: (busy: boolean) => setShellBusyMock(busy),
  triggerChannelAndMarkBusy: vi.fn(),
}));

vi.mock('./commandLog.js', () => ({
  refreshLogBadge: () => refreshLogBadgeMock(),
  showLogEntryById: vi.fn(),
}));

vi.mock('./confirm.js', () => ({
  confirmDialog: () => confirmDialogMock(),
}));

describe('decideShellPartialEvents (HS-7983)', () => {
  it('returns no events when no processes are running', () => {
    const result = decideShellPartialEvents({ ids: [], outputs: {} }, new Map());
    expect(result.events).toEqual([]);
    expect(result.nextCache.size).toBe(0);
  });

  it('dispatches an event for the first chunk of a newly-running id', () => {
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'first chunk\n' } },
      new Map(),
    );
    expect(result.events).toEqual([{ id: 42, partial: 'first chunk\n' }]);
    expect(result.nextCache.get(42)).toBe('first chunk\n'.length);
  });

  it('does NOT re-dispatch when the partial has not grown', () => {
    const cache = new Map<number, number>([[42, 'first chunk\n'.length]]);
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'first chunk\n' } },
      cache,
    );
    expect(result.events).toEqual([]);
    // Cache unchanged for this id.
    expect(result.nextCache.get(42)).toBe('first chunk\n'.length);
  });

  it('dispatches when the partial grew between ticks', () => {
    const cache = new Map<number, number>([[42, 5]]);
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'hello world' } },
      cache,
    );
    expect(result.events).toEqual([{ id: 42, partial: 'hello world' }]);
    expect(result.nextCache.get(42)).toBe('hello world'.length);
  });

  it('drops cache entries for ids that left the running list', () => {
    const cache = new Map<number, number>([[42, 50], [43, 100]]);
    const result = decideShellPartialEvents(
      { ids: [42], outputs: { 42: 'a'.repeat(60) } },
      cache,
    );
    expect(result.nextCache.has(42)).toBe(true);
    // 43 dropped from cache because it's not in the running ids list.
    expect(result.nextCache.has(43)).toBe(false);
  });

  it('preserves cache for an id that is running but has no output yet (pre-first-chunk)', () => {
    const cache = new Map<number, number>([[42, 10]]);
    const result = decideShellPartialEvents(
      // `outputs` missing the id — treat as "no new chunk this tick".
      { ids: [42], outputs: {} },
      cache,
    );
    expect(result.events).toEqual([]);
    // Carry forward the prior length so a later chunk emits the delta
    // correctly rather than re-emitting the whole buffer.
    expect(result.nextCache.get(42)).toBe(10);
  });

  it('handles a missing `outputs` field (older server, backward compat)', () => {
    const result = decideShellPartialEvents(
      { ids: [42] },
      new Map(),
    );
    expect(result.events).toEqual([]);
    // Cache is empty — nothing to preserve, nothing to drop, nothing to add.
    expect(result.nextCache.size).toBe(0);
  });

  it('dispatches for multiple concurrent running commands', () => {
    const result = decideShellPartialEvents(
      { ids: [42, 43], outputs: { 42: 'one', 43: 'two\nlines\n' } },
      new Map(),
    );
    expect(result.events).toContainEqual({ id: 42, partial: 'one' });
    expect(result.events).toContainEqual({ id: 43, partial: 'two\nlines\n' });
    expect(result.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HS-7984 — first-use toast (Phase 4)
// ---------------------------------------------------------------------------

describe('maybeFireShellStreamFirstUseToast (HS-7984)', () => {
  const KEY = 'hotsheet:shell-stream-toast-dismissed';
  const originalSetting = state.settings.shell_streaming_enabled;

  beforeEach(() => {
    window.localStorage.removeItem(KEY);
    document.querySelectorAll('.hs-toast').forEach(t => t.remove());
    state.settings.shell_streaming_enabled = true;
  });

  afterEach(() => {
    state.settings.shell_streaming_enabled = originalSetting;
    window.localStorage.removeItem(KEY);
    document.querySelectorAll('.hs-toast').forEach(t => t.remove());
  });

  it('shows the discoverability toast on the first call after enable (HS-8015 wording points users at the Commands Log)', () => {
    maybeFireShellStreamFirstUseToast();
    const toast = document.querySelector('.hs-toast');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('Commands Log');
    // localStorage sentinel is set so subsequent calls skip.
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it('does NOT re-fire on a subsequent call (idempotent via the localStorage sentinel)', () => {
    maybeFireShellStreamFirstUseToast();
    document.querySelectorAll('.hs-toast').forEach(t => t.remove());
    maybeFireShellStreamFirstUseToast();
    expect(document.querySelector('.hs-toast')).toBeNull();
  });

  it('respects an existing localStorage sentinel from a prior session', () => {
    window.localStorage.setItem(KEY, '1700000000000');
    maybeFireShellStreamFirstUseToast();
    expect(document.querySelector('.hs-toast')).toBeNull();
  });

  it('no-ops when the streaming setting is disabled — no toast and no sentinel mutation', () => {
    state.settings.shell_streaming_enabled = false;
    maybeFireShellStreamFirstUseToast();
    expect(document.querySelector('.hs-toast')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HS-8060 — per-button shell-running spinner-with-stop-icon
// ---------------------------------------------------------------------------

function makeShellCommand(name: string, prompt = `echo ${name}`): CustomCommand {
  return { name, prompt, target: 'shell', icon: 'play', color: '#3b82f6' };
}

function setupSidebarDOM(): HTMLElement {
  document.body.innerHTML = `
    <div id="channel-play-section" style="display:none"></div>
    <div id="channel-commands-container"></div>
  `;
  return document.getElementById('channel-commands-container')!;
}

describe('commandKey (HS-8060)', () => {
  it('produces the same key for two CustomCommand instances with identical (target, name, prompt)', () => {
    const a = makeShellCommand('Build');
    const b = { ...makeShellCommand('Build'), color: '#ff0000' }; // different color
    expect(commandKey(a)).toBe(commandKey(b));
  });

  it('produces different keys when the target differs', () => {
    const shell: CustomCommand = { name: 'X', prompt: 'p', target: 'shell' };
    const claude: CustomCommand = { name: 'X', prompt: 'p', target: 'claude' };
    expect(commandKey(shell)).not.toBe(commandKey(claude));
  });

  it('treats undefined target as the default `claude`', () => {
    const undef: CustomCommand = { name: 'X', prompt: 'p' };
    const claude: CustomCommand = { name: 'X', prompt: 'p', target: 'claude' };
    expect(commandKey(undef)).toBe(commandKey(claude));
  });
});

describe('renderButton running-state branch (HS-8060)', () => {
  beforeEach(() => {
    apiMock.mockReset();
    confirmDialogMock.mockReset();
    setShellBusyMock.mockReset();
    refreshLogBadgeMock.mockReset();
    refreshLogBadgeMock.mockResolvedValue();
    confirmDialogMock.mockResolvedValue(true);
    _resetRunningButtonsForTesting();
    setupSidebarDOM();
  });

  afterEach(() => {
    _resetRunningButtonsForTesting();
    document.body.innerHTML = '';
  });

  it('idle button — no spinner element, no `is-running` class', () => {
    getCommandItemsMock.mockReturnValue([makeShellCommand('Build')]);
    renderChannelCommands();
    const btn = document.querySelector<HTMLButtonElement>('.channel-command-btn');
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains('is-running')).toBe(false);
    expect(btn!.querySelector('.channel-command-btn-spinner')).toBeNull();
  });

  it('running button — has `is-running` class, contains spinner with bg:inherit + stop glyph', () => {
    const cmd = makeShellCommand('Build');
    getCommandItemsMock.mockReturnValue([cmd]);
    _runningButtonsForTesting.set(commandKey(cmd), 42);
    renderChannelCommands();
    const btn = document.querySelector<HTMLButtonElement>('.channel-command-btn');
    expect(btn!.classList.contains('is-running')).toBe(true);
    const spinner = btn!.querySelector<HTMLElement>('.channel-command-btn-spinner');
    expect(spinner).not.toBeNull();
    // The ring + stop are both inside the spinner.
    expect(spinner!.querySelector('.channel-command-btn-spinner-ring')).not.toBeNull();
    const stop = spinner!.querySelector('.channel-command-btn-spinner-stop');
    expect(stop).not.toBeNull();
    expect(stop!.querySelector('svg')).not.toBeNull(); // the SVG stop glyph
  });

  it('clicking a running button opens the confirm dialog and on Stop fires POST /shell/kill with the running id', async () => {
    const cmd = makeShellCommand('Build');
    getCommandItemsMock.mockReturnValue([cmd]);
    _runningButtonsForTesting.set(commandKey(cmd), 42);
    apiMock.mockResolvedValueOnce({ ok: true });
    confirmDialogMock.mockResolvedValueOnce(true);
    renderChannelCommands();
    document.querySelector<HTMLButtonElement>('.channel-command-btn')!.click();
    // Drain microtasks so the awaited confirm + kill resolve.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(confirmDialogMock).toHaveBeenCalledOnce();
    expect(apiMock).toHaveBeenCalledOnce();
    expect(apiMock.mock.calls[0][0]).toBe('/shell/kill');
    const body = (apiMock.mock.calls[0][1] as { method: string; body: { id: number } }).body;
    expect(body.id).toBe(42);
  });

  it('clicking a running button — Cancel keeps it running (no kill, runningButtons unchanged)', async () => {
    const cmd = makeShellCommand('Build');
    getCommandItemsMock.mockReturnValue([cmd]);
    _runningButtonsForTesting.set(commandKey(cmd), 42);
    confirmDialogMock.mockResolvedValueOnce(false);
    renderChannelCommands();
    document.querySelector<HTMLButtonElement>('.channel-command-btn')!.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(confirmDialogMock).toHaveBeenCalledOnce();
    // No kill call. Note we did NOT call /shell/exec either — clicking
    // a running button must not double-spawn.
    expect(apiMock).not.toHaveBeenCalled();
    expect(_runningButtonsForTesting.get(commandKey(cmd))).toBe(42);
  });

  it('two concurrent commands track independent running state — each button shows its own spinner', () => {
    const a = makeShellCommand('A', 'echo a');
    const b = makeShellCommand('B', 'echo b');
    getCommandItemsMock.mockReturnValue([a, b]);
    _runningButtonsForTesting.set(commandKey(a), 100);
    _runningButtonsForTesting.set(commandKey(b), 101);
    renderChannelCommands();
    const buttons = document.querySelectorAll<HTMLButtonElement>('.channel-command-btn');
    expect(buttons.length).toBe(2);
    for (const btn of buttons) {
      expect(btn.classList.contains('is-running')).toBe(true);
      expect(btn.querySelector('.channel-command-btn-spinner')).not.toBeNull();
    }
  });

  it('one running + one idle — only the running button shows the spinner', () => {
    const a = makeShellCommand('A', 'echo a');
    const b = makeShellCommand('B', 'echo b');
    getCommandItemsMock.mockReturnValue([a, b]);
    _runningButtonsForTesting.set(commandKey(a), 100); // only A is running
    renderChannelCommands();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.channel-command-btn'));
    const aBtn = buttons.find(btn => btn.dataset.commandKey === commandKey(a));
    const bBtn = buttons.find(btn => btn.dataset.commandKey === commandKey(b));
    expect(aBtn!.classList.contains('is-running')).toBe(true);
    expect(bBtn!.classList.contains('is-running')).toBe(false);
    expect(aBtn!.querySelector('.channel-command-btn-spinner')).not.toBeNull();
    expect(bBtn!.querySelector('.channel-command-btn-spinner')).toBeNull();
  });

  it('non-shell (claude-target) commands never get the running-state spinner even if their key happens to be in the map', () => {
    // Defensive: the runningButtons map is shell-only by construction
    // (`runShellCommand` is the only writer) but a corrupted state map
    // shouldn't render a spinner on a Claude command.
    const claude: CustomCommand = { name: 'Ask', prompt: 'hello', target: 'claude' };
    getCommandItemsMock.mockReturnValue([claude]);
    isChannelAliveMock.mockReturnValue(true); // make the command visible
    // Set up a `channel-play-section` that's actually visible so
    // `channelEnabled` resolves to true.
    document.getElementById('channel-play-section')!.style.display = '';
    _runningButtonsForTesting.set(commandKey(claude), 999);
    renderChannelCommands();
    const btn = document.querySelector<HTMLButtonElement>('.channel-command-btn');
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains('is-running')).toBe(false);
    expect(btn!.querySelector('.channel-command-btn-spinner')).toBeNull();
  });
});
