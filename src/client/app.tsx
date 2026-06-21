import { setApiTransport, setApiUploadTransport } from '../api/_runner.js';
import { createTicket, getGitStatus, getGlassboxStatus, launchGlassbox, updateSettings, uploadAttachment } from '../api/index.js';
import { PLUGINS_ENABLED } from '../feature-flags.js';
import { maybeShowAiInstructionsNudge } from './aiInstructionsNudge.js';
import { flashAnchoredHint } from './anchoredHint.js';
import { suppressAnimation } from './animate.js';
import { initAnnouncer, refreshAnnouncerVisibility } from './announcer.js';
import { bindAnnouncerSettings } from './announcerSettings.js';
import { api, apiUpload, apiWithSecret } from './api.js';
import { bindBackupsUI } from './backups.js';
import { bindBatchToolbar } from './batch.js';
import { startBellPolling } from './bellPoll.js';
import { channelAutoTrigger, initChannel } from './channelUI.js';
import { initSkillsBanner } from './clipboardUtil.js';
import { applyPerProjectDrawerState, initCommandLog, refreshCommandLog } from './commandLog.js';
import { initCustomViews, loadCustomViews } from './customViews.js';
import { initDashboardWidget, refreshDashboardWidget, restoreTicketList } from './dashboardMode.js';
import { initDbRecoveryBanner } from './dbRecoveryBanner.js';
import { closeDetail, initResize, refreshDetail, selectAndOpenDetail } from './detail.js';
// HS-8553 — `bindDetailPanel` + the position-toggle pair moved to
// `./detailBindings/` so app.tsx isn't carrying 16 sibling top-level
// functions.
import { bindDetailPanel } from './detailBindings/panel.js';
import { bindDetailPositionToggle, updateDetailPositionToggle } from './detailBindings/positionToggle.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { initDrawerTerminalGrid } from './drawerTerminalGrid.js';
import { initGitStatusChip, refreshGitStatusChip } from './gitStatusChip.js';
import { hasGlassboxReviewableChanges } from './glassboxReview.js';
import { loadGlobalDiagnostics } from './globalDiagnostics.js';
import { initLongTaskObserver } from './longTaskObserver.js';
import { bindOpenFolder } from './openFolder.js';
import { bindPasteAttachmentListener } from './pasteAttachments.js';
import { startLongPoll } from './poll.js';
import { showPrintDialog } from './print.js';
import { initProjectTabs, setProjectReloadCallback } from './projectTabs.js';
import { initQuitConfirm } from './quitConfirm.js';
import { applyScrollbarPrefClass } from './scrollbarPref.js';
import { bindSettingsDialog } from './settingsDialog.js';
import { loadAppName, loadCategories, loadSettings, rebuildCategoryUI, setRestoreTicketListCallback } from './settingsLoader.js';
import { initShare } from './share.js';
import { bindKeyboardShortcuts } from './shortcuts.js';
import { bindSearchInput, bindSidebar, bindSortControls, syncSearchInputFromState, syncSidebarActiveState } from './sidebar.js';
import { refreshAllKnownTags, state } from './state.js';
import { showTagsDialog } from './tagsDialog.js';
import { bindExternalLinkHandler, checkForUpdate, requestNativeNotificationPermission, restoreAppIcon } from './tauriIntegration.js';
import { loadTelemetryCostMode } from './telemetryCostMode.js';
import { initTerminal } from './terminal.js';
import { initTerminalDashboard } from './terminalDashboard.js';
import { loadTerminalWebglOptOut } from './terminalWebgl.js';
import { canUseColumnView, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { bindTicketRefGlobalClickHandler } from './ticketRefDialog.js';
import { loadTicketPrefixes, reloadTicketPrefixes } from './ticketRefs.js';
import { maybeShowUpgradeNudge } from './upgradeNudge.js';

// Wire up the restoreTicketList callback used by settingsLoader's category buttons
setRestoreTicketListCallback(restoreTicketList);

/** Reload all app state — used after project switch and during init. */
async function reloadPluginToolbar() {
  if (!PLUGINS_ENABLED) return;
  const { refreshPluginUI, renderPluginToolbarButtons } = await import('./pluginUI.js');
  // refreshPluginUI reloads from API and re-renders toolbar, status_bar, sidebar
  await refreshPluginUI();
  // Ensure the toolbar container exists in the DOM
  if (!document.querySelector('.plugin-toolbar-container')) {
    const glassboxBtn = byIdOrNull('glassbox-btn');
    const toolbarTarget = glassboxBtn?.parentElement;
    if (toolbarTarget) {
      const container = toElement(<span className="plugin-toolbar-container"></span>);
      toolbarTarget.insertBefore(container, glassboxBtn);
      renderPluginToolbarButtons(container);
    }
  }
}

async function reloadAppState() {
  await loadSettings();
  // HS-8053 — drop the ticket-prefix cache and re-fetch for the new
  // project. Pre-fix `loadTicketPrefixes()` was only called at app init,
  // so a project with a non-`HS` prefix (e.g. Domotion's `DM`) never
  // got its prefixes picked up — `DM-123` references never linkified
  // when the user switched to Domotion mid-session.
  //
  // HS-8062 — chain `refreshDetail()` so any active detail panel
  // re-renders with the new prefix set and the `.ticket-ref` anchors
  // appear / update for the new project's references.
  void reloadTicketPrefixes().then(() => refreshDetail()).catch(() => { /* swallow — covered by reloadTicketPrefixes fallback */ });
  // Sync toggle button UI to the new project's saved settings
  updateLayoutToggle();
  updateDetailPositionToggle();
  await loadCategories(rebuildCategoryUI);
  await loadCustomViews();
  // HS-8737 / HS-8738 — re-seed the shared known-tag cache for the new project
  // so the detail-panel tag autocomplete + custom-view tag filter don't keep
  // showing the previous project's tags after a switch.
  void refreshAllKnownTags();
  // If the restored view is a custom view that doesn't exist in this project, fall back to 'all'
  if (state.view.startsWith('custom:')) {
    const viewId = state.view.slice(7);
    if (!state.customViews.some(v => v.id === viewId)) {
      state.view = 'all';
    }
  }
  // Sync sidebar highlight to the restored per-project view
  syncSidebarActiveState();
  // HS-7360 — restore the per-project search into the header input so the
  // visible text matches the saved state.search for the new active project.
  // setActiveProject() already repopulated state.search from the projectSearches
  // map; this writes that back into the DOM input and toggles `.has-value`.
  syncSearchInputFromState();
  loadAppName();
  suppressAnimation();
  await loadTickets();
  // HS-7993 — refresh the sidebar git chip on every project switch. Without
  // this, the chip stayed showing the previous project's branch / dirty
  // count until the next poll-version bump (which only fires when SOMETHING
  // mutates server-side) or a window.focus event. The chip itself swaps to
  // the cached value for the new project synchronously and uses this
  // refresh to freshen the cache.
  refreshGitStatusChip();
  // Refresh command log for the new project context
  refreshCommandLog();
  // Tear down the old project's terminals, rebuild for the new project, and
  // restore its saved drawer visibility + active tab (HS-6309).
  void applyPerProjectDrawerState();
  // Refresh sidebar stats widget for the new project
  void refreshDashboardWidget();
  // Re-init channel for the new project context
  void initChannel();
  // Reload plugin UI for the new project
  void reloadPluginToolbar();
  // HS-8758 / §78 — the announcer is cross-project now: it keeps playing across
  // project switches (no teardown here). Just re-evaluate the Listen button
  // (its any-project-enabled gate is unaffected by the switch, but the active
  // project changing can flip the default context for the *next* launch).
  void refreshAnnouncerVisibility();
}

async function loadInitialState(): Promise<void> {
  await initProjectTabs();
  setProjectReloadCallback(async () => {
    closeDetail();
    restoreTicketList(); // Exit dashboard mode if active
    await reloadAppState();
  });
  await loadSettings();
  // HS-8446 — hydrate the global diagnostics flag before the
  // slow-server banner gate (`serverBusyChip.setBannerVisible`) and the
  // longtask toast gate first evaluate. Fire-and-forget — both gates
  // default to "diagnostics off" until the load resolves, which matches
  // the intended default-off behavior. Failures leave the cached value
  // at `false`, which is the safe default.
  void loadGlobalDiagnostics();
  // HS-8488 — hydrate the "use software rendering" opt-out into the cache so
  // `createEntry` makes the right WebGL/DOM renderer decision on the first
  // terminal mount. Fire-and-forget; default cached value `false` (WebGL on)
  // is the happy path until the load resolves.
  void loadTerminalWebglOptOut();
  // HS-8497 — load the telemetry billing mode synchronously into the
  // cache so the per-tab cost chip + the drawer + the dashboard make
  // the right hide/annotate decision on first paint. Fire-and-forget;
  // the default cached value `'api'` is what we want until the load
  // resolves, which matches the no-subscription happy path.
  void loadTelemetryCostMode();
  // HS-8754 — hydrate the Announcer playback-speed cache so the TTS path + both
  // speed selectors reflect the saved rate on first use. Default 1× until loaded.
  void import('./announcerSpeechRate.js').then(({ loadAnnouncerSpeechRate }) => loadAnnouncerSpeechRate());
  // HS-8781 — hydrate the "announce permission checks" cache so the permission
  // popup path reads it synchronously. Default ON until loaded.
  void import('./announcerPermissionPref.js').then(({ loadAnnouncerSpeakPermissions }) => loadAnnouncerSpeakPermissions());
  await loadCategories(rebuildCategoryUI);
  await loadCustomViews();
  loadAppName();
  suppressAnimation();
  await loadTickets();
}

function bindAllUiHandlers(): void {
  bindSidebar(restoreTicketList, updateLayoutToggle);
  bindLayoutToggle();
  bindDetailPositionToggle();
  bindSortControls();
  bindSearchInput();
  bindBatchToolbar(() => showTagsDialog());
  bindDetailPanel();
  bindKeyboardShortcuts();
  bindSettingsDialog(rebuildCategoryUI);
  bindBackupsUI();
  // HS-7899: surface the launch-time DB-recovery banner once the backups UI
  // is wired (the banner's "Restore from backup" opens Settings → Backups).
  void initDbRecoveryBanner();
  initSkillsBanner();
  bindOpenFolder();
  // HS-7954 — wire the sidebar git status chip. Initial fetch happens
  // immediately; subsequent refetches driven by `/api/poll` + `window.focus`.
  initGitStatusChip();
  // HS-8147 — wire the per-project tab cost chip refresh loop.
  // Subscribes to the bell-state long-poll so chip refreshes piggyback
  // on the existing cadence (§67.10.1).
  void import('./costPoll.js').then(({ initCostPoll }) => { initCostPoll(); });
  // HS-8507 / §70.2 — install the cross-project stats header button's
  // click handler + run the visibility gate. The button appears only
  // when at least one project has telemetry_enabled === true; the
  // settings dialog's master toggle also re-fetches after a PATCH.
  void import('./crossProjectStatsButton.js').then(({ initTelemetrySidebar }) => { initTelemetrySidebar(); });
  // HS-8036 — load the project's known ticket-number prefixes; HS-8062 —
  // refresh detail after resolution so pre-cache markdown re-linkifies.
  void loadTicketPrefixes().then(() => refreshDetail()).catch(() => { /* swallow */ });
  bindTicketRefGlobalClickHandler();
  // HS-7962 — non-Tauri throttled upgrade nudge. Skips under Tauri.
  maybeShowUpgradeNudge();
  // HS-8913 — once-per-project nudge to install Hot Sheet's recommended
  // AI-assistant instruction sections into CLAUDE.md (silently auto-updates
  // already-installed sections that are behind the current version).
  maybeShowAiInstructionsNudge();
  void reloadPluginToolbar();
  bindGlassbox();
  initCustomViews(() => { void loadTickets(); });
  initResize();
  // HS-8747 / §78 — wire the header Listen button + the Announcer settings
  // section. The settings binding refreshes the Listen button's visibility
  // after an opt-in / key change.
  initAnnouncer();
  bindAnnouncerSettings(() => { void refreshAnnouncerVisibility(); });
}

function bindAppLevelDocumentListeners(): void {
  // Permanent listeners — bound once and never removed (SPA lifecycle).
  // Clicking empty space in the ticket list deselects all (HS-2114).
  byId('ticket-list').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.ticket-row') && !target.closest('.column-card') && !target.closest('.column-header') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
    }
  });
  document.addEventListener('hotsheet:render', () => renderTicketList());
  document.addEventListener('hotsheet:show-tags-dialog', () => { void showTagsDialog(); });
  document.addEventListener('hotsheet:upnext-changed', () => channelAutoTrigger());
  byIdOrNull('print-btn')?.addEventListener('click', showPrintDialog);
}

/** HS-7492 — file-drop handling: row/card target wins over selection.
 *  While dragging, the row/card under the cursor gets `.file-drop-target`;
 *  cleared on dragleave/drop/dragend. */
function bindFileDropListeners(): void {
  let lastFileDropRow: HTMLElement | null = null;
  const setFileDropRow = (row: HTMLElement | null): void => {
    if (lastFileDropRow === row) return;
    lastFileDropRow?.classList.remove('file-drop-target');
    row?.classList.add('file-drop-target');
    lastFileDropRow = row;
  };
  const findRowUnder = (el: HTMLElement): HTMLElement | null => {
    // `.trash-row` excluded — attachments on trashed tickets would be
    // silently dropped by the next auto-cleanup sweep.
    return el.closest<HTMLElement>('.ticket-row[data-id]:not(.trash-row), .column-card[data-id]');
  };
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    const types = e.dataTransfer?.types;
    if (types?.includes('Files') !== true) return;
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    setFileDropRow(findRowUnder(target));
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) setFileDropRow(null);
  });
  document.addEventListener('dragend', () => { setFileDropRow(null); });
  document.addEventListener('drop', async (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.detail-body') || target.closest('.custom-view-editor-overlay') || target.closest('.feedback-dialog-overlay')) return;
    e.preventDefault();
    setFileDropRow(null);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const { id: ticketId, createdNew } = await resolveDropTicketId(target, findRowUnder);
    for (const file of Array.from(files)) {
      await uploadAttachment(ticketId, file);
    }
    // HS-8742 — when the drop created a fresh "Attachment" ticket (no row under
    // the cursor, no single selection), select + open it so the user lands on
    // it ready to retitle and see the attached files. Mirrors the paste flow.
    if (createdNew) selectAndOpenDetail(ticketId);
    void loadTickets();
  });
}

async function resolveDropTicketId(
  target: HTMLElement,
  findRowUnder: (el: HTMLElement) => HTMLElement | null,
): Promise<{ id: number; createdNew: boolean }> {
  // Row/card drop target takes precedence over selection — a user dropping
  // a file on a specific ticket obviously intends to attach to that ticket.
  const rowEl = findRowUnder(target);
  const rowId = rowEl?.dataset.id;
  if (rowId !== undefined && rowId !== '') return { id: parseInt(rowId, 10), createdNew: false };
  if (state.selectedIds.size === 1) return { id: Array.from(state.selectedIds)[0], createdNew: false };
  // Create a new ticket — use draft input text if available.
  const draftInput = document.querySelector<HTMLInputElement>('.draft-input');
  const title = draftInput?.value.trim() ?? '';
  const res = await createTicket({ title: title || 'Attachment' });
  if (draftInput && title !== '') draftInput.value = '';
  void loadTickets();
  return { id: res.id, createdNew: true };
}

function initDrawerAndDashboard(): void {
  initCommandLog();
  initTerminal();
  initTerminalDashboard();
  // HS-6311 — drawer terminal grid (§36). onExitGrid re-reveals the active
  // drawer-tab content (showGridChrome had set every .drawer-tab-content to
  // display:none).
  initDrawerTerminalGrid({
    onExitGrid: () => {
      const activeBtn = document.querySelector<HTMLElement>('.drawer-tab.active');
      const tab = activeBtn?.dataset.drawerTab ?? 'commands-log';
      void import('./commandLog.js').then(({ switchDrawerTab }) => { switchDrawerTab(tab); });
    },
  });
  // HS-7596 / §37 — quit-confirm. Tauri-only.
  initQuitConfirm();
  // Cross-project bell long-poll (HS-6603 §24.4.1).
  startBellPolling();
  // HS-7272 — prime Tauri notification permission once.
  void requestNativeNotificationPermission();
  void initDashboardWidget();
  initShare();
}

async function init() {
  try {
    // HS-8522 — wire the typed API layer (`src/api/*`, `apis.*`) to the
    // client `api()` runtime before any typed caller can run. Routes through
    // `apiWithSecret` for cross-project calls (`opts.secret`) and `api`
    // otherwise, so the typed layer inherits project scoping, secret headers,
    // the server-busy chip, and the network-error popup. `_runner.ts` stays
    // free of client-only imports so server route files can import schemas
    // from `src/api/*` without pulling the DOM runtime into the Node bundle.
    setApiTransport((path, opts) =>
      opts.secret !== undefined
        ? apiWithSecret(path, opts.secret, { method: opts.method, body: opts.body })
        : api(path, { method: opts.method, body: opts.body, skipProjectScope: opts.skipProjectScope }),
    );
    // HS-8633 — multipart uploads route through their own transport (FormData,
    // no JSON Content-Type) so `_runner` stays server-safe + JSON-only.
    setApiUploadTransport((path, file) => apiUpload(path, file));

    // HS-8054 — start the longtask observer first so any hangs during init
    // itself get logged. `[hotsheet longtask]` prefix; in-memory buffer via
    // `window.__hotsheetGetLongTasks()`.
    initLongTaskObserver();

    // HS-8494 — detect whether the OS reserves space for scrollbars
    // (macOS "Always show scroll bars" + Linux/Windows defaults) and
    // tag the body so the otherwise-suppressed horizontal tab strips
    // can reveal a minimal iOS-style thumb. Synchronous, cheap, runs
    // once per app boot.
    applyScrollbarPrefClass();

    await loadInitialState();
    bindAllUiHandlers();

    startLongPoll();
    void checkForUpdate();
    bindAppLevelDocumentListeners();

    // Restore saved app icon variant in Tauri (Dock resets on launch).
    void restoreAppIcon();
    bindExternalLinkHandler();
    void initChannel();

    bindFileDropListeners();
    bindPasteAttachmentListener();
    initDrawerAndDashboard();

    // Auto-focus the draft input on load.
    focusDraftInput();
  } catch (err) {
    console.error('Hot Sheet init failed:', err);
    const el = byIdOrNull('ticket-list');
    if (el) el.replaceChildren(toElement(<div style="padding:20px;color:red">Init error: {String(err)}</div>));
  }
}

// --- Glassbox integration ---

function bindGlassbox() {
  const btn = byId<HTMLButtonElement>('glassbox-btn');
  const icon = byId<HTMLImageElement>('glassbox-icon');

  void getGlassboxStatus().then(({ available }) => {
    if (!available) return;
    icon.src = '/static/assets/glassbox-icon.png';
    btn.style.display = '';
  }).catch(() => { /* ignore */ });

  btn.addEventListener('click', () => {
    void (async () => {
      // HS-8784 — if there's nothing pending, say so clearly instead of opening
      // Glassbox to an empty review (which read as "the button did nothing").
      // The confirmation is anchored to the button itself (not a bottom-center
      // toast) — the user reported missing the toast entirely since it appeared
      // far from where they clicked. A failed status probe falls through and
      // launches as before.
      try {
        if (!hasGlassboxReviewableChanges(await getGitStatus())) {
          flashAnchoredHint(btn, 'No pending changes for Glassbox to review.');
          return;
        }
      } catch { /* status probe failed — don't block the launch */ }
      // HS-8786 — surface a launch failure instead of silently doing nothing
      // (the old fire-and-forget swallowed the 404/500 from the launch route).
      try {
        await launchGlassbox();
      } catch {
        flashAnchoredHint(btn, 'Could not open Glassbox. Make sure the Glassbox CLI is installed.');
      }
    })();
  });
}

// --- Layout toggle ---

function updateLayoutToggle() {
  const toggle = byId('layout-toggle');
  const canColumn = canUseColumnView();
  const columnsBtn = toggle.querySelector('[data-layout="columns"]') as HTMLButtonElement;
  columnsBtn.disabled = !canColumn;
  columnsBtn.style.opacity = canColumn ? '' : '0.3';

  // Show effective layout: list when columns unavailable, otherwise user preference
  const effectiveLayout = (state.layout === 'columns' && !canColumn) ? 'list' : state.layout;
  toggle.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.layout === effectiveLayout);
  });
}

function bindLayoutToggle() {
  const toggle = byId('layout-toggle');
  toggle.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const layout = (btn as HTMLElement).dataset.layout as 'list' | 'columns';
      if (layout === 'columns' && !canUseColumnView()) return;
      // HS-7756 — manually switching to columns while the include rows
      // are toggled on means "restart the search" per the spec: clear
      // the include flags + reload so column view can render the
      // active-only result set. The search itself stays active and the
      // include rows will re-render so the user can re-toggle.
      const wasIncluding = state.includeBacklogInSearch || state.includeArchiveInSearch;
      const needsReload = layout === 'columns' && wasIncluding;
      if (needsReload) {
        void import('./searchExtraRows.js').then(m => m.clearIncludeFlagsOnly());
      }
      state.layout = layout;
      suppressAnimation();
      updateLayoutToggle();
      if (needsReload) void loadTickets();
      else renderTicketList();
      void updateSettings({ layout });
    });
  });
  updateLayoutToggle();
}


void init();
