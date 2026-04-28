// @vitest-environment happy-dom
/**
 * HS-7927 — drawer tab cycling now spans Commands Log + every terminal,
 * not just the terminal tabs (the original HS-6472 behaviour).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isCommandsLogFocused, isNewTerminalShortcut, pickNextDrawerTabId } from './shortcuts.js';

describe('isNewTerminalShortcut (HS-7926)', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 't' };

  it('matches Cmd+T (macOS)', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true })).toBe(true);
  });

  it('matches Ctrl+T (Windows/Linux)', () => {
    expect(isNewTerminalShortcut({ ...base, ctrlKey: true })).toBe(true);
  });

  it('is case-insensitive on the T letter', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, key: 'T' })).toBe(true);
  });

  it('rejects Cmd+Shift+T (reserved by browsers for "reopen closed tab")', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, shiftKey: true })).toBe(false);
  });

  it('rejects Cmd+Alt+T (reserved for future variant)', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, altKey: true })).toBe(false);
  });

  it('rejects bare T (no modifier — would steal typing)', () => {
    expect(isNewTerminalShortcut(base)).toBe(false);
  });

  it('rejects other letters even with the right modifier', () => {
    expect(isNewTerminalShortcut({ ...base, metaKey: true, key: 'r' })).toBe(false);
  });
});

describe('pickNextDrawerTabId (HS-7927)', () => {
  it('cycles forward through every drawer tab including commands-log', () => {
    const tabs = [
      { active: true, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
      { active: false, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, 1)).toBe('terminal:a');
  });

  it('cycles backward and wraps from commands-log to the last terminal', () => {
    const tabs = [
      { active: true, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
      { active: false, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, -1)).toBe('terminal:b');
  });

  it('forward-wraps from the last terminal back to commands-log', () => {
    const tabs = [
      { active: false, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
      { active: true, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, 1)).toBe('commands-log');
  });

  it('lands on commands-log when stepping back from the first terminal — the HS-7927 user-reported gap', () => {
    // Pre-fix this configuration would have wrapped 'terminal:a' → 'terminal:b'
    // because commands-log was excluded from the cycle.
    const tabs = [
      { active: false, tabId: 'commands-log' },
      { active: true, tabId: 'terminal:a' },
      { active: false, tabId: 'terminal:b' },
    ];
    expect(pickNextDrawerTabId(tabs, -1)).toBe('commands-log');
  });

  it('returns null when there are fewer than two cyclable tabs (single-tab no-op)', () => {
    expect(pickNextDrawerTabId([{ active: true, tabId: 'commands-log' }], 1)).toBeNull();
    expect(pickNextDrawerTabId([], 1)).toBeNull();
  });

  it('starts from tab 0 when nothing is currently active', () => {
    const tabs = [
      { active: false, tabId: 'commands-log' },
      { active: false, tabId: 'terminal:a' },
    ];
    expect(pickNextDrawerTabId(tabs, 1)).toBe('terminal:a');
  });
});

describe('isCommandsLogFocused (HS-7927 follow-up)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true when focus is on the commands-log search input', () => {
    document.body.innerHTML = `
      <div id="drawer-panel-commands-log">
        <input id="command-log-search" />
      </div>
    `;
    const input = document.getElementById('command-log-search') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns true for any focusable descendant of #drawer-panel-commands-log', () => {
    document.body.innerHTML = `
      <div id="drawer-panel-commands-log">
        <div>
          <button id="nested-btn">x</button>
        </div>
      </div>
    `;
    (document.getElementById('nested-btn') as HTMLButtonElement).focus();
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns false when focus is on an unrelated input', () => {
    document.body.innerHTML = `
      <div id="drawer-panel-commands-log"></div>
      <input id="other" />
    `;
    (document.getElementById('other') as HTMLInputElement).focus();
    expect(isCommandsLogFocused()).toBe(false);
  });

  it('returns false when nothing is focused (activeElement === body)', () => {
    document.body.innerHTML = `<div id="drawer-panel-commands-log"></div>`;
    expect(isCommandsLogFocused()).toBe(false);
  });

  // HS-7927 second follow-up — focus on the Commands Log tab BUTTON (which
  // lives in `.drawer-tabs`, OUTSIDE `#drawer-panel-commands-log`) also
  // counts as "commands-log focused" so Cmd+Shift+Arrow cycles drawer tabs
  // even though the user just clicked the tab button.
  it('returns true when focus is on the Commands Log tab button and commands-log is the active drawer tab', () => {
    document.body.innerHTML = `
      <div id="command-log-panel">
        <div class="drawer-tabs">
          <button class="drawer-tab active" data-drawer-tab="commands-log" id="drawer-tab-commands-log"></button>
          <button class="drawer-tab" data-drawer-tab="terminal:default"></button>
        </div>
        <div id="drawer-panel-commands-log"></div>
      </div>
    `;
    (document.getElementById('drawer-tab-commands-log') as HTMLButtonElement).focus();
    expect(isCommandsLogFocused()).toBe(true);
  });

  it('returns false when focus is on a terminal tab button (commands-log is not the active drawer tab)', () => {
    document.body.innerHTML = `
      <div id="command-log-panel">
        <div class="drawer-tabs">
          <button class="drawer-tab" data-drawer-tab="commands-log"></button>
          <button class="drawer-tab active" data-drawer-tab="terminal:default" id="drawer-tab-terminal"></button>
        </div>
      </div>
    `;
    (document.getElementById('drawer-tab-terminal') as HTMLButtonElement).focus();
    expect(isCommandsLogFocused()).toBe(false);
  });

  it('returns false when focus is in the drawer chrome but no drawer tab is active', () => {
    document.body.innerHTML = `
      <div id="command-log-panel">
        <div class="drawer-tabs">
          <button class="drawer-tab" data-drawer-tab="commands-log" id="drawer-tab-commands-log"></button>
        </div>
      </div>
    `;
    (document.getElementById('drawer-tab-commands-log') as HTMLButtonElement).focus();
    // No `.active` class — the tab is focused but not active. Should be false.
    expect(isCommandsLogFocused()).toBe(false);
  });
});
