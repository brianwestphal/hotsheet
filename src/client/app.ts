import { api, apiUpload } from './api.js';
import { bindBackupsUI, loadBackupList } from './backups.js';
import { applyDetailPosition, applyDetailSize, closeDetail, initResize, openDetail, updateStats } from './detail.js';
import type { AppSettings, Ticket } from './state.js';
import { state } from './state.js';
import { canUseColumnView, draggedTicketIds, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';

async function init() {
  await loadSettings();
  void loadAppName();
  await loadTickets();
  bindSidebar();
  bindLayoutToggle();
  bindDetailPositionToggle();
  bindSortControls();
  bindSearchInput();
  bindBatchToolbar();
  bindDetailPanel();
  bindKeyboardShortcuts();
  bindSettingsDialog();
  bindBackupsUI();
  bindCopyPrompt();
  initResize();
  startLongPoll();
  void checkForUpdate();
  // Re-render when detail panel dispatches close event
  document.addEventListener('hotsheet:render', () => renderTicketList());
  // Auto-focus the draft input on load
  focusDraftInput();
}

// --- Settings ---

async function loadSettings() {
  try {
    const settings = await api<Record<string, string>>('/settings');
    if (settings.detail_position === 'side' || settings.detail_position === 'bottom') {
      state.settings.detail_position = settings.detail_position;
    }
    if (settings.detail_width) state.settings.detail_width = parseInt(settings.detail_width, 10) || 360;
    if (settings.detail_height) state.settings.detail_height = parseInt(settings.detail_height, 10) || 300;
    if (settings.trash_cleanup_days) state.settings.trash_cleanup_days = parseInt(settings.trash_cleanup_days, 10) || 3;
    if (settings.verified_cleanup_days) state.settings.verified_cleanup_days = parseInt(settings.verified_cleanup_days, 10) || 30;
    if (settings.layout === 'list' || settings.layout === 'columns') state.layout = settings.layout;
  } catch { /* use defaults */ }

  applyDetailPosition(state.settings.detail_position);
  applyDetailSize();
}

async function loadAppName() {
  try {
    const fs = await api<{ appName?: string }>('/file-settings');
    if (fs.appName) {
      document.title = fs.appName;
      const h1 = document.querySelector('.app-title h1');
      if (h1) h1.textContent = fs.appName;
    }
  } catch { /* ignore */ }
}

function bindSettingsDialog() {
  const overlay = document.getElementById('settings-overlay')!;
  const closeBtn = document.getElementById('settings-close')!;
  const settingsBtn = document.getElementById('settings-btn')!;

  settingsBtn.addEventListener('click', () => {
    // Populate fields with current values
    (document.getElementById('settings-trash-days') as HTMLInputElement).value = String(state.settings.trash_cleanup_days);
    (document.getElementById('settings-verified-days') as HTMLInputElement).value = String(state.settings.verified_cleanup_days);
    overlay.style.display = 'flex';
    void loadBackupList();
    // Load file-based settings (app name, backup dir)
    void api<{ appName?: string; backupDir?: string }>('/file-settings').then((fs) => {
      (document.getElementById('settings-app-name') as HTMLInputElement).value = fs.appName || '';
      (document.getElementById('settings-backup-dir') as HTMLInputElement).value = fs.backupDir || '';
    });
  });

  closeBtn.addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.style.display = 'none';
    }
  });

  // Trash cleanup days
  const trashInput = document.getElementById('settings-trash-days') as HTMLInputElement;
  let trashTimeout: ReturnType<typeof setTimeout> | null = null;
  trashInput.addEventListener('input', () => {
    if (trashTimeout) clearTimeout(trashTimeout);
    trashTimeout = setTimeout(() => {
      const val = Math.max(1, parseInt(trashInput.value, 10) || 3);
      trashInput.value = String(val);
      state.settings.trash_cleanup_days = val;
      void api('/settings', { method: 'PATCH', body: { trash_cleanup_days: String(val) } });
    }, 500);
  });

  // Verified cleanup days
  const verifiedInput = document.getElementById('settings-verified-days') as HTMLInputElement;
  let verifiedTimeout: ReturnType<typeof setTimeout> | null = null;
  verifiedInput.addEventListener('input', () => {
    if (verifiedTimeout) clearTimeout(verifiedTimeout);
    verifiedTimeout = setTimeout(() => {
      const val = Math.max(1, parseInt(verifiedInput.value, 10) || 30);
      verifiedInput.value = String(val);
      state.settings.verified_cleanup_days = val;
      void api('/settings', { method: 'PATCH', body: { verified_cleanup_days: String(val) } });
    }, 500);
  });

  // App name (file-based setting)
  const appNameInput = document.getElementById('settings-app-name') as HTMLInputElement;
  const appNameHint = document.getElementById('settings-app-name-hint')!;
  let appNameTimeout: ReturnType<typeof setTimeout> | null = null;
  appNameInput.addEventListener('input', () => {
    if (appNameTimeout) clearTimeout(appNameTimeout);
    appNameTimeout = setTimeout(() => {
      const val = appNameInput.value.trim();
      void api('/file-settings', { method: 'PATCH', body: { appName: val } }).then(() => {
        const displayName = val || 'Hot Sheet';
        document.title = displayName;
        const h1 = document.querySelector('.app-title h1');
        if (h1) h1.textContent = displayName;
        appNameHint.textContent = val ? 'Saved. Restart the desktop app to update the title bar.' : 'Using default name.';
      });
    }, 800);
  });

  // Check for Updates button
  const checkUpdatesBtn = document.getElementById('check-updates-btn') as HTMLButtonElement;
  const checkUpdatesStatus = document.getElementById('check-updates-status')!;
  checkUpdatesBtn.addEventListener('click', async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    checkUpdatesBtn.disabled = true;
    checkUpdatesBtn.textContent = 'Checking...';
    checkUpdatesStatus.textContent = '';
    try {
      const version = (await invoke('check_for_update')) as string | null;
      if (version) {
        checkUpdatesStatus.textContent = `Update available: v${version}`;
        showUpdateBanner(version);
      } else {
        checkUpdatesStatus.textContent = 'Your software is up to date.';
      }
    } catch {
      checkUpdatesStatus.textContent = 'Could not check for updates.';
    }
    checkUpdatesBtn.textContent = 'Check for Updates';
    checkUpdatesBtn.disabled = false;
  });

  // Backup directory (file-based setting)
  const backupDirInput = document.getElementById('settings-backup-dir') as HTMLInputElement;
  const backupDirHint = document.getElementById('settings-backup-dir-hint')!;
  let backupDirTimeout: ReturnType<typeof setTimeout> | null = null;
  backupDirInput.addEventListener('input', () => {
    if (backupDirTimeout) clearTimeout(backupDirTimeout);
    backupDirTimeout = setTimeout(() => {
      const val = backupDirInput.value.trim();
      void api('/file-settings', { method: 'PATCH', body: { backupDir: val } }).then(() => {
        backupDirHint.textContent = val ? 'Saved. New backups will use this location.' : 'Using default location inside the data directory.';
      });
    }, 800);
  });
}

// --- Tauri update notification ---

async function checkForUpdate() {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  // Show the "Check for Updates" section in settings
  const section = document.getElementById('settings-updates-section');
  if (section) section.style.display = '';

  // The Rust update check is async and may not have completed yet.
  // Poll a few times with increasing delays to catch it.
  const delays = [0, 3000, 10000];
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const version = (await invoke('get_pending_update')) as string | null;
      if (version) {
        showUpdateBanner(version);
        return;
      }
    } catch {
      return;
    }
  }
}

function getTauriInvoke(): ((cmd: string) => Promise<unknown>) | null {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke: (cmd: string) => Promise<unknown> } }
    | undefined;
  return tauri?.core?.invoke ?? null;
}

function showUpdateBanner(version: string) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;

  const label = document.getElementById('update-banner-label');
  if (label) label.textContent = `Update available: v${version}`;

  banner.style.display = 'flex';

  const installBtn = document.getElementById('update-install-btn') as HTMLButtonElement | null;
  installBtn?.addEventListener('click', async () => {
    if (!installBtn) return;
    installBtn.textContent = 'Installing...';
    installBtn.disabled = true;
    try {
      const invoke = getTauriInvoke();
      await invoke?.('install_update');
      if (label) label.textContent = 'Update installed! Restart the app to apply.';
      installBtn.style.display = 'none';
    } catch {
      installBtn.textContent = 'Install Failed';
      installBtn.disabled = false;
    }
  });

  const dismissBtn = document.getElementById('update-banner-dismiss');
  dismissBtn?.addEventListener('click', () => {
    banner.style.display = 'none';
  });
}

// --- Skills notification ---

function showSkillsBanner() {
  const banner = document.getElementById('skills-banner');
  if (!banner) return;
  banner.style.display = 'flex';
  const dismissBtn = document.getElementById('skills-banner-dismiss');
  dismissBtn?.addEventListener('click', () => { banner.style.display = 'none'; });
}

// --- Copy AI prompt ---

function bindCopyPrompt() {
  const section = document.getElementById('copy-prompt-section')!;
  const btn = document.getElementById('copy-prompt-btn')!;
  const label = document.getElementById('copy-prompt-label')!;
  const icon = document.getElementById('copy-prompt-icon')!;
  let prompt = '';

  void api<{ prompt: string; skillCreated: boolean }>('/worklist-info').then((info) => {
    prompt = info.prompt;
    section.style.display = '';
    if (info.skillCreated) {
      showSkillsBanner();
    }
  });

  btn.addEventListener('click', () => {
    if (prompt === '') return;
    void navigator.clipboard.writeText(prompt).then(() => {
      label.textContent = 'Copied!';
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
      setTimeout(() => {
        label.textContent = 'Copy AI prompt';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    });
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

// --- Sidebar navigation ---

function getDropAction(view: string): { action: string; value: unknown } | null {
  if (view === 'up-next') return { action: 'up_next', value: true };
  if (view === 'open') return { action: 'status', value: 'not_started' };
  if (view === 'completed') return { action: 'status', value: 'completed' };
  if (view === 'verified') return { action: 'status', value: 'verified' };
  if (view === 'backlog') return { action: 'status', value: 'backlog' };
  if (view === 'archive') return { action: 'status', value: 'archive' };
  if (view === 'trash') return { action: 'delete', value: null };
  if (view.startsWith('category:')) return { action: 'category', value: view.split(':')[1] };
  if (view.startsWith('priority:')) return { action: 'priority', value: view.split(':')[1] };
  return null;
}

async function applyDropAction(view: string, ids: number[]) {
  const drop = getDropAction(view);
  if (!drop) return;

  if (drop.action === 'delete') {
    await api('/tickets/batch', { method: 'POST', body: { ids, action: 'delete' } });
  } else {
    await api('/tickets/batch', { method: 'POST', body: { ids, action: drop.action, value: drop.value } });
  }
  void loadTickets();
}

function bindSidebar() {
  const items = document.querySelectorAll('.sidebar-item[data-view]');
  items.forEach(item => {
    item.addEventListener('click', () => {
      items.forEach(i => { i.classList.remove('active'); });
      item.classList.add('active');
      state.view = (item as HTMLElement).dataset.view!;
      state.selectedIds.clear();
      updateLayoutToggle();
      void loadTickets();
    });

    // Drop target support
    const view = (item as HTMLElement).dataset.view!;
    if (!getDropAction(view)) return;

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = 'move';
      item.classList.add('drop-target');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-target');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-target');
      const ids = [...draggedTicketIds];
      if (ids.length === 0) return;
      void applyDropAction(view, ids);
    });
  });
}

// --- Sort controls ---

function bindSortControls() {
  const select = document.getElementById('sort-select') as HTMLSelectElement;
  select.addEventListener('change', () => {
    const [sortBy, sortDir] = select.value.split(':');
    state.sortBy = sortBy;
    state.sortDir = sortDir;
    void loadTickets();
  });
}

// --- Search ---

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

function bindSearchInput() {
  const input = document.getElementById('search-input') as HTMLInputElement;
  input.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = input.value;
      void loadTickets();
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.search = '';
      void loadTickets();
    }
  });
}

// --- Batch toolbar ---

function bindBatchToolbar() {
  const batchCategory = document.getElementById('batch-category') as HTMLSelectElement;
  batchCategory.addEventListener('change', async () => {
    if (!batchCategory.value) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'category', value: batchCategory.value },
    });
    batchCategory.value = '';
    void loadTickets();
  });

  const batchPriority = document.getElementById('batch-priority') as HTMLSelectElement;
  batchPriority.addEventListener('change', async () => {
    if (!batchPriority.value) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'priority', value: batchPriority.value },
    });
    batchPriority.value = '';
    void loadTickets();
  });

  const batchStatus = document.getElementById('batch-status') as HTMLSelectElement;
  batchStatus.addEventListener('change', async () => {
    if (!batchStatus.value) return;
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'status', value: batchStatus.value },
    });
    batchStatus.value = '';
    void loadTickets();
  });

  document.getElementById('batch-upnext')!.addEventListener('click', async () => {
    const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
    // Toggle: if any selected ticket is NOT up_next, set all to true; otherwise set all to false
    const allUpNext = selectedTickets.every(t => t.up_next);
    const settingUpNext = !allUpNext;

    if (settingUpNext) {
      // Reopen any done tickets so they can be added to Up Next
      const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
      if (doneTickets.length > 0) {
        await api('/tickets/batch', {
          method: 'POST',
          body: { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
        });
      }
    }

    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'up_next', value: settingUpNext },
    });
    void loadTickets();
  });

  document.getElementById('batch-delete')!.addEventListener('click', async () => {
    await api('/tickets/batch', {
      method: 'POST',
      body: { ids: Array.from(state.selectedIds), action: 'delete' },
    });
    state.selectedIds.clear();
    void loadTickets();
  });

  // Select-all checkbox
  document.getElementById('batch-select-all')!.addEventListener('change', (e) => {
    const checkbox = e.target as HTMLInputElement;
    if (checkbox.checked) {
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
    } else {
      state.selectedIds.clear();
    }
    renderTicketList();
  });
}

// --- Detail panel ---

let detailSaveTimeout: ReturnType<typeof setTimeout> | null = null;

function bindDetailPanel() {
  document.getElementById('detail-close')!.addEventListener('click', closeDetail);

  // Auto-save detail fields
  const fields = ['detail-title', 'detail-details'];
  for (const fieldId of fields) {
    const el = document.getElementById(fieldId) as HTMLInputElement | HTMLTextAreaElement;
    el.addEventListener('input', () => {
      if (detailSaveTimeout) clearTimeout(detailSaveTimeout);
      detailSaveTimeout = setTimeout(() => {
        if (state.activeTicketId == null) return;
        const key = fieldId.replace('detail-', '');
        void api(`/tickets/${state.activeTicketId}`, {
          method: 'PATCH',
          body: { [key]: el.value },
        }).then(() => void loadTickets());
      }, 300);
    });
  }

  // Dropdowns save immediately
  const selects = ['detail-category', 'detail-priority', 'detail-status'];
  for (const selId of selects) {
    const el = document.getElementById(selId) as HTMLSelectElement;
    el.addEventListener('change', async () => {
      if (state.activeTicketId == null) return;
      const key = selId.replace('detail-', '');
      await api(`/tickets/${state.activeTicketId}`, {
        method: 'PATCH',
        body: { [key]: el.value },
      });
      void loadTickets();
    });
  }

  // Up Next checkbox
  document.getElementById('detail-upnext')!.addEventListener('change', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    const checkbox = document.getElementById('detail-upnext') as HTMLInputElement;
    // If adding a completed/verified ticket to Up Next, reopen it
    if (checkbox.checked && ticket && (ticket.status === 'completed' || ticket.status === 'verified')) {
      await api(`/tickets/${state.activeTicketId}`, {
        method: 'PATCH',
        body: { status: 'not_started', up_next: true },
      });
    } else {
      await api(`/tickets/${state.activeTicketId}/up-next`, { method: 'POST' });
    }
    void loadTickets();
    openDetail(state.activeTicketId);
  });

  // File upload
  document.getElementById('detail-file-input')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || state.activeTicketId == null) return;
    await apiUpload(`/tickets/${state.activeTicketId}/attachments`, file);
    input.value = '';
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
      if (attId) void api(`/attachments/${attId}/reveal`, { method: 'POST' });
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

// --- Clipboard formatting ---

function parseNotes(raw: string): { text: string; created_at: string }[] {
  if (!raw || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  if (raw.trim()) return [{ text: raw, created_at: '' }];
  return [];
}

function formatTicketForClipboard(ticket: Ticket): string {
  const lines: string[] = [];
  lines.push(`${ticket.ticket_number}: ${ticket.title}`);

  if (ticket.details.trim()) {
    lines.push('');
    lines.push(ticket.details.trim());
  }

  const notes = parseNotes(ticket.notes);
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`- ${note.text}`);
    }
  }

  return lines.join('\n');
}

// --- Global keyboard shortcuts ---

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input/textarea (except specific shortcuts)
    const tag = (e.target as HTMLElement).tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Close settings dialog on Escape
    const overlay = document.getElementById('settings-overlay')!;
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      return;
    }

    if (e.key === 'Escape') {
      if (state.selectedIds.size > 0) {
        state.selectedIds.clear();
        renderTicketList();
      }
      return;
    }

    // Cmd/Ctrl+A: select all visible tickets
    if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInput) {
      e.preventDefault();
      state.selectedIds.clear();
      for (const t of state.tickets) {
        state.selectedIds.add(t.id);
      }
      renderTicketList();
      return;
    }

    // Cmd/Ctrl+D: toggle up next for all selected tickets
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
      if (state.selectedIds.size > 0) {
        e.preventDefault();
        const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
        const allUpNext = selectedTickets.every(t => t.up_next);
        const settingUpNext = !allUpNext;
        if (settingUpNext) {
          const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
          if (doneTickets.length > 0) {
            void api('/tickets/batch', {
              method: 'POST',
              body: { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
            }).then(() =>
              api('/tickets/batch', {
                method: 'POST',
                body: { ids: Array.from(state.selectedIds), action: 'up_next', value: true },
              })
            ).then(() => void loadTickets());
            return;
          }
        }
        void api('/tickets/batch', {
          method: 'POST',
          body: { ids: Array.from(state.selectedIds), action: 'up_next', value: settingUpNext },
        }).then(() => void loadTickets());
      }
      return;
    }

    // Cmd/Ctrl+C: copy selected ticket(s) info to clipboard
    // Opt+Cmd/Ctrl+C: force ticket copy even when in a text field
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && state.selectedIds.size > 0) {
      // Let native copy work in text fields (unless Alt/Option forces ticket copy)
      if (isInput && !e.altKey) { /* native copy */ }
      else {
        // Also let native copy work when text is selected on the page
        const sel = !e.altKey && window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim() !== '') { /* native copy */ }
        else {
          e.preventDefault();
          const selected = state.tickets.filter(t => state.selectedIds.has(t.id));
          const text = selected.map(formatTicketForClipboard).join('\n\n');
          void navigator.clipboard.writeText(text);
          return;
        }
      }
    }

    // Cmd/Ctrl+N: focus draft input (works everywhere)
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      focusDraftInput();
      return;
    }

    // Cmd/Ctrl+F: focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      (document.getElementById('search-input') as HTMLInputElement).focus();
      return;
    }

    // N: focus draft input (when not in an input)
    if (e.key === 'n' && !isInput) {
      e.preventDefault();
      focusDraftInput();
      return;
    }
  });
}

// --- Long polling for live updates ---

let pollVersion = 0;

function startLongPoll() {
  async function poll() {
    try {
      const result = await api<{ version: number }>(`/poll?version=${pollVersion}`);
      if (result.version > pollVersion) {
        pollVersion = result.version;
        if (!state.backupPreview?.active) void loadTickets();
      }
    } catch {
      // Server down — wait longer before retry
      await new Promise(r => setTimeout(r, 5000));
    }
    // Continue polling
    setTimeout(poll, 100);
  }
  void poll();
}

void init();
