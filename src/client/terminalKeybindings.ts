/**
 * Shared xterm keybindings that are not tied to a specific terminal instance
 * (drawer, dashboard centered tile, dashboard dedicated view). Factored out so
 * every xterm instance in the app gets the same app-level shortcuts regardless
 * of where the xterm is mounted.
 *
 * HS-7329 — Cmd/Ctrl+K clears the terminal (Terminal.app / iTerm2 / VS Code
 * convention). `term.clear()` keeps the current prompt row and drops everything
 * above it (both viewport and scrollback). We intercept unconditionally even
 * when a TUI like `vim` is running, matching Terminal.app / iTerm2; users who
 * want readline's `Ctrl+K` (kill-line) can hold Shift or Alt and we pass the
 * event through to xterm's default handling.
 */

export interface KeyLikeEvent {
  readonly type: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}

export function isClearTerminalShortcut(e: KeyLikeEvent): boolean {
  if (e.type !== 'keydown') return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey || e.shiftKey) return false;
  return e.key === 'k' || e.key === 'K';
}
