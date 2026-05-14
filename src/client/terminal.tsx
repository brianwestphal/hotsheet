import type { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { fireToastsForActiveProject, subscribeToBellState } from './bellPoll.js';
import { confirmDialog } from './confirm.js';
import { pruneHiddenForProject } from './dashboardHiddenTerminals.js';
import { byIdOrNull, toElement } from './dom.js';
import {
  type DrawerGridTileEntry,
  exitDrawerGridMode,
  isDrawerGridActive,
  onTerminalListUpdated,
} from './drawerTerminalGrid.js';
import { recordInteraction } from './longTaskObserver.js';
import type { Signal } from './reactive.js';
import { signal } from './reactive.js';
import { bindList } from './reactive-bind.js';
import { getActiveProject } from './state.js';
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
import {
  tabDisplayName,
  updateCwdChip,
  updateTabLabel,
} from './terminalInstanceLabel.js';
import { isClearTerminalShortcut, isFindShortcut, isJumpShortcut, isTerminalViewToggleShortcut } from './terminalKeybindings.js';
import { cacheHomeDir, parseOsc7Payload } from './terminalOsc7.js';
import { mountTerminalSearch, type TerminalSearchHandle } from './terminalSearch.js';
import {
  applyShellIntegrationToolbarVisibility,
  closeDanglingCommand,
  copyLastOutput,
  freshShellIntegrationState,
  handleOsc133,
  jumpToPromptMarker,
  reapplyShellIntegrationDecorations,
  resetShellIntegration,
  type ShellIntegrationState,
  shellIntegrationUiEnabled,
} from './terminalShellIntegration.js';
import { initTabContextMenu, orderedTabIds, showTabContextMenu } from './terminalTabContextMenu.js';
import { attachTabDragHandlers, initTabDragDrop } from './terminalTabDragDrop.js';
import { pickNearestTerminalTabId } from './terminalTabSelection.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';

type Status = 'not-connected' | 'connecting' | 'alive' | 'exited';

// Lucide "square" (stop) and "play" (start) glyphs — used for the power toggle button.
const POWER_ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
const POWER_ICON_START = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
// Lucide `folder` glyph. Shown on the terminal toolbar CWD chip (HS-7262);
// clicking opens the folder in the OS file manager.
const FOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
// Lucide `clipboard-copy` glyph. Shown on the terminal toolbar copy-last-output
// button (HS-7268); visible only when OSC 133 shell integration has been seen
// on this terminal.
const CLIPBOARD_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M16 14h-6"/><path d="M10 18h.01"/></svg>';
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

// HS-8396 Phase 1 — OSC 133 shell-integration types + constants moved to
// `terminalShellIntegration.tsx`. `CommandRecord` and `ShellIntegrationState`
// are imported below; the `TerminalInstance.shellIntegration` field is
// typed via that import.

const instances = new Map<string, TerminalInstance>();

/**
 * HS-8312 / §60 Phase 2 — drawer tab strip + pane container reconciled
 * via two parallel bindLists keyed on terminal id. The `instances` Map
 * above remains the imperative source of truth for xterm + WebSocket
 * lifetime; these bindLists only decide WHERE in the strip / pane
 * container each row sits. `removeTerminalInstance` handles xterm/WS
 * teardown + DOM detach + the signal sync below, so the per-row
 * dispose returned by the bindList render functions is a no-op.
 *
 * Pre-fix `loadAndRenderTerminalTabs` did a wholesale clear of
 * `tabStrip` (`innerHTML = ''`) plus a per-pane `el.remove()` sweep on
 * `paneContainer`, then re-appended every `inst.tabBtn` / `inst.pane`
 * in order — which DID preserve the xterm + WS instances (those live
 * in `instances`) but churned DOM positions on every poll tick.
 * Post-fix surviving rows keep their DOM identity across reorder; the
 * bindList only mutates the DOM for rows that actually moved,
 * appeared, or disappeared.
 */
const drawerInstancesSignal: Signal<readonly TerminalInstance[]> = signal([]);
let drawerTabsBindListDispose: (() => void) | null = null;
let drawerPanesBindListDispose: (() => void) | null = null;

function ensureDrawerBindLists(tabStrip: HTMLElement, paneContainer: HTMLElement): void {
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

/**
 * HS-8224 — bundled module-level lifecycle state, mirroring the HS-8190
 * pattern landed in `permissionOverlay.tsx` and the HS-8222 / HS-8223
 * follow-ups applied to `terminalDashboard.tsx` + `drawerTerminalGrid.tsx`.
 * Holds the active-terminal pointer, the project-secret the per-instance
 * state was built for, the last-known config snapshot driven by every
 * `/terminal/list` round-trip, the bell-subscription idempotency flag, and
 * the in-flight tab-drag id.
 *
 * The local var is named `terminalState` (not `state`) to avoid shadowing
 * the imported `state` from `./state.js` — matches the precedent set in
 * HS-8190 where shadowing was hit and reverted.
 */
interface TerminalModuleState {
  activeTerminalId: string | null;
  /** The project secret the current instances were built for. Changes
   *  trigger a full rebuild (HS-6309). */
  currentProjectSecret: string | null;
  /** Populated on each loadAndRenderTerminalTabs(). Consumed by
   *  settings-refresh flows. */
  lastKnownConfigs: { configured: TerminalTabConfig[]; dynamic: TerminalTabConfig[] };
  /** Idempotency flag for `subscribeToBellState`. */
  bellSubscribed: boolean;
  // HS-8396 Phase 3 — `tabDragFromId` moved to `terminalTabDragDrop.ts`
  // (module-private state — no other surface touches it).
}

function freshTerminalModuleState(): TerminalModuleState {
  return {
    activeTerminalId: null,
    currentProjectSecret: null,
    lastKnownConfigs: { configured: [], dynamic: [] },
    bellSubscribed: false,
  };
}

let terminalState: TerminalModuleState = freshTerminalModuleState();

/** One-time DOM setup for the terminal area inside the drawer. Called from app init. */
export function initTerminal(): void {
  // HS-8396 Phase 3 — wire the tab drag-drop module's accessors before
  // any tab strip is rendered. The accessor pair lets the new module
  // read/write `lastKnownConfigs` without a circular import.
  initTabDragDrop({
    getLastKnownConfigs: () => terminalState.lastKnownConfigs,
    setLastKnownConfigs: (next) => { terminalState.lastKnownConfigs = next; },
  });
  // HS-8396 Phase 4 — wire the tab context menu's accessors. Hooks point
  // back into the lifecycle helpers that stay in this module.
  initTabContextMenu({
    getInstance: (id) => instances.get(id),
    closeDynamicTerminal,
    selectFallbackAfterClose,
  });
  // Wire up the new + button that creates dynamic terminals.
  byIdOrNull('drawer-add-terminal-btn')?.addEventListener('click', () => { void createDynamicTerminal(); });
  // Keep in-drawer bell indicators in sync with bellPoll (HS-6603 §24.4.3).
  ensureBellSubscription();
  window.addEventListener('resize', () => {
    const active = terminalState.activeTerminalId === null ? null : instances.get(terminalState.activeTerminalId);
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
  // HS-8283 — drawer instances belong to the active project; ignore change
  // events for other projects' secrets so adding a new project folder
  // doesn't trigger a redundant re-apply on the active project's drawer
  // terminals using a cache that hasn't been updated for them.
  subscribeToDefaultAppearanceChanges((changedSecret) => {
    const activeSecret = getActiveProject()?.secret ?? '';
    if (changedSecret !== '' && changedSecret !== activeSecret) return;
    for (const inst of instances.values()) {
      if (inst.term !== null) void reapplyAppearance(inst);
    }
  });

  // HS-7562 — when a per-terminal config changes (Settings → Terminal outline
  // editor's Appearance section saved), update the matching instance's
  // config snapshot from the latest list response so resolveInstanceAppearance
  // picks up the new theme / fontFamily / fontSize, then re-apply. We don't
  // know the new values inline here, so refresh `terminalState.lastKnownConfigs` first via
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
  const drawerPanel = byIdOrNull('command-log-panel');
  if (drawerPanel !== null && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const active = terminalState.activeTerminalId === null ? null : instances.get(terminalState.activeTerminalId);
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

function reconcileProjectChange(activeSecret: string | null): void {
  // If the active project changed since the last render, every previously-
  // mounted xterm/ws is bound to the old project — tear them all down. Otherwise
  // `activateTerminal` would reuse stale instances keyed by id (a configured
  // `default` terminal in project A shadowing project B's `default`).
  if (terminalState.currentProjectSecret !== null && terminalState.currentProjectSecret !== activeSecret) {
    disposeAllInstances();
  }
  terminalState.currentProjectSecret = activeSecret;
}

function buildWantedMap(data: ListResponse): Map<string, ListEntry> {
  const wanted = new Map<string, ListEntry>();
  for (const c of data.configured) wanted.set(c.id, { ...c, dynamic: false });
  for (const c of data.dynamic) wanted.set(c.id, { ...c, dynamic: true });
  return wanted;
}

function ensureInstanceForEntry(entry: ListEntry): TerminalInstance {
  // `notificationMessage` is already surfaced as a toast via
  // fireToastsForActiveProject above — drop it here along with `bellPending`
  // so only the TerminalTabConfig shape flows into `inst.config`.
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
  if (entry.bellPending === true && !inst.hasBell) {
    inst.hasBell = true;
    updateTabLabel(inst);
  }
  return inst;
}

function toGridEntries(wanted: Map<string, ListEntry>): DrawerGridTileEntry[] {
  return [...wanted.values()].map(e => ({
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
}

export async function loadAndRenderTerminalTabs(): Promise<void> {
  // HS-7977: terminals are a Tauri-only feature. Web/browser deployments must
  // never spawn xterm/PTY instances or render terminal panes.
  if (getTauriInvoke() === null) return;

  reconcileProjectChange(getActiveProject()?.secret ?? null);

  let data: ListResponse;
  try {
    data = await api<ListResponse>('/terminal/list');
  } catch {
    return;
  }
  terminalState.lastKnownConfigs = data;
  // HS-7276 — seed the module-level $HOME cache so the CWD chip can tildify
  // subsequent OSC 7 pushes. No-op after the first tick.
  cacheHomeDir(data.home);
  // HS-6307 — refresh the project default appearance whenever the terminal
  // list reloads. Fires the default-changed event if the value moved.
  void loadProjectDefaultAppearance();

  const tabStrip = byIdOrNull('drawer-terminal-tabs');
  const paneContainer = byIdOrNull('drawer-terminal-panes');
  if (!tabStrip || !paneContainer) return;

  const wanted = buildWantedMap(data);

  // Remove instances for terminals that no longer exist server-side.
  for (const id of [...instances.keys()]) {
    if (!wanted.has(id)) removeTerminalInstance(id);
  }

  // HS-8016 — reconcile per-project hidden state so the eye-icon count badge
  // stops counting deleted terminals.
  const activeProject = getActiveProject();
  if (activeProject !== null) pruneHiddenForProject(activeProject.secret, [...wanted.keys()]);

  // HS-7264 — fire OSC 9 toasts for any pending desktop notifications.
  fireToastsForActiveProject([...wanted.values()]);

  // HS-8312 — build the ordered instance list (lazy create / config
  // update via ensureInstanceForEntry), then write the signal. The two
  // parallel bindLists set up in ensureDrawerBindLists reconcile
  // tabStrip + paneContainer DOM positions: surviving ids keep their
  // existing tabBtn + pane elements (no `innerHTML = ''` / re-append
  // churn), new ids get rendered + appended, dropped ids were already
  // removed via removeTerminalInstance above and the bindList self-
  // heals on this write (its `live` Map drops the ids that aren't in
  // survivors).
  ensureDrawerBindLists(tabStrip, paneContainer);
  const orderedInstances: TerminalInstance[] = [];
  for (const entry of wanted.values()) {
    orderedInstances.push(ensureInstanceForEntry(entry));
  }
  drawerInstancesSignal.value = orderedInstances;

  // If the previously-active id no longer exists, default to the first terminal.
  if (terminalState.activeTerminalId !== null && !wanted.has(terminalState.activeTerminalId)) {
    terminalState.activeTerminalId = null;
  }

  // HS-6311 — hand the full list to the drawer-grid module.
  onTerminalListUpdated(toGridEntries(wanted));
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

function ensureBellSubscription(): void {
  if (terminalState.bellSubscribed) return;
  terminalState.bellSubscribed = true;
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
  terminalState.activeTerminalId = id;

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
  if (terminalState.activeTerminalId === null) return;
  const inst = instances.get(terminalState.activeTerminalId);
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
  return terminalState.activeTerminalId === inst.id && inst.pane.style.display !== 'none';
}

// IMPORTANT: the custom JSX runtime renders to an HTML string, so DOM
// elements passed as JSX children silently render as empty strings — the
// resulting button has no children at all. Build each tree as a single JSX
// expression and query the inner pieces back out via querySelector. Root
// cause of HS-6342 (configured tabs rendered as blank buttons) and HS-6341
// (dynamic tab + xterm pane both rendered with no header / no label).
function buildTabBtnEl(config: TerminalTabConfig, tabName: string): HTMLElement {
  return toElement(
    <button className="drawer-tab drawer-terminal-tab" data-drawer-tab={`terminal:${config.id}`} data-terminal-id={config.id} draggable="true">
      <span className="drawer-tab-label">{tabName}</span>
      {config.dynamic === true
        ? raw(`<button class="drawer-tab-close" title="Close terminal">${CLOSE_ICON}</button>`)
        : null}
    </button>
  );
}

function bindTabBtnHandlers(tabBtn: HTMLElement, config: TerminalTabConfig): void {
  const closeBtn = tabBtn.querySelector<HTMLButtonElement>('.drawer-tab-close');
  tabBtn.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;
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
  // HS-7827 — drag-to-reorder. Configured-id reorder persists; dynamic-id
  // reorder is in-memory only.
  attachTabDragHandlers(tabBtn, config.id);
}

function buildPaneEl(config: TerminalTabConfig, tabName: string): HTMLElement {
  return toElement(
    <div className="drawer-tab-content drawer-terminal-pane" data-drawer-panel={`terminal:${config.id}`} style="display:none">
      <div className="terminal-header">
        <span className="terminal-status-dot" title="Not connected"></span>
        <span className="terminal-label">{tabName}</span>
        {/* HS-7262 — CWD chip; hidden until OSC 7 push. Click opens the
            folder in the OS file manager via /api/terminal/open-cwd. */}
        <button className="terminal-cwd-chip" title="Open folder" style="display:none">
          {raw(FOLDER_ICON)}
          <span className="terminal-cwd-label"></span>
        </button>
        <span className="terminal-header-spacer"></span>
        {/* HS-7331 — terminal search slot. Mounted from terminalSearch.tsx on
            xterm attach. */}
        <span className="terminal-search-slot"></span>
        {/* HS-8286 — per-pane "Server slow" chip removed. Stall detection
            now feeds the global server-slow banner via the per-entry
            watcher in `terminalCheckout.tsx::createEntry`. */}
        {/* HS-7268 — copy-last-output, hidden until first OSC 133 escape. */}
        <button className="terminal-header-btn terminal-copy-output-btn" title="Copy last command output" style="display:none">
          {raw(CLIPBOARD_ICON)}
        </button>
        <button className="terminal-header-btn terminal-power-btn" title="Stop terminal">
          <span className="terminal-power-icon">{raw(POWER_ICON_STOP)}</span>
        </button>
        <button className="terminal-header-btn terminal-clear-btn" title="Clear screen (keeps process running)">
          {raw(TRASH_ICON)}
        </button>
        {/* HS-6307 — per-terminal appearance (theme / font / size). */}
        <button className="terminal-header-btn terminal-appearance-btn" title="Appearance (theme, font)">
          {raw(SETTINGS_ICON)}
        </button>
      </div>
      {/* HS-7959 — `.terminal-body` keeps padding/focus-ring; xterm mounts
          inside an inner `.terminal-canvas-host` with NO padding so FitAddon
          reads the parent's true content height. */}
      <div className="terminal-body">
        <div className="terminal-canvas-host"></div>
      </div>
    </div>
  );
}

function bindAppearanceBtn(inst: TerminalInstance, pane: HTMLElement): void {
  // HS-6307 + HS-7896 — opens the popover anchored below the button; live
  // hooks read/write `inst.config` synchronously so the user's pick lands on
  // the live xterm without a settings round-trip.
  const appearanceBtn = pane.querySelector<HTMLButtonElement>('.terminal-appearance-btn');
  appearanceBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    mountAppearancePopover({
      anchor: appearanceBtn,
      terminalId: inst.id,
      // HS-8283 — drawer terminals belong to the active project; pass that
      // secret so the popover resolves the default against the right cache.
      projectSecret: getActiveProject()?.secret ?? '',
      isDynamic: inst.config.dynamic === true,
      onApply: () => { void reapplyAppearance(inst); },
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
}

function bindPaneHeaderHandlers(inst: TerminalInstance, pane: HTMLElement): void {
  pane.querySelector<HTMLButtonElement>('.terminal-power-btn')!.addEventListener('click', () => { void onPowerClick(inst); });
  pane.querySelector<HTMLButtonElement>('.terminal-clear-btn')!.addEventListener('click', () => { inst.term?.clear(); });
  bindAppearanceBtn(inst, pane);

  // HS-7268 — copy-last-output click. Button hidden until shell-integration
  // flips, so by click time we have at least one record.
  pane.querySelector<HTMLButtonElement>('.terminal-copy-output-btn')
    ?.addEventListener('click', () => { void copyLastOutput(inst); });

  // HS-7262 — CWD chip click reveals the folder via /api/terminal/open-cwd.
  pane.querySelector<HTMLButtonElement>('.terminal-cwd-chip')?.addEventListener('click', () => {
    if (inst.runtimeCwd === null || inst.runtimeCwd === '') return;
    void api('/terminal/open-cwd', { method: 'POST', body: { path: inst.runtimeCwd } }).catch(() => { /* ignore */ });
  });
}

function createInstance(config: TerminalTabConfig): TerminalInstance {
  const tabName = tabDisplayName(config);
  const tabBtn = buildTabBtnEl(config, tabName);
  bindTabBtnHandlers(tabBtn, config);

  const pane = buildPaneEl(config, tabName);
  const inst: TerminalInstance = {
    id: config.id,
    config,
    checkout: null,
    termHandlerDisposers: [],
    term: null,
    fit: null,
    search: null,
    searchHandle: null,
    body: pane.querySelector<HTMLElement>('.terminal-body')!,
    canvasHost: pane.querySelector<HTMLElement>('.terminal-canvas-host')!,
    header: pane.querySelector<HTMLElement>('.terminal-header')!,
    label: pane.querySelector<HTMLElement>('.terminal-label')!,
    statusDot: pane.querySelector<HTMLElement>('.terminal-status-dot')!,
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
    shellIntegration: freshShellIntegrationState(),
  };

  bindPaneHeaderHandlers(inst, pane);
  return inst;
}

/** HS-7827 — wire HTML5 drag handlers on a drawer terminal tab button.
 *  Tracks the dragged terminal id at module scope and reorders the strip
 *  on drop. Configured-id reorder is persisted to settings.terminals via
 *  PATCH; dynamic-id reorder lives in memory only. */
/** Re-render the CWD chip on the terminal toolbar. HS-7262.
 *  HS-7276 — reads $HOME from the module-level cache that
 *  `loadAndRenderTerminalTabs` seeds from `/api/terminal/list`, so paths
 *  under $HOME render as `~/…`. Before the first /list response lands the
 *  cache is null and the label degrades to an un-tildified absolute path. */
// HS-8396 Phase 2 — `tabDisplayName`, `effectiveHeaderLabel`,
// `updateTabLabel`, `updateCwdChip` + the `BELL_ICON` constant moved to
// `terminalInstanceLabel.tsx`. Imported at the top of this file.

/** HS-6307 — resolve the appearance layers for a terminal. Factored out so
 *  mountXterm / reapplyAppearance / the popover all read the same stack. */
function resolveInstanceAppearance(inst: TerminalInstance) {
  const configOverride: { theme?: string; fontFamily?: string; fontSize?: number } = {};
  if (inst.config.theme !== undefined) configOverride.theme = inst.config.theme;
  if (inst.config.fontFamily !== undefined) configOverride.fontFamily = inst.config.fontFamily;
  if (inst.config.fontSize !== undefined) configOverride.fontSize = inst.config.fontSize;
  // HS-8283 — drawer terminals always belong to the active project, so
  // resolve against the active project's per-secret cached default.
  const activeSecret = getActiveProject()?.secret ?? '';
  return resolveAppearance({
    projectDefault: getProjectDefault(activeSecret),
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
  // doesn't leave the gutter in the previous theme's color mid-flight.
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
 * `attachWebSocketToEntry` now centralizes the WS lifecycle including
 * reconnect on transient close, so the drawer's old `scheduleReconnect`
 * path is gone.
 */
function applyDrawerXtermOptions(inst: TerminalInstance, term: XTerm): void {
  // HS-8044 — option overrides applied here win for the drawer's lifetime as
  // long as it stays at top-of-stack of the shared (secret, terminalId) xterm.
  term.options.theme = resolveAppearanceThemeForInit(inst);
  term.options.linkHandler = {
    activate: (_event, text) => { openExternalUrl(text); },
  };
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
  term.loadAddon(new SerializeAddon());
}

function mountDrawerSearchAddon(inst: TerminalInstance, term: XTerm): { search: SearchAddon; searchHandle: TerminalSearchHandle | null } {
  // HS-7331 — xterm's SearchAddon powers the toolbar Find widget. Disposed on
  // PTY restart + re-created on the next mount so search state doesn't leak.
  const search = new SearchAddon();
  term.loadAddon(search);
  const searchSlot = inst.header.querySelector<HTMLElement>('.terminal-search-slot');
  let searchHandle: TerminalSearchHandle | null = null;
  if (searchSlot !== null) {
    searchHandle = mountTerminalSearch(term, search);
    searchSlot.replaceChildren(searchHandle.root);
  }
  return { search, searchHandle };
}

function attachDrawerKeyHandler(inst: TerminalInstance, term: XTerm): void {
  // Per-shortcut rationale lives on the original mountXterm comments
  // (HS-7329 / HS-7269 / HS-7331 / HS-7594).
  term.attachCustomKeyEventHandler((e) => {
    if (isClearTerminalShortcut(e)) {
      inst.checkout?.term.clear();
      return false;
    }
    if (isFindShortcut(e)) return false;
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
}

function attachDrawerTermHandlers(inst: TerminalInstance, term: XTerm, handle: ReturnType<typeof checkout>): void {
  // HS-8044 — echo fit-driven dim changes through `handle.resize` so the WS
  // resize frame is sent and `lastApplied` bookkeeping stays current.
  inst.termHandlerDisposers.push(term.onResize(({ cols, rows }) => {
    handle.resize(cols, rows);
  }));

  // OSC 0 / OSC 2 title-change escapes (HS-6473).
  inst.termHandlerDisposers.push(term.onTitleChange((newTitle) => {
    inst.runtimeTitle = typeof newTitle === 'string' ? newTitle : '';
    updateTabLabel(inst);
  }));

  // OSC 7 — shell-pushed CWD (HS-7262). xterm.js doesn't handle OSC 7
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
}

// HS-8286 — `attachStallIndicator` deleted. The per-pane stall chip was
// removed; stall detection now feeds the global server-slow banner via
// the per-entry watcher inside `terminalCheckout.tsx::createEntry`.

function mountInstanceViaCheckout(inst: TerminalInstance, secret: string): void {
  const handle = checkout({
    projectSecret: secret,
    terminalId: inst.id,
    cols: 80,
    rows: 24,
    mountInto: inst.canvasHost,
    // HS-8295 — paint the §54 "Terminal in use elsewhere" placeholder with
    // this terminal's resolved theme background so a §47 popup borrowing
    // the live xterm doesn't flash the drawer canvas to `--bg-secondary`.
    placeholderBackground: resolveAppearanceBackground(resolveInstanceAppearance(inst)),
    onControlMessage(msg) { handleControlMessage(inst, msg); },
    onRestoredToTop() {
      // HS-8206 v2 — when another consumer (e.g. the §47 permission popup
      // borrowing the live terminal via §54 checkout) releases, the live
      // xterm reparents back into our `canvasHost`. `applyResizeIfChanged`
      // inside `releaseInternal` resizes the term to the cols/rows we
      // originally requested at checkout time (80×24), NOT to the drawer
      // pane's actual current geometry — which is typically much wider
      // (e.g. 178×42). Without an explicit refit here, the user sees the
      // drawer terminal stuck at the popup's narrow size with content
      // wrapping at ~80 cols even though the drawer pane is full-width.
      // Defer one rAF so the reparent + applyResizeIfChanged round-trip
      // has settled before FitAddon reads CSS dims.
      requestAnimationFrame(() => doFit(inst));
    },
  });
  const term = handle.term;
  const fit = handle.fit;

  applyDrawerXtermOptions(inst, term);
  const { search, searchHandle } = mountDrawerSearchAddon(inst, term);

  // HS-7960 — paint the body's gutter to match the theme BEFORE the async
  // appearance load runs (fire-and-forget below). Without this synchronous
  // prime the very first canvas paint flashes with the app's `--bg`.
  inst.body.style.backgroundColor = resolveAppearanceBackground(resolveInstanceAppearance(inst));
  // HS-6307 — apply full appearance (font family + size). Fire-and-forget.
  void reapplyAppearance(inst);

  // Clicking the body (including padding gutters outside the canvas) focuses
  // the terminal — preserves the pre-HS-7959 click-to-focus reach.
  inst.body.addEventListener('click', () => { term.focus(); });

  attachDrawerKeyHandler(inst, term);
  attachDrawerTermHandlers(inst, term, handle);

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

// HS-8088 — discriminated union over the control-message shapes the
// drawer currently consumes. Pre-fix the parsed JSON arrived as
// `{ type: string; [k: string]: unknown }` and each branch did
// `msg as unknown as HistoryMessage` / `as unknown as ExitMessage` to
// peel apart the fields. The narrowing predicates below let TS pick
// the right branch from a `msg.type === 'history'` / `'exit'` check
// without an escape-hatch cast at every callsite. The interface members
// extend an index signature so the predicates' type guards can narrow
// against the JSON-shape parameter type.
interface HistoryMessage { type: 'history'; bytes: string; alive: boolean; exitCode: number | null; cols: number; rows: number; command: string; [k: string]: unknown }
interface ExitMessage { type: 'exit'; code: number; [k: string]: unknown }
type ControlMessage = HistoryMessage | ExitMessage;

function isHistoryMessage(msg: { type: string; [k: string]: unknown }): msg is HistoryMessage {
  return msg.type === 'history' && typeof msg.bytes === 'string' && typeof msg.alive === 'boolean';
}
function isExitMessage(msg: { type: string; [k: string]: unknown }): msg is ExitMessage {
  return msg.type === 'exit' && typeof msg.code === 'number';
}
// `ControlMessage` is exposed for tests / future callers — kept exported
// to mirror the audit's intent.
export type { ControlMessage };

function handleControlMessage(inst: TerminalInstance, msg: { type: string; [k: string]: unknown }): void {
  if (isHistoryMessage(msg)) {
    // HS-8044 — bytes-replay (resize first, write second) is now done
    // inside the checkout module's WS handler. The drawer just extracts
    // the metadata fields (alive, exitCode, command) for tab-status /
    // tab-label updates.
    inst.exitCode = msg.exitCode;
    setStatus(inst, msg.alive ? 'alive' : 'exited');
    if (msg.command !== '') {
      // Prefer the user-supplied name; fall back to resolved command for unnamed terminals.
      if ((inst.config.name ?? '') === '') inst.label.textContent = shortCommandName(msg.command);
    }
    requestAnimationFrame(() => doFit(inst));
    return;
  }
  if (isExitMessage(msg)) {
    inst.exitCode = msg.code;
    setStatus(inst, 'exited');
    inst.term?.write(`\r\n[process exited with code ${msg.code}]\r\n`);
    // HS-7267 — if a command was in-flight (A seen, no D yet), close it out
    // with exitCode=-1 so its gutter glyph stays visible (otherwise the
    // record sits dangling with no visible end). §26.9 edge case "runaway
    // C without D".
    if (inst.term !== null) closeDanglingCommand(inst, inst.term);
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
  if (terminalState.activeTerminalId === id) terminalState.activeTerminalId = null;
  // HS-8312 — keep the drawer bindLists' `live` Map in sync. Without
  // this drop, a future signal write that does NOT include this id
  // would still see the cached entry on the live Map; the removed
  // tabBtn / pane (`parentNode === null` after `inst.tabBtn.remove()`
  // above) would survive in the cache and a hypothetical re-creation
  // of the same id with a fresh tabBtn would still resolve to the
  // stale cached element. Filter conditionally so callers that
  // remove-en-masse via disposeAllInstances (which sets the signal to
  // [] up-front) don't fire N redundant signal writes.
  const current = drawerInstancesSignal.value;
  const filtered = current.filter(i => i.id !== id);
  if (filtered.length !== current.length) {
    drawerInstancesSignal.value = filtered;
  }
}

/** Tear down every client-side terminal instance. The server-side PTYs are untouched. */
function disposeAllInstances(): void {
  // HS-8312 — flush the drawer bindLists' live Map up-front so the
  // per-id removeTerminalInstance calls below don't cascade N signal
  // writes (each would trigger a bindList effect run + DOM reconcile).
  // After this assignment removeTerminalInstance's filter sees an
  // already-empty signal and short-circuits the subsequent writes.
  drawerInstancesSignal.value = [];
  for (const id of [...instances.keys()]) removeTerminalInstance(id);
  terminalState.activeTerminalId = null;
}

/**
 * Called by the app when the active project has changed. Tears down the old
 * project's terminals on the next `loadAndRenderTerminalTabs()` and resets
 * the cached `terminalState.activeTerminalId` so the new project starts clean (HS-6309).
 */
export function onProjectSwitch(): void {
  disposeAllInstances();
  terminalState.currentProjectSecret = null;
  terminalState.lastKnownConfigs = { configured: [], dynamic: [] };
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
  return terminalState.lastKnownConfigs;
}

// --- Context menu (HS-6470) ---
// Right-clicking a terminal tab opens a lightweight menu with the usual
// "close tab / close others / close to the left / close to the right" entries.
// Configured (default) terminals cannot be closed at all — the menu still
// opens on them, but "Close Tab" is disabled, and the "Close Others/Left/Right"
// actions skip configured tabs so only dynamic ones get torn down.
//
// HS-8221 — the menu DOM + viewport-clamp + outside-click-dismiss live in
// `terminal/tabContextMenu.tsx`. The helpers below adapt this file's
// per-tab state (`instances` Map, `orderedTabIds` walker, `isDynamic`
// predicate) into the callback contract that module exposes.

// HS-8396 Phase 4 — `isDynamic`, `orderedTabIds`, `showTabContextMenu`,
// `closeTabs`, `promptRenameTerminal` moved to `terminalTabContextMenu.tsx`.
// `isDynamic` + `orderedTabIds` + `showTabContextMenu` are imported back
// for the few main-file callsites (`closeDynamicTerminal` uses
// `orderedTabIds`, `bindTabBtnHandlers` uses `showTabContextMenu`).


/** **TEST ONLY** — reset every module-level state slot back to its boot
 *  default so consecutive tests don't leak. Mirrors the HS-8190 convention
 *  in `permissionOverlay.tsx::_resetStateForTesting`. The const collection
 *  state (`instances`) is cleared explicitly because it is a separate
 *  container, not part of the bundled state object. Per-instance teardown
 *  is best-effort — tests that need a clean DOM should swap the page first.
 */
export function _resetStateForTesting(): void {
  for (const inst of instances.values()) {
    try {
      if (inst.ws !== null) inst.ws.close();
      if (inst.term !== null) inst.term.dispose();
    } catch { /* ignore */ }
  }
  instances.clear();
  terminalState = freshTerminalModuleState();
  // HS-8312 — reset the drawer bindList wiring so the next test's
  // setupDom creates a fresh tabStrip / paneContainer that the
  // bindList re-binds to. Without this, the bindLists from a prior
  // test stay bound to a now-detached DOM and the next signal write
  // mutates nothing visible.
  drawerInstancesSignal.value = [];
  if (drawerTabsBindListDispose !== null) { drawerTabsBindListDispose(); drawerTabsBindListDispose = null; }
  if (drawerPanesBindListDispose !== null) { drawerPanesBindListDispose(); drawerPanesBindListDispose = null; }
}
