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

/**
 * HS-7594 — Cmd+` (macOS) / Ctrl+` (Linux/Windows) toggles a terminal-view
 * surface. The exact target depends on where focus is at chord time:
 *
 * - When focus is INSIDE a drawer terminal (`.xterm` ancestor) → toggle the
 *   §36 drawer terminal grid view.
 * - When focus is anywhere else → toggle the §25 global Terminal Dashboard.
 *
 * `isAltVariant` distinguishes Opt+Cmd+` (Alt+Ctrl+` elsewhere): the alt
 * variant always targets the global Terminal Dashboard, so a user whose
 * focus is inside a drawer terminal can jump to the dashboard without
 * leaving the terminal first.
 *
 * The shortcut deliberately uses backtick (matches VS Code's "View: Toggle
 * Terminal" Cmd+`). xterm normally forwards backtick to the shell, so every
 * xterm mount site (drawer terminal, dashboard tile, dashboard dedicated
 * view, drawer-grid tile, drawer-grid dedicated view) uses
 * `isTerminalViewToggleShortcut` in its `attachCustomKeyEventHandler` and
 * returns `false` to swallow the chord — the bubbling DOM event still
 * reaches the document-level shortcuts.tsx listener which dispatches the
 * actual toggle.
 *
 * Detection uses `e.code === 'Backquote'` first (layout-stable), falling
 * back to `e.key === '`'` for engines that don't expose `.code` reliably.
 * Returns null when the chord doesn't match; otherwise `{ alt: true|false }`
 * so the caller can branch on the alt variant.
 */
export function isTerminalViewToggleShortcut(e: KeyLikeEvent, isMac: boolean = detectIsMac()): { alt: boolean } | null {
  if (e.type !== 'keydown') return null;
  // Match either `e.key === '`'` OR (older browsers) `e.code === 'Backquote'`.
  // Some platforms expose `e.key === 'Dead'` for backtick on AZERTY layouts;
  // the `e.code` fallback handles that.
  const code = (e as KeyLikeEvent & { code?: string }).code;
  const isBacktick = e.key === '`' || code === 'Backquote';
  if (!isBacktick) return null;
  if (e.shiftKey) return null;
  // Primary modifier: Cmd on macOS / Ctrl elsewhere.
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary) return null;
  return { alt: e.altKey };
}
