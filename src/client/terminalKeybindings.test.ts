import { describe, expect, it } from 'vitest';

import { isClearTerminalShortcut, isFindShortcut, isJumpShortcut, isMagnifiedNavShortcut, isTerminalViewToggleShortcut } from './terminalKeybindings.js';

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

describe('isTerminalViewToggleShortcut (HS-7594)', () => {
  describe('on macOS (isMac=true)', () => {
    const mac = true;

    it('matches Cmd+` (plain) and reports alt:false', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, key: '`' }), mac)).toEqual({ alt: false });
    });

    it('matches Cmd+Alt+` and reports alt:true', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, altKey: true, key: '`' }), mac)).toEqual({ alt: true });
    });

    it('matches via e.code === Backquote when e.key is something else (AZERTY layouts)', () => {
      // Some AZERTY engines surface backtick as "Dead" on .key; .code stays
      // 'Backquote'. Cast through unknown to inject the optional `code` field.
      const e = { ...evt({ metaKey: true, key: 'Dead' }), code: 'Backquote' } as Parameters<typeof isTerminalViewToggleShortcut>[0];
      expect(isTerminalViewToggleShortcut(e, mac)).toEqual({ alt: false });
    });

    it('does NOT match Ctrl+` — forwarded to shell on macOS (no readline binding by default but the chord is reserved for tools like fish-shell)', () => {
      expect(isTerminalViewToggleShortcut(evt({ ctrlKey: true, key: '`' }), mac)).toBeNull();
    });

    it('rejects when both Cmd and Ctrl are held', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, ctrlKey: true, key: '`' }), mac)).toBeNull();
    });

    it('rejects when Shift is held — leaves room for future bindings', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, shiftKey: true, key: '`' }), mac)).toBeNull();
    });

    it('rejects non-backtick keys', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, key: 'k' }), mac)).toBeNull();
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, key: '~' }), mac)).toBeNull();
    });
  });

  describe('on Linux/Windows (isMac=false)', () => {
    const nonMac = false;

    it('matches Ctrl+` (plain) and reports alt:false', () => {
      expect(isTerminalViewToggleShortcut(evt({ ctrlKey: true, key: '`' }), nonMac)).toEqual({ alt: false });
    });

    it('matches Ctrl+Alt+` and reports alt:true', () => {
      expect(isTerminalViewToggleShortcut(evt({ ctrlKey: true, altKey: true, key: '`' }), nonMac)).toEqual({ alt: true });
    });

    it('does NOT match Cmd+` — Cmd has no convention on non-Mac platforms', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, key: '`' }), nonMac)).toBeNull();
    });
  });

  describe('shared invariants', () => {
    it('ignores non-keydown events on both platforms', () => {
      expect(isTerminalViewToggleShortcut(evt({ metaKey: true, key: '`', type: 'keyup' }), true)).toBeNull();
      expect(isTerminalViewToggleShortcut(evt({ ctrlKey: true, key: '`', type: 'keypress' }), false)).toBeNull();
    });

    it('rejects no-modifier backtick (would otherwise prevent typing it into the shell)', () => {
      expect(isTerminalViewToggleShortcut(evt({ key: '`' }), true)).toBeNull();
      expect(isTerminalViewToggleShortcut(evt({ key: '`' }), false)).toBeNull();
    });
  });
});

describe('isMagnifiedNavShortcut (HS-8028)', () => {
  describe('on macOS (isMac=true)', () => {
    const mac = true;
    it('returns "right" for Shift+Cmd+ArrowRight', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'ArrowRight' }), mac)).toBe('right');
    });
    it('returns "left" for Shift+Cmd+ArrowLeft', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'ArrowLeft' }), mac)).toBe('left');
    });
    it('returns "up" for Shift+Cmd+ArrowUp', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'ArrowUp' }), mac)).toBe('up');
    });
    it('returns "down" for Shift+Cmd+ArrowDown', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'ArrowDown' }), mac)).toBe('down');
    });

    it('does NOT match plain Cmd+Arrow (no Shift) — preserved for OSC 133 jumps', () => {
      expect(isMagnifiedNavShortcut(evt({ metaKey: true, key: 'ArrowUp' }), mac)).toBeNull();
      expect(isMagnifiedNavShortcut(evt({ metaKey: true, key: 'ArrowDown' }), mac)).toBeNull();
    });

    it('does NOT match Shift+Arrow alone (no Cmd)', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, key: 'ArrowRight' }), mac)).toBeNull();
    });

    it('does NOT match Shift+Ctrl+Arrow on macOS — wrong-platform modifier passes through', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, ctrlKey: true, key: 'ArrowUp' }), mac)).toBeNull();
    });

    it('does NOT match Shift+Cmd+Alt+Arrow — alt held disqualifies', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, altKey: true, key: 'ArrowUp' }), mac)).toBeNull();
    });

    it('does NOT match for non-arrow keys', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'a' }), mac)).toBeNull();
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'Tab' }), mac)).toBeNull();
    });
  });

  describe('on Linux/Windows (isMac=false)', () => {
    const nonMac = false;
    it('returns "right" for Shift+Ctrl+ArrowRight', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, ctrlKey: true, key: 'ArrowRight' }), nonMac)).toBe('right');
    });

    it('does NOT match Shift+Cmd+Arrow on Linux/Windows — wrong-platform modifier passes through', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'ArrowRight' }), nonMac)).toBeNull();
    });
  });

  describe('shared invariants', () => {
    it('ignores non-keydown events on both platforms', () => {
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, metaKey: true, key: 'ArrowUp', type: 'keyup' }), true)).toBeNull();
      expect(isMagnifiedNavShortcut(evt({ shiftKey: true, ctrlKey: true, key: 'ArrowUp', type: 'keypress' }), false)).toBeNull();
    });
  });
});
