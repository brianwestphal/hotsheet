/**
 * Per-drawer-terminal types + the shared module-level state slot,
 * extracted out of `terminal.tsx` per HS-8396 (the "main interfaces in
 * their own file + instance management functions in their own file"
 * split). Mirrors the state-holder pattern landed under HS-8395
 * (`terminalDashboardState.ts`) and HS-8394 Phase 2
 * (`permissionPopupState.ts`) — both `terminal.tsx` (init / activate /
 * reconciliation) and `terminalInstanceLifecycle.tsx` (createInstance /
 * setStatus / teardown / removeTerminalInstance / disposeAllInstances)
 * import these directly so the cross-module surface stays minimal.
 *
 * Owns:
 * - `Status`, `TerminalTabConfig`, `TerminalInstance` interfaces.
 * - `instances` Map — the imperative source of truth for per-id xterm +
 *   WebSocket lifetime.
 * - `drawerInstancesSignal` — the signal driving the drawer tab strip +
 *   pane container bindLists (HS-8312 / §60 Phase 2).
 * - `drawerTabsBindListDispose` / `drawerPanesBindListDispose` slots
 *   plus their setter helpers (test-reset rebinds these).
 * - `TerminalModuleState` interface + `freshTerminalModuleState()` +
 *   the mutable `terminalState` slot + `setTerminalState(next)` setter
 *   (ES module `export let` bindings are read-only at the import site,
 *   so cross-module reset code can't reassign without the setter).
 *
 * No DOM construction, no lifecycle management — those live in
 * `terminalInstanceLifecycle.tsx`.
 */

import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal as XTerm } from '@xterm/xterm';

import { type Signal, signal } from './reactive.js';
import { bindList } from './reactive-bind.js';
import type { CheckoutHandle } from './terminalCheckout.js';
import type { TerminalSearchHandle } from './terminalSearch.js';
import type { ShellIntegrationState } from './terminalShellIntegration.js';

export type Status = 'not-connected' | 'connecting' | 'alive' | 'exited';

export interface TerminalTabConfig {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  lazy?: boolean;
  /** True for dynamically-created terminals (closable from the tab strip). */
  dynamic?: boolean;
  /** HS-6307 — per-terminal appearance override (theme id / font id / size).
   *  Unset fields fall back to the project default + hard-coded fallback. */
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
}

export interface TerminalInstance {
  id: string;
  config: TerminalTabConfig;
  /** HS-8044 — the drawer pane is a `terminalCheckout` consumer (Phase
   *  2.4 of HS-8032). The handle owns the live xterm + WebSocket + the
   *  per-entry FitAddon. `term`, `fit`, `search`, `searchHandle` are
   *  cleared when the consumer is disposed (tab closed, project
   *  switched away, drawer terminated). The handle is `null` until the
   *  tab is first activated (lazy mount, matches pre-fix behavior). */
  checkout: CheckoutHandle | null;
  /** HS-8044 — disposers for `term.onResize`, `term.onTitleChange`,
   *  `term.onBell`, OSC 7 / OSC 133 parser hooks. Captured so a tab
   *  close / dispose drops the handlers from the shared term — without
   *  this, a re-mount of the same `(secret, terminalId)` would stack
   *  duplicate handlers atop the surviving xterm. */
  termHandlerDisposers: Array<{ dispose(): void }>;
  /** Convenience aliases sourced from `checkout.term` / `checkout.fit`
   *  + the per-tab SearchAddon for backward compat with the many
   *  `inst.term?.X(...)` callsites scattered across the file. Updated
   *  in `mountInstanceViaCheckout`; null when checkout is null. */
  term: XTerm | null;
  fit: FitAddon | null;
  search: SearchAddon | null;
  searchHandle: TerminalSearchHandle | null;
  body: HTMLElement;
  /** HS-7959 — inner padding-less host that owns the xterm. Distinct from
   *  `body` (which keeps the visual padding + focus ring) so xterm's
   *  FitAddon can read accurate parent dimensions. */
  canvasHost: HTMLElement;
  header: HTMLElement;
  label: HTMLElement;
  statusDot: HTMLElement;
  pane: HTMLElement;
  tabBtn: HTMLElement;
  /** HS-8044 — WebSocket lifecycle now lives in `terminalCheckout`. The
   *  drawer no longer owns or reconnects to a WS directly. Kept as a
   *  permanently-null field so the few remaining read sites (status
   *  checks during shutdown, etc.) don't need to be rewritten — the
   *  checkout module's reconnect-on-close path replaces the drawer's
   *  prior `scheduleReconnect` flow entirely. */
  ws: WebSocket | null;
  wsSecret: string | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  status: Status;
  exitCode: number | null;
  stopRequested: boolean;
  /** Becomes true once the xterm DOM has been mounted (happens on first activation). */
  mounted: boolean;
  /** Title pushed by the running process via OSC 0 / OSC 2 (`\x1b]0;TITLE\x07`).
   *  When non-empty, takes precedence over the configured `name` for the tab label
   *  (HS-6473, see docs/23-terminal-titles-and-bell.md). Reset on PTY restart. */
  runtimeTitle: string;
  /** CWD pushed by the running shell via OSC 7 (`\x1b]7;file://host/path\x07`).
   *  Null until the shell pushes its first OSC 7 (typical zsh/fish/starship
   *  prompts emit this on every command). Shown as a clickable chip in the
   *  terminal toolbar that opens the folder in the OS file manager. Reset on
   *  PTY restart. HS-7262, see docs/29-osc7-cwd-tracking.md. */
  runtimeCwd: string | null;
  /** True when the process has rung the bell (`\x07`) since this terminal tab
   *  was last activated. Cleared by `activateTerminal` (HS-6473). */
  hasBell: boolean;
  /** OSC 133 shell-integration state (HS-7267 / docs/26-shell-integration-osc133.md).
   *  `enabled` flips true once the first 133 escape is seen; the gutter only
   *  renders while enabled so users who haven't opted into shell integration
   *  see no layout change. `commands` is a bounded ring (500) of per-prompt
   *  records; `current` is the in-flight record between A and D. */
  shellIntegration: ShellIntegrationState;
}

/** Imperative source of truth for per-id xterm + WebSocket lifetime. The
 *  bindLists below decide WHERE in the DOM each row sits; this Map decides
 *  WHAT lives at each id. */
export const instances = new Map<string, TerminalInstance>();

/**
 * HS-8312 / §60 Phase 2 — drawer tab strip + pane container reconciled
 * via two parallel bindLists keyed on terminal id. Pre-fix
 * `loadAndRenderTerminalTabs` did a wholesale clear of `tabStrip` plus
 * a per-pane sweep on `paneContainer`, then re-appended every
 * `inst.tabBtn` / `inst.pane` in order — which DID preserve the xterm +
 * WS instances (those live in `instances`) but churned DOM positions on
 * every poll tick. Post-fix surviving rows keep their DOM identity
 * across reorder; the bindList only mutates the DOM for rows that
 * actually moved, appeared, or disappeared.
 */
export const drawerInstancesSignal: Signal<readonly TerminalInstance[]> = signal([]);

let drawerTabsBindListDispose: (() => void) | null = null;
let drawerPanesBindListDispose: (() => void) | null = null;

export function ensureDrawerBindLists(tabStrip: HTMLElement, paneContainer: HTMLElement): void {
  if (drawerTabsBindListDispose === null) {
    drawerTabsBindListDispose = bindList(
      tabStrip,
      drawerInstancesSignal,
      (inst) => inst.id,
      (inst) => ({ el: inst.tabBtn }),
    );
  }
  if (drawerPanesBindListDispose === null) {
    drawerPanesBindListDispose = bindList(
      paneContainer,
      drawerInstancesSignal,
      (inst) => inst.id,
      (inst) => ({ el: inst.pane }),
    );
  }
}

/** Used by `_resetStateForTesting` so the next test's setupDom rebinds
 *  to the fresh tabStrip / paneContainer DOM. Without this, the bindLists
 *  from a prior test stay bound to a now-detached DOM and the next signal
 *  write mutates nothing visible. */
export function disposeDrawerBindLists(): void {
  if (drawerTabsBindListDispose !== null) {
    drawerTabsBindListDispose();
    drawerTabsBindListDispose = null;
  }
  if (drawerPanesBindListDispose !== null) {
    drawerPanesBindListDispose();
    drawerPanesBindListDispose = null;
  }
}

/**
 * HS-8224 — bundled module-level lifecycle state, mirroring the HS-8190
 * pattern landed in `permissionOverlay.tsx` and the HS-8222 / HS-8223
 * follow-ups applied to `terminalDashboard.tsx` + `drawerTerminalGrid.tsx`.
 * Holds the active-terminal pointer, the project-secret the per-instance
 * state was built for, the last-known config snapshot driven by every
 * `/terminal/list` round-trip, and the bell-subscription idempotency flag.
 */
export interface TerminalModuleState {
  activeTerminalId: string | null;
  /** The project secret the current instances were built for. Changes
   *  trigger a full rebuild (HS-6309). */
  currentProjectSecret: string | null;
  /** Populated on each loadAndRenderTerminalTabs(). Consumed by
   *  settings-refresh flows. */
  lastKnownConfigs: { configured: TerminalTabConfig[]; dynamic: TerminalTabConfig[] };
  /** Idempotency flag for `subscribeToBellState`. */
  bellSubscribed: boolean;
}

export function freshTerminalModuleState(): TerminalModuleState {
  return {
    activeTerminalId: null,
    currentProjectSecret: null,
    lastKnownConfigs: { configured: [], dynamic: [] },
    bellSubscribed: false,
  };
}

/** Mutable module-level state slot. Both `terminal.tsx` and
 *  `terminalInstanceLifecycle.tsx` read + write field-level here. */
export let terminalState: TerminalModuleState = freshTerminalModuleState();

/** Replace the slot wholesale — required for the test reset path because
 *  ES module `export let` bindings are read-only at the import site. */
export function setTerminalState(next: TerminalModuleState): void {
  terminalState = next;
}
