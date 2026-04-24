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
 */

export interface KeyLikeEvent {
  readonly type: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}

function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes('Mac');
}

export function isClearTerminalShortcut(e: KeyLikeEvent, isMac: boolean = detectIsMac()): boolean {
  if (e.type !== 'keydown') return false;
  if (e.altKey || e.shiftKey) return false;
  if (e.key !== 'k' && e.key !== 'K') return false;
  if (isMac) {
    return e.metaKey && !e.ctrlKey;
  }
  return e.ctrlKey && !e.metaKey;
}
