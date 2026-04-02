import { suppressAnimation } from './animate.js';
import { api, apiUpload } from './api.js';
import { bindBackupsUI } from './backups.js';
import { bindBatchToolbar, PRIORITY_ITEMS, STATUS_ITEMS } from './batch.js';
import { channelAutoTrigger, initChannel } from './channelUI.js';
import { bindCopyPrompt } from './clipboardUtil.js';
import { initCustomViews, loadCustomViews } from './customViews.js';
import { renderDashboard, renderSidebarWidget } from './dashboard.js';
import { applyDetailPosition, applyDetailSize, closeDetail, displayTag, hasTag, initResize, normalizeTag, openDetail, parseTags, renderDetailTags, updateDetailCategory, updateDetailPriority, updateDetailStatus } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import { startLongPoll } from './poll.js';
import { showPrintDialog } from './print.js';
import { bindSettingsDialog } from './settingsDialog.js';
import { bindKeyboardShortcuts, getDetailSaveTimeout, setDetailSaveTimeout } from './shortcuts.js';
import { bindSearchInput, bindSidebar, bindSortControls } from './sidebar.js';
import type { AppSettings, CategoryDef, Ticket } from './state.js';
import { getPriorityColor, getPriorityIcon, getStatusIcon, state } from './state.js';
import { showTagsDialog } from './tagsDialog.js';
import { checkForUpdate, restoreAppIcon } from './tauriIntegration.js';
import { canUseColumnView, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { pushNotesUndo, recordTextChange, trackedPatch } from './undo/actions.js';

async function init() {
  try {
  await loadSettings();
  await loadCategories();
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
  // Claude Channel
  void initChannel();
  // Dashboard sidebar widget
  void initDashboardWidget();
  // Auto-focus the draft input on load
  focusDraftInput();
  } catch (err) {
    console.error('Hot Sheet init failed:', err);
    const el = document.getElementById('ticket-list');
    if (el) el.innerHTML = `<div style="padding:20px;color:red">Init error: ${String(err)}</div>`;
  }
}

// --- Settings ---

async function loadSettings() {
  try {
    const settings = await api<Record<string, string>>('/settings');
    if (settings.detail_position === 'side' || settings.detail_position === 'bottom') {
      state.settings.detail_position = settings.detail_position;
    }
    if (settings.detail_width !== undefined && settings.detail_width !== '') state.settings.detail_width = parseInt(settings.detail_width, 10) || 360;
    if (settings.detail_height !== undefined && settings.detail_height !== '') state.settings.detail_height = parseInt(settings.detail_height, 10) || 300;
    if (settings.trash_cleanup_days !== undefined && settings.trash_cleanup_days !== '') state.settings.trash_cleanup_days = parseInt(settings.trash_cleanup_days, 10) || 3;
    if (settings.verified_cleanup_days !== undefined && settings.verified_cleanup_days !== '') state.settings.verified_cleanup_days = parseInt(settings.verified_cleanup_days, 10) || 30;
    if (settings.layout === 'list' || settings.layout === 'columns') state.layout = settings.layout;
    if (settings.notify_permission === 'none' || settings.notify_permission === 'once' || settings.notify_permission === 'persistent') {
      state.settings.notify_permission = settings.notify_permission;
    }
    if (settings.notify_completed === 'none' || settings.notify_completed === 'once' || settings.notify_completed === 'persistent') {
      state.settings.notify_completed = settings.notify_completed;
    }
    if (settings.auto_order !== '') {
      state.settings.auto_order = settings.auto_order !== 'false';
    }
  } catch { /* use defaults */ }

  applyDetailPosition(state.settings.detail_position);
  applyDetailSize();
}

async function loadCategories() {
  try {
    const categories = await api<CategoryDef[]>('/categories');
    if (categories.length > 0) state.categories = categories;
  } catch { /* use defaults */ }
  rebuildCategoryUI();
}

function rebuildCategoryUI() {
  // Rebuild sidebar category buttons
  const sidebarSection = document.getElementById('sidebar-categories');
  if (sidebarSection) {
    const label = sidebarSection.querySelector('.sidebar-label');
    sidebarSection.innerHTML = '';
    if (label) sidebarSection.appendChild(label);
    for (const cat of state.categories) {
      const btn = toElement(
        <button className={`sidebar-item${state.view === `category:${cat.id}` ? ' active' : ''}`} data-view={`category:${cat.id}`}>
          <span className="cat-dot" style={`background:${cat.color}`}></span> {cat.label}
        </button>
      );
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        btn.classList.add('active');
        state.view = `category:${cat.id}`;
        state.selectedIds.clear();
        restoreTicketList();
        suppressAnimation();
        void loadTickets();
      });
      sidebarSection.appendChild(btn);
    }
  }

  // Refresh detail panel category button if a ticket is active
  if (state.activeTicketId != null) {
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) updateDetailCategory(ticket.category);
  }

  // Update keyboard hints in the footer to reflect current shortcut keys
  const hintsContainer = document.querySelector('.keyboard-hints');
  if (hintsContainer) {
    const catHint = hintsContainer.querySelector('[data-hint="category"]');
    const keys = state.categories
      .map(c => c.shortcutKey.toUpperCase())
      .filter(Boolean)
      .join('/');
    if (catHint && keys) {
      catHint.innerHTML = `<kbd>\u2318${keys}</kbd> category`;
    }
  }
}

async function loadAppName() {
  try {
    const fs = await api<{ appName?: string }>('/file-settings');
    if (fs.appName !== undefined && fs.appName !== '') {
      document.title = fs.appName;
      const h1 = document.querySelector('.app-title h1');
      if (h1) h1.textContent = fs.appName;
    }
  } catch { /* ignore */ }
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
      state.settings.detail_position = position;
      applyDetailPosition(position);
      applyDetailSize();
      updateDetailPositionToggle();
      void api('/settings', { method: 'PATCH', body: { detail_position: position } });
    });
  });
  updateDetailPositionToggle();
}

// --- Dashboard ---

function restoreTicketList() {
  const dashContainer = document.getElementById('dashboard-container');
  if (dashContainer) {
    dashContainer.id = 'ticket-list';
    dashContainer.innerHTML = '';
    exitDashboardMode();
  }
}

const DASHBOARD_HIDDEN_IDS = ['search-input', 'layout-toggle', 'sort-select', 'detail-position-toggle', 'glassbox-btn'];

function enterDashboardMode() {
  state.view = 'dashboard';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  // Hide toolbar elements
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = document.getElementById(id);
    if (el) {
      const container = el.closest('.search-box, .layout-toggle, .sort-controls') || el;
      (container as HTMLElement).style.display = 'none';
    }
  }
  // Hide batch toolbar and detail panel
  const batchToolbar = document.getElementById('batch-toolbar');
  if (batchToolbar) batchToolbar.style.display = 'none';
  const detailPanel = document.getElementById('detail-panel');
  if (detailPanel) detailPanel.style.display = 'none';
  const resizeHandle = document.getElementById('detail-resize-handle');
  if (resizeHandle) resizeHandle.style.display = 'none';

  const ticketList = document.getElementById('ticket-list')!;
  ticketList.innerHTML = '';
  ticketList.id = 'dashboard-container';
  ticketList.classList.remove('ticket-list-columns');
  void renderDashboard(ticketList);
}

function exitDashboardMode() {
  // Restore toolbar elements
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = document.getElementById(id);
    if (el) {
      const container = el.closest('.search-box, .layout-toggle, .sort-controls') || el;
      (container as HTMLElement).style.display = '';
    }
  }
  restoreTicketList();
  // Detail panel and resize handle are restored by syncDetailPanel on next render
}

async function initDashboardWidget() {
  const widget = await renderSidebarWidget();
  const statsBar = document.getElementById('stats-bar');
  if (statsBar) statsBar.after(widget);
  widget.addEventListener('click', () => enterDashboardMode());
}

// --- Detail panel ---

function bindDetailPanel() {
  document.getElementById('detail-close')!.addEventListener('click', closeDetail);

  // Auto-save detail fields
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

  // Detail dropdown buttons
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

  // Up Next star button
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

  // Add note
  document.getElementById('detail-add-note-btn')?.addEventListener('click', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (ticket) {
      // Snapshot before for undo (after will be computed once we know the new note)
      const beforeNotes = ticket.notes;
      await api(`/tickets/${state.activeTicketId}`, {
        method: 'PATCH',
        body: { notes: '(new note)' },
      });
      // Fetch the updated ticket to get the after-state notes with the new ID
      const updated = await api<{ notes: string }>(`/tickets/${state.activeTicketId}`);
      pushNotesUndo({ ...ticket, notes: beforeNotes } as Ticket, 'Add note', updated.notes);
      ticket.notes = updated.notes;
    }
    openDetail(state.activeTicketId);
  });

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

  // Attachment actions (event delegation)
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

  // Tag input with autocomplete
  const tagInput = document.getElementById('detail-tag-input') as HTMLInputElement;
  let acDropdown: HTMLElement | null = null;
  let acIndex = -1;
  let allKnownTags: string[] = [];

  // Load known tags
  void api<string[]>('/tags').then(tags => { allKnownTags = tags; });

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
        tagInput.value = items[acIndex].textContent ?? tagInput.value;
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

void init();
