import { clearTerminalBell, createTerminal, listTerminals } from '../api/index.js';
import { fireToastsForActiveProject, subscribeToBellState } from './bellPoll.js';
import { pruneHiddenForProject } from './dashboardHiddenTerminals.js';
import { byIdOrNull } from './dom.js';
import {
  type DrawerGridTileEntry,
  exitDrawerGridMode,
  isDrawerGridActive,
  onTerminalListUpdated,
} from './drawerTerminalGrid.js';
import { recordInteraction } from './longTaskObserver.js';
import { getActiveProject } from './state.js';
import {
  loadProjectDefaultAppearance,
  subscribeToDefaultAppearanceChanges,
} from './terminalAppearance.js';
import { initDrawerMount, mountInstanceViaCheckout } from './terminalDrawerMount.js';
import {
  disposeDrawerBindLists,
  drawerInstancesSignal,
  ensureDrawerBindLists,
  freshTerminalModuleState,
  instances,
  setTerminalState,
  type TerminalInstance,
  terminalState,
  type TerminalTabConfig,
} from './terminalInstance.js';
import {
  doFit,
  reapplyAppearance,
} from './terminalInstanceAppearance.js';
import { updateTabLabel } from './terminalInstanceLabel.js';
import {
  closeDynamicTerminal,
  createInstance,
  disposeAllInstances,
  initInstanceLifecycle,
  removeTerminalInstance,
  selectFallbackAfterClose,
  setStatus,
  shortCommandName,
  teardown,
} from './terminalInstanceLifecycle.js';
import { cacheHomeDir } from './terminalOsc7.js';
import {
  applyShellIntegrationToolbarVisibility,
  reapplyShellIntegrationDecorations,
} from './terminalShellIntegration.js';
import { initTabContextMenu } from './terminalTabContextMenu.js';
import { initTabDragDrop } from './terminalTabDragDrop.js';
import { clearTransientTerminalNames } from './terminalTransientNames.js';

export type { TerminalInstance,TerminalTabConfig } from './terminalInstance.js';

/** One-time DOM setup for the terminal area inside the drawer. Called from app init. */
export function initTerminal(): void {
  // HS-8396 Phase 3 — wire the tab drag-drop module's accessors before
  // any tab strip is rendered. The accessor pair lets the new module
  // read/write `lastKnownConfigs` without a circular import.
  initTabDragDrop({
    getLastKnownConfigs: () => terminalState.lastKnownConfigs,
    setLastKnownConfigs: (next) => { terminalState.lastKnownConfigs = next; },
  });
  // HS-8396 — wire the per-instance lifecycle module to this file's
  // `selectDrawerTab` glue (which lazy-imports `commandLog.js` to call
  // `switchDrawerTab`). The lifecycle module owns close-with-confirm +
  // post-close fallback selection; the drawer-tab switcher lives in
  // `commandLog.tsx`, so it's hooked in at init time.
  initInstanceLifecycle({
    selectDrawerTab,
    toggleDrawerFullHeight,
  });
  // HS-8396 Phase 4 — wire the tab context menu's accessors. Hooks point
  // back into the lifecycle helpers (now in `terminalInstanceLifecycle.tsx`).
  initTabContextMenu({
    getInstance: (id) => instances.get(id),
    closeDynamicTerminal,
    selectFallbackAfterClose,
  });
  // HS-8396 Phases 5+6 — wire the drawer xterm mount + control-message
  // dispatch module's hooks. The lifecycle helpers (`setStatus`,
  // `shortCommandName`) now live in `terminalInstanceLifecycle.tsx`;
  // `isTerminalTabActive` stays here (reads `terminalState.activeTerminalId`).
  initDrawerMount({
    setStatus,
    shortCommandName,
    isTerminalTabActive,
  });
  // Wire up the new + button that creates dynamic terminals.
  byIdOrNull('drawer-add-terminal-btn')?.addEventListener('click', () => { void createDynamicTerminal(); });
  // Keep in-drawer bell indicators in sync with bellPoll (HS-6603 §24.4.3).
  ensureBellSubscription();
  window.addEventListener('resize', () => {
    const active = terminalState.activeTerminalId === null ? null : instances.get(terminalState.activeTerminalId);
    // HS-8619 — only refit when the drawer pane currently owns the shared
    // term (top of the §54 checkout stack). While a Terminal Dashboard tile /
    // dedicated view borrows it, the drawer must not drive a fit that fights
    // the borrowing consumer's sizing.
    if (active !== null && active !== undefined && isTerminalTabActive(active)
        && active.checkout?.isTopOfStack() === true) doFit(active);
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
      // HS-8619 — same top-of-stack gate as the window-resize handler above:
      // a drawer-panel resize must not refit a terminal whose live xterm is
      // currently borrowed by a dashboard tile / dedicated view.
      if (active !== null && active !== undefined && isTerminalTabActive(active)
          && active.checkout?.isTopOfStack() === true) doFit(active);
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
  // HS-8624 — terminals now work in the browser too (the server already serves
  // any secret-authenticated client; only the UI was Tauri-gated). No platform
  // early-return: web + Tauri both mount the xterm/PTY panes. Tauri-specific
  // niceties (external-URL open, file dialogs) keep their own `getTauriInvoke()`
  // fallbacks at their callsites.

  reconcileProjectChange(getActiveProject()?.secret ?? null);

  let data: ListResponse;
  try {
    data = await listTerminals();
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
    void clearTerminalBell(id).catch(() => {});
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


/**
 * Called by the app when the active project has changed. Tears down the old
 * project's terminals on the next `loadAndRenderTerminalTabs()` and resets
 * the cached `terminalState.activeTerminalId` so the new project starts clean (HS-6309).
 */
export function onProjectSwitch(): void {
  disposeAllInstances();
  terminalState.currentProjectSecret = null;
  terminalState.lastKnownConfigs = { configured: [], dynamic: [] };
  // HS-9277 — transient terminal renames are session + project-scoped: a
  // project-tab switch restores configured names (HS-6668), so clear them here
  // (both the drawer tab strip and the dashboard read this shared store).
  clearTransientTerminalNames();
}

// --- Dynamic terminal lifecycle (HS-6306) ---

async function createDynamicTerminal(): Promise<void> {
  try {
    const { config } = await createTerminal();
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
    // HS-9274 — clicking "+" is an authoritative user tab choice: mark it so an
    // in-flight `applyPerProjectDrawerState` restore (boot / project switch) can't
    // clobber the new terminal's activation back to the saved/default tab.
    const { noteUserTabSwitch } = await import('./commandLog.js');
    noteUserTabSwitch();
    await selectDrawerTab(`terminal:${config.id}`);
  } catch { /* ignore */ }
}

/**
 * HS-8539 — open a NEW drawer terminal running the user's default shell and run
 * `command` in it (the server writes `command\n` to the PTY via `runCommand`, so
 * it executes as if typed and the shell stays open). Used by the long-press
 * "run in a new terminal" path on custom shell-command buttons, and by a normal
 * click when the command has "Launch in New Terminal" enabled. Opens the drawer
 * (if closed) and selects the new terminal's tab.
 */
export async function openTerminalRunningCommand(command: string, name?: string, cwd?: string): Promise<string> {
  // HS-8936 — `cwd` opens the terminal in a specific directory (a git worktree
  // root) so the injected command (e.g. `claude`) runs there and picks up that
  // worktree's `.mcp.json` → the shared owner Hot Sheet.
  const { config } = await createTerminal({ spawn: true, runCommand: command, name, cwd });
  const active = getActiveProject();
  if (active !== null) {
    const { hideNewTerminalInNonDefaultGroupings } = await import('./dashboardHiddenTerminals.js');
    hideNewTerminalInNonDefaultGroupings(active.secret, config.id);
  }
  await loadAndRenderTerminalTabs();
  const mod = await import('./commandLog.js');
  // HS-9274 — same as the "+" path: launching a command in a new terminal is a
  // user-initiated tab activation, so mark it authoritative against an in-flight
  // drawer-state restore.
  mod.noteUserTabSwitch();
  mod.openDrawerTab(`terminal:${config.id}`);
  // HS-8962 — returns the new terminal id so the worker-pool panel can register +
  // later close it on drain. Existing void-ignoring callers are unaffected.
  return config.id;
}

// Bridge to the drawer tab switcher implemented in commandLog.tsx.
async function selectDrawerTab(tabId: string): Promise<void> {
  const mod = await import('./commandLog.js');
  mod.switchDrawerTab(tabId);
}

// HS-8609 — bridge to the drawer height toggle in commandLog.tsx. Flips the
// drawer between normal and full height and persists the choice. Lazy-imported
// (like `selectDrawerTab`) to avoid a circular import.
function toggleDrawerFullHeight(): void {
  void import('./commandLog.js').then((mod) => {
    mod.setDrawerExpanded(!mod.isDrawerExpanded());
    void mod.saveDrawerState();
  });
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
  setTerminalState(freshTerminalModuleState());
  // HS-8312 — reset the drawer bindList wiring so the next test's
  // setupDom creates a fresh tabStrip / paneContainer that the
  // bindList re-binds to. Without this, the bindLists from a prior
  // test stay bound to a now-detached DOM and the next signal write
  // mutates nothing visible.
  drawerInstancesSignal.value = [];
  disposeDrawerBindLists();
}
