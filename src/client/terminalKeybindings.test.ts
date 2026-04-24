import { describe, expect, it } from 'vitest';

import { isClearTerminalShortcut } from './terminalKeybindings.js';

function evt(overrides: Partial<Parameters<typeof isClearTerminalShortcut>[0]> = {}): Parameters<typeof isClearTerminalShortcut>[0] {
  return {
    type: 'keydown',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: 'k',
    ...overrides,
  };
}

describe('isClearTerminalShortcut (HS-7329)', () => {
  it('matches Cmd+K on macOS (metaKey)', () => {
    expect(isClearTerminalShortcut(evt({ metaKey: true }))).toBe(true);
  });

  it('matches Ctrl+K on other platforms (ctrlKey)', () => {
    expect(isClearTerminalShortcut(evt({ ctrlKey: true }))).toBe(true);
  });

  it('is case-insensitive on the key letter', () => {
    expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'K' }))).toBe(true);
    expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'k' }))).toBe(true);
  });

  it('does not match without a modifier (plain k)', () => {
    expect(isClearTerminalShortcut(evt({ key: 'k' }))).toBe(false);
  });

  it('does not match Alt+K (common terminal mode)', () => {
    expect(isClearTerminalShortcut(evt({ metaKey: true, altKey: true }))).toBe(false);
    expect(isClearTerminalShortcut(evt({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('does not match Shift+Cmd+K — lets readline Ctrl+Shift+K through', () => {
    expect(isClearTerminalShortcut(evt({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isClearTerminalShortcut(evt({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('does not match other keys with Cmd/Ctrl', () => {
    expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'c' }))).toBe(false);
    expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'j' }))).toBe(false);
    expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'ArrowUp' }))).toBe(false);
  });

  it('ignores keyup and keypress events', () => {
    expect(isClearTerminalShortcut(evt({ type: 'keyup', metaKey: true }))).toBe(false);
    expect(isClearTerminalShortcut(evt({ type: 'keypress', metaKey: true }))).toBe(false);
  });
});
