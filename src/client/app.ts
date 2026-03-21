import { api, apiUpload } from './api.js';
import { bindBackupsUI, loadBackupList } from './backups.js';
import { applyDetailPosition, applyDetailSize, closeDetail, initResize, openDetail, updateStats } from './detail.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import type { AppSettings, CategoryDef, Ticket } from './state.js';
import { getCategoryColor, state } from './state.js';
import { cancelPendingSave, canUseColumnView, draggedTicketIds, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { canRedo, canUndo, performRedo, performUndo, recordTextChange, trackedBatch, trackedCompoundBatch, trackedPatch } from './undo/actions.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function init() {
  await loadSettings();
  await loadCategories();
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
  bindGlassbox();
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

async function loadCategories() {
  try {
    const categories = await api<CategoryDef[]>('/categories');
    if (categories.length > 0) state.categories = categories;
  } catch { /* use defaults */ }
  rebuildCategoryUI();
}

function rebuildCategoryUI() {
  // Rebuild sidebar category buttons
  const sidebarSection = document.querySelector('.sidebar-section:nth-child(3)');
  if (sidebarSection) {
    const label = sidebarSection.querySelector('.sidebar-label');
    sidebarSection.innerHTML = '';
    if (label) sidebarSection.appendChild(label);
    for (const cat of state.categories) {
      const btn = document.createElement('button');
      btn.className = 'sidebar-item';
      btn.dataset.view = `category:${cat.id}`;
      btn.innerHTML = `<span class="cat-dot" style="background:${cat.color}"></span> ${escapeHtml(cat.label)}`;
      if (state.view === `category:${cat.id}`) btn.classList.add('active');
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        btn.classList.add('active');
        state.view = `category:${cat.id}`;
        state.selectedIds.clear();
        void loadTickets();
      });
      sidebarSection.appendChild(btn);
    }
  }

  // Rebuild batch toolbar category dropdown
  const batchCat = document.getElementById('batch-category') as HTMLSelectElement | null;
  if (batchCat) {
    batchCat.innerHTML = '<option value="">Category...</option>';
    for (const cat of state.categories) {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.label;
      batchCat.appendChild(opt);
    }
  }

  // Rebuild detail panel category dropdown
  const detailCat = document.getElementById('detail-category') as HTMLSelectElement | null;
  if (detailCat) {
    detailCat.innerHTML = '';
    for (const cat of state.categories) {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.label;
      detailCat.appendChild(opt);
    }
  }
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

  // Tab switching
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-tab-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = (tab as HTMLElement).dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.settings-tab-panel[data-panel="${target}"]`)?.classList.add('active');
    });
  });

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
        // Close settings panel so the update banner is visible
        document.getElementById('settings-overlay')!.style.display = 'none';
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

  // --- Category management ---
  bindCategorySettings();
}

function renderCategoryList() {
  const container = document.getElementById('category-list')!;
  container.innerHTML = '';

  for (let i = 0; i < state.categories.length; i++) {
    const cat = state.categories[i];
    const row = document.createElement('div');
    row.className = 'category-row';
    row.innerHTML = `<input type="color" class="category-color-input" value="${cat.color}" title="Color" />`
      + `<input type="text" class="category-label-input" value="${escapeAttr(cat.label)}" placeholder="Label" title="Display name" />`
      + `<input type="text" class="category-short-input" value="${escapeAttr(cat.shortLabel)}" placeholder="ABR" title="Short label (3 chars)" maxlength="4" />`
      + `<input type="text" class="category-key-input" value="${escapeAttr(cat.shortcutKey)}" placeholder="k" title="Keyboard shortcut" maxlength="1" />`
      + `<input type="text" class="category-desc-input" value="${escapeAttr(cat.description)}" placeholder="Description..." title="Description (for AI tools)" />`
      + `<button class="category-delete-btn" title="Remove">&times;</button>`;

    const inputs = row.querySelectorAll('input');
    const [colorInput, labelInput, shortInput, keyInput, descInput] = inputs as unknown as HTMLInputElement[];

    const scheduleSync = () => {
      debouncedCategorySync();
    };

    colorInput.addEventListener('input', () => { state.categories[i].color = colorInput.value; scheduleSync(); });
    labelInput.addEventListener('input', () => {
      state.categories[i].label = labelInput.value;
      // Auto-generate ID from label for new categories
      if (!cat.id || cat.id === '') {
        state.categories[i].id = labelInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      }
      scheduleSync();
    });
    shortInput.addEventListener('input', () => { state.categories[i].shortLabel = shortInput.value.toUpperCase(); scheduleSync(); });
    keyInput.addEventListener('input', () => {
      const key = keyInput.value.toLowerCase().slice(0, 1);
      keyInput.value = key;
      state.categories[i].shortcutKey = key;
      checkShortcutConflicts();
      scheduleSync();
    });
    descInput.addEventListener('input', () => { state.categories[i].description = descInput.value; scheduleSync(); });

    row.querySelector('.category-delete-btn')!.addEventListener('click', () => {
      state.categories.splice(i, 1);
      renderCategoryList();
      debouncedCategorySync();
    });

    container.appendChild(row);
  }

  checkShortcutConflicts();
}

function checkShortcutConflicts() {
  const keyInputs = document.querySelectorAll('.category-key-input');
  const seen = new Map<string, number[]>();

  state.categories.forEach((cat, i) => {
    if (cat.shortcutKey) {
      const key = cat.shortcutKey.toLowerCase();
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(i);
    }
  });

  keyInputs.forEach((input, i) => {
    const key = state.categories[i]?.shortcutKey?.toLowerCase();
    if (key && seen.get(key)!.length > 1) {
      input.classList.add('category-key-conflict');
    } else {
      input.classList.remove('category-key-conflict');
    }
  });
}

let categorySyncTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedCategorySync() {
  if (categorySyncTimeout) clearTimeout(categorySyncTimeout);
  categorySyncTimeout = setTimeout(async () => {
    await api('/categories', { method: 'PUT', body: state.categories });
    rebuildCategoryUI();
  }, 500);
}

function bindCategorySettings() {
  // Add button
  document.getElementById('category-add-btn')!.addEventListener('click', () => {
    state.categories.push({
      id: '',
      label: '',
      shortLabel: '',
      color: '#6b7280',
      shortcutKey: '',
      description: '',
    });
    renderCategoryList();
    // Focus the label input of the new row
    const rows = document.querySelectorAll('.category-row');
    const last = rows[rows.length - 1];
    (last?.querySelector('.category-label-input') as HTMLInputElement)?.focus();
  });

  // Preset selector
  const presetSelect = document.getElementById('category-preset-select') as HTMLSelectElement;
  void api<{ id: string; name: string }[]>('/category-presets').then(presets => {
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    }
  });

  presetSelect.addEventListener('change', async () => {
    if (!presetSelect.value) return;
    const presets = await api<{ id: string; name: string; categories: CategoryDef[] }[]>('/category-presets');
    const preset = presets.find(p => p.id === presetSelect.value);
    if (preset) {
      state.categories = [...preset.categories];
      await api('/categories', { method: 'PUT', body: state.categories });
      renderCategoryList();
      rebuildCategoryUI();
    }
    presetSelect.value = '';
  });

  // Render initial list when settings dialog opens
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => {
    renderCategoryList();
  });
}

// --- Tauri update notification ---

async function checkForUpdate() {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  // Show the "Updates" tab and panel in settings
  const section = document.getElementById('settings-updates-section');
  if (section) section.style.display = '';
  const updatesTab = document.getElementById('settings-tab-updates');
  if (updatesTab) updatesTab.style.display = '';

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
  const affected = state.tickets.filter(t => ids.includes(t.id));

  if (drop.action === 'delete') {
    await trackedBatch(affected, { ids, action: 'delete' }, 'Delete tickets');
  } else {
    await trackedBatch(affected, { ids, action: drop.action, value: drop.value }, `Change ${drop.action}`);
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
    const ids = Array.from(state.selectedIds);
    const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
    await trackedBatch(affected, { ids, action: 'category', value: batchCategory.value }, 'Batch change category');
    batchCategory.value = '';
    void loadTickets();
  });

  const batchPriority = document.getElementById('batch-priority') as HTMLSelectElement;
  batchPriority.addEventListener('change', async () => {
    if (!batchPriority.value) return;
    const ids = Array.from(state.selectedIds);
    const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
    await trackedBatch(affected, { ids, action: 'priority', value: batchPriority.value }, 'Batch change priority');
    batchPriority.value = '';
    void loadTickets();
  });

  const batchStatus = document.getElementById('batch-status') as HTMLSelectElement;
  batchStatus.addEventListener('change', async () => {
    if (!batchStatus.value) return;
    const ids = Array.from(state.selectedIds);
    const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
    await trackedBatch(affected, { ids, action: 'status', value: batchStatus.value }, 'Batch change status');
    batchStatus.value = '';
    void loadTickets();
  });

  document.getElementById('batch-upnext')!.addEventListener('click', async () => {
    const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
    const allUpNext = selectedTickets.every(t => t.up_next);
    const settingUpNext = !allUpNext;
    const ids = Array.from(state.selectedIds);

    if (settingUpNext) {
      const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
      if (doneTickets.length > 0) {
        const ops = [
          { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
          { ids, action: 'up_next', value: true },
        ];
        await trackedCompoundBatch(selectedTickets, ops, 'Batch toggle up next');
      } else {
        await trackedBatch(selectedTickets, { ids, action: 'up_next', value: true }, 'Batch toggle up next');
      }
    } else {
      await trackedBatch(selectedTickets, { ids, action: 'up_next', value: false }, 'Batch toggle up next');
    }
    void loadTickets();
  });

  document.getElementById('batch-delete')!.addEventListener('click', async () => {
    const ids = Array.from(state.selectedIds);
    const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
    await trackedBatch(affected, { ids, action: 'delete' }, 'Batch delete');
    state.selectedIds.clear();
    void loadTickets();
  });

  // More actions menu
  const batchMore = document.getElementById('batch-more')!;
  batchMore.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchMore, [
      {
        label: 'Duplicate',
        key: 'd',
        action: async () => {
          const ids = Array.from(state.selectedIds);
          const created = await api<Ticket[]>('/tickets/duplicate', {
            method: 'POST',
            body: { ids },
          });
          state.selectedIds.clear();
          for (const t of created) state.selectedIds.add(t.id);
          void loadTickets();
        },
      },
      {
        label: 'Move to Backlog',
        key: 'b',
        action: async () => {
          const ids = Array.from(state.selectedIds);
          const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
          await trackedBatch(affected, { ids, action: 'status', value: 'backlog' }, 'Move to backlog');
          state.selectedIds.clear();
          void loadTickets();
        },
      },
      {
        label: 'Archive',
        key: 'a',
        action: async () => {
          const ids = Array.from(state.selectedIds);
          const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
          await trackedBatch(affected, { ids, action: 'status', value: 'archive' }, 'Archive');
          state.selectedIds.clear();
          void loadTickets();
        },
      },
    ]);
    document.body.appendChild(menu);
    positionDropdown(menu, batchMore);
    menu.style.visibility = '';
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
      // Record text change for undo (coalesces rapid edits)
      const ticket = state.tickets.find(t => t.id === state.activeTicketId);
      if (ticket) {
        const key = fieldId.replace('detail-', '');
        recordTextChange(ticket, key, el.value);
      }
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
      const ticket = state.tickets.find(t => t.id === state.activeTicketId);
      const key = selId.replace('detail-', '');
      if (ticket) {
        await trackedPatch(ticket, { [key]: el.value }, `Change ${key}`);
      } else {
        await api(`/tickets/${state.activeTicketId}`, {
          method: 'PATCH',
          body: { [key]: el.value },
        });
      }
      void loadTickets();
    });
  }

  // Up Next checkbox
  document.getElementById('detail-upnext')!.addEventListener('change', async () => {
    if (state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    const checkbox = document.getElementById('detail-upnext') as HTMLInputElement;
    if (ticket) {
      if (checkbox.checked && (ticket.status === 'completed' || ticket.status === 'verified')) {
        await trackedPatch(ticket, { status: 'not_started', up_next: true }, 'Toggle up next');
      } else {
        await trackedPatch(ticket, { up_next: !ticket.up_next }, 'Toggle up next');
      }
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

function triggerUndo() {
  console.log('[undo] triggerUndo called, canUndo:', canUndo());
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  performUndo().then(() => console.log('[undo] performUndo completed')).catch((e) => console.error('[undo] performUndo error:', e));
}

function triggerRedo() {
  console.log('[undo] triggerRedo called, canRedo:', canRedo());
  if (detailSaveTimeout) { clearTimeout(detailSaveTimeout); detailSaveTimeout = null; }
  cancelPendingSave();
  performRedo().then(() => console.log('[undo] performRedo completed')).catch((e) => console.error('[undo] performRedo error:', e));
}

function bindKeyboardShortcuts() {
  // Tauri menu events for Undo/Redo (native menu captures Cmd+Z before the WebView)
  window.addEventListener('app:undo', triggerUndo);
  window.addEventListener('app:redo', triggerRedo);

  // Keyboard fallback for browser mode (non-Tauri) — capture phase
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        triggerRedo();
      } else {
        triggerUndo();
      }
    }
  }, true);

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
        const ids = Array.from(state.selectedIds);
        if (settingUpNext) {
          const doneTickets = selectedTickets.filter(t => t.status === 'completed' || t.status === 'verified');
          if (doneTickets.length > 0) {
            void trackedCompoundBatch(selectedTickets, [
              { ids: doneTickets.map(t => t.id), action: 'status', value: 'not_started' },
              { ids, action: 'up_next', value: true },
            ], 'Toggle up next').then(() => void loadTickets());
            return;
          }
        }
        void trackedBatch(
          selectedTickets,
          { ids, action: 'up_next', value: settingUpNext },
          'Toggle up next',
        ).then(() => void loadTickets());
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
