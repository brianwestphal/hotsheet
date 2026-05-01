import type { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { IDecoration, IMarker, Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { fireToastsForActiveProject, subscribeToBellState } from './bellPoll.js';
import { isChannelAlive, triggerChannelAndMarkBusy } from './channelUI.js';
import { confirmDialog } from './confirm.js';
import { pruneHiddenForProject } from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';
import {
  type DrawerGridTileEntry,
  exitDrawerGridMode,
  isDrawerGridActive,
  onTerminalListUpdated,
} from './drawerTerminalGrid.js';
import { ICON_CLOSE_LEFT, ICON_CLOSE_OTHERS, ICON_CLOSE_RIGHT, ICON_PENCIL, ICON_X } from './icons.js';
import { recordInteraction } from './longTaskObserver.js';
import { getActiveProject, state } from './state.js';
import { getTauriInvoke, openExternalUrl } from './tauriIntegration.js';
import {
  applyAppearanceToTerm,
  getProjectDefault,
  getSessionOverride,
  loadProjectDefaultAppearance,
  resolveAppearance,
  resolveAppearanceBackground,
  subscribeToDefaultAppearanceChanges,
} from './terminalAppearance.js';
import { mountAppearancePopover } from './terminalAppearancePopover.js';
import { checkout,type CheckoutHandle } from './terminalCheckout.js';
import { isClearTerminalShortcut, isFindShortcut, isJumpShortcut, isTerminalViewToggleShortcut } from './terminalKeybindings.js';
import { cacheHomeDir, formatCwdLabel, getCachedHomeDir, parseOsc7Payload } from './terminalOsc7.js';
import { buildAskClaudePrompt, computeLastOutputRange, exitCodeGutterClass, findPromptLine, parseOsc133ExitCode } from './terminalOsc133.js';
import { mountTerminalSearch, type TerminalSearchHandle } from './terminalSearch.js';
import { configuredSubsetInStripOrder, reorderConfigsById, reorderIds } from './terminalTabReorder.js';
import { pickNearestTerminalTabId } from './terminalTabSelection.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';

type Status = 'not-connected' | 'connecting' | 'alive' | 'exited';

// Lucide "square" (stop) and "play" (start) glyphs — used for the power toggle button.
const POWER_ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
const POWER_ICON_START = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
// Lucide `bell` glyph. Shown on drawer tabs when the process rings the bell
// (\x07) while the tab isn't active (HS-6473).
const BELL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
// Lucide `folder` glyph. Shown on the terminal toolbar CWD chip (HS-7262);
// clicking opens the folder in the OS file manager.
const FOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
// Lucide `clipboard-copy` glyph. Shown on the terminal toolbar copy-last-output
// button (HS-7268); visible only when OSC 133 shell integration has been seen
// on this terminal.
const CLIPBOARD_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M16 14h-6"/><path d="M10 18h.01"/></svg>';
// Shown briefly after a successful copy-last-output click (Lucide `check`).
const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
// Lucide `settings` glyph — gear button on the terminal toolbar that opens the
// HS-6307 appearance popover (theme / font / font-size per terminal).
const SETTINGS_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';

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

interface TerminalInstance {
  id: string;
  config: TerminalTabConfig;
  /** HS-8044 — the drawer pane is a `terminalCheckout` consumer (Phase
   *  2.4 of HS-8032). The handle owns the live xterm + WebSocket + the
   *  per-entry FitAddon. `term`, `fit`, `search`, `searchHandle` are
   *  cleared when the consumer is disposed (tab closed, project
   *  switched away, drawer terminated). The handle is `null` until the
   *  tab is first activated (lazy mount, matches pre-fix behaviour). */
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
  /** HS-7986 / HS-8035 — terminal-header chip the user clicks to clear a
   *  server-side scanner suppression. Hidden until the server reports a
   *  suppressed scanner; click POSTs `/api/terminal/prompt-resume`. */
  promptResumeChip: HTMLButtonElement;
}

interface CommandRecord {
  id: number;
  promptStart: IMarker | null;
  commandStart: IMarker | null;
  outputStart: IMarker | null;
  commandEnd: IMarker | null;
  exitCode: number | null;
  /** Decoration attached at promptStart to render the gutter glyph. Disposed
   *  on record eviction. */
  decoration: IDecoration | null;
}

interface ShellIntegrationState {
  enabled: boolean;
  commands: CommandRecord[];
  current: CommandRecord | null;
  nextId: number;
}

const SHELL_INTEGRATION_RING_SIZE = 500;

const instances = new Map<string, TerminalInstance>();
let activeTerminalId: string | null = null;
/** The project secret the current instances were built for. Changes trigger a full rebuild (HS-6309). */
let currentProjectSecret: string | null = null;
/** Populated on each loadAndRenderTerminalTabs(). Consumed by settings-refresh flows. */
let lastKnownConfigs: { configured: TerminalTabConfig[]; dynamic: TerminalTabConfig[] } = { configured: [], dynamic: [] };

/** One-time DOM setup for the terminal area inside the drawer. Called from app init. */
export function initTerminal(): void {
  // Wire up the new + button that creates dynamic terminals.
  document.getElementById('drawer-add-terminal-btn')?.addEventListener('click', () => { void createDynamicTerminal(); });
  // Keep in-drawer bell indicators in sync with bellPoll (HS-6603 §24.4.3).
  ensureBellSubscription();
  window.addEventListener('resize', () => {
    const active = activeTerminalId === null ? null : instances.get(activeTerminalId);
    if (active !== null && active !== undefined && isTerminalTabActive(active)) doFit(active);
  });

  // HS-7269 — re-apply shell-integration UI visibility on every open terminal
  // when the user toggles the setting. No full rebuild — the OSC handler
  // state (markers, commands ring) is preserved, so re-enabling shows the UI
  // against whatever has already been tracked.
  document.addEventListener('hotsheet:shell-integration-ui-changed', () => {
    for (const inst of instances.values()) {
      applyShellIntegrationToolbarVisibility(inst);
      reapplyShellIntegrationDecorations(inst);
    }
  });

  // HS-6307 — when the project-default appearance changes (Settings → Terminal),
  // re-resolve + re-apply on every mounted xterm. Per-terminal overrides stay
  // in place; only fields inherited from the default pick up the new value.
  subscribeToDefaultAppearanceChanges(() => {
    for (const inst of instances.values()) {
      if (inst.term !== null) void reapplyAppearance(inst);
    }
  });

  // HS-7562 — when a per-terminal config changes (Settings → Terminal outline
  // editor's Appearance section saved), update the matching instance's
  // config snapshot from the latest list response so resolveInstanceAppearance
  // picks up the new theme / fontFamily / fontSize, then re-apply. We don't
  // know the new values inline here, so refresh `lastKnownConfigs` first via
  // a lightweight /terminal/list fetch the next loadAndRenderTerminalTabs
  // would normally do anyway — but the editor has already PATCHed file-settings
  // by the time this event fires, so a quick re-resolve from the existing
  // `inst.config` is enough as long as the editor also wrote the new fields
  // into `terminals[index]` BEFORE PATCH, and the next list refresh updates
  // `inst.config` via loadAndRenderTerminalTabs's existing config-merge path.
  // The editor already calls scheduleSave() which awaits the PATCH and then
  // calls refreshTerminalsAfterSettingsChange (which re-renders tabs and
  // therefore re-merges configs into instances), so by the time this event
  // fires the instance's config is already up-to-date — re-applying is enough.
  document.addEventListener('hotsheet:terminal-config-changed', (e) => {
    const detail = (e as CustomEvent<{ terminalId?: string } | undefined>).detail;
    const id = detail === undefined ? undefined : detail.terminalId;
    if (typeof id === 'string' && id !== '') {
      const inst = instances.get(id);
      if (inst !== undefined && inst.term !== null) void reapplyAppearance(inst);
      return;
    }
    // No specific id — re-apply everything as a fallback.
    for (const inst of instances.values()) {
      if (inst.term !== null) void reapplyAppearance(inst);
    }
  });

  // HS-6502: refit the active terminal whenever the drawer panel changes size.
  // The drawer can resize without a window-level resize event — users drag the
  // top edge of the drawer (initResize in commandLog.tsx) and toggle the
  // full-height expand button. Both of those adjust the drawer element's
  // computed height directly, so we watch the drawer panel with a
  // ResizeObserver and re-run FitAddon.fit() for the active terminal.
  const drawerPanel = document.getElementById('command-log-panel');
  if (drawerPanel !== null && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const active = activeTerminalId === null ? null : instances.get(activeTerminalId);
      if (active !== null && active !== undefined && isTerminalTabActive(active)) doFit(active);
    });
    ro.observe(drawerPanel);
  }
}

/**
 * Load the configured + dynamic terminals from the server and (re)render the
 * drawer tab buttons accordingly. Called once at drawer first-open and again
 * whenever the user saves the Embedded Terminal settings.
 */
export async function loadAndRenderTerminalTabs(): Promise<void> {
  // HS-7977: terminals are a Tauri-only feature. Web/browser deployments must
  // never spawn xterm/PTY instances or render terminal panes. The drawer tab
  // strip is hidden via applyTerminalTabVisibility, but the panes container
  // would still be populated here without this gate, leaking terminal output
  // into the drawer when a saved active tab is `terminal:*`.
  if (getTauriInvoke() === null) return;

  const active = getActiveProject();
  const activeSecret = active?.secret ?? null;

  // If the active project changed since the last render, every previously-mounted
  // xterm/ws is bound to the old project — tear them all down before refetching.
  // Otherwise `activateTerminal` would try to reuse stale instances keyed by id
  // (a configured `default` terminal in project A shadowing project B's `default`).
  if (currentProjectSecret !== null && currentProjectSecret !== activeSecret) {
    disposeAllInstances();
  }
  currentProjectSecret = activeSecret;

  // HS-6603 §24.3.1: the list response carries a server-side `bellPending`
  // flag per terminal. Phase 1's local onBell path only catches bells on a
  // mounted xterm — the server-authoritative field is what lets us surface
  // bells that fired before the xterm was mounted or while the project was
  // inactive.
  type ListEntry = TerminalTabConfig & {
    bellPending?: boolean;
    notificationMessage?: string | null;
    // HS-6311 — drawer grid needs live state + exit code to render lazy /
    // exited placeholder tiles. Already returned by /terminal/list's
    // `annotate` helper (see src/routes/terminal.ts).
    state?: 'alive' | 'exited' | 'not_spawned';
    exitCode?: number | null;
  };
  type ListResponse = { configured: ListEntry[]; dynamic: ListEntry[]; home?: string };
  let data: ListResponse;
  try {
    data = await api<ListResponse>('/terminal/list');
  } catch {
    return;
  }
  lastKnownConfigs = data;
  // HS-7276 — seed the module-level $HOME cache so the CWD chip can tildify
  // subsequent OSC 7 pushes. No-op after the first tick; the value doesn't
  // change mid-session.
  cacheHomeDir(data.home);
  // HS-6307 — refresh the project default appearance whenever the terminal
  // list reloads. Covers project switch + settings-save (which already trigger
  // this path). Fires the default-changed event if the value actually moved,
  // so previously-mounted terminals re-resolve.
  void loadProjectDefaultAppearance();

  const tabStrip = document.getElementById('drawer-terminal-tabs');
  const paneContainer = document.getElementById('drawer-terminal-panes');
  if (!tabStrip || !paneContainer) return;

  const wanted = new Map<string, ListEntry>();
  for (const c of data.configured) wanted.set(c.id, { ...c, dynamic: false });
  for (const c of data.dynamic) wanted.set(c.id, { ...c, dynamic: true });

  // Remove instances for terminals that no longer exist server-side.
  for (const id of [...instances.keys()]) {
    if (!wanted.has(id)) removeTerminalInstance(id);
  }

  // HS-8016 — reconcile per-project hidden state against the live terminal
  // list so the eye-icon count badge stops counting terminals that were
  // closed (drawer X-button), destroyed, or deleted in Settings. Triggers
  // the `subscribeToHiddenChanges` notify+persist chain when the diff is
  // non-empty so the Default grouping's stale ids land in `hidden_terminals`
  // and the per-grouping shape simultaneously.
  const activeProject = getActiveProject();
  if (activeProject !== null) pruneHiddenForProject(activeProject.secret, [...wanted.keys()]);

  // Ensure an instance + DOM exists for every wanted terminal, in order.
  tabStrip.innerHTML = '';
  paneContainer.querySelectorAll('.drawer-terminal-pane').forEach(el => el.remove());

  // HS-7264 — fire OSC 9 toasts for any pending desktop notifications the
  // server tracked while we were disconnected / on another project. Dedupes
  // against the bellPoll recentlyToasted map so a subsequent long-poll tick
  // doesn't re-fire the same message.
  fireToastsForActiveProject([...wanted.values()]);

  for (const entry of wanted.values()) {
    // `notificationMessage` is already surfaced as a toast via
    // fireToastsForActiveProject above — drop it here along with `bellPending`
    // so only the TerminalTabConfig shape flows into `inst.config`.
    const bellPending = entry.bellPending;
    const config: TerminalTabConfig = {
      id: entry.id, command: entry.command, name: entry.name,
      cwd: entry.cwd, lazy: entry.lazy, dynamic: entry.dynamic,
      theme: entry.theme, fontFamily: entry.fontFamily, fontSize: entry.fontSize,
    };
    let inst = instances.get(config.id);
    if (!inst) {
      inst = createInstance(config);
      instances.set(config.id, inst);
    } else {
      // Config may have changed; update label text if the user renamed.
      inst.config = { ...inst.config, ...config };
      updateTabLabel(inst);
    }
    // Seed the bell indicator from the server so a tab that was hidden /
    // unmounted while the bell fired still shows the glyph the first time
    // the user sees it (HS-6603 §24.4.3).
    if (bellPending === true && !inst.hasBell) {
      inst.hasBell = true;
      updateTabLabel(inst);
    }
    tabStrip.appendChild(inst.tabBtn);
    paneContainer.appendChild(inst.pane);
  }

  // If the previously-active id no longer exists, default to the first terminal.
  if (activeTerminalId !== null && !wanted.has(activeTerminalId)) {
    activeTerminalId = null;
  }

  // HS-6311 — hand the full list to the drawer-grid module so it can enable /
  // disable the toggle button (requires ≥2 terminals to enable) and, if the
  // current project is in grid mode, rebuild its tiles. Shape-compatible with
  // `DrawerGridTileEntry`; we strip notificationMessage which is unused here.
  const gridEntries: DrawerGridTileEntry[] = [...wanted.values()].map(e => ({
    id: e.id,
    name: e.name,
    command: e.command,
    bellPending: e.bellPending,
    state: e.state,
    exitCode: e.exitCode,
    theme: e.theme,
    fontFamily: e.fontFamily,
    fontSize: e.fontSize,
    dynamic: e.dynamic,
  }));
  onTerminalListUpdated(gridEntries);
}

/** HS-6603 §24.4.3: re-sync each active-project terminal's bell indicator
 *  against the bellPoll snapshot. Driven by `subscribeToBellState` on every
 *  long-poll tick. We only touch terminals for the *active* project — other
 *  projects' bells surface via the project-tab indicator in projectTabs. */
function syncInstancesWithBellState(bellStates: Map<string, { terminalIds: string[] }>): void {
  const active = getActiveProject();
  if (!active) return;
  const entry = bellStates.get(active.secret);
  const pendingIds = new Set(entry?.terminalIds ?? []);
  for (const inst of instances.values()) {
    const wantsBell = pendingIds.has(inst.id);
    if (wantsBell && !inst.hasBell) {
      inst.hasBell = true;
      updateTabLabel(inst);
    } else if (!wantsBell && inst.hasBell) {
      // Poll cleared the flag (e.g., another tab acknowledged it) — drop the
      // local indicator too so the two views stay in sync.
      inst.hasBell = false;
      updateTabLabel(inst);
    }
  }
}

let bellSubscribed = false;
function ensureBellSubscription(): void {
  if (bellSubscribed) return;
  bellSubscribed = true;
  subscribeToBellState(syncInstancesWithBellState);
}

/** Activate the named terminal tab (mount xterm + connect ws on first activation). */
export function activateTerminal(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  // HS-8054 — context for the longtask observer. The label includes
  // `mount` vs `reuse` so the log differentiates first-mount cost
  // (heavy: xterm + addons + WS) from steady-state activation (cheap).
  recordInteraction(`activate-terminal:${id}:${inst.mounted ? 'reuse' : 'mount'}`);
  // HS-6311 — clicking a terminal tab while the drawer is in grid mode exits
  // grid mode first (mirrors §25.3 rule 3: tab click auto-exits the dashboard
  // and activates that tab's normal view). Delegate to the grid module so
  // its internal state + chrome visibility stay consistent.
  if (isDrawerGridActive()) exitDrawerGridMode();
  activeTerminalId = id;

  // Hide other terminal panes; show this one. Clear the bell indicator on
  // the now-active tab — viewing the terminal counts as "the user has
  // acknowledged it" (HS-6473).
  for (const other of instances.values()) {
    other.pane.style.display = other.id === id ? '' : 'none';
    other.tabBtn.classList.toggle('active', other.id === id);
  }
  if (inst.hasBell) {
    inst.hasBell = false;
    updateTabLabel(inst);
    // HS-6603 §24.4.3: also drop the server-side `bellPending` flag so the
    // cross-project poll stops reporting this terminal as pending. The local
    // indicator already cleared above; this call is fire-and-forget.
    void api('/terminal/clear-bell', { method: 'POST', body: { terminalId: id } }).catch(() => {});
  }

  const active = getActiveProject();
  if (!active) return;

  if (!inst.mounted) {
    mountInstanceViaCheckout(inst, active.secret);
    // HS-6799: fit the xterm to its pane BEFORE the first frame so the
    // checkout's `cols`/`rows` reflect the real pane geometry. Pre-
    // HS-8044 this was sequenced ahead of the manual `connect()` so the
    // server's spawn-resize matched; post-HS-8044 the checkout's WS
    // open + first resize frame echo the same dims via fit() output
    // through `term.onResize → handle.resize`.
    doFit(inst);
    inst.mounted = true;
  } else if (inst.wsSecret !== active.secret) {
    // Project switched — rebuild from scratch.
    teardown(inst);
    mountInstanceViaCheckout(inst, active.secret);
    doFit(inst);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      doFit(inst);
      inst.term?.focus();
    });
  });
}

/** Drawer visibility flipped off — stop sending resizes etc. */
export function deactivateAllTerminals(): void {
  for (const inst of instances.values()) {
    inst.tabBtn.classList.remove('active');
  }
}

/**
 * HS-7592 — force a fresh PTY resize with the active drawer terminal's current
 * cols / rows, even if xterm's `fit()` doesn't think anything changed. Used
 * after exiting the Terminal Dashboard's dedicated view: the dashboard's
 * `fit() + 'resize'` flow leaves the PTY at dashboard-pane dims, and the
 * drawer's own ResizeObserver-driven `doFit` doesn't emit a resize when
 * cols/rows haven't changed client-side (xterm fires `onResize` only on
 * dim change). Without this, live output from the PTY wraps at the
 * dashboard's wider / taller geometry until the user happens to resize
 * the drawer enough to move the xterm's cols/rows — which can be never.
 *
 * Safe to call any time: no-op when no terminal is active, when the active
 * terminal has no WebSocket open, or when the xterm hasn't mounted yet.
 */
export function resyncActiveTerminalPtySize(): void {
  if (activeTerminalId === null) return;
  const inst = instances.get(activeTerminalId);
  if (inst === undefined) return;
  if (inst.checkout === null) return;
  // First refit so the xterm reflects the drawer's CURRENT pane size, then
  // unconditionally push those dims to the PTY via the checkout's resize
  // path. HS-8044 — pre-fix this sent the resize frame directly via
  // `inst.ws.send(...)`; post-fix `handle.resize` updates the entry's
  // `lastApplied` bookkeeping AND sends the WS frame in one call (and
  // skips on same-size to avoid SIGWINCH storms).
  doFit(inst);
  const term = inst.checkout.term;
  inst.checkout.resize(term.cols, term.rows);
}

/** Is the given instance the currently-active drawer tab? */
function isTerminalTabActive(inst: TerminalInstance): boolean {
  return activeTerminalId === inst.id && inst.pane.style.display !== 'none';
}

function createInstance(config: TerminalTabConfig): TerminalInstance {
  // IMPORTANT: the custom JSX runtime renders to an HTML string, so DOM elements
  // passed as JSX children (e.g. `<button>{label}</button>` where `label` is an
  // HTMLElement) silently render as empty strings — the resulting button has no
  // children at all. Build each tree as a single JSX expression and query the
  // inner pieces back out via querySelector. This is the root cause of HS-6342
  // (configured tabs rendered as blank buttons) and HS-6341 (dynamic tab + xterm
  // pane both rendered with no header / no label).
  const tabName = tabDisplayName(config);
  const tabBtn = toElement(
    <button className="drawer-tab drawer-terminal-tab" data-drawer-tab={`terminal:${config.id}`} data-terminal-id={config.id} draggable="true">
      <span className="drawer-tab-label">{tabName}</span>
      {config.dynamic === true
        ? raw(`<button class="drawer-tab-close" title="Close terminal">${CLOSE_ICON}</button>`)
        : null}
    </button>
  );
  const closeBtn = tabBtn.querySelector<HTMLButtonElement>('.drawer-tab-close');
  tabBtn.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;
    // Delegate to the drawer tab switcher so the Commands Log pane is hidden too.
    void selectDrawerTab(`terminal:${config.id}`);
  });
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeDynamicTerminal(config.id);
  });
  // HS-7827 — block dragstart from the close button so the native drag
  // gesture stays bound to the tab body.
  closeBtn?.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  tabBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e, config.id);
  });
  // HS-7827 — drag-to-reorder. Configured-id reorder is persisted to
  // settings.terminals; dynamic-id reorder lives in memory only (per
  // the ticket's "for configured terminals at least" caveat).
  attachTabDragHandlers(tabBtn, config.id);

  const pane = toElement(
    <div className="drawer-tab-content drawer-terminal-pane" data-drawer-panel={`terminal:${config.id}`} style="display:none">
      <div className="terminal-header">
        <span className="terminal-status-dot" title="Not connected"></span>
        <span className="terminal-label">{tabName}</span>
        {/* HS-7262 — CWD chip populated by OSC 7 handler; hidden by default,
            shown once the shell pushes its first file://host/path. Click opens
            the folder in the OS file manager via /api/terminal/open-cwd. */}
        <button className="terminal-cwd-chip" title="Open folder" style="display:none">
          {raw(FOLDER_ICON)}
          <span className="terminal-cwd-label"></span>
        </button>
        <span className="terminal-header-spacer"></span>
        {/* HS-7331 — terminal search slot. The collapsed magnifier + expanding
            input is mounted from `terminalSearch.tsx` on xterm attach (so we
            know the SearchAddon instance). Hidden slot until mount keeps the
            header's fixed-width layout stable before the first connect. */}
        <span className="terminal-search-slot"></span>
        {/* HS-7986 — prompt-detection suppression resume chip. Hidden by
            default; shown when the user clicks "Not a prompt — let me handle
            it" on the §52 overlay so they can re-arm detection without
            typing into the terminal. Click clears suppression. */}
        <button className="terminal-header-btn terminal-prompt-resume-chip" title="Prompt detection paused — click to resume" style="display:none">
          <span className="terminal-prompt-resume-label">Detection paused — Resume</span>
        </button>
        {/* HS-7268 — copy-last-output button, hidden until OSC 133 escapes are
            seen on this terminal. Reveals in `handleOsc133` when `shellIntegration.enabled`
            flips; re-hides on PTY restart via `resetShellIntegration`. */}
        <button className="terminal-header-btn terminal-copy-output-btn" title="Copy last command output" style="display:none">
          {raw(CLIPBOARD_ICON)}
        </button>
        <button className="terminal-header-btn terminal-power-btn" title="Stop terminal">
          <span className="terminal-power-icon">{raw(POWER_ICON_STOP)}</span>
        </button>
        <button className="terminal-header-btn terminal-clear-btn" title="Clear screen (keeps process running)">
          {raw(TRASH_ICON)}
        </button>
        {/* HS-6307 — per-terminal appearance (theme / font / size). Click
            opens a small floating popover anchored below the button. */}
        <button className="terminal-header-btn terminal-appearance-btn" title="Appearance (theme, font)">
          {raw(SETTINGS_ICON)}
        </button>
      </div>
      {/* HS-7959 — `.terminal-body` keeps its visual padding + focus ring,
          but xterm mounts inside an inner `.terminal-canvas-host` with NO
          padding so xterm's `FitAddon` reads the parent's true content
          height. Pre-fix the FitAddon was reading the body's border-box
          height (because `box-sizing: border-box` is global) and ignoring
          the parent's own padding, so it over-counted rows by `padding * 2 /
          cellHeight` and the bottom row was clipped at certain drawer
          heights. Mirrors the pattern §25's dashboard dedicated view uses
          (`.terminal-dashboard-dedicated-pane`, see HS-7098). */}
      <div className="terminal-body">
        <div className="terminal-canvas-host"></div>
      </div>
    </div>
  );
  const header = pane.querySelector<HTMLElement>('.terminal-header')!;
  const body = pane.querySelector<HTMLElement>('.terminal-body')!;
  const canvasHost = pane.querySelector<HTMLElement>('.terminal-canvas-host')!;
  const statusDot = pane.querySelector<HTMLElement>('.terminal-status-dot')!;
  const labelText = pane.querySelector<HTMLElement>('.terminal-label')!;
  const powerBtn = pane.querySelector<HTMLButtonElement>('.terminal-power-btn')!;
  const clearBtn = pane.querySelector<HTMLButtonElement>('.terminal-clear-btn')!;
  const promptResumeChip = pane.querySelector<HTMLButtonElement>('.terminal-prompt-resume-chip')!;

  const inst: TerminalInstance = {
    id: config.id,
    config,
    checkout: null,
    termHandlerDisposers: [],
    term: null,
    fit: null,
    search: null,
    searchHandle: null,
    body,
    canvasHost,
    header,
    label: labelText,
    statusDot,
    pane,
    tabBtn,
    ws: null,
    wsSecret: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    status: 'not-connected',
    exitCode: null,
    stopRequested: false,
    mounted: false,
    runtimeTitle: '',
    runtimeCwd: null,
    hasBell: false,
    shellIntegration: { enabled: false, commands: [], current: null, nextId: 1 },
    promptResumeChip,
  };

  // HS-7986 / HS-8035 — chip click POSTs `/api/terminal/prompt-resume` so the
  // server-side scanner re-arms after a prior dismiss-with-suppress. Network
  // errors are swallowed: the chip hides immediately for responsiveness, and
  // the next bell-state poll will re-show it if the server still reports the
  // scanner as suppressed.
  promptResumeChip.addEventListener('click', () => {
    promptResumeChip.style.display = 'none';
    void api('/terminal/prompt-resume', { method: 'POST', body: { terminalId: inst.id } })
      .catch(() => { /* swallow */ });
  });

  powerBtn.addEventListener('click', () => { void onPowerClick(inst); });
  clearBtn.addEventListener('click', () => { inst.term?.clear(); });

  // HS-6307 — appearance gear. Opens the popover anchored below the button
  // and routes apply() calls back through reapplyAppearance so the theme /
  // font / size land on the live xterm instance.
  const appearanceBtn = pane.querySelector<HTMLButtonElement>('.terminal-appearance-btn');
  appearanceBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    mountAppearancePopover({
      anchor: appearanceBtn,
      terminalId: inst.id,
      isDynamic: inst.config.dynamic === true,
      onApply: () => { void reapplyAppearance(inst); },
      // HS-7896 — give the popover a live read of `inst.config` so it shows
      // the correct selected theme / font / size when opening, and let it
      // mutate `inst.config` synchronously when the user picks a new value
      // so reapplyAppearance sees the change on the first re-render. Without
      // these hooks the popover wrote to disk but the live xterm kept
      // reading the stale snapshot.
      getCurrentConfigOverride: () => {
        const out: { theme?: string; fontFamily?: string; fontSize?: number } = {};
        if (inst.config.theme !== undefined) out.theme = inst.config.theme;
        if (inst.config.fontFamily !== undefined) out.fontFamily = inst.config.fontFamily;
        if (inst.config.fontSize !== undefined) out.fontSize = inst.config.fontSize;
        return out;
      },
      onConfigOverrideChange: (partial) => {
        if ('theme' in partial) {
          if (partial.theme === undefined) delete inst.config.theme;
          else inst.config.theme = partial.theme;
        }
        if ('fontFamily' in partial) {
          if (partial.fontFamily === undefined) delete inst.config.fontFamily;
          else inst.config.fontFamily = partial.fontFamily;
        }
        if ('fontSize' in partial) {
          if (partial.fontSize === undefined) delete inst.config.fontSize;
          else inst.config.fontSize = partial.fontSize;
        }
      },
    });
  });

  // HS-7268 — copy-last-output click. The button is hidden until
  // `shellIntegration.enabled` flips true (first OSC 133 escape seen), so by
  // the time the click fires we always have at least one record or an
  // in-flight one. `copyLastOutput` no-ops with a subtle shake if there's
  // nothing to copy (e.g. user clicked between A and C, or after C marker
  // scrolled out of the buffer).
  const copyOutputBtn = pane.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  copyOutputBtn?.addEventListener('click', () => { void copyLastOutput(inst); });

  // HS-7262 — CWD chip click reveals the folder in the OS file manager. Uses
  // the terminal's own record of the most recent OSC 7 push; the server
  // endpoint validates the path exists before spawning the file manager.
  const cwdChip = pane.querySelector<HTMLButtonElement>('.terminal-cwd-chip');
  cwdChip?.addEventListener('click', () => {
    if (inst.runtimeCwd === null || inst.runtimeCwd === '') return;
    void api('/terminal/open-cwd', { method: 'POST', body: { path: inst.runtimeCwd } }).catch(() => { /* ignore */ });
  });

  return inst;
}

/** HS-7827 — wire HTML5 drag handlers on a drawer terminal tab button.
 *  Tracks the dragged terminal id at module scope and reorders the strip
 *  on drop. Configured-id reorder is persisted to settings.terminals via
 *  PATCH; dynamic-id reorder lives in memory only. */
let tabDragFromId: string | null = null;
function attachTabDragHandlers(tabBtn: HTMLElement, terminalId: string): void {
  tabBtn.addEventListener('dragstart', (e) => {
    tabDragFromId = terminalId;
    if (e.dataTransfer !== null) {
      e.dataTransfer.effectAllowed = 'move';
      // Required by Firefox to start the drag — payload itself is unused.
      e.dataTransfer.setData('text/plain', terminalId);
    }
    tabBtn.classList.add('dragging');
  });
  tabBtn.addEventListener('dragend', () => {
    tabDragFromId = null;
    tabBtn.classList.remove('dragging');
    document.querySelectorAll('.drawer-terminal-tab.drag-over')
      .forEach(el => el.classList.remove('drag-over'));
  });
  tabBtn.addEventListener('dragover', (e) => {
    if (tabDragFromId === null || tabDragFromId === terminalId) return;
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    tabBtn.classList.add('drag-over');
  });
  tabBtn.addEventListener('dragleave', () => {
    tabBtn.classList.remove('drag-over');
  });
  tabBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    tabBtn.classList.remove('drag-over');
    if (tabDragFromId === null || tabDragFromId === terminalId) return;
    void reorderTabAfterDrop(tabDragFromId, terminalId);
    tabDragFromId = null;
  });
}

async function reorderTabAfterDrop(fromId: string, toId: string): Promise<void> {
  const tabStrip = document.getElementById('drawer-terminal-tabs');
  if (tabStrip === null) return;
  const currentOrder: string[] = [];
  for (const el of tabStrip.querySelectorAll<HTMLElement>('.drawer-terminal-tab')) {
    const id = el.dataset.terminalId;
    if (typeof id === 'string' && id !== '') currentOrder.push(id);
  }
  const nextOrder = reorderIds(currentOrder, fromId, toId);
  if (nextOrder.join('|') === currentOrder.join('|')) return;

  // Apply the visual reorder by re-appending tabs (and matching panes) in
  // the new order. Browsers handle move-via-append cleanly — no flicker.
  const paneContainer = document.getElementById('drawer-terminal-panes');
  for (const id of nextOrder) {
    const tab = tabStrip.querySelector<HTMLElement>(`.drawer-terminal-tab[data-terminal-id="${CSS.escape(id)}"]`);
    if (tab !== null) tabStrip.appendChild(tab);
    if (paneContainer !== null) {
      const pane = paneContainer.querySelector<HTMLElement>(`.drawer-terminal-pane[data-drawer-panel="${CSS.escape(`terminal:${id}`)}"]`);
      if (pane !== null) paneContainer.appendChild(pane);
    }
  }

  // Persist the configured-only subset to settings.terminals. Dynamic ids
  // are intentionally NOT persisted — their position in the strip is a
  // session-only concern (per the HS-7827 spec).
  const canonicalIds = lastKnownConfigs.configured.map(c => c.id);
  const newConfiguredOrder = configuredSubsetInStripOrder(nextOrder, canonicalIds);
  if (newConfiguredOrder.join('|') === canonicalIds.join('|')) return; // no change to persist
  const reorderedConfigs = reorderConfigsById(lastKnownConfigs.configured, newConfiguredOrder);
  // Strip the runtime-only fields the cache carries from /terminal/list
  // (`bellPending`, `state`, `exitCode`, `notificationMessage`, `dynamic`)
  // before persisting — settings.terminals is the canonical config shape.
  const persistShape = reorderedConfigs.map(({ id, name, command, cwd, lazy, theme, fontFamily, fontSize }) => {
    const out: { id: string; name?: string; command: string; cwd?: string; lazy?: boolean; theme?: string; fontFamily?: string; fontSize?: number } = { id, command };
    if (name !== undefined) out.name = name;
    if (cwd !== undefined) out.cwd = cwd;
    if (lazy !== undefined) out.lazy = lazy;
    if (theme !== undefined) out.theme = theme;
    if (fontFamily !== undefined) out.fontFamily = fontFamily;
    if (fontSize !== undefined) out.fontSize = fontSize;
    return out;
  });
  // Update the local cache so a subsequent rebuild before the PATCH
  // round-trips reflects the new order. /terminal/list will re-confirm
  // after the server applies the patch.
  lastKnownConfigs = { ...lastKnownConfigs, configured: persistShape.map(c => ({ ...c, dynamic: false })) };
  try {
    await api('/file-settings', { method: 'PATCH', body: { terminals: persistShape } });
  } catch {
    // PATCH failed — the in-memory + DOM order still moved, so the user
    // sees their reorder; on the next reload the server-side order wins.
  }
}

/** Re-render the CWD chip on the terminal toolbar. HS-7262.
 *  HS-7276 — reads $HOME from the module-level cache that
 *  `loadAndRenderTerminalTabs` seeds from `/api/terminal/list`, so paths
 *  under $HOME render as `~/…`. Before the first /list response lands the
 *  cache is null and the label degrades to an un-tildified absolute path. */
function updateCwdChip(inst: TerminalInstance): void {
  const chip = inst.header.querySelector<HTMLButtonElement>('.terminal-cwd-chip');
  const label = chip?.querySelector<HTMLElement>('.terminal-cwd-label');
  if (chip === null || label === null || label === undefined) return;
  const cwd = inst.runtimeCwd;
  if (cwd === null || cwd === '') {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  label.textContent = formatCwdLabel(cwd, getCachedHomeDir());
  chip.setAttribute('title', `Open folder: ${cwd}`);
}

function tabDisplayName(config: TerminalTabConfig): string {
  if (typeof config.name === 'string' && config.name !== '') return config.name;
  const word = config.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  // Path-style commands like /bin/zsh → "zsh"; .exe stripped on Windows.
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/** The label for the in-pane terminal toolbar. Prefers the runtime title
 *  pushed via OSC 0/2 (HS-6473) — for shells like zsh that update their title
 *  with `cwd` or the running command, this is far more useful than the static
 *  configured name. Falls back to the static drawer-tab name when no process
 *  has pushed a title. */
function effectiveHeaderLabel(inst: TerminalInstance): string {
  if (inst.runtimeTitle !== '') return inst.runtimeTitle;
  return tabDisplayName(inst.config);
}

function updateTabLabel(inst: TerminalInstance): void {
  // HS-6473 follow-up: the drawer tab keeps the static configured/derived
  // name — only the in-pane toolbar follows the runtime title. Shells push
  // noisy per-cwd titles that make the narrow drawer-tab label unreadable.
  const tabName = tabDisplayName(inst.config);
  const headerName = effectiveHeaderLabel(inst);
  const labelEl = inst.tabBtn.querySelector('.drawer-tab-label');
  if (labelEl) labelEl.textContent = tabName;
  inst.label.textContent = headerName;
  inst.tabBtn.classList.toggle('has-bell', inst.hasBell);

  // Insert / remove the bell glyph as a sibling of the label. Built and
  // placed via DOM (not via re-rendering the whole tab) so the close button
  // and event listeners survive (HS-6473).
  let bellEl = inst.tabBtn.querySelector<HTMLElement>('.drawer-tab-bell');
  if (inst.hasBell) {
    if (bellEl === null) {
      bellEl = document.createElement('span');
      bellEl.className = 'drawer-tab-bell';
      bellEl.setAttribute('title', 'Bell');
      bellEl.setAttribute('aria-label', 'Terminal bell');
      bellEl.innerHTML = BELL_ICON;
      // Insert immediately after the label so the order is [label][bell][close?].
      labelEl?.insertAdjacentElement('afterend', bellEl);
    }
  } else if (bellEl !== null) {
    bellEl.remove();
  }
}

/** HS-6307 — resolve the appearance layers for a terminal. Factored out so
 *  mountXterm / reapplyAppearance / the popover all read the same stack. */
function resolveInstanceAppearance(inst: TerminalInstance) {
  const configOverride: { theme?: string; fontFamily?: string; fontSize?: number } = {};
  if (inst.config.theme !== undefined) configOverride.theme = inst.config.theme;
  if (inst.config.fontFamily !== undefined) configOverride.fontFamily = inst.config.fontFamily;
  if (inst.config.fontSize !== undefined) configOverride.fontSize = inst.config.fontSize;
  return resolveAppearance({
    projectDefault: getProjectDefault(),
    configOverride,
    sessionOverride: getSessionOverride(inst.id),
  });
}

/** Build just the xterm ITheme for the initial `new XTerm({ theme: … })`
 *  call — the full appearance (font family + size) is applied async after
 *  the terminal opens. */
function resolveAppearanceThemeForInit(inst: TerminalInstance) {
  const appearance = resolveInstanceAppearance(inst);
  const theme = getThemeById(appearance.theme) ?? getThemeById('default')!;
  return themeToXtermOptions(theme);
}

/** Re-resolve + apply appearance to a live xterm. Called on mount, on the
 *  appearance popover's onApply callback, and on project-default changes. */
async function reapplyAppearance(inst: TerminalInstance): Promise<void> {
  if (inst.term === null) return;
  const appearance = resolveInstanceAppearance(inst);
  // HS-7960 — paint the body's padded gutter with the new theme background
  // synchronously, BEFORE the async font load runs, so a slow font fetch
  // doesn't leave the gutter in the previous theme's colour mid-flight.
  inst.body.style.backgroundColor = resolveAppearanceBackground(appearance);
  await applyAppearanceToTerm(inst.term, appearance);
}

/**
 * HS-8044 — mount the drawer pane via `terminalCheckout` instead of
 * constructing per-instance `XTerm` + `WebSocket`. The checkout module
 * owns the live xterm + WS + scrollback replay + reconnect-on-close
 * (per HS-8044's module-driven reconnect addition); this function wires
 * the drawer's per-instance chrome (SearchAddon, OSC handlers, theme,
 * custom key bindings, bell, title, CWD chip, prompt-resume) onto the
 * shared term that checkout returns.
 *
 * Replaces pre-fix `mountXterm(inst, secret)` + `connect(inst)` (which
 * each constructed their own xterm + WebSocket and managed the per-
 * instance reconnect-on-close loop). The checkout module's
 * `attachWebSocketToEntry` now centralises the WS lifecycle including
 * reconnect on transient close, so the drawer's old `scheduleReconnect`
 * path is gone.
 */
function mountInstanceViaCheckout(inst: TerminalInstance, secret: string): void {
  const handle = checkout({
    projectSecret: secret,
    terminalId: inst.id,
    cols: 80,
    rows: 24,
    mountInto: inst.canvasHost,
    onControlMessage(msg) {
      handleControlMessage(inst, msg);
    },
  });
  const term = handle.term;
  const fit = handle.fit;

  // HS-8044 — apply per-consumer xterm options. The xterm is shared
  // across consumers (drawer pane + dashboard tile + dedicated etc.)
  // for the same `(secret, terminalId)`; option overrides applied here
  // win for the drawer's lifetime as long as it stays at top-of-stack.
  term.options.theme = resolveAppearanceThemeForInit(inst);
  term.options.linkHandler = {
    activate: (_event, text) => { openExternalUrl(text); },
  };
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
  term.loadAddon(new SerializeAddon());

  // HS-7331 — xterm's SearchAddon powers the toolbar Find widget. Mount the
  // UI into the `.terminal-search-slot` placeholder carved out of the
  // header markup; the handle is disposed on PTY restart + re-created on
  // the next mount so search state doesn't leak across spawn cycles.
  const search = new SearchAddon();
  term.loadAddon(search);
  const searchSlot = inst.header.querySelector<HTMLElement>('.terminal-search-slot');
  let searchHandle: TerminalSearchHandle | null = null;
  if (searchSlot !== null) {
    searchHandle = mountTerminalSearch(term, search);
    searchSlot.replaceChildren(searchHandle.root);
  }

  // HS-7960 — paint the body's gutter to match the theme background BEFORE
  // the async appearance load runs (which is fire-and-forget below). Without
  // this synchronous prime the very first canvas paint would flash with the
  // app's `--bg` for a frame on themes whose background differs.
  inst.body.style.backgroundColor = resolveAppearanceBackground(resolveInstanceAppearance(inst));

  // HS-6307 — apply full appearance (font family + size; theme is already set
  // synchronously on XTerm options via resolveAppearanceThemeForInit).
  // Fire-and-forget — the font stylesheet loads async, and xterm falls back to
  // the System stack via CSS cascade while the webfont resolves.
  void reapplyAppearance(inst);

  // Clicking anywhere in the body (including the visible padding gutters
  // outside the xterm canvas) focuses the terminal — preserves the
  // pre-HS-7959 click-to-focus reach.
  inst.body.addEventListener('click', () => { term.focus(); });

  // Custom key handler — see comments on the original mountXterm for
  // the per-shortcut rationale (HS-7329 / HS-7269 / HS-7331 / HS-7594).
  term.attachCustomKeyEventHandler((e) => {
    if (isClearTerminalShortcut(e)) {
      inst.checkout?.term.clear();
      return false;
    }
    if (isFindShortcut(e)) {
      return false;
    }
    if (isTerminalViewToggleShortcut(e) !== null) return false;
    if (!shellIntegrationUiEnabled()) return true;
    if (!inst.shellIntegration.enabled) return true;
    const direction = isJumpShortcut(e);
    if (direction !== null) {
      jumpToPromptMarker(inst, direction);
      return false;
    }
    return true;
  });

  // HS-8044 — keystroke-send (`term.onData`) is wired centrally inside
  // checkout's WS handler, so the drawer no longer needs its own
  // `term.onData → ws.send` route. We DO still want the prompt-resume
  // chip auto-hide on keystroke (HS-8035), so register a separate
  // handler that just touches DOM state — checkout's keystroke-send
  // continues to fire alongside.
  inst.termHandlerDisposers.push(term.onData(() => {
    if (inst.promptResumeChip.style.display !== 'none') {
      inst.promptResumeChip.style.display = 'none';
    }
  }));

  // HS-8044 — `term.onResize` echoes fit-driven dim changes through the
  // checkout's `handle.resize` so the WS resize frame is sent and the
  // entry's `lastApplied` bookkeeping stays current.
  inst.termHandlerDisposers.push(term.onResize(({ cols, rows }) => {
    handle.resize(cols, rows);
  }));

  // OSC 0 / OSC 2 title-change escapes (HS-6473).
  inst.termHandlerDisposers.push(term.onTitleChange((newTitle) => {
    inst.runtimeTitle = typeof newTitle === 'string' ? newTitle : '';
    updateTabLabel(inst);
  }));

  // OSC 7 — shell-pushed CWD (HS-7262). xterm.js does NOT handle OSC 7
  // natively — register a parser hook on the number directly.
  inst.termHandlerDisposers.push(term.parser.registerOscHandler(7, (payload) => {
    const parsed = parseOsc7Payload(payload);
    if (parsed !== null) {
      inst.runtimeCwd = parsed;
      updateCwdChip(inst);
    }
    return true;
  }));

  // OSC 133 — FinalTerm / iTerm2 / VS Code shell integration (HS-7267).
  inst.termHandlerDisposers.push(term.parser.registerOscHandler(133, (payload) => {
    handleOsc133(inst, term, payload);
    return true;
  }));

  // Bell character `\x07` (HS-6473).
  inst.termHandlerDisposers.push(term.onBell(() => {
    if (!isTerminalTabActive(inst)) {
      inst.hasBell = true;
      updateTabLabel(inst);
    }
  }));

  inst.checkout = handle;
  inst.term = term;
  inst.fit = fit;
  inst.search = search;
  inst.searchHandle = searchHandle;
  inst.wsSecret = secret;
}

// HS-8044 — pre-fix `connect(inst)` opened a per-instance WebSocket
// here, wired open / message / close / error listeners, and
// `scheduleReconnect(inst)` retried with backoff on close. Post-fix the
// checkout module owns all of that: `mountInstanceViaCheckout` delegates
// to `checkout(...)` which opens the WS internally, and the module's
// own close-event listener auto-reconnects when the entry's stack is
// non-empty (the drawer remains a consumer until the tab closes /
// project switches away). The drawer's `onControlMessage` callback
// passed into `checkout()` receives the parsed JSON control messages
// and routes them through `handleControlMessage(inst, msg)` for
// 'history' / 'exit' handling.

interface HistoryMessage { type: 'history'; bytes: string; alive: boolean; exitCode: number | null; cols: number; rows: number; command: string }
interface ExitMessage { type: 'exit'; code: number }

function handleControlMessage(inst: TerminalInstance, msg: { type: string; [k: string]: unknown }): void {
  if (msg.type === 'history') {
    const h = msg as unknown as HistoryMessage;
    // HS-8044 — bytes-replay (resize first, write second) is now done
    // inside the checkout module's WS handler. The drawer just extracts
    // the metadata fields (alive, exitCode, command) for tab-status /
    // tab-label updates.
    inst.exitCode = h.exitCode;
    setStatus(inst, h.alive ? 'alive' : 'exited');
    if (typeof h.command === 'string' && h.command !== '') {
      // Prefer the user-supplied name; fall back to resolved command for unnamed terminals.
      if ((inst.config.name ?? '') === '') inst.label.textContent = shortCommandName(h.command);
    }
    requestAnimationFrame(() => doFit(inst));
    return;
  }
  if (msg.type === 'exit') {
    const e = msg as unknown as ExitMessage;
    inst.exitCode = e.code;
    setStatus(inst, 'exited');
    inst.term?.write(`\r\n[process exited with code ${e.code}]\r\n`);
    // HS-7267 — if a command was in-flight (A seen, no D yet), close it out
    // with exitCode=-1 so its gutter glyph stays visible (otherwise the
    // record sits dangling with no visible end). §26.9 edge case "runaway
    // C without D".
    const si = inst.shellIntegration;
    if (si.current !== null && inst.term !== null) {
      si.current.exitCode = -1;
      attachGutterDecoration(inst, inst.term, si.current);
      pushAndEvict(si, si.current);
      si.current = null;
    }
    return;
  }
}

/**
 * OSC 133 handler entry point (HS-7267). The payload is everything after
 * `\x1b]133;` up to the terminator, with the four known subcommands:
 *   "A"        → prompt start
 *   "B"        → command start (user input region begins)
 *   "C"        → output start (command entered, output follows)
 *   "D" or "D;<exit>" → command end (exit code may be omitted)
 * Unknown subcommands are silently ignored so future protocol extensions
 * don't break us.
 */
function handleOsc133(inst: TerminalInstance, term: XTerm, payload: string): void {
  if (typeof payload !== 'string' || payload === '') return;
  const subcommand = payload[0];
  if (subcommand === 'A') {
    onShellIntegrationPromptStart(inst, term);
  } else if (subcommand === 'B') {
    onShellIntegrationCommandStart(inst, term);
  } else if (subcommand === 'C') {
    onShellIntegrationOutputStart(inst, term);
  } else if (subcommand === 'D') {
    // "D" alone or "D;<exitCode>".
    const code = parseOsc133ExitCode(payload);
    onShellIntegrationCommandEnd(inst, term, code);
  }
}

function onShellIntegrationPromptStart(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (!si.enabled) {
    si.enabled = true;
    // HS-7268 — reveal the copy-last-output toolbar button the first time we
    // see an OSC 133 escape. The button was rendered with `display:none` so
    // users who never opt into shell integration see no extra toolbar icon.
    applyShellIntegrationToolbarVisibility(inst);
  }
  // If there's a current record (previous A never got a D — shell crashed
  // mid-command), flush it into the ring with exitCode=-1 so its glyph
  // survives in the gutter rather than vanishing on next A.
  if (si.current !== null) {
    si.current.exitCode = -1;
    attachGutterDecoration(inst, term, si.current);
    pushAndEvict(si, si.current);
    si.current = null;
  }
  const marker = term.registerMarker(0);
  si.current = {
    id: si.nextId++,
    promptStart: marker,
    commandStart: null,
    outputStart: null,
    commandEnd: null,
    exitCode: null,
    decoration: null,
  };
}

function onShellIntegrationCommandStart(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.commandStart = term.registerMarker(0);
}

function onShellIntegrationOutputStart(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.outputStart = term.registerMarker(0);
}

function onShellIntegrationCommandEnd(inst: TerminalInstance, term: XTerm, code: number | null): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.commandEnd = term.registerMarker(0);
  si.current.exitCode = code;
  attachGutterDecoration(inst, term, si.current);
  pushAndEvict(si, si.current);
  si.current = null;
}

function pushAndEvict(si: ShellIntegrationState, record: CommandRecord): void {
  si.commands.push(record);
  while (si.commands.length > SHELL_INTEGRATION_RING_SIZE) {
    const evicted = si.commands.shift();
    if (evicted !== undefined) disposeCommandRecord(evicted);
  }
}

function disposeCommandRecord(r: CommandRecord): void {
  try { r.decoration?.dispose(); } catch { /* ignore */ }
  try { r.promptStart?.dispose(); } catch { /* ignore */ }
  try { r.commandStart?.dispose(); } catch { /* ignore */ }
  try { r.outputStart?.dispose(); } catch { /* ignore */ }
  try { r.commandEnd?.dispose(); } catch { /* ignore */ }
}

/** Render the exit-code gutter glyph for a completed command (green check /
 *  red x / neutral dot depending on exitCode). Idempotent — a second call
 *  on the same record re-attaches after disposing the previous decoration
 *  (used when a dangling A record is retroactively finalised as exitCode=-1
 *  by the NEXT prompt's A handler).
 *
 *  HS-7269 — gated on `shell_integration_ui`: when the setting is off we
 *  don't create the decoration at all so the gutter glyph + Phase 2 hover
 *  popover (attached below) never render. Toggling the setting back on
 *  re-runs this path for every record via `reapplyShellIntegrationDecorations`. */
function attachGutterDecoration(inst: TerminalInstance, term: XTerm, record: CommandRecord): void {
  if (record.promptStart === null) return;
  if (!shellIntegrationUiEnabled()) return;
  try { record.decoration?.dispose(); } catch { /* ignore */ }
  const deco = term.registerDecoration({
    marker: record.promptStart,
    x: 0,
    width: 1,
    height: 1,
  });
  if (deco === undefined) return;
  record.decoration = deco;
  deco.onRender((el) => {
    el.className = `terminal-osc133-gutter terminal-osc133-gutter-${exitCodeGutterClass(record.exitCode)}`;
    el.innerHTML = gutterGlyphSvg(record.exitCode);
    el.title = record.exitCode === null
      ? 'Command (no exit code reported)'
      : `Command (exit ${record.exitCode})`;
    // HS-7269 — hover popover on the gutter glyph with Copy command / Copy
    // output / Rerun / Ask Claude (HS-7270) actions. Attached per-decoration
    // so each command's popover targets its own record (closed-over); the
    // popover is mounted lazily on first hover so we don't allocate 500 DOM
    // trees up front.
    attachGutterHoverPopover(inst, el, term, record);
  });
}

/** HS-7269 — re-attach (or dispose) gutter decorations on every tracked
 *  record in response to a `shell_integration_ui` setting flip. We can't
 *  just toggle CSS visibility because `registerDecoration` has already
 *  committed the marker → DOM binding; we dispose and re-register instead. */
function reapplyShellIntegrationDecorations(inst: TerminalInstance): void {
  const term = inst.term;
  if (term === null) return;
  if (shellIntegrationUiEnabled()) {
    for (const r of inst.shellIntegration.commands) attachGutterDecoration(inst, term, r);
  } else {
    for (const r of inst.shellIntegration.commands) {
      try { r.decoration?.dispose(); } catch { /* ignore */ }
      r.decoration = null;
    }
  }
}

/** HS-7269 — mount a hover popover on a gutter-glyph decoration's DOM element.
 *  The popover offers three actions scoped to THIS command:
 *    - Copy command — reads B→C range (falls back to message if B is null).
 *    - Copy output — reads C→D range (or C→cursor if still running).
 *    - Rerun — sends `commandText + '\r'` through the terminal's WS.
 *  A single shared popover element is reused across hovers (only one visible
 *  at a time); `showGutterPopover` retargets it to the currently-hovered
 *  decoration. The popover closes on mouseleave from BOTH the glyph and the
 *  popover itself (user can move cursor to the popover to click a button). */
function attachGutterHoverPopover(inst: TerminalInstance, el: HTMLElement, term: XTerm, record: CommandRecord): void {
  el.style.cursor = 'pointer';
  el.addEventListener('mouseenter', () => { showGutterPopover(inst, el, term, record); });
  el.addEventListener('mouseleave', () => { scheduleGutterPopoverClose(); });
}

let gutterPopoverEl: HTMLElement | null = null;
let gutterPopoverCloseTimer: number | null = null;

function showGutterPopover(inst: TerminalInstance, anchor: HTMLElement, term: XTerm, record: CommandRecord): void {
  if (gutterPopoverCloseTimer !== null) {
    window.clearTimeout(gutterPopoverCloseTimer);
    gutterPopoverCloseTimer = null;
  }
  if (gutterPopoverEl !== null) gutterPopoverEl.remove();

  // HS-7270 — the "Ask Claude" entry only renders when the Claude Channel is
  // alive. Checking at popover open time (not on click) keeps the popover
  // small for users without the channel and matches the gate pattern other
  // channel-dependent affordances use (see channelUI.tsx checkAndTrigger).
  const askClaudeHtml = isChannelAlive()
    ? '<button class="terminal-osc133-popover-btn terminal-osc133-popover-ask" data-action="ask-claude">Ask Claude</button>'
    : '';
  const popover = toElement(
    <div className="terminal-osc133-popover">
      <button className="terminal-osc133-popover-btn" data-action="copy-command">Copy command</button>
      <button className="terminal-osc133-popover-btn" data-action="copy-output">Copy output</button>
      <button className="terminal-osc133-popover-btn" data-action="rerun">Rerun</button>
      {raw(askClaudeHtml)}
    </div>
  );
  document.body.appendChild(popover);

  popover.addEventListener('mouseenter', () => {
    if (gutterPopoverCloseTimer !== null) {
      window.clearTimeout(gutterPopoverCloseTimer);
      gutterPopoverCloseTimer = null;
    }
  });
  popover.addEventListener('mouseleave', () => { scheduleGutterPopoverClose(); });
  popover.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.terminal-osc133-popover-btn');
    if (btn === null) return;
    const action = btn.dataset.action;
    if (action === 'copy-command') void copyCommandOfRecord(term, record);
    else if (action === 'copy-output') void copyOutputOfRecord(term, record);
    else if (action === 'rerun') rerunCommandOfRecord(term, record);
    else if (action === 'ask-claude') askClaudeAboutRecord(inst, term, record);
    closeGutterPopover();
  });

  // Position flush-left of the gutter glyph, vertically centered on it.
  const rect = anchor.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.left = `${rect.right + 6}px`;
  popover.style.top = `${rect.top + rect.height / 2}px`;
  popover.style.transform = 'translateY(-50%)';
  popover.style.zIndex = '600';

  gutterPopoverEl = popover;
}

function scheduleGutterPopoverClose(): void {
  if (gutterPopoverCloseTimer !== null) return;
  gutterPopoverCloseTimer = window.setTimeout(closeGutterPopover, 200);
}

function closeGutterPopover(): void {
  if (gutterPopoverEl !== null) {
    gutterPopoverEl.remove();
    gutterPopoverEl = null;
  }
  if (gutterPopoverCloseTimer !== null) {
    window.clearTimeout(gutterPopoverCloseTimer);
    gutterPopoverCloseTimer = null;
  }
}

/** HS-7269 — read the B→C range of a specific record (not necessarily the
 *  latest). Returns null when either marker is missing or disposed. */
function readRecordCommand(term: XTerm, record: CommandRecord): string | null {
  const b = record.commandStart;
  const c = record.outputStart;
  if (b === null || c === null || b.isDisposed || c.isDisposed) return null;
  if (c.line <= b.line) return null;
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = b.line; y < c.line; y++) {
    const line = buf.getLine(y);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? null : lines.join('\n');
}

/** HS-7269 — read the C→D range of a specific record (or C→cursor if D is
 *  missing, i.e. the command is still running). */
function readRecordOutput(term: XTerm, record: CommandRecord): string | null {
  const c = record.outputStart;
  if (c === null || c.isDisposed) return null;
  const buf = term.buffer.active;
  const endLine = record.commandEnd !== null && !record.commandEnd.isDisposed
    ? record.commandEnd.line
    : buf.baseY + buf.cursorY + 1;
  if (endLine <= c.line) return null;
  const lines: string[] = [];
  for (let y = c.line; y < endLine; y++) {
    const line = buf.getLine(y);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? null : lines.join('\n');
}

async function copyCommandOfRecord(term: XTerm, record: CommandRecord): Promise<void> {
  const text = readRecordCommand(term, record);
  if (text === null) return;
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

async function copyOutputOfRecord(term: XTerm, record: CommandRecord): Promise<void> {
  const text = readRecordOutput(term, record);
  if (text === null) return;
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

/** HS-7269 — re-send the record's captured B→C command text through the
 *  terminal's input path, followed by `\r` so the shell runs it. Uses the
 *  public `term.paste` API which routes through the same onData path that
 *  normal typing uses. Silently no-ops when the command text isn't readable. */
function rerunCommandOfRecord(term: XTerm, record: CommandRecord): void {
  const text = readRecordCommand(term, record);
  if (text === null) return;
  // Strip any trailing newline (B→C region typically contains just the
  // command line); the `\r` below fires the shell's Enter handler.
  term.paste(text.replace(/\n+$/, '') + '\r');
}

/** HS-7270 — ask the Claude Channel to diagnose a failing (or successful)
 *  command. Reads the command text + output + cwd off the record, runs it
 *  through `buildAskClaudePrompt` for the canonical template (see docs/33),
 *  and fires `triggerChannelAndMarkBusy(message)` which POSTs to
 *  `/api/channel/trigger` with the rendered prompt. The popover already
 *  gated the button on `isChannelAlive()` at open time, but we re-check
 *  here to cover the rare case of the channel going down between popover
 *  open and click. Command text unavailable (shell skipped B, scrollback
 *  trimmed) → silent no-op; the popover closed already so there's nothing
 *  to shake, and a toast explaining "no command text" would be noisier than
 *  the problem. */
function askClaudeAboutRecord(inst: TerminalInstance, term: XTerm, record: CommandRecord): void {
  if (!isChannelAlive()) return;
  const command = readRecordCommand(term, record);
  if (command === null) return;
  const output = readRecordOutput(term, record) ?? '';
  const prompt = buildAskClaudePrompt({
    command,
    exitCode: record.exitCode,
    cwd: inst.runtimeCwd,
    output,
  });
  triggerChannelAndMarkBusy(prompt);
}

/** Compact inline SVG so the glyph renders at 10×10 in the gutter column.
 *  Lucide check / x / circle minimalized to reduce DOM weight per record. */
function gutterGlyphSvg(code: number | null): string {
  if (code === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  }
  if (code === null) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
}

/** Dispose every shell-integration record + reset state. Called on PTY restart
 *  and project switch (implicitly via removeTerminalInstance). HS-7267. */
function resetShellIntegration(inst: TerminalInstance): void {
  for (const r of inst.shellIntegration.commands) disposeCommandRecord(r);
  if (inst.shellIntegration.current !== null) disposeCommandRecord(inst.shellIntegration.current);
  inst.shellIntegration = { enabled: false, commands: [], current: null, nextId: 1 };
  // HS-7268 — re-hide the copy-last-output button; it'll reappear on the next
  // OSC 133 A seen (if the user's shell integration survives the restart).
  applyShellIntegrationToolbarVisibility(inst);
}

/** Show or hide shell-integration-specific toolbar affordances based on
 *  whether we've ever seen an OSC 133 escape on this terminal (HS-7268)
 *  AND the user's `shell_integration_ui` setting (HS-7269). When the setting
 *  is off the button stays hidden even after the OSC handler fires — the
 *  handler still runs so markers are tracked, but no UI surfaces. */
function applyShellIntegrationToolbarVisibility(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  if (btn === null) return;
  const visible = inst.shellIntegration.enabled && shellIntegrationUiEnabled();
  btn.style.display = visible ? '' : 'none';
}

/** HS-7269 — read the per-project "Enable shell integration UI" setting.
 *  Default true (setting absent → on). Reads from the shared `state.settings`
 *  object which is reloaded on project switch, so the check is always scoped
 *  to the active project. */
function shellIntegrationUiEnabled(): boolean {
  return state.settings.shell_integration_ui;
}

/** HS-7269 — scroll the xterm viewport to the previous or next command's
 *  prompt row. Uses `term.scrollToLine(line)` which takes the absolute buffer
 *  line (our markers already store this). Pulls the active buffer's cursor
 *  position as the anchor so "next" from the middle of a scrolled-back view
 *  jumps to the first prompt below the viewport, not the first prompt below
 *  some stale cursor. No-op when there's no marker in the chosen direction
 *  (caller already swallowed the keystroke to prevent `\e[1;5A` leaks). */
function jumpToPromptMarker(inst: TerminalInstance, direction: 'prev' | 'next'): void {
  const term = inst.term;
  if (term === null) return;
  const buf = term.buffer.active;
  const fromLine = buf.viewportY;
  const promptLines: number[] = [];
  for (const r of inst.shellIntegration.commands) {
    if (r.promptStart !== null && !r.promptStart.isDisposed) {
      promptLines.push(r.promptStart.line);
    }
  }
  const target = findPromptLine({ promptLines, fromLine, direction });
  if (target === null) return;
  term.scrollToLine(target);
}

/** HS-7268 — copy the most recent command's output to the clipboard. Reads the
 *  [start, end) range from `computeLastOutputRange` via xterm's live buffer,
 *  joins rows with `\n`, trims trailing blank lines, and writes via
 *  `navigator.clipboard.writeText` (Tauri WKWebView supports this natively).
 *  Flashes the button glyph to a check on success so the user gets visual
 *  feedback without a toast — the click was a direct action on the button,
 *  so a toast would feel redundant. On empty / no-range / clipboard error,
 *  the button briefly shakes to signal the no-op. */
async function copyLastOutput(inst: TerminalInstance): Promise<void> {
  const term = inst.term;
  if (term === null) { shakeCopyOutputBtn(inst); return; }
  const buf = term.buffer.active;
  const cursorLine = buf.baseY + buf.cursorY;
  const range = computeLastOutputRange({
    current: inst.shellIntegration.current,
    commands: inst.shellIntegration.commands,
    cursorLine,
  });
  if (range === null) { shakeCopyOutputBtn(inst); return; }

  const lines: string[] = [];
  for (let y = range.start; y < range.end; y++) {
    const line = buf.getLine(y);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  // Trim trailing blank rows so a command whose output doesn't fill the
  // full buffer range (common — the D marker lands on a blank precmd line)
  // doesn't paste dangling newlines.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) { shakeCopyOutputBtn(inst); return; }

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    flashCopyOutputBtnSuccess(inst);
  } catch {
    shakeCopyOutputBtn(inst);
  }
}

function flashCopyOutputBtnSuccess(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  if (btn === null) return;
  btn.innerHTML = CHECK_ICON;
  btn.classList.add('copied');
  window.setTimeout(() => {
    btn.innerHTML = CLIPBOARD_ICON;
    btn.classList.remove('copied');
  }, 900);
}

function shakeCopyOutputBtn(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  if (btn === null) return;
  btn.classList.add('shake');
  window.setTimeout(() => btn.classList.remove('shake'), 400);
}

function shortCommandName(command: string): string {
  if (command.startsWith('claude')) return 'claude';
  return command.split(/\s+/)[0] ?? 'terminal';
}

// HS-8044 — `scheduleReconnect(inst)` removed. The checkout module's
// `attachWebSocketToEntry` now handles WS-close → reconnect for any
// entry with a non-empty consumer stack, which includes the drawer's
// instance until its tab is closed / project switched away. The
// `inst.reconnectAttempts` + `inst.reconnectTimer` fields are kept on
// the interface for back-compat (read by no remaining code path) and
// could be dropped in HS-8045 cleanup if confirmed unused there.

function setStatus(inst: TerminalInstance, status: Status): void {
  inst.status = status;
  inst.statusDot.className = `terminal-status-dot status-${status}`;
  inst.statusDot.setAttribute('title', {
    'not-connected': 'Not connected',
    'connecting': 'Connecting…',
    'alive': 'Running',
    'exited': inst.exitCode !== null ? `Exited (code ${inst.exitCode})` : 'Exited',
  }[status]);
  if (status !== 'alive') inst.stopRequested = false;
  updatePowerButton(inst);
}

function updatePowerButton(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-power-btn');
  const icon = btn?.querySelector<HTMLElement>('.terminal-power-icon');
  if (!btn || !icon) return;
  const showStop = inst.status === 'alive' || inst.status === 'connecting';
  icon.innerHTML = showStop ? POWER_ICON_STOP : POWER_ICON_START;
  btn.setAttribute('title', showStop
    ? (inst.stopRequested ? 'Stop again to force quit' : 'Stop terminal')
    : 'Start terminal');
  btn.classList.toggle('is-stop-pending', showStop && inst.stopRequested);
}

async function onPowerClick(inst: TerminalInstance): Promise<void> {
  const alive = inst.status === 'alive' || inst.status === 'connecting';

  if (alive && !inst.stopRequested) {
    inst.stopRequested = true;
    updatePowerButton(inst);
    // SIGHUP — what a terminal emulator sends when the user closes the window.
    // Interactive shells (zsh, bash, fish) respect SIGHUP and exit cleanly;
    // they typically ignore SIGTERM, which made the Stop button appear to do
    // nothing for dynamic shell terminals (HS-6471).
    try { await api('/terminal/kill', { method: 'POST', body: { terminalId: inst.id, signal: 'SIGHUP' } }); } catch { /* ignore */ }
    return;
  }

  if (alive && inst.stopRequested) {
    const confirmed = await confirmDialog({
      title: 'Force quit terminal?',
      message: 'The terminal process has not stopped. Force quit (SIGKILL) the process?',
      confirmLabel: 'Force quit',
      danger: true,
    });
    if (!confirmed) return;
    try { await api('/terminal/kill', { method: 'POST', body: { terminalId: inst.id, signal: 'SIGKILL' } }); } catch { /* ignore */ }
    return;
  }

  try {
    await api('/terminal/restart', { method: 'POST', body: { terminalId: inst.id } });
    inst.term?.clear();
    inst.exitCode = null;
    setStatus(inst, 'alive');
    // Restart wipes any title the previous process pushed via OSC; fall back
    // to the configured/derived name until the new process pushes its own.
    // HS-7262 — same for the CWD; the new shell will push its own OSC 7 on
    // the first prompt.
    inst.runtimeTitle = '';
    inst.runtimeCwd = null;
    updateTabLabel(inst);
    updateCwdChip(inst);
    // HS-7267 — drop all prior shell-integration records + decorations; the
    // new shell rebuilds its own A/B/C/D cycle.
    resetShellIntegration(inst);
  } catch { /* ignore */ }
}

function teardown(inst: TerminalInstance): void {
  if (inst.reconnectTimer !== null) clearTimeout(inst.reconnectTimer);
  inst.reconnectTimer = null;
  // HS-8044 — drop term-level handlers (OSC 7 / OSC 133 parser hooks,
  // onResize / onTitleChange / onBell, the prompt-resume keystroke
  // hider) BEFORE releasing the checkout. These were registered on the
  // shared term — leaving them attached after release would leak state
  // into a future re-checkout.
  for (const d of inst.termHandlerDisposers) {
    try { d.dispose(); } catch { /* already disposed */ }
  }
  inst.termHandlerDisposers = [];
  inst.searchHandle?.dispose();
  inst.searchHandle = null;
  inst.search = null;
  // HS-8044 — release the checkout instead of disposing the term + ws
  // directly. The empty-stack dispose path inside the checkout module
  // closes the WS + disposes the xterm; if a sibling consumer (e.g. a
  // dashboard tile or quit-confirm preview for the same terminal) is
  // still on the stack, the live xterm reparents to that consumer's
  // mount and the dispose is skipped.
  if (inst.checkout !== null) {
    try { inst.checkout.release(); } catch { /* already released */ }
    inst.checkout = null;
  }
  inst.term = null;
  inst.fit = null;
  inst.ws = null;
  inst.mounted = false;
  inst.status = 'not-connected';
}

function removeTerminalInstance(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  teardown(inst);
  inst.tabBtn.remove();
  inst.pane.remove();
  instances.delete(id);
  if (activeTerminalId === id) activeTerminalId = null;
}

/** Tear down every client-side terminal instance. The server-side PTYs are untouched. */
function disposeAllInstances(): void {
  for (const id of [...instances.keys()]) removeTerminalInstance(id);
  activeTerminalId = null;
}

/**
 * Called by the app when the active project has changed. Tears down the old
 * project's terminals on the next `loadAndRenderTerminalTabs()` and resets
 * the cached `activeTerminalId` so the new project starts clean (HS-6309).
 */
export function onProjectSwitch(): void {
  disposeAllInstances();
  currentProjectSecret = null;
  lastKnownConfigs = { configured: [], dynamic: [] };
}

function doFit(inst: TerminalInstance): void {
  if (!inst.fit) return;
  try { inst.fit.fit(); } catch { /* body not visible yet */ }
}

// --- Dynamic terminal lifecycle (HS-6306) ---

async function createDynamicTerminal(): Promise<void> {
  try {
    const { config } = await api<{ config: TerminalTabConfig }>('/terminal/create', { method: 'POST' });
    // HS-7949 follow-up — apply the same "new terminals are hidden in non-
    // Default visibility groupings" rule to dynamic terminals (drawer "+"
    // button) that the server-side `addNewTerminalsToNonDefaultGroupings`
    // applies to configured terminals (Settings → Terminal). Without this,
    // a `dyn-*` id pops into every named grouping the user has built —
    // exactly the regression the user reported.
    const active = getActiveProject();
    if (active !== null) {
      const { hideNewTerminalInNonDefaultGroupings } = await import('./dashboardHiddenTerminals.js');
      hideNewTerminalInNonDefaultGroupings(active.secret, config.id);
    }
    await loadAndRenderTerminalTabs();
    await selectDrawerTab(`terminal:${config.id}`);
  } catch { /* ignore */ }
}

/**
 * Close a dynamic terminal, confirming first if its PTY is still alive.
 *
 * HS-6701: closing a tab with a running process used to silently kill the PTY.
 * Now matches the Settings → Embedded Terminal delete flow: reveal the tab in
 * the drawer, show an in-app confirmDialog naming the tab, and only destroy on
 * confirm. Tabs whose status is exited / not-connected close silently — there
 * is no running process to interrupt. Pass `skipConfirm: true` to bypass the
 * dialog (used by bulk flows that have already confirmed at a higher level).
 */
async function closeDynamicTerminal(
  id: string,
  skipConfirm = false,
  skipActiveFallback = false,
): Promise<void> {
  const inst = instances.get(id);

  if (inst !== undefined && inst.status === 'alive' && !skipConfirm) {
    const name = tabDisplayName(inst.config);
    const mod = await import('./commandLog.js');
    const restoreDrawer = mod.previewDrawerTab(`terminal:${id}`);
    const confirmed = await confirmDialog({
      title: 'Close terminal?',
      message: `Close terminal "${name}"? Its running process will be stopped.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!confirmed) {
      restoreDrawer();
      return;
    }
    // If the user confirmed, keep the revealed tab active — it's about to
    // disappear anyway and the next selectDrawerTab() below handles fallback.
  }

  // Snapshot the tab-strip order BEFORE removal so the fallback can walk the
  // original positions and pick the nearest surviving tab (HS-7275).
  const orderBeforeClose = orderedTabIds();

  try {
    await api('/terminal/destroy', { method: 'POST', body: { terminalId: id } });
  } catch { /* ignore */ }
  removeTerminalInstance(id);
  if (skipActiveFallback) return;
  await selectFallbackAfterClose(orderBeforeClose, [id]);
}

/**
 * Select the next drawer tab after one or more terminals have been closed.
 *
 * Only fires when the drawer was actually showing a closed tab — otherwise the
 * user stays on whatever they were viewing (e.g., commands-log). When the drawer
 * WAS showing a closed tab, prefer the nearest surviving terminal to the right
 * of the first closed position, then to the left, and fall back to commands-log
 * when no terminal tab survives. HS-7275.
 */
async function selectFallbackAfterClose(
  orderBeforeClose: readonly string[],
  closedIds: readonly string[],
): Promise<void> {
  if (closedIds.length === 0) return;
  const mod = await import('./commandLog.js');
  const activeDrawerTab = mod.getActiveDrawerTab();
  const closedDrawerTabs = new Set(closedIds.map(id => `terminal:${id}`));
  if (!closedDrawerTabs.has(activeDrawerTab)) return;

  const nextTabId = pickNearestTerminalTabId(orderBeforeClose, closedIds);
  if (nextTabId !== null) {
    await selectDrawerTab(`terminal:${nextTabId}`);
  } else {
    await selectDrawerTab('commands-log');
  }
}

// Bridge to the drawer tab switcher implemented in commandLog.tsx.
async function selectDrawerTab(tabId: string): Promise<void> {
  const mod = await import('./commandLog.js');
  mod.switchDrawerTab(tabId);
}

/** Called by experimental settings after the user saves the terminals list. */
export async function refreshTerminalsAfterSettingsChange(): Promise<void> {
  await loadAndRenderTerminalTabs();
}

/** Exposed for debugging / tests. */
export function getLastKnownTerminalConfigs() {
  return lastKnownConfigs;
}

// --- Context menu (HS-6470) ---
// Right-clicking a terminal tab opens a lightweight menu with the usual
// "close tab / close others / close to the left / close to the right" entries.
// Configured (default) terminals cannot be closed at all — the menu still
// opens on them, but "Close Tab" is disabled, and the "Close Others/Left/Right"
// actions skip configured tabs so only dynamic ones get torn down.

function dismissTabContextMenu(): void {
  document.querySelector('.terminal-tab-context-menu')?.remove();
}

function isDynamic(id: string): boolean {
  return instances.get(id)?.config.dynamic === true;
}

/** Ordered list of tab ids, matching the visible left-to-right tab strip order. */
function orderedTabIds(): string[] {
  const strip = document.getElementById('drawer-terminal-tabs');
  if (!strip) return [];
  const out: string[] = [];
  for (const el of Array.from(strip.children)) {
    const id = (el as HTMLElement).dataset.terminalId;
    if (typeof id === 'string' && id !== '') out.push(id);
  }
  return out;
}

function showTabContextMenu(e: MouseEvent, clickedId: string): void {
  dismissTabContextMenu();
  const isClickedDynamic = isDynamic(clickedId);

  // HS-7835 — Lucide icons on every entry.
  const menu = toElement(
    <div className="terminal-tab-context-menu command-log-context-menu" style={`left:${e.clientX}px;top:${e.clientY}px`}>
      <div className={`context-menu-item${isClickedDynamic ? '' : ' disabled'}`} data-action="close">
        <span className="dropdown-icon">{raw(ICON_X)}</span>
        <span className="context-menu-label">Close Tab</span>
      </div>
      <div className="context-menu-item" data-action="close-others">
        <span className="dropdown-icon">{raw(ICON_CLOSE_OTHERS)}</span>
        <span className="context-menu-label">Close Other Tabs</span>
      </div>
      <div className="context-menu-item" data-action="close-left">
        <span className="dropdown-icon">{raw(ICON_CLOSE_LEFT)}</span>
        <span className="context-menu-label">Close Tabs to the Left</span>
      </div>
      <div className="context-menu-item" data-action="close-right">
        <span className="dropdown-icon">{raw(ICON_CLOSE_RIGHT)}</span>
        <span className="context-menu-label">Close Tabs to the Right</span>
      </div>
      <div className="context-menu-separator"></div>
      <div className="context-menu-item" data-action="rename">
        <span className="dropdown-icon">{raw(ICON_PENCIL)}</span>
        <span className="context-menu-label">Rename...</span>
      </div>
    </div>
  );

  const bind = (action: string, handler: () => void) => {
    const el = menu.querySelector<HTMLElement>(`[data-action="${action}"]`);
    if (!el) return;
    if (el.classList.contains('disabled')) return;
    el.addEventListener('click', () => {
      dismissTabContextMenu();
      handler();
    });
  };

  bind('close', () => { void closeDynamicTerminal(clickedId); });
  bind('close-others', () => { void closeTabs(orderedTabIds().filter(id => id !== clickedId && isDynamic(id))); });
  bind('close-left', () => {
    const ids = orderedTabIds();
    const idx = ids.indexOf(clickedId);
    if (idx < 0) return;
    void closeTabs(ids.slice(0, idx).filter(isDynamic));
  });
  bind('close-right', () => {
    const ids = orderedTabIds();
    const idx = ids.indexOf(clickedId);
    if (idx < 0) return;
    void closeTabs(ids.slice(idx + 1).filter(isDynamic));
  });
  bind('rename', () => {
    const inst = instances.get(clickedId);
    if (inst) promptRenameTerminal(inst);
  });

  document.body.appendChild(menu);

  // Clamp to viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  setTimeout(() => {
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        dismissTabContextMenu();
        document.removeEventListener('click', close, true);
        document.removeEventListener('contextmenu', close, true);
      }
    };
    document.addEventListener('click', close, true);
    document.addEventListener('contextmenu', close, true);
  }, 0);
}

/**
 * Bulk-close a set of dynamic tabs (Close Others / Close Tabs to the Left /
 * Close Tabs to the Right). HS-6701: when any of the target PTYs are alive,
 * surface a confirm dialog before stopping their processes.
 *
 *   0 alive  → destroy all silently (nothing to interrupt).
 *   1 alive  → reuse the single-tab confirm flow for that one; on confirm, also
 *              destroy the inert tabs. On cancel, abort the whole bulk op.
 *   2+ alive → single "Stop All" dialog listing the running tab names;
 *              confirm destroys all, cancel aborts the whole bulk op.
 */
async function closeTabs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const aliveIds = ids.filter(id => instances.get(id)?.status === 'alive');
  const deadIds = ids.filter(id => !aliveIds.includes(id));

  // Snapshot order BEFORE any close so the fallback anchors on the original
  // positions after every close has completed (HS-7275).
  const orderBeforeClose = orderedTabIds();

  if (aliveIds.length === 0) {
    for (const id of ids) await closeDynamicTerminal(id, true, true);
    await selectFallbackAfterClose(orderBeforeClose, ids);
    return;
  }

  if (aliveIds.length === 1) {
    // Fall through to the single-tab confirm UX — if the user cancels there,
    // the whole bulk op aborts (no dead-tab destroys either). If they confirm,
    // the alive tab is destroyed by closeDynamicTerminal; we then clean up the
    // inert tabs.
    const aliveId = aliveIds[0];
    const before = instances.has(aliveId);
    await closeDynamicTerminal(aliveId, false, true);
    const confirmed = before && !instances.has(aliveId);
    if (!confirmed) return;
    for (const id of deadIds) await closeDynamicTerminal(id, true, true);
    await selectFallbackAfterClose(orderBeforeClose, ids);
    return;
  }

  const names = aliveIds
    .map(id => {
      const inst = instances.get(id);
      return inst !== undefined ? tabDisplayName(inst.config) : id;
    })
    .map(n => `  • ${n}`)
    .join('\n');
  const confirmed = await confirmDialog({
    title: 'Stop all running terminals?',
    message: `The following terminals have running processes that will be stopped:\n\n${names}`,
    confirmLabel: 'Stop All',
    danger: true,
  });
  if (!confirmed) return;
  for (const id of ids) await closeDynamicTerminal(id, true, true);
  await selectFallbackAfterClose(orderBeforeClose, ids);
}

/**
 * In-app rename dialog for a terminal tab (HS-6668). The rename is transient —
 * it updates the in-memory `config.name` on the instance and re-renders the tab
 * label, but does NOT persist to settings.json. A page reload or project-tab
 * switch restores the original configured / server-derived name. This matches
 * the "temporary for default terminals" requirement and keeps dynamic terminals
 * consistent (the dynamic config is also in-memory-only on the server).
 */
function promptRenameTerminal(inst: TerminalInstance): void {
  document.querySelectorAll('.terminal-rename-overlay').forEach(el => el.remove());
  const current = tabDisplayName(inst.config);

  const overlay = toElement(
    <div className="cmd-editor-overlay terminal-rename-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>Rename Terminal</span>
          <button className="cmd-editor-close-btn" title="Close">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Tab name</label>
            <input type="text" className="term-rename-input" value={current} />
            <span className="settings-hint">This rename is temporary — it doesn't change saved settings and resets on reload or project switch.</span>
          </div>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-cancel-btn">Cancel</button>
          <button className="btn btn-sm btn-primary cmd-editor-done-btn">Rename</button>
        </div>
      </div>
    </div>
  );

  const input = overlay.querySelector<HTMLInputElement>('.term-rename-input')!;

  const apply = () => {
    const next = input.value.trim();
    // Update the in-memory config so tabDisplayName() picks up the new name on
    // every subsequent updateTabLabel() call. Empty input falls back to the
    // default derivation (effectively restoring the original).
    if (next === '') {
      const rest = { ...inst.config };
      delete rest.name;
      inst.config = rest;
    } else {
      inst.config = { ...inst.config, name: next };
    }
    updateTabLabel(inst);
    overlay.remove();
  };

  const cancel = () => { overlay.remove(); };

  overlay.querySelector('.cmd-editor-close-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-cancel-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-done-btn')?.addEventListener('click', apply);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
