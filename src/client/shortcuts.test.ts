/**
 * HS-7927 — drawer tab cycling now spans Commands Log + every terminal,
 * not just the terminal tabs (the original HS-6472 behaviour).
 */
import { describe, expect, it } from 'vitest';

import { isNewTerminalShortcut, pickNextDrawerTabId } from './shortcuts.js';

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
