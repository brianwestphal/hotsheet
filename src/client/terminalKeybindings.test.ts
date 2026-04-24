import { describe, expect, it } from 'vitest';

import { isClearTerminalShortcut, isFindShortcut, isJumpShortcut } from './terminalKeybindings.js';

type AnyHelper = typeof isClearTerminalShortcut | typeof isFindShortcut | typeof isJumpShortcut;

function evt(overrides: Partial<Parameters<AnyHelper>[0]> = {}): Parameters<AnyHelper>[0] {
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

describe('isClearTerminalShortcut (HS-7329 / HS-7459)', () => {
  describe('on macOS (isMac=true)', () => {
    const mac = true;

    it('matches Cmd+K', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true }), mac)).toBe(true);
    });

    it('does NOT match Ctrl+K — forwarded to shell for readline kill-line (HS-7459)', () => {
      expect(isClearTerminalShortcut(evt({ ctrlKey: true }), mac)).toBe(false);
    });

    it('does not match Cmd+Ctrl+K (both modifiers held)', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true, ctrlKey: true }), mac)).toBe(false);
    });

    it('is case-insensitive on the key letter', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'K' }), mac)).toBe(true);
      expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'k' }), mac)).toBe(true);
    });

    it('does not match Cmd+Shift+K / Cmd+Alt+K', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true, shiftKey: true }), mac)).toBe(false);
      expect(isClearTerminalShortcut(evt({ metaKey: true, altKey: true }), mac)).toBe(false);
    });
  });

  describe('on Linux/Windows (isMac=false)', () => {
    const nonMac = false;

    it('matches Ctrl+K', () => {
      expect(isClearTerminalShortcut(evt({ ctrlKey: true }), nonMac)).toBe(true);
    });

    it('does NOT match Cmd+K on non-Mac (no such convention)', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true }), nonMac)).toBe(false);
    });

    it('does not match Cmd+Ctrl+K (both modifiers held)', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true, ctrlKey: true }), nonMac)).toBe(false);
    });

    it('is case-insensitive on the key letter', () => {
      expect(isClearTerminalShortcut(evt({ ctrlKey: true, key: 'K' }), nonMac)).toBe(true);
      expect(isClearTerminalShortcut(evt({ ctrlKey: true, key: 'k' }), nonMac)).toBe(true);
    });

    it('does not match Ctrl+Shift+K — lets readline Ctrl+Shift+K through', () => {
      expect(isClearTerminalShortcut(evt({ ctrlKey: true, shiftKey: true }), nonMac)).toBe(false);
    });

    it('does not match Ctrl+Alt+K', () => {
      expect(isClearTerminalShortcut(evt({ ctrlKey: true, altKey: true }), nonMac)).toBe(false);
    });
  });

  describe('shared invariants', () => {
    it('does not match without any modifier (plain k)', () => {
      expect(isClearTerminalShortcut(evt({ key: 'k' }), true)).toBe(false);
      expect(isClearTerminalShortcut(evt({ key: 'k' }), false)).toBe(false);
    });

    it('does not match other keys with the correct modifier', () => {
      expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'c' }), true)).toBe(false);
      expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'j' }), true)).toBe(false);
      expect(isClearTerminalShortcut(evt({ metaKey: true, key: 'ArrowUp' }), true)).toBe(false);
      expect(isClearTerminalShortcut(evt({ ctrlKey: true, key: 'c' }), false)).toBe(false);
    });

    it('ignores keyup and keypress events', () => {
      expect(isClearTerminalShortcut(evt({ type: 'keyup', metaKey: true }), true)).toBe(false);
      expect(isClearTerminalShortcut(evt({ type: 'keypress', metaKey: true }), true)).toBe(false);
      expect(isClearTerminalShortcut(evt({ type: 'keyup', ctrlKey: true }), false)).toBe(false);
    });
  });

  describe('runtime platform detection (default arg)', () => {
    it('uses navigator.userAgent when isMac is not supplied', () => {
      // This process runs under Node / vitest where `navigator` is defined
      // (Node 20+) and `userAgent` is typically a Node.js string — so the
      // default detection should be !isMac, meaning Ctrl+K matches and
      // Cmd+K does not. This guards against regressions in the default path.
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const defaultIsMac = ua.includes('Mac');
      expect(isClearTerminalShortcut(evt({ metaKey: true }))).toBe(defaultIsMac);
      expect(isClearTerminalShortcut(evt({ ctrlKey: true }))).toBe(!defaultIsMac);
    });
  });
});

describe('isFindShortcut (HS-7460)', () => {
  describe('on macOS (isMac=true)', () => {
    const mac = true;

    it('matches Cmd+F', () => {
      expect(isFindShortcut(evt({ key: 'f', metaKey: true }), mac)).toBe(true);
    });

    it('does NOT match Ctrl+F — forwarded to shell for readline forward-char', () => {
      expect(isFindShortcut(evt({ key: 'f', ctrlKey: true }), mac)).toBe(false);
    });

    it('does not match Cmd+Ctrl+F (both modifiers held)', () => {
      expect(isFindShortcut(evt({ key: 'f', metaKey: true, ctrlKey: true }), mac)).toBe(false);
    });

    it('is case-insensitive on the key letter', () => {
      expect(isFindShortcut(evt({ key: 'F', metaKey: true }), mac)).toBe(true);
      expect(isFindShortcut(evt({ key: 'f', metaKey: true }), mac)).toBe(true);
    });

    it('does not match Cmd+Shift+F / Cmd+Alt+F', () => {
      expect(isFindShortcut(evt({ key: 'f', metaKey: true, shiftKey: true }), mac)).toBe(false);
      expect(isFindShortcut(evt({ key: 'f', metaKey: true, altKey: true }), mac)).toBe(false);
    });
  });

  describe('on Linux/Windows (isMac=false)', () => {
    const nonMac = false;

    it('matches Ctrl+F', () => {
      expect(isFindShortcut(evt({ key: 'f', ctrlKey: true }), nonMac)).toBe(true);
    });

    it('does NOT match Cmd+F on non-Mac', () => {
      expect(isFindShortcut(evt({ key: 'f', metaKey: true }), nonMac)).toBe(false);
    });

    it('does not match Cmd+Ctrl+F (both modifiers held)', () => {
      expect(isFindShortcut(evt({ key: 'f', metaKey: true, ctrlKey: true }), nonMac)).toBe(false);
    });
  });

  describe('shared invariants', () => {
    it('does not match without any modifier (plain f)', () => {
      expect(isFindShortcut(evt({ key: 'f' }), true)).toBe(false);
      expect(isFindShortcut(evt({ key: 'f' }), false)).toBe(false);
    });

    it('does not match other keys with the correct modifier', () => {
      expect(isFindShortcut(evt({ key: 'k', metaKey: true }), true)).toBe(false);
      expect(isFindShortcut(evt({ key: 'd', ctrlKey: true }), false)).toBe(false);
    });

    it('ignores keyup and keypress events', () => {
      expect(isFindShortcut(evt({ key: 'f', type: 'keyup', metaKey: true }), true)).toBe(false);
      expect(isFindShortcut(evt({ key: 'f', type: 'keypress', ctrlKey: true }), false)).toBe(false);
    });
  });
});

describe('isJumpShortcut (HS-7460)', () => {
  describe('on macOS (isMac=true)', () => {
    const mac = true;

    it('returns prev for Cmd+ArrowUp', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', metaKey: true }), mac)).toBe('prev');
    });

    it('returns next for Cmd+ArrowDown', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowDown', metaKey: true }), mac)).toBe('next');
    });

    it('returns null for Ctrl+ArrowUp — forwarded to shell (tmux pane resize, vim, etc.)', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', ctrlKey: true }), mac)).toBeNull();
    });

    it('returns null for Ctrl+ArrowDown', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowDown', ctrlKey: true }), mac)).toBeNull();
    });

    it('returns null for Cmd+Ctrl+ArrowUp (both modifiers held)', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', metaKey: true, ctrlKey: true }), mac)).toBeNull();
    });

    it('returns null for Cmd+Shift+ArrowUp (selection-extend chord preserved)', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', metaKey: true, shiftKey: true }), mac)).toBeNull();
    });
  });

  describe('on Linux/Windows (isMac=false)', () => {
    const nonMac = false;

    it('returns prev for Ctrl+ArrowUp', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', ctrlKey: true }), nonMac)).toBe('prev');
    });

    it('returns next for Ctrl+ArrowDown', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowDown', ctrlKey: true }), nonMac)).toBe('next');
    });

    it('returns null for Cmd+ArrowUp on non-Mac', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', metaKey: true }), nonMac)).toBeNull();
    });

    it('returns null for Ctrl+Alt+ArrowUp (alt-arrow chord preserved)', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', ctrlKey: true, altKey: true }), nonMac)).toBeNull();
    });
  });

  describe('shared invariants', () => {
    it('returns null without any modifier (plain ArrowUp)', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp' }), true)).toBeNull();
      expect(isJumpShortcut(evt({ key: 'ArrowDown' }), false)).toBeNull();
    });

    it('returns null for ArrowLeft / ArrowRight even with the correct modifier', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowLeft', metaKey: true }), true)).toBeNull();
      expect(isJumpShortcut(evt({ key: 'ArrowRight', ctrlKey: true }), false)).toBeNull();
    });

    it('returns null for non-arrow keys with the correct modifier', () => {
      expect(isJumpShortcut(evt({ key: 'k', metaKey: true }), true)).toBeNull();
      expect(isJumpShortcut(evt({ key: 'PageUp', ctrlKey: true }), false)).toBeNull();
    });

    it('ignores keyup and keypress events', () => {
      expect(isJumpShortcut(evt({ key: 'ArrowUp', type: 'keyup', metaKey: true }), true)).toBeNull();
      expect(isJumpShortcut(evt({ key: 'ArrowDown', type: 'keypress', ctrlKey: true }), false)).toBeNull();
    });
  });
});
