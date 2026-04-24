/**
 * Shared xterm keybindings that are not tied to a specific terminal instance
 * (drawer, dashboard centered tile, dashboard dedicated view). Factored out so
 * every xterm instance in the app gets the same app-level shortcuts regardless
 * of where the xterm is mounted.
 *
 * HS-7329 / HS-7459 — "clear terminal" shortcut is platform-specific. On
 * macOS the convention is Cmd+K (Terminal.app / iTerm2 / VS Code); on Linux
 * and Windows the same apps use Ctrl+K. We intercept one platform-correct
 * shortcut only — the other modifier passes through to xterm unchanged so,
 * e.g., macOS Ctrl+K keeps working as readline's kill-line. `term.clear()`
 * keeps the current prompt row and drops everything above it (both viewport
 * and scrollback). Users who want readline's Ctrl+K on Linux/Windows can hold
 * Shift or Alt and the event passes through.
 *
 * HS-7460 — `isFindShortcut` and `isJumpShortcut` follow the same pattern for
 * Cmd/Ctrl+F (terminal search widget) and Cmd/Ctrl+Up/Down (OSC 133 jumps).
 * The wrong-platform modifier passes through so e.g. macOS Ctrl+F still
 * reaches readline's `forward-char` and macOS Ctrl+Up/Down still reaches
 * tmux / vim / fish-shell bindings that use those chords.
 */

export interface KeyLikeEvent {
  readonly type: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}

export type JumpDirection = 'prev' | 'next';

function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes('Mac');
}

/**
 * True iff the event carries the platform-correct primary modifier (Cmd on
 * macOS, Ctrl elsewhere) with no conflicting Alt/Shift and without the
 * other-platform modifier also held. Centralised so every cross-xterm shortcut
 * (clear, find, jump, future ones) follows the same matching rules.
 */
function hasPlatformPrimaryModifier(e: KeyLikeEvent, isMac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (isMac) {
    return e.metaKey && !e.ctrlKey;
  }
  return e.ctrlKey && !e.metaKey;
}

export function isClearTerminalShortcut(e: KeyLikeEvent, isMac: boolean = detectIsMac()): boolean {
  if (e.type !== 'keydown') return false;
  if (e.key !== 'k' && e.key !== 'K') return false;
  return hasPlatformPrimaryModifier(e, isMac);
}

export function isFindShortcut(e: KeyLikeEvent, isMac: boolean = detectIsMac()): boolean {
  if (e.type !== 'keydown') return false;
  if (e.key !== 'f' && e.key !== 'F') return false;
  return hasPlatformPrimaryModifier(e, isMac);
}

export function isJumpShortcut(e: KeyLikeEvent, isMac: boolean = detectIsMac()): JumpDirection | null {
  if (e.type !== 'keydown') return null;
  if (!hasPlatformPrimaryModifier(e, isMac)) return null;
  if (e.key === 'ArrowUp') return 'prev';
  if (e.key === 'ArrowDown') return 'next';
  return null;
}
