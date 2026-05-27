// @vitest-environment happy-dom
/**
 * HS-8656 — Cmd/Ctrl+Shift+[ / ] cycle tabs, matching macOS Terminal.app
 * (which supports both the brackets and the arrows). They're terminal-aware
 * aliases for the Cmd+Shift+Arrow entry: drawer/terminal tab when a terminal is
 * focused, project tab otherwise. These tests pin the routing of the
 * `cycleTabForBracket` wrapper through the two switch sinks.
 *
 * Isolated file (not `shortcuts.test.tsx`) so the commandLog mock — needed
 * because `switchTerminalTabByOffset` dynamically imports `switchDrawerTab` —
 * doesn't clash with that file's real-`getActiveDrawerTab` `isCommandsLogFocused`
 * tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { switchTabByOffset } from './projectTabs.js';
import { cycleTabForBracket } from './shortcuts.js';

vi.mock('./projectTabs.js', () => ({ switchTabByOffset: vi.fn(), closeActiveTab: vi.fn() }));
vi.mock('./commandLog.js', () => ({ getActiveDrawerTab: vi.fn(() => 'commands-log'), switchDrawerTab: vi.fn() }));

function ev(altKey = false): KeyboardEvent {
  return { altKey } as unknown as KeyboardEvent;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('cycleTabForBracket (HS-8656)', () => {
  it('cycles the PROJECT tab when no terminal / drawer is focused', () => {
    cycleTabForBracket(1, ev(), { isInput: false, isTerminalFocused: false, isCommandsLogFocused: false });
    expect(vi.mocked(switchTabByOffset)).toHaveBeenCalledWith(1);
  });

  it('cycles the PROJECT tab even from a regular text input (brackets are not a selection chord)', () => {
    cycleTabForBracket(-1, ev(), { isInput: true, isTerminalFocused: false, isCommandsLogFocused: false });
    expect(vi.mocked(switchTabByOffset)).toHaveBeenCalledWith(-1);
  });

  it('cycles the DRAWER/terminal tab when a terminal is focused', async () => {
    // switchTerminalTabByOffset needs ≥2 drawer tabs (one active) to pick a target.
    document.body.innerHTML =
      '<div id="drawer-terminal-tabs">' +
      '<button class="drawer-tab active" data-drawer-tab="terminal:a"></button>' +
      '<button class="drawer-tab" data-drawer-tab="terminal:b"></button>' +
      '</div>';
    const { switchDrawerTab } = await import('./commandLog.js');

    cycleTabForBracket(1, ev(), { isInput: false, isTerminalFocused: true, isCommandsLogFocused: false });
    // switchTerminalTabByOffset resolves a dynamic import before calling switchDrawerTab.
    await vi.waitFor(() => { expect(vi.mocked(switchDrawerTab)).toHaveBeenCalledWith('terminal:b'); });
    expect(vi.mocked(switchTabByOffset)).not.toHaveBeenCalled();
  });
});
