// @vitest-environment happy-dom
/**
 * HS-9443 — tests over the shortcut table's `match` predicates (the TRIGGER),
 * not its `run` sinks.
 *
 * That split is exactly where the bug hid: `shortcutsBracketTab.test.tsx` pinned
 * `cycleTabForBracket`'s routing and `shortcuts.test.tsx` pinned
 * `decideShiftArrowTabAction`'s decision matrix, so the Cmd/Ctrl+Shift+[ / ] chords
 * looked thoroughly covered — while their matchers compared `e.key` against `[` / `]`
 * and could therefore NEVER fire. A browser reports the character the chord
 * PRODUCES, so with Shift held those keys arrive as `{` / `}` (measured in Chromium:
 * `key=} code=BracketRight meta=true ctrl=false shift=true`).
 *
 * Two layers below: the specific bracket cases, and a generic sweep that fails for
 * ANY future shift-chord matching a character Shift would have changed.
 */
import { describe, expect, it } from 'vitest';

import { KEYBOARD_SHORTCUTS, type KeyContext } from './shortcuts.js';

const CTX: KeyContext = { isInput: false, isTerminalFocused: false, isCommandsLogFocused: false };

/** A KeyboardEvent stand-in — matchers only read key/modifier fields. */
function key(k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}): KeyboardEvent {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods } as KeyboardEvent;
}

/** Entries whose matcher accepts `e`, by label. */
function matching(e: KeyboardEvent): string[] {
  return KEYBOARD_SHORTCUTS.filter((sc) => {
    // A matcher may consult module/DOM state; a throw means "not applicable here",
    // never a test failure — the sweep below must not depend on app state.
    try { return sc.match(e, CTX); } catch { return false; }
  }).map(sc => sc.label);
}

describe('Cmd/Ctrl+Shift+[ / ] tab cycling matchers (HS-9443)', () => {
  it('fires for the SHIFTED characters a browser actually reports', () => {
    // The exact events Chromium delivers for these chords.
    expect(matching(key('}', { metaKey: true, shiftKey: true }))).toContain('Cmd/Ctrl+Shift+]: next tab (terminal-aware)');
    expect(matching(key('{', { metaKey: true, shiftKey: true }))).toContain('Cmd/Ctrl+Shift+[: previous tab (terminal-aware)');
    // …and on Windows/Linux, where Ctrl stands in for Cmd.
    expect(matching(key('}', { ctrlKey: true, shiftKey: true }))).toContain('Cmd/Ctrl+Shift+]: next tab (terminal-aware)');
    expect(matching(key('{', { ctrlKey: true, shiftKey: true }))).toContain('Cmd/Ctrl+Shift+[: previous tab (terminal-aware)');
  });

  it('still fires for the unshifted characters (engines that report the base key)', () => {
    // Key reporting differs between engines, and the Tauri WKWebView was not
    // measured — keep accepting the pre-HS-9443 form rather than trading one
    // broken engine for another.
    expect(matching(key(']', { metaKey: true, shiftKey: true }))).toContain('Cmd/Ctrl+Shift+]: next tab (terminal-aware)');
    expect(matching(key('[', { metaKey: true, shiftKey: true }))).toContain('Cmd/Ctrl+Shift+[: previous tab (terminal-aware)');
  });

  it('does not fire without Cmd/Ctrl, or without Shift', () => {
    expect(matching(key('}', { shiftKey: true }))).not.toContain('Cmd/Ctrl+Shift+]: next tab (terminal-aware)');
    expect(matching(key(']', { metaKey: true }))).not.toContain('Cmd/Ctrl+Shift+]: next tab (terminal-aware)');
  });

  it('keeps the two directions distinct', () => {
    expect(matching(key('{', { metaKey: true, shiftKey: true }))).not.toContain('Cmd/Ctrl+Shift+]: next tab (terminal-aware)');
    expect(matching(key('}', { metaKey: true, shiftKey: true }))).not.toContain('Cmd/Ctrl+Shift+[: previous tab (terminal-aware)');
  });
});

/**
 * The generic guard — this is what protects the NEXT punctuation chord someone adds.
 *
 * Invariant: if a matcher REQUIRES Shift and accepts an unshifted character `c` that
 * Shift would change, it is describing an event no browser will ever deliver (the
 * real event carries `SHIFT_MAP[c]`). Such a matcher must therefore ALSO accept the
 * shifted character.
 *
 * "Requires Shift" is measured, not parsed: the matcher accepts `(c, shift)` but
 * rejects `(c, no shift)`. That exclusion matters — `Cmd+,` (settings) has no
 * `shiftKey` check, so it incidentally accepts `Shift+Cmd+,` while remaining
 * perfectly reachable as `Cmd+,`. Only a chord whose ONLY route is through Shift can
 * be made unreachable this way. Letters are excluded too: `e.key` for a shifted
 * letter is its uppercase form, a different question.
 */
const SHIFT_MAP: Readonly<Record<string, string>> = {
  '[': '{', ']': '}', ',': '<', '.': '>', '/': '?', ';': ':', "'": '"',
  '\\': '|', '-': '_', '=': '+', '`': '~',
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
};

describe('no shortcut matches an unreachable shifted chord (HS-9443 class guard)', () => {
  it.each(Object.entries(SHIFT_MAP))('%s → %s', (base, shifted) => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, {}]) {
      const withShift = matching(key(base, { ...mods, shiftKey: true }));
      const withoutShift = new Set(matching(key(base, { ...mods, shiftKey: false })));
      const acceptsShifted = matching(key(shifted, { ...mods, shiftKey: true }));
      for (const label of withShift) {
        if (withoutShift.has(label)) continue; // reachable without Shift — not this class
        expect(
          acceptsShifted,
          `"${label}" requires Shift and matches "${base}", but a real browser event with Shift held carries ` +
          `"${shifted}" — so this chord can never fire. Match both characters (see isBracketKey in shortcuts.tsx).`,
        ).toContain(label);
      }
    }
  });
});
