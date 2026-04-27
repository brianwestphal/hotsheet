import { PLUGINS_ENABLED } from '../feature-flags.js';
import { suppressAnimation } from './animate.js';
import { api, apiUpload } from './api.js';
import { bindBackupsUI } from './backups.js';
import { bindBatchToolbar } from './batch.js';
import { startBellPolling } from './bellPoll.js';
import { channelAutoTrigger, initChannel } from './channelUI.js';
import { bindCopyPrompt } from './clipboardUtil.js';
import { applyPerProjectDrawerState, initCommandLog, refreshCommandLog } from './commandLog.js';
import { TIMERS } from './constants/timers.js';
import { initCustomViews, loadCustomViews } from './customViews.js';
import { initDashboardWidget, refreshDashboardWidget, restoreTicketList } from './dashboardMode.js';
import { initDbRecoveryBanner } from './dbRecoveryBanner.js';
import { applyDetailPosition, applyDetailSize, closeDetail, initResize, openDetail, openDetailAndFocusNote, updateDetailCategory, updateDetailPriority, updateDetailStatus } from './detail.js';
import { toElement } from './dom.js';
import { initDrawerTerminalGrid } from './drawerTerminalGrid.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { bindOpenFolder } from './openFolder.js';
import { startLongPoll } from './poll.js';
import { showPrintDialog } from './print.js';
import { initProjectTabs, setProjectReloadCallback } from './projectTabs.js';
import { initQuitConfirm } from './quitConfirm.js';
import { bindSettingsDialog } from './settingsDialog.js';
import { loadAppName, loadCategories, loadSettings, rebuildCategoryUI, setRestoreTicketListCallback } from './settingsLoader.js';
import { initShare } from './share.js';
import { bindKeyboardShortcuts, getDetailSaveTimeout, setDetailSaveTimeout } from './shortcuts.js';
import { bindSearchInput, bindSidebar, bindSortControls, syncSearchInputFromState, syncSidebarActiveState } from './sidebar.js';
import type { AppSettings, Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, state, STATUS_ITEMS } from './state.js';
import { bindDetailTagInput } from './tagAutocomplete.js'; // .tsx file, JSX enabled
import { showTagsDialog } from './tagsDialog.js';
import { bindExternalLinkHandler, checkForUpdate, getTauriInvoke, requestNativeNotificationPermission, restoreAppIcon } from './tauriIntegration.js';
import { initTerminal } from './terminal.js';
import { initTerminalDashboard } from './terminalDashboard.js';
import { canUseColumnView, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { pushNotesUndo, recordTextChange, trackedPatch } from './undo/actions.js';

// Wire up the restoreTicketList callback used by settingsLoader's category buttons
setRestoreTicketListCallback(restoreTicketList);

/** Preview an attachment — Quicklook on macOS (Tauri), inline overlay in browser. */
async function previewAttachment(item: HTMLElement) {
  const filename = item.dataset.filename ?? '';
  const attId = item.dataset.attId ?? '';
  if (attId === '') return;

  // Tauri: use qlmanage for macOS Quicklook
  const invoke = getTauriInvoke();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- no universal replacement for platform detection
  if (invoke && navigator.platform.includes('Mac')) {
    const storedPath = item.dataset.storedPath ?? '';
    if (storedPath !== '') {
      try { await invoke('quicklook', { path: storedPath }); } catch { /* fallback below */ }
      return;
    }
  }

  // Browser fallback: show inline preview overlay for images
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);
  const pdfExts = new Set(['pdf']);

  if (imageExts.has(ext) || pdfExts.has(ext)) {
    const overlay = toElement(
      <div className="quicklook-overlay" style="position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;cursor:pointer">
        {imageExts.has(ext)
          ? <img src={`/api/attachments/file/${encodeURIComponent(filename)}`} style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.4)" alt={filename} />
          : <iframe src={`/api/attachments/file/${encodeURIComponent(filename)}`} style="width:80vw;height:85vh;border:none;border-radius:8px" title={filename}></iframe>
        }
      </div>
    );
    overlay.addEventListener('click', () => overlay.remove());
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(overlay);
  }
}

/** Reload all app state — used after project switch and during init. */
async function reloadPluginToolbar() {
  if (!PLUGINS_ENABLED) return;
  const { refreshPluginUI, renderPluginToolbarButtons } = await import('./pluginUI.js');
  // refreshPluginUI reloads from API and re-renders toolbar, status_bar, sidebar
  await refreshPluginUI();
  // Ensure the toolbar container exists in the DOM
  if (!document.querySelector('.plugin-toolbar-container')) {
    const glassboxBtn = document.getElementById('glassbox-btn');
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
  // Sync toggle button UI to the new project's saved settings
  updateLayoutToggle();
  updateDetailPositionToggle();
  await loadCategories(rebuildCategoryUI);
  await loadCustomViews();
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
  void loadAppName();
  suppressAnimation();
  await loadTickets();
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
}

async function init() {
  try {
  // Determine the active project before any API calls
  await initProjectTabs();
  setProjectReloadCallback(async () => {
    closeDetail();
    restoreTicketList(); // Exit dashboard mode if active
    await reloadAppState();
  });

  await loadSettings();
  await loadCategories(rebuildCategoryUI);
  await loadCustomViews();
  void loadAppName();
  suppressAnimation();
  await loadTickets();
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
  // HS-7899: surface the launch-time DB-recovery banner once the
  // backups UI is wired (the banner's "Restore from backup" button
  // opens Settings → Backups, which depends on bindBackupsUI).
  void initDbRecoveryBanner();
  bindCopyPrompt();
  bindOpenFolder();

  // Load plugin UI elements and render toolbar buttons
  void reloadPluginToolbar();
  bindGlassbox();
  initCustomViews(() => { void loadTickets(); });
  initResize();
  startLongPoll();
  void checkForUpdate();
  // --- Permanent app-level event listeners ---
  // These are bound once during init and never removed (SPA lifecycle).
  // Temporary listeners (context menus, dropdowns, modals) are cleaned up
  // via their own close/remove handlers.

  // Clicking empty space in the ticket list deselects all (HS-2114)
  document.getElementById('ticket-list')!.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Only deselect if the click landed directly on the container or a column body/gap, not on a ticket row
    if (!target.closest('.ticket-row') && !target.closest('.column-card') && !target.closest('.column-header') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
    }
  });
  // Re-render when detail panel dispatches close event
  document.addEventListener('hotsheet:render', () => renderTicketList());
  // Tags dialog triggered from context menu
  document.addEventListener('hotsheet:show-tags-dialog', () => { void showTagsDialog(); });
  // Channel auto-trigger on up_next changes
  document.addEventListener('hotsheet:upnext-changed', () => channelAutoTrigger());
  // Print button
  document.getElementById('print-btn')?.addEventListener('click', showPrintDialog);
  // Restore saved app icon variant in Tauri (Dock resets to bundle icon on launch)
  void restoreAppIcon();
  bindExternalLinkHandler();
  // Claude Channel
  void initChannel();
  // Prevent browser navigation when files are dropped outside valid drop targets.
  // If the drop lands on a ticket row / column card (HS-7492) → attach to THAT
  // ticket regardless of selection. Else if a single ticket is selected →
  // attach to it. Else create a new ticket.
  //
  // HS-7492 — visual feedback: while a file is being dragged, the ticket row
  // or column card under the cursor gets `.file-drop-target`. Cleared on
  // dragleave / drop / dragend. We only mark rows on Files drags (not the
  // column-view ticket-reorder drag which carries text/plain) so the
  // existing `.column-drop-target` behaviour for reorder is unaffected.
  let lastFileDropRow: HTMLElement | null = null;
  const setFileDropRow = (row: HTMLElement | null): void => {
    if (lastFileDropRow === row) return;
    lastFileDropRow?.classList.remove('file-drop-target');
    row?.classList.add('file-drop-target');
    lastFileDropRow = row;
  };
  const findRowUnder = (el: HTMLElement): HTMLElement | null => {
    // `.trash-row` rows are excluded — attachments on trashed tickets would
    // be silently dropped by the next auto-cleanup sweep.
    const row = el.closest<HTMLElement>('.ticket-row[data-id]:not(.trash-row), .column-card[data-id]');
    return row;
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
    // Only clear when the drag leaves the viewport — intra-doc moves between
    // rows flip the highlight via the next dragover. `relatedTarget` is null
    // when the cursor leaves the window.
    if (e.relatedTarget === null) setFileDropRow(null);
  });
  document.addEventListener('dragend', () => { setFileDropRow(null); });
  document.addEventListener('drop', async (e) => {
    // Don't intercept drops on valid targets (detail panel, dialogs) — they handle their own drops
    const target = e.target as HTMLElement;
    if (target.closest('.detail-body') || target.closest('.custom-view-editor-overlay') || target.closest('.feedback-dialog-overlay')) return;

    e.preventDefault();
    setFileDropRow(null);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    let ticketId: number;
    // HS-7492 — row/card drop target takes precedence over the selection.
    // A user dropping a file onto a specific ticket obviously intends to
    // attach to that ticket, even if a different one is currently selected.
    const rowEl = findRowUnder(target);
    const rowId = rowEl?.dataset.id;
    if (rowId !== undefined && rowId !== '') {
      ticketId = parseInt(rowId, 10);
    } else if (state.selectedIds.size === 1) {
      // Attach to the selected ticket
      ticketId = Array.from(state.selectedIds)[0];
    } else {
      // Create a new ticket (use draft input text if available, otherwise empty)
      const draftInput = document.querySelector<HTMLInputElement>('.draft-input');
      const title = draftInput?.value.trim() ?? '';
      const res = await api<{ id: number }>('/tickets', { method: 'POST', body: { title: title || 'Attachment' } });
      ticketId = res.id;
      if (draftInput && title !== '') draftInput.value = '';
      void loadTickets();
    }

    for (const file of Array.from(files)) {
      await apiUpload(`/tickets/${ticketId}/attachments`, file);
    }
    void loadTickets();
  });

  // Command log panel + embedded terminal (tabs in the same drawer)
  initCommandLog();
  initTerminal();
  initTerminalDashboard();
  // HS-6311 — drawer terminal grid view (§36). Sits alongside the drawer
  // tabs; toggled on via a new button in the drawer toolbar. onExitGrid
  // restores whatever drawer tab was active before grid mode: showGridChrome
  // set every .drawer-tab-content to display:none so we need to re-reveal the
  // currently-active one here.
  initDrawerTerminalGrid({
    onExitGrid: () => {
      const activeBtn = document.querySelector<HTMLElement>('.drawer-tab.active');
      const tab = activeBtn?.dataset.drawerTab ?? 'commands-log';
      void import('./commandLog.js').then(({ switchDrawerTab }) => { switchDrawerTab(tab); });
    },
  });
  // HS-7596 / §37 — quit-confirm. Subscribes to the Rust-side
  // `quit-confirm-requested` event and runs the §37.5 confirm flow.
  // Tauri-only — no-op in browser context.
  initQuitConfirm();
  // Cross-project bell long-poll (HS-6603 §24.4.1) — surfaces server-side
  // bell state on project tabs and feeds the in-drawer indicator for
  // bells fired while the user is inside another project.
  startBellPolling();
  // HS-7272 — prime Tauri notification permission once. First call on macOS
  // shows the OS permission dialog; subsequent calls short-circuit. A denial
  // here is fine — the in-app toast still fires for every OSC 9.
  void requestNativeNotificationPermission();
  // Dashboard sidebar widget
  void initDashboardWidget();
  // Share prompt and toolbar button
  initShare();
  // Auto-focus the draft input on load
  focusDraftInput();
  } catch (err) {
    console.error('Hot Sheet init failed:', err);
    const el = document.getElementById('ticket-list');
    if (el) el.replaceChildren(toElement(<div style="padding:20px;color:red">Init error: {String(err)}</div>));
  }
}

// --- Glassbox integration ---

function bindGlassbox() {
  const btn = document.getElementById('glassbox-btn') as HTMLButtonElement;
  const icon = document.getElementById('glassbox-icon') as HTMLImageElement;

  void api<{ available: boolean }>('/glassbox/status').then(({ available }) => {
    if (!available) return;
    icon.src = '/static/assets/glassbox-icon.png';
    btn.style.display = '';
  }).catch(() => { /* ignore */ });

  btn.addEventListener('click', () => {
    void api('/glassbox/launch', { method: 'POST' });
  });
}

// --- Layout toggle ---

function updateLayoutToggle() {
  const toggle = document.getElementById('layout-toggle')!;
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
  const toggle = document.getElementById('layout-toggle')!;
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
      void api('/settings', { method: 'PATCH', body: { layout } });
    });
  });
  updateLayoutToggle();
}

// --- Detail position toggle ---

function updateDetailPositionToggle() {
  const toggle = document.getElementById('detail-position-toggle')!;
  toggle.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.position === state.settings.detail_position);
  });
}

function bindDetailPositionToggle() {
  const toggle = document.getElementById('detail-position-toggle')!;
  toggle.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const position = (btn as HTMLElement).dataset.position as AppSettings['detail_position'];
      // If clicking the already-active position, toggle the detail panel off
      if (position === state.settings.detail_position && state.settings.detail_visible) {
        state.settings.detail_visible = false;
        const panel = document.getElementById('detail-panel');
        const handle = document.getElementById('detail-resize-handle');
        if (panel) panel.style.display = 'none';
        if (handle) handle.style.display = 'none';
        toggle.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
        void api('/settings', { method: 'PATCH', body: { detail_visible: 'false' } });
        return;
      }
      // Switching position or re-enabling
      state.settings.detail_visible = true;
      state.settings.detail_position = position;
      const panel = document.getElementById('detail-panel');
      const handle = document.getElementById('detail-resize-handle');
      if (panel) panel.style.display = '';
      if (handle) handle.style.display = '';
      applyDetailPosition(position);
      applyDetailSize();
      updateDetailPositionToggle();
      void api('/settings', { method: 'PATCH', body: { detail_position: position, detail_visible: 'true' } });
    });
  });
  updateDetailPositionToggle();
}

// --- Detail panel ---

/** Auto-save debounce for title and details fields. */
function bindDetailAutoSave() {
  const fields = ['detail-title', 'detail-details'];
  for (const fieldId of fields) {
    const el = document.getElementById(fieldId) as HTMLInputElement | HTMLTextAreaElement;
    el.addEventListener('input', () => {
      // Record text change for undo (coalesces rapid edits)
      const ticket = state.tickets.find(t => t.id === state.activeTicketId);
      if (ticket) {
        const key = fieldId.replace('detail-', '');
        recordTextChange(ticket, key, el.value);
      }
      const currentTimeout = getDetailSaveTimeout();
      if (currentTimeout) clearTimeout(currentTimeout);
      const newTimeout = setTimeout(() => {
        if (state.activeTicketId == null) return;
        const key = fieldId.replace('detail-', '');
        void api(`/tickets/${state.activeTicketId}`, {
          method: 'PATCH',
          body: { [key]: el.value },
        }).then(() => void loadTickets());
      }, TIMERS.DETAIL_SAVE_MS);
      setDetailSaveTimeout(newTimeout);
    });
  }
}

/** Category, priority, and status dropdown binding. */
function bindDetailDropdowns() {
  async function applyDetailChange(key: string, value: string) {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) {
      await trackedPatch(ticket, { [key]: value }, `Change ${key}`);
    } else {
      await api(`/tickets/${state.activeTicketId}`, { method: 'PATCH', body: { [key]: value } });
    }
    void loadTickets();
    openDetail(state.activeTicketId);
  }

  function bindDropdown(elementId: string, getItems: (current: string) => Parameters<typeof createDropdown>[1]) {
    document.getElementById(elementId)!.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLButtonElement;
      if (btn.disabled) return;
      closeAllMenus();
      const current = btn.dataset.value ?? '';
      const menu = createDropdown(btn, getItems(current));
      document.body.appendChild(menu);
      positionDropdown(menu, btn);
      menu.style.visibility = '';
    });
  }

  bindDropdown('detail-category', (current) => state.categories.map(c => ({
    label: c.label, key: c.shortcutKey, color: c.color, active: c.id === current,
    action: () => { updateDetailCategory(c.id); void applyDetailChange('category', c.id); },
  })));

  bindDropdown('detail-priority', (current) => PRIORITY_ITEMS.map(p => ({
    label: p.label, key: p.key, icon: getPriorityIcon(p.value), iconColor: getPriorityColor(p.value),
    active: p.value === current,
    action: () => { updateDetailPriority(p.value); void applyDetailChange('priority', p.value); },
  })));

  bindDropdown('detail-status', (current) => STATUS_ITEMS.map(s => ({
    label: s.label, key: s.key, icon: getStatusIcon(s.value), active: s.value === current,
    action: () => { updateDetailStatus(s.value); void applyDetailChange('status', s.value); },
  })));
}

/** Up-next star toggle. */
function bindDetailUpNext() {
  document.getElementById('detail-upnext')!.addEventListener('click', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) {
      if (!ticket.up_next && (ticket.status === 'completed' || ticket.status === 'verified')) {
        await trackedPatch(ticket, { status: 'not_started', up_next: true }, 'Toggle up next');
      } else {
        await trackedPatch(ticket, { up_next: !ticket.up_next }, 'Toggle up next');
      }
    } else {
      await api(`/tickets/${state.activeTicketId}/up-next`, { method: 'POST' });
    }
    void loadTickets();
    channelAutoTrigger();
    openDetail(state.activeTicketId);
  });
}

/** Add note functionality. */
function bindDetailNotes() {
  document.getElementById('detail-add-note-btn')?.addEventListener('click', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (!ticket) return;

    // Build the new notes array client-side and PUT in bulk so we can:
    //   1. control the new note's id (so we can find its element after re-render)
    //   2. start it empty (no default text)
    const beforeNotes = ticket.notes;
    type NoteEntry = { id: string; text: string; created_at: string };
    let parsed: NoteEntry[] = [];
    try {
      const raw: unknown = JSON.parse(beforeNotes || '[]');
      if (Array.isArray(raw)) parsed = raw as NoteEntry[];
    } catch { /* legacy raw text — ignore */ }
    const newNoteId = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newNotes: NoteEntry[] = [...parsed, { id: newNoteId, text: '', created_at: new Date().toISOString() }];
    const newNotesJson = JSON.stringify(newNotes);
    await api(`/tickets/${state.activeTicketId}/notes-bulk`, {
      method: 'PUT',
      body: { notes: newNotesJson },
    });
    pushNotesUndo({ ...ticket, notes: beforeNotes } as Ticket, 'Add note', newNotesJson);
    ticket.notes = newNotesJson;
    openDetailAndFocusNote(state.activeTicketId, newNoteId);
  });
}

/** File upload button + drag-and-drop upload. */
function bindDetailFileUpload() {
  // File upload (supports multiple files)
  document.getElementById('detail-file-input')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0 || state.activeTicketId == null) return;
    for (const file of Array.from(files)) {
      await apiUpload(`/tickets/${state.activeTicketId}/attachments`, file);
    }
    input.value = '';
    openDetail(state.activeTicketId);
    void loadTickets();
  });

  // Drag-and-drop file upload onto detail panel
  const detailBody = document.getElementById('detail-body')!;
  let dragCounter = 0; // Track nested enter/leave to avoid flicker

  detailBody.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files') !== true) return;
    dragCounter++;
    if (dragCounter === 1) detailBody.classList.add('drop-active');
  });

  detailBody.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  detailBody.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter === 0) detailBody.classList.remove('drop-active');
  });

  detailBody.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    detailBody.classList.remove('drop-active');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0 || state.activeTicketId == null) return;
    for (const file of Array.from(files)) {
      await apiUpload(`/tickets/${state.activeTicketId}/attachments`, file);
    }
    openDetail(state.activeTicketId);
    void loadTickets();
  });
}

/** Attachment reveal/delete click handlers. */
function bindDetailAttachmentActions() {
  const attEl = document.getElementById('detail-attachments')!;
  attEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // Reveal in file manager
    const revealBtn: HTMLElement | null = target.closest('.attachment-reveal');
    if (revealBtn) {
      const attId = revealBtn.dataset['attId'];
      if (attId !== undefined && attId !== '') void api(`/attachments/${attId}/reveal`, { method: 'POST' });
      return;
    }

    // Delete
    const deleteBtn: HTMLElement | null = target.closest('.attachment-delete');
    if (deleteBtn !== null) {
      const attId = deleteBtn.dataset['attId'];
      if (attId === undefined || attId === '') return;
      await api(`/attachments/${attId}`, { method: 'DELETE' });
      if (state.activeTicketId != null) {
        openDetail(state.activeTicketId);
      }
      return;
    }

    // Select attachment item (click on the row itself)
    const item: HTMLElement | null = target.closest('.attachment-item');
    if (item) {
      attEl.querySelectorAll('.attachment-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      item.focus();
    }
  });

  // Double-click to preview
  attEl.addEventListener('dblclick', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.attachment-item');
    if (item != null) void previewAttachment(item);
  });

  // Keyboard navigation and Space to preview
  attEl.addEventListener('keydown', (e) => {
    const active = document.activeElement as HTMLElement | null;
    if (active == null || !active.classList.contains('attachment-item')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(attEl.querySelectorAll<HTMLElement>('.attachment-item'));
      const idx = items.indexOf(active);
      const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      if (nextIdx >= 0 && nextIdx < items.length) {
        const next = items[nextIdx];
        items.forEach(el => el.classList.remove('selected'));
        next.classList.add('selected');
        next.focus();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      void previewAttachment(active);
    }
  });
}

/** Tag input with autocomplete. */
// Tag autocomplete extracted to tagAutocomplete.ts

function bindDetailPanel() {
  document.getElementById('detail-close')!.addEventListener('click', closeDetail);

  // Click ticket number to copy to clipboard
  const ticketNumEl = document.getElementById('detail-ticket-number')!;
  ticketNumEl.style.cursor = 'pointer';
  ticketNumEl.title = 'Click to copy';
  ticketNumEl.addEventListener('click', () => {
    const num = ticketNumEl.textContent;
    if (num !== '') {
      void navigator.clipboard.writeText(num);
      const original = ticketNumEl.textContent;
      ticketNumEl.textContent = 'Copied!';
      setTimeout(() => { ticketNumEl.textContent = original; }, 1000);
    }
  });

  bindDetailAutoSave();
  bindDetailDropdowns();
  bindDetailUpNext();
  bindDetailNotes();
  bindDetailFileUpload();
  bindDetailAttachmentActions();
  bindDetailTagInput();
}

void init();
