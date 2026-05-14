/**
 * Commands Log drawer-pane orchestration: panel open/close lifecycle,
 * polling timer, search debounce, drawer-tab switching, per-project
 * persistence, and the bindList mount against the entries container.
 *
 * Per HS-8385 the streaming-side helpers + per-entry row rendering live
 * in dedicated modules:
 * - `commandLogStreaming.ts` — `writePartialIntoPre`,
 *   `shouldAutoScrollToBottom`, `applyShellPartialEvent`.
 * - `commandLogEntryRow.tsx` — `renderEntryRow` + the context menu +
 *   `cancelingShellIds` + the pure formatting helpers.
 *
 * Their public surface is re-exported from here so existing importers
 * (including `commandLog.test.ts`) keep working without an import sweep.
 */

import { api } from './api.js';
import { cleanupCancelingShellIds, dismissContextMenu, renderEntryRow } from './commandLogEntryRow.js';
import { dismissFilterDropdown, showFilterDropdown } from './commandLogFilter.js';
import { commandLogSelectionStore } from './commandLogSelectionStore.js';
import {
  type AnnotatedEntry,
  commandLogStore,
  filteredEntriesSignal,
  getEntrySignals,
} from './commandLogStore.js';
import {
  applyShellPartialEvent,
  shouldAutoScrollToBottom,
  writePartialIntoPre,
} from './commandLogStreaming.js';
import { SHELL_PARTIAL_OUTPUT_EVENT, type ShellPartialOutputEvent } from './commandSidebar.js';
import { TIMERS } from './constants/timers.js';
import { byId, byIdOrNull } from './dom.js';
import { resolveDrawerTabForTauri } from './drawerTabGating.js';
import { recordInteraction } from './longTaskObserver.js';
import { bindList } from './reactive-bind.js';
import { getTauriInvoke } from './tauriIntegration.js';

// Re-export the streaming helpers so existing importers (and the
// `commandLog.test.ts` harness) keep their `from './commandLog.js'`
// shape after the HS-8385 split.
export { applyShellPartialEvent, shouldAutoScrollToBottom, writePartialIntoPre };

type LogEntry = AnnotatedEntry;

let panelOpen = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSeenId = 0;
/** HS-8318 — top-level bindList disposer + per-row effect cleanups for
 *  the Commands Log entries container. Mounted once per
 *  `#command-log-entries` lifetime via `mountEntriesBindList()` and torn
 *  down on test reset. */
let entriesBindListDispose: (() => void) | null = null;
/**
 * Active drawer tab id. `commands-log` selects the log pane; anything else is
 * interpreted as `terminal:<id>` and routed through the embedded terminal module.
 */
let activeTab: string = 'commands-log';

/** Read the id of the currently-visible drawer tab (`commands-log` or `terminal:<id>`). */
export function getActiveDrawerTab(): string {
  return activeTab;
}

/** Mount the bindList against the entries container. Idempotent —
 *  subsequent calls no-op once the bindList is wired up. Returns
 *  whether the bindList is mounted (false when the container isn't in
 *  the DOM yet). */
function mountEntriesBindList(): boolean {
  if (entriesBindListDispose !== null) return true;
  const container = byIdOrNull('command-log-entries');
  if (container === null) return false;
  container.innerHTML = '';
  entriesBindListDispose = bindList(
    container,
    filteredEntriesSignal,
    (entry) => entry.id,
    renderEntryRow,
  );
  return true;
}

/** **HS-8324 — TEST ONLY.** Mount the bindList against a hand-supplied
 *  container (creates `<div id="command-log-entries">` in `document.body`
 *  if missing). Returns true once mounted. Production paths go through
 *  `loadEntries` which calls `mountEntriesBindList()` after the container
 *  exists in the live DOM. */
export function _mountEntriesBindListForTesting(): boolean {
  return mountEntriesBindList();
}

/** **HS-8324 — TEST ONLY.** Tear down the bindList + its per-row
 *  effects so consecutive tests start with a clean slate. */
export function _unmountEntriesBindListForTesting(): void {
  if (entriesBindListDispose !== null) {
    try { entriesBindListDispose(); } catch { /* swallow */ }
    entriesBindListDispose = null;
  }
}

// --- Load entries from API ---

async function loadEntries() {
  let entries: { id: number; event_type: string; direction: string; summary: string; detail: string; created_at: string }[];
  let running: { ids: number[]; outputs?: Record<number, string> };
  try {
    const params = new URLSearchParams();
    params.set('limit', '100');
    const currentSearch = commandLogStore.state.value.filter.search;
    if (currentSearch !== '') params.set('search', currentSearch);

    // Fetch entries and running shell processes in parallel
    const [fetchedEntries, fetchedRunning] = await Promise.all([
      api<typeof entries>(`/command-log?${params.toString()}`),
      api<{ ids: number[]; outputs?: Record<number, string> }>('/shell/running').catch(() => ({ ids: [] as number[], outputs: {} as Record<number, string> })),
    ]);
    entries = fetchedEntries;
    running = fetchedRunning;
  } catch {
    // Don't clear the display on load errors — keep showing the last entries
    return;
  }

  // HS-8318 — feed the store. `setEntries` reconciles by id (per-entry
  // signals survive surviving ids), then `setRunningOutput` writes the
  // server-side `partialOutputs` snapshot into the per-entry partial
  // signals (only fires effects for entries whose output actually changed
  // since the last tick). The bindList view-layer re-renders only the
  // rows whose shape or partial signal moved.
  commandLogStore.actions.setEntries(entries, running.ids);
  if (running.outputs !== undefined) {
    for (const idStr of Object.keys(running.outputs)) {
      const idNum = Number(idStr);
      if (!Number.isFinite(idNum)) continue;
      const fromServer = running.outputs[idNum] ?? '';
      const sigs = getEntrySignals(idNum);
      const cached = sigs?.partial.value ?? '';
      // Use the longer of (cached, server) so a chunk that arrived via
      // the live `applyShellPartialEvent` between this tick's request
      // dispatch and its response doesn't get clobbered by the older
      // poll snapshot. Partial buffers are monotonic on the server, so
      // length is a safe proxy for "is newer".
      const next = fromServer.length >= cached.length ? fromServer : cached;
      if (next !== cached) commandLogStore.actions.setRunningOutput(idNum, next);
    }
  }
  // Drop ids whose process is no longer in the server-reported running
  // list (canceling-shell state cleanup — HS-8385: lives in
  // commandLogEntryRow.ts which owns the canceling Set).
  cleanupCancelingShellIds(running.ids);
  // Make sure the bindList is mounted now that the container is in the DOM.
  mountEntriesBindList();

  // Track latest seen ID for badge
  if (entries.length > 0 && entries[0].id > lastSeenId) {
    lastSeenId = entries[0].id;
  }
}

// --- Panel open/close ---

function updateToggleIcon(isOpen: boolean) {
  const btn = byIdOrNull('command-log-btn');
  if (!btn) return;
  btn.classList.toggle('is-open', isOpen);
  btn.setAttribute('title', isOpen ? 'Close drawer' : 'Commands Log');
}

/** Switch which drawer tab is visible. Both tab contents remain mounted.
 *  tab id is `commands-log` or `terminal:<terminalId>`. */
export function switchDrawerTab(tab: string) {
  tab = resolveDrawerTabForTauri(tab, getTauriInvoke() !== null);
  // HS-8054 — context for the longtask observer.
  recordInteraction(`drawer-tab:${tab}`);
  const changed = tab !== activeTab;
  activeTab = tab;
  // HS-6311 — clicking a drawer tab while in grid mode exits grid mode first
  // (mirrors §25.3 rule 3). Import is synchronous-ish here; safe because the
  // grid module doesn't import commandLog back (no cycle).
  void import('./drawerTerminalGrid.js').then(({ isDrawerGridActive, exitDrawerGridMode }) => {
    if (isDrawerGridActive()) exitDrawerGridMode();
  });
  for (const btn of document.querySelectorAll<HTMLElement>('.drawer-tab')) {
    btn.classList.toggle('active', btn.dataset.drawerTab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.drawer-tab-content')) {
    panel.style.display = panel.dataset.drawerPanel === tab ? '' : 'none';
  }
  if (tab === 'commands-log') {
    // Entering commands-log: refresh + mark as seen.
    updateBadge(false);
    void loadEntries();
  } else if (tab.startsWith('terminal:')) {
    const terminalId = tab.slice('terminal:'.length);
    void import('./terminal.js').then(({ activateTerminal }) => { activateTerminal(terminalId); });
  }
  if (changed) void saveDrawerState();
}

function openPanel() {
  const panel = byId('command-log-panel');
  panel.style.display = '';
  panelOpen = true;
  updateToggleIcon(true);
  startPolling();
  // Refresh the dynamic terminal tab list before restoring the active tab so
  // the previously-active terminal (if any) exists in the DOM before we
  // activate it.
  void import('./terminal.js').then(({ loadAndRenderTerminalTabs }) => loadAndRenderTerminalTabs())
    .finally(() => { switchDrawerTab(activeTab); });
  void saveDrawerState();
}

/**
 * Temporarily show a drawer tab and return a disposer that restores the prior
 * state. Used by Settings → Terminal delete flow (HS-6403) to reveal the
 * terminal the user is about to remove before the confirm appears.
 */
export function previewDrawerTab(tab: string): () => void {
  const prevOpen = panelOpen;
  const prevTab = activeTab;
  if (!panelOpen) openPanel();
  switchDrawerTab(tab);
  return () => {
    if (!prevOpen) {
      closePanel();
    } else if (prevTab !== tab) {
      switchDrawerTab(prevTab);
    }
  };
}

/** Refresh the command log contents (e.g., after switching projects). */
export function refreshCommandLog() {
  const panel = byIdOrNull('command-log-panel');
  if (panel && panel.style.display !== 'none') {
    void loadEntries();
  }
  void refreshLogBadge();
}

// --- Per-project drawer state persistence (HS-6309) ---
//
// The open/closed state of the drawer and the id of the active tab are stored
// in file-settings under `drawer_open` and `drawer_active_tab`. Both are
// project-scoped so switching projects restores whatever the user last had
// in view for that project (including which terminal tab was focused).

/** True while applyPerProjectDrawerState is restoring state — prevents feedback loops. */
let suspendSave = false;

async function saveDrawerState(): Promise<void> {
  if (suspendSave) return;
  try {
    await api('/file-settings', {
      method: 'PATCH',
      body: {
        drawer_open: panelOpen ? 'true' : 'false',
        drawer_active_tab: activeTab,
        drawer_expanded: isDrawerExpanded() ? 'true' : 'false',
      },
    });
  } catch { /* ignore — the user will open the drawer themselves next time */ }
}

// HS-6312: full-height drawer toggle. `.app.drawer-expanded` hides the ticket
// area so the drawer claims everything below the header. Persisted per-project
// alongside the existing drawer_open / drawer_active_tab keys.

/** HS-7660 — exposed so the drawer-grid module's enlarge / shrink callbacks
 *  can save the drawer's pre-enlarge expanded state. */
export function isDrawerExpanded(): boolean {
  return document.querySelector('.app')?.classList.contains('drawer-expanded') === true;
}

/** HS-7660 — exposed so the drawer-grid module can force the drawer to full
 *  height when a tile is centered / opened in dedicated view, then restore on
 *  shrink. The expand button + slider visibility flips alongside the class
 *  via the existing CSS rules. */
export function setDrawerExpanded(expanded: boolean): void {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('drawer-expanded', expanded);
  const btn = byIdOrNull('drawer-expand-btn');
  if (btn !== null) {
    btn.title = expanded ? 'Restore tickets view' : 'Expand drawer to full height';
    const up = btn.querySelector<HTMLElement>('.drawer-expand-icon-up');
    const down = btn.querySelector<HTMLElement>('.drawer-expand-icon-down');
    if (up !== null) up.style.display = expanded ? 'none' : '';
    if (down !== null) down.style.display = expanded ? '' : 'none';
  }
}

function toggleDrawerExpanded(): void {
  const next = !isDrawerExpanded();
  // Expanding makes no sense unless the drawer is visible; open it first.
  if (next && !panelOpen) openPanel();
  setDrawerExpanded(next);
  void saveDrawerState();
}

/**
 * Called by the app on project switch (see app.tsx `reloadAppState`). Tears down
 * the old project's terminal instances, reloads the new project's terminal tabs,
 * then applies the saved drawer state (visibility + active tab).
 */
export async function applyPerProjectDrawerState(): Promise<void> {
  const { onProjectSwitch, loadAndRenderTerminalTabs } = await import('./terminal.js');
  onProjectSwitch();

  let fs: { drawer_open?: string | boolean; drawer_active_tab?: string; drawer_expanded?: string | boolean };
  try {
    fs = await api<{ drawer_open?: string | boolean; drawer_active_tab?: string; drawer_expanded?: string | boolean }>('/file-settings');
  } catch {
    fs = {};
  }
  const wantOpen = fs.drawer_open === true || fs.drawer_open === 'true';
  const wantExpanded = fs.drawer_expanded === true || fs.drawer_expanded === 'true';
  const savedTab = typeof fs.drawer_active_tab === 'string' && fs.drawer_active_tab !== ''
    ? fs.drawer_active_tab
    : 'commands-log';

  suspendSave = true;
  try {
    // Close the panel first so the subsequent open (or no-op close) lands in a
    // predictable state regardless of where we came from. Also collapse the
    // expand state before reapplying so we never leave a stale full-height
    // layout from the previous project.
    if (panelOpen) closePanel();
    setDrawerExpanded(false);

    // Rebuild tabs from the new project before choosing the active tab so we
    // can check whether the saved terminal:<id> still exists.
    await loadAndRenderTerminalTabs();

    const exists = savedTab === 'commands-log'
      || document.querySelector(`.drawer-tab[data-drawer-tab="${CSS.escape(savedTab)}"]`) !== null;
    activeTab = exists ? savedTab : 'commands-log';

    if (wantOpen) openPanel(); // this will honor the pre-set activeTab
    if (wantOpen && wantExpanded) setDrawerExpanded(true);
  } finally {
    suspendSave = false;
  }
}

export function showLogEntryById(logId: number) {
  if (!panelOpen) openPanel();
  // The drawer may currently be on a terminal tab — the user opted into "Show
  // log on completion" precisely to see the entry, so switch to commands-log
  // so it's actually visible (HS-6636).
  if (activeTab !== 'commands-log') switchDrawerTab('commands-log');
  // Wait for entries to load, then scroll to and expand the entry
  setTimeout(() => {
    const entry = document.querySelector<HTMLElement>(`.command-log-entry[data-id="${logId}"]`);
    if (entry !== null) {
      entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Auto-expand if not already. HS-8324 — go through the store so
      // the per-row expansion effect picks it up rather than firing the
      // click handler (which would also toggle selection).
      commandLogSelectionStore.actions.setExpanded(logId, true);
      // Highlight: selecting also pins the range anchor.
      commandLogSelectionStore.actions.selectOnly(logId);
    }
  }, 500);
}

function closePanel() {
  const panel = byId('command-log-panel');
  panel.style.display = 'none';
  panelOpen = false;
  // A collapsed drawer cannot be "expanded" in any meaningful sense — clear
  // the flag so reopening starts in the saved/default non-expanded layout
  // unless the user explicitly re-expands it.
  setDrawerExpanded(false);
  updateToggleIcon(false);
  stopPolling();
  dismissContextMenu();
  dismissFilterDropdown();
  void saveDrawerState();
}

function togglePanel() {
  if (panelOpen) {
    closePanel();
  } else {
    openPanel();
  }
}

// --- Polling ---

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (panelOpen) void loadEntries();
  }, TIMERS.COMMAND_LOG_REFRESH_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Badge ---

function updateBadge(hasNew: boolean) {
  const badge = byIdOrNull('command-log-badge');
  if (!badge) return;
  badge.style.display = hasNew ? '' : 'none';
}

/** Refresh the unread count badge. Call after channel events. */
export async function refreshLogBadge() {
  if (panelOpen) return; // No badge when panel is open
  try {
    if (lastSeenId === 0) {
      // First load: set baseline without showing badge
      const entries = await api<LogEntry[]>('/command-log?limit=1');
      if (entries.length > 0) lastSeenId = entries[0].id;
      return;
    }
    // We approximate unread by total count vs. a stored count.
    // For simplicity, just show total count if there are new entries.
    const entries = await api<LogEntry[]>('/command-log?limit=1');
    if (entries.length > 0 && entries[0].id > lastSeenId) {
      updateBadge(true);
    }
  } catch { /* ignore */ }
}

// --- Resize handle ---

function initResize() {
  const handle = byId('command-log-resize');
  const panel = byId('command-log-panel');
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    startY = e.clientY;
    startHeight = panel.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = e.clientY - startY;
    const newHeight = Math.max(150, Math.min(600, startHeight - delta));
    panel.style.height = `${newHeight}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// --- Search debounce ---

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

function onSearchInput(value: string) {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    commandLogStore.actions.setFilterSearch(value);
    void loadEntries();
  }, 300);
}

// --- Clear log ---

async function clearLogEntries() {
  await api('/command-log', { method: 'DELETE' });
  commandLogSelectionStore.actions.clearSelected();
  void loadEntries();
}


// --- Init ---

/** Initialize the command log panel. Call from app.tsx init(). */
export function initCommandLog() {
  // Button click — toggles drawer open/closed
  byIdOrNull('command-log-btn')?.addEventListener('click', togglePanel);

  // HS-7983 — module-level subscription to the streaming-shell-output
  // event. Delegated to `applyShellPartialEvent` (now in
  // `commandLogStreaming.ts`) so the listener wire-up is one line and
  // the DOM-mutation logic stays unit-testable in happy-dom without
  // bootstrapping the full drawer.
  window.addEventListener(SHELL_PARTIAL_OUTPUT_EVENT, (e: Event) => {
    applyShellPartialEvent((e as CustomEvent<ShellPartialOutputEvent>).detail);
  });

  // HS-6312: expand drawer to full height (hides ticket area).
  byIdOrNull('drawer-expand-btn')?.addEventListener('click', toggleDrawerExpanded);

  // Clear button
  byIdOrNull('command-log-clear')?.addEventListener('click', () => { void clearLogEntries(); });

  // Filter button (HS-2550). HS-8318 — the dropdown's `onFilterChange`
  // is now a no-op because `commandLogFilter`'s toggle handlers write
  // directly into `commandLogStore.actions.setFilterTypes`, which fires
  // the `filteredEntriesSignal` and re-renders via bindList. The
  // dropdown still calls the callback for back-compat, but there's no
  // imperative `renderEntries` left to call.
  byIdOrNull('command-log-filter-btn')?.addEventListener('click', () => { showFilterDropdown(() => { /* bindList covers it */ }); });

  // Search input
  const searchEl = byIdOrNull<HTMLInputElement>('command-log-search');
  searchEl?.addEventListener('input', () => { onSearchInput(searchEl.value); });

  // Drawer tab switching — supports `commands-log` and dynamic `terminal:<id>` ids.
  byIdOrNull('command-log-panel')?.addEventListener('click', (e) => {
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>('.drawer-tab');
    if (!tabEl) return;
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;  // close button handled by terminal module
    const t = tabEl.dataset.drawerTab;
    if (typeof t === 'string' && t !== '') switchDrawerTab(t);
  });

  // Resize handle
  initResize();

  // Initialize badge baseline
  void refreshLogBadge();

  // Drawer init must be sequential: visibility first (shows the terminal tabs
  // wrap container so subsequent renders land in a visible parent), then the
  // per-project drawer state (which spawns/teardowns terminal instances + picks
  // the active tab). Running these in parallel raced loadAndRenderTerminalTabs
  // calls against each other, sometimes leaving the tab strip empty (HS-6342).
  void (async () => {
    await applyTerminalTabVisibility();
    await applyPerProjectDrawerState();
  })();
}

/**
 * Show or hide the terminal tab strip. Gating is Tauri-only (HS-6437,
 * HS-6337) — there is no per-user toggle anymore, the feature is simply on
 * when the desktop app is running and off when a plain browser connects.
 * Exported so settings can refresh the terminal strip after the user edits
 * the configured list.
 */
export async function applyTerminalTabVisibility() {
  try {
    const enabled = getTauriInvoke() !== null;
    const tabsContainer = byIdOrNull('drawer-terminal-tabs-wrap');
    if (tabsContainer) tabsContainer.style.display = enabled ? '' : 'none';
    // HS-6475: hide the divider alongside the terminal tab strip so it doesn't
    // dangle next to a lone Commands Log icon when terminals are unavailable.
    const divider = document.querySelector<HTMLElement>('.drawer-tabs-divider');
    if (divider) divider.style.display = enabled ? '' : 'none';
    if (!enabled && activeTab.startsWith('terminal:')) switchDrawerTab('commands-log');
    if (enabled) {
      const mod = await import('./terminal.js');
      await mod.loadAndRenderTerminalTabs();
    }
  } catch { /* ignore */ }
}
