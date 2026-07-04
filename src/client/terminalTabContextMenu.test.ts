// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalInstance } from './terminal.js';
import { closeTabs, initTabContextMenu } from './terminalTabContextMenu.js';

// HS-9329 — this suite pins the alive-count branching in `closeTabs`, the logic
// that decides which (if any) confirm dialog renders on a bulk tab close
// (Close Others / Close to the Left / Close to the Right). Before this it was
// exercised ONLY by the terminal-drawer e2e specs, which flaked in headless CI
// on PTY-spawn timing rather than on this logic (the create-loop didn't wait
// for the PTYs to reach `alive`, so the "N alive" branch the test expected was
// never taken). A happy-dom unit test with the alive state injected directly is
// deterministic and can't flake on spawn timing — it's the "transition-matrix"
// guard the CLAUDE.md testing philosophy asks for on a stateful path.

const h = vi.hoisted(() => ({
  confirmDialog: vi.fn((_opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise.resolve(false)),
}));
vi.mock('./confirm.js', () => ({ confirmDialog: h.confirmDialog }));
// Peripheral deps only reached by the menu/rename paths, not by `closeTabs`.
vi.mock('./terminal/renameDialog.js', () => ({ openRenameDialog: vi.fn() }));
vi.mock('./terminal/tabContextMenu.js', () => ({ showTabContextMenu: vi.fn() }));
vi.mock('./terminalTransientNames.js', () => ({ setTransientTerminalName: vi.fn() }));
vi.mock('./state.js', () => ({ getActiveProject: vi.fn(() => null) }));

/** Minimal instance for the alive-check + name derivation `closeTabs` uses. */
function makeInst(id: string, status: 'alive' | 'exited' | 'not-connected', name?: string): TerminalInstance {
  return {
    config: { id, dynamic: true, command: 'zsh', ...(name !== undefined ? { name } : {}) },
    status,
  } as unknown as TerminalInstance;
}

let instances: Map<string, TerminalInstance>;
let closeDynamicTerminal: ReturnType<typeof vi.fn>;
let selectFallbackAfterClose: ReturnType<typeof vi.fn>;
// Models the per-tab confirm inside `closeDynamicTerminal(id, /*skipConfirm*/false)`:
// when true the user "confirms" and the terminal is destroyed; when false they
// cancel and it survives. A `skipConfirm: true` call always destroys.
let singleTabConfirm: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  h.confirmDialog.mockResolvedValue(false);
  singleTabConfirm = true;
  instances = new Map();

  closeDynamicTerminal = vi.fn((id: string, skipConfirm?: boolean) => {
    if (skipConfirm === true || singleTabConfirm) instances.delete(id);
    return Promise.resolve();
  });
  selectFallbackAfterClose = vi.fn(() => Promise.resolve());

  initTabContextMenu({
    getInstance: (id: string) => instances.get(id),
    closeDynamicTerminal: closeDynamicTerminal as never,
    selectFallbackAfterClose: selectFallbackAfterClose as never,
  });

  // `orderedTabIds()` walks `#drawer-terminal-tabs`; give it a realistic strip
  // so the fallback receives the original left-to-right order.
  document.body.innerHTML = '<div id="drawer-terminal-tabs"></div>';
  const strip = document.getElementById('drawer-terminal-tabs')!;
  for (const id of ['a', 'b', 'c']) {
    const el = document.createElement('div');
    el.dataset.terminalId = id;
    strip.appendChild(el);
  }
});

describe('closeTabs alive-count branching (HS-6701 / HS-9329)', () => {
  it('empty id set is a no-op — no closes, no dialog, no fallback', async () => {
    await closeTabs([]);
    expect(closeDynamicTerminal).not.toHaveBeenCalled();
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(selectFallbackAfterClose).not.toHaveBeenCalled();
  });

  it('0 alive → destroys all silently (no confirm dialog)', async () => {
    instances.set('a', makeInst('a', 'exited'));
    instances.set('b', makeInst('b', 'not-connected'));

    await closeTabs(['a', 'b']);

    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(closeDynamicTerminal).toHaveBeenCalledWith('a', true, true);
    expect(closeDynamicTerminal).toHaveBeenCalledWith('b', true, true);
    expect(selectFallbackAfterClose).toHaveBeenCalledWith(['a', 'b', 'c'], ['a', 'b']);
  });

  it('1 alive, confirmed → single-tab confirm path destroys the alive tab then the inert ones', async () => {
    singleTabConfirm = true;
    instances.set('a', makeInst('a', 'alive'));
    instances.set('b', makeInst('b', 'exited'));

    await closeTabs(['a', 'b']);

    // The lone alive tab goes through the single-tab confirm (skipConfirm=false),
    // NOT the multi-tab "Stop All" dialog.
    expect(h.confirmDialog).not.toHaveBeenCalled();
    expect(closeDynamicTerminal).toHaveBeenCalledWith('a', false, true);
    expect(closeDynamicTerminal).toHaveBeenCalledWith('b', true, true);
    expect(selectFallbackAfterClose).toHaveBeenCalledTimes(1);
  });

  it('1 alive, cancelled → whole bulk op aborts (inert tabs survive, no fallback)', async () => {
    singleTabConfirm = false; // user cancels the per-tab confirm
    instances.set('a', makeInst('a', 'alive'));
    instances.set('b', makeInst('b', 'exited'));

    await closeTabs(['a', 'b']);

    expect(closeDynamicTerminal).toHaveBeenCalledWith('a', false, true);
    // 'b' (the inert tab) must NOT be closed once the alive-tab confirm was cancelled.
    expect(closeDynamicTerminal).not.toHaveBeenCalledWith('b', true, true);
    expect(instances.has('a')).toBe(true); // survived
    expect(selectFallbackAfterClose).not.toHaveBeenCalled();
  });

  it('2+ alive, confirmed → one Stop-All dialog listing names, then destroys all', async () => {
    h.confirmDialog.mockResolvedValue(true);
    instances.set('a', makeInst('a', 'alive', 'Build'));
    instances.set('b', makeInst('b', 'alive', 'Serve'));
    instances.set('c', makeInst('c', 'exited'));

    await closeTabs(['a', 'b', 'c']);

    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    const arg = h.confirmDialog.mock.calls[0][0];
    expect(arg.title).toBe('Stop All Running Terminals?');
    expect(arg.confirmLabel).toBe('Stop All');
    expect(arg.danger).toBe(true);
    // Only the alive tabs' display names are listed.
    expect(arg.message).toContain('Build');
    expect(arg.message).toContain('Serve');

    for (const id of ['a', 'b', 'c']) {
      expect(closeDynamicTerminal).toHaveBeenCalledWith(id, true, true);
    }
    expect(selectFallbackAfterClose).toHaveBeenCalledTimes(1);
  });

  it('2+ alive, cancelled → nothing is destroyed', async () => {
    h.confirmDialog.mockResolvedValue(false);
    instances.set('a', makeInst('a', 'alive', 'Build'));
    instances.set('b', makeInst('b', 'alive', 'Serve'));

    await closeTabs(['a', 'b']);

    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    expect(closeDynamicTerminal).not.toHaveBeenCalled();
    expect(selectFallbackAfterClose).not.toHaveBeenCalled();
  });
});
