import { PLUGINS_ENABLED } from '../feature-flags.js';
import { suppressAnimation } from './animate.js';
import { api, apiUpload } from './api.js';
import { bindBackupsUI } from './backups.js';
import { bindBatchToolbar } from './batch.js';
import { channelAutoTrigger, initChannel } from './channelUI.js';
import { bindCopyPrompt } from './clipboardUtil.js';
import { initCommandLog, refreshCommandLog } from './commandLog.js';
import { initCustomViews, loadCustomViews } from './customViews.js';
import { initDashboardWidget, refreshDashboardWidget, restoreTicketList } from './dashboardMode.js';
import { applyDetailPosition, applyDetailSize, closeDetail, displayTag, hasTag, initResize, normalizeTag, openDetail, openDetailAndFocusNote, parseTags, renderDetailTags, updateDetailCategory, updateDetailPriority, updateDetailStatus } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { bindOpenFolder } from './openFolder.js';
import { startLongPoll } from './poll.js';
import { showPrintDialog } from './print.js';
import { initProjectTabs, setProjectReloadCallback } from './projectTabs.js';
import { bindSettingsDialog } from './settingsDialog.js';
import { loadAppName, loadCategories, loadSettings, rebuildCategoryUI, setRestoreTicketListCallback } from './settingsLoader.js';
import { initShare } from './share.js';
import { bindKeyboardShortcuts, getDetailSaveTimeout, setDetailSaveTimeout } from './shortcuts.js';
import { bindSearchInput, bindSidebar, bindSortControls } from './sidebar.js';
import type { AppSettings, Ticket } from './state.js';
import { allKnownTags, getPriorityColor, getPriorityIcon, getStatusIcon, PRIORITY_ITEMS, refreshAllKnownTags, state, STATUS_ITEMS } from './state.js';
import { showTagsDialog } from './tagsDialog.js';
import { bindExternalLinkHandler, checkForUpdate, restoreAppIcon } from './tauriIntegration.js';
import { canUseColumnView, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { pushNotesUndo, recordTextChange, trackedPatch } from './undo/actions.js';

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
    const glassboxBtn = document.getElementById('glassbox-btn');
    const toolbarTarget = glassboxBtn?.parentElement;
    if (toolbarTarget) {
      const container = document.createElement('span');
      container.className = 'plugin-toolbar-container';
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
  void loadAppName();
  suppressAnimation();
  await loadTickets();
  // Refresh command log for the new project context
  refreshCommandLog();
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
  bindCopyPrompt();
  bindOpenFolder();

  // Load plugin UI elements and render toolbar buttons
  void reloadPluginToolbar();
  bindGlassbox();
  initCustomViews(() => { void loadTickets(); });
  initResize();
  startLongPoll();
  void checkForUpdate();
  // Clicking empty space in the ticket list deselects all (HS-2114)
  document.getElementById('ticket-list')!.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Only deselect if the click landed directly on the container or a column body/gap, not on a ticket row
    if (!target.closest('.ticket-row') && !target.closest('.column-card') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
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
  // Command log panel
  initCommandLog();
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
      state.layout = layout;
      suppressAnimation();
      updateLayoutToggle();
      renderTicketList();
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
      }, 300);
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

  document.getElementById('detail-category')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    closeAllMenus();
    const current = btn.dataset.value ?? '';
    const menu = createDropdown(btn, state.categories.map(c => ({
      label: c.label,
      key: c.shortcutKey,
      color: c.color,
      active: c.id === current,
      action: () => { updateDetailCategory(c.id); void applyDetailChange('category', c.id); },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, btn);
    menu.style.visibility = '';
  });

  document.getElementById('detail-priority')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    closeAllMenus();
    const current = btn.dataset.value ?? '';
    const menu = createDropdown(btn, PRIORITY_ITEMS.map(p => ({
      label: p.label,
      key: p.key,
      icon: getPriorityIcon(p.value),
      iconColor: getPriorityColor(p.value),
      active: p.value === current,
      action: () => { updateDetailPriority(p.value); void applyDetailChange('priority', p.value); },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, btn);
    menu.style.visibility = '';
  });

  document.getElementById('detail-status')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    closeAllMenus();
    const current = btn.dataset.value ?? '';
    const menu = createDropdown(btn, STATUS_ITEMS.map(s => ({
      label: s.label,
      key: s.key,
      icon: getStatusIcon(s.value),
      active: s.value === current,
      action: () => { updateDetailStatus(s.value); void applyDetailChange('status', s.value); },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, btn);
    menu.style.visibility = '';
  });
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
  document.getElementById('detail-attachments')!.addEventListener('click', async (e) => {
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
    if (deleteBtn === null) return;
    const attId = deleteBtn.dataset['attId'];
    if (attId === undefined || attId === '') return;
    await api(`/attachments/${attId}`, { method: 'DELETE' });
    if (state.activeTicketId != null) {
      openDetail(state.activeTicketId);
    }
  });
}

/** Tag input with autocomplete. */
function bindDetailTagInput() {
  const tagInput = document.getElementById('detail-tag-input') as HTMLInputElement;
  let acDropdown: HTMLElement | null = null;
  let acIndex = -1;

  // Load known tags into shared state
  void refreshAllKnownTags();

  function closeAutocomplete() {
    acDropdown?.remove();
    acDropdown = null;
    acIndex = -1;
  }

  function showAutocomplete() {
    closeAutocomplete();
    const query = tagInput.value.trim().toLowerCase();
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    const currentTags = ticket ? parseTags(ticket.tags) : [];
    const matches = query
      ? allKnownTags.filter(t => t.toLowerCase().includes(query) && !hasTag(currentTags, t))
      : allKnownTags.filter(t => !hasTag(currentTags, t)).slice(0, 100);
    if (matches.length === 0) return;

    acDropdown = toElement(<div className="tag-autocomplete"></div>);
    for (let i = 0; i < matches.length; i++) {
      const item = toElement(<div className="tag-autocomplete-item">{displayTag(matches[i])}</div>);
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        tagInput.value = matches[i];
        closeAutocomplete();
        void addCurrentTag();
      });
      acDropdown.appendChild(item);
    }

    // Position below the input
    const rect = tagInput.getBoundingClientRect();
    acDropdown.style.position = 'fixed';
    acDropdown.style.left = `${rect.left}px`;
    acDropdown.style.top = `${rect.bottom + 2}px`;
    acDropdown.style.width = `${rect.width}px`;
    document.body.appendChild(acDropdown);
  }

  async function addCurrentTag() {
    const normalized = normalizeTag(tagInput.value);
    if (!normalized || state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (!ticket) return;
    const currentTags = parseTags(ticket.tags);
    if (hasTag(currentTags, normalized)) { tagInput.value = ''; return; }
    const updated = [...currentTags, normalized];
    tagInput.value = '';
    closeAutocomplete();
    await api(`/tickets/${state.activeTicketId}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
    ticket.tags = JSON.stringify(updated);
    renderDetailTags(updated, false);
    // Add to known tags if new
    if (!hasTag(allKnownTags, normalized)) allKnownTags.push(normalized);
  }

  tagInput.addEventListener('input', () => { showAutocomplete(); });
  tagInput.addEventListener('focus', () => { showAutocomplete(); });
  tagInput.addEventListener('blur', () => { closeAutocomplete(); });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (acDropdown && acIndex >= 0) {
        const items = acDropdown.querySelectorAll('.tag-autocomplete-item');
        const text = items[acIndex].textContent;
        if (text !== '') tagInput.value = text;
      }
      closeAutocomplete();
      void addCurrentTag();
    } else if (e.key === 'Escape') {
      closeAutocomplete();
    } else if (e.key === 'ArrowDown' && acDropdown) {
      e.preventDefault();
      const items = acDropdown.querySelectorAll('.tag-autocomplete-item');
      acIndex = Math.min(acIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    } else if (e.key === 'ArrowUp' && acDropdown) {
      e.preventDefault();
      const items = acDropdown.querySelectorAll('.tag-autocomplete-item');
      acIndex = Math.max(acIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    }
  });
}

function bindDetailPanel() {
  document.getElementById('detail-close')!.addEventListener('click', closeDetail);
  bindDetailAutoSave();
  bindDetailDropdowns();
  bindDetailUpNext();
  bindDetailNotes();
  bindDetailFileUpload();
  bindDetailAttachmentActions();
  bindDetailTagInput();
}

void init();
