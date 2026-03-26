import { raw } from '../jsx-runtime.js';
import { suppressAnimation } from './animate.js';
import { api, apiUpload } from './api.js';
import { bindBackupsUI, loadBackupList } from './backups.js';
import { initCustomViews, loadCustomViews } from './customViews.js';
import { renderDashboard, renderSidebarWidget } from './dashboard.js';
import { showPrintDialog } from './print.js';
import { applyDetailPosition, applyDetailSize, closeDetail, displayTag, hasTag, initResize, normalizeTag, openDetail, parseTags, refreshDetail, renderDetailTags, updateDetailCategory, updateDetailPriority, updateDetailStatus, updateStats } from './detail.js';
import { toElement } from './dom.js';
import { closeAllMenus, createDropdown, positionDropdown } from './dropdown.js';
import type { AppSettings, CategoryDef, NotifyLevel, Ticket } from './state.js';
import { getCategoryColor, getPriorityColor, getPriorityIcon, getStatusIcon, state } from './state.js';
import { cancelPendingSave, canUseColumnView, draggedTicketIds, focusDraftInput, loadTickets, renderTicketList } from './ticketList.js';
import { canRedo, canUndo, performRedo, performUndo, pushNotesUndo, recordTextChange, trackedBatch, trackedCompoundBatch, trackedPatch } from './undo/actions.js';

async function init() {
  try {
  await loadSettings();
  await loadCategories();
  await loadCustomViews();
  void loadAppName();
  suppressAnimation();
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
  initCustomViews(() => { void loadTickets(); });
  initResize();
  startLongPoll();
  void checkForUpdate();
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
    if (el) el.innerHTML = `<div style="padding:20px;color:red">Init error: ${err}</div>`;
  }
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
    if (settings.notify_permission === 'none' || settings.notify_permission === 'once' || settings.notify_permission === 'persistent') {
      state.settings.notify_permission = settings.notify_permission;
    }
    if (settings.notify_completed === 'none' || settings.notify_completed === 'once' || settings.notify_completed === 'persistent') {
      state.settings.notify_completed = settings.notify_completed;
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
    (document.getElementById('settings-notify-permission') as HTMLSelectElement).value = state.settings.notify_permission;
    (document.getElementById('settings-notify-completed') as HTMLSelectElement).value = state.settings.notify_completed;
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

  // App icon picker
  const iconBtn = document.getElementById('app-icon-picker-btn')!;
  const iconPreview = document.getElementById('app-icon-preview') as HTMLImageElement;
  let currentIcon = 'default';

  // Load current icon from file-settings
  void api<{ appIcon?: string }>('/file-settings').then((fs) => {
    if (fs.appIcon) {
      currentIcon = fs.appIcon;
      iconPreview.src = `/static/assets/icon-${currentIcon}.png`;
    }
  });

  iconBtn.addEventListener('click', () => {
    // Remove existing popup
    document.querySelectorAll('.icon-variant-popup').forEach(el => el.remove());

    const variants = ['default', ...Array.from({ length: 9 }, (_, i) => `variant-${i + 1}`)];
    const popup = toElement(
      <div className="icon-variant-popup">
        {variants.map(v =>
          <button className={`icon-variant-option${v === currentIcon ? ' active' : ''}`} data-variant={v}>
            <img src={`/static/assets/icon-${v}.png`} width="40" height="40" />
          </button>
        )}
      </div>
    );

    popup.querySelectorAll('.icon-variant-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const variant = (btn as HTMLElement).dataset.variant!;
        currentIcon = variant;
        iconPreview.src = `/static/assets/icon-${variant}.png`;
        popup.remove();

        // Save to file-settings
        void api('/file-settings', { method: 'PATCH', body: { appIcon: variant } });

        // Apply via Tauri if available
        const invoke = getTauriInvoke();
        if (invoke) {
          invoke('set_app_icon', { variant }).catch(() => {});
        }
      });
    });

    const rect = iconBtn.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(popup);

    // Close on outside click
    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
      };
      document.addEventListener('click', close);
    }, 0);
  });

  // Notification dropdowns
  const notifyPermSelect = document.getElementById('settings-notify-permission') as HTMLSelectElement;
  const notifyCompSelect = document.getElementById('settings-notify-completed') as HTMLSelectElement;
  notifyPermSelect.addEventListener('change', () => {
    state.settings.notify_permission = notifyPermSelect.value as NotifyLevel;
    void api('/settings', { method: 'PATCH', body: { notify_permission: notifyPermSelect.value } });
  });
  notifyCompSelect.addEventListener('change', () => {
    state.settings.notify_completed = notifyCompSelect.value as NotifyLevel;
    void api('/settings', { method: 'PATCH', body: { notify_completed: notifyCompSelect.value } });
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

  // --- Context tab (auto-context) ---
  bindAutoContextSettings();

  // --- Experimental tab (channel + custom commands) ---
  bindExperimentalSettings();

  // --- Category management ---
  bindCategorySettings();
}

function renderCategoryList() {
  const container = document.getElementById('category-list')!;
  container.innerHTML = '';

  for (let i = 0; i < state.categories.length; i++) {
    const cat = state.categories[i];
    const row = toElement(
      <div className="category-row">
        <input type="color" className="category-color-input" value={cat.color} title="Color" />
        <input type="text" className="category-label-input" value={cat.label} placeholder="Label" title="Display name" />
        <input type="text" className="category-short-input" value={cat.shortLabel} placeholder="ABR" title="Short label (3 chars)" maxlength="4" />
        <input type="text" className="category-key-input" value={cat.shortcutKey} placeholder="k" title="Keyboard shortcut" maxlength="1" />
        <input type="text" className="category-desc-input" value={cat.description} placeholder="Description..." title="Description (for AI tools)" />
        <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
      </div>
    );

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
      presetSelect.appendChild(toElement(<option value={p.id}>{p.name}</option>));
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

function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
    | undefined;
  return tauri?.core?.invoke ?? null;
}

/** Restore the saved app icon variant on page load. The Dock resets to the bundle
 *  icon during app launch, so we re-apply it from the client once the page is ready. */
async function restoreAppIcon() {
  const invoke = getTauriInvoke();
  if (!invoke) return;
  try {
    const fs = await api<{ appIcon?: string }>('/file-settings');
    if (fs.appIcon && fs.appIcon !== 'default') {
      await invoke('set_app_icon', { variant: fs.appIcon });
    }
  } catch { /* non-critical */ }
}

/** Request user attention — bounces dock icon in Tauri, flashes tab title in browser.
 *  @param level 'once' = single bounce, 'persistent' = keep bouncing until focused */
function requestAttention(level: 'once' | 'persistent') {
  const invoke = getTauriInvoke();
  if (invoke) {
    // Tauri: custom command that calls request_user_attention.
    // 'persistent' = Critical (bounces until focused), 'once' = Informational (single bounce).
    invoke(level === 'persistent' ? 'request_attention' : 'request_attention_once').catch(() => {});
  } else if (!document.hasFocus()) {
    // Browser: flash the tab title
    const maxFlashes = level === 'persistent' ? 30 : 6;
    const originalTitle = document.title;
    let flashes = 0;
    const interval = setInterval(() => {
      document.title = flashes % 2 === 0 ? '\u26a0 Hot Sheet needs attention' : originalTitle;
      flashes++;
      if (flashes >= maxFlashes || document.hasFocus()) {
        clearInterval(interval);
        document.title = originalTitle;
      }
    }, 800);
  }
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
  suppressAnimation();
  void loadTickets();
}

function bindSidebar() {
  const items = document.querySelectorAll('.sidebar-item[data-view]');
  items.forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      state.view = (item as HTMLElement).dataset.view!;
      state.selectedIds.clear();
      // Restore ticket list if coming from dashboard
      restoreTicketList();
      suppressAnimation();
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
    suppressAnimation();
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
      suppressAnimation();
      void loadTickets();
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.search = '';
      suppressAnimation();
      void loadTickets();
    }
  });
}

// --- Experimental Settings (Channel + Custom Commands) ---

interface CustomCommand {
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
}

// Predefined color palette for command buttons
const CMD_COLORS = [
  { value: '#e5e7eb', label: 'Neutral' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#f97316', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#6b7280', label: 'Gray' },
];

// All Lucide icons loaded from generated JSON
import ALL_LUCIDE_ICONS from './lucide-icons.json';
const CMD_ICONS: { name: string; svg: string }[] = Object.entries(ALL_LUCIDE_ICONS as Record<string, string>).map(([name, svg]) => ({ name, svg }));


function renderIconSvg(svgPath: string, size = 14, color = 'currentColor'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
}

function contrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Relative luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

// --- Auto-context settings ---

interface AutoContextEntry {
  type: 'category' | 'tag';
  key: string;
  text: string;
}

let autoContextEntries: AutoContextEntry[] = [];

function bindAutoContextSettings() {
  const list = document.getElementById('auto-context-list')!;
  const addBtn = document.getElementById('auto-context-add-btn')!;

  async function loadEntries() {
    try {
      const settings = await api<Record<string, string>>('/settings');
      if (settings.auto_context) {
        autoContextEntries = JSON.parse(settings.auto_context);
      }
    } catch { /* ignore */ }
    renderEntries();
  }

  async function saveEntries() {
    await api('/settings', { method: 'PATCH', body: { auto_context: JSON.stringify(autoContextEntries) } });
  }

  function renderEntries() {
    list.innerHTML = '';
    if (autoContextEntries.length === 0) {
      list.innerHTML = '<div style="padding:12px 0;color:var(--text-muted);font-size:13px">No auto-context entries yet. Click + Add to create one.</div>';
      return;
    }
    for (let i = 0; i < autoContextEntries.length; i++) {
      const entry = autoContextEntries[i];
      const displayKey = entry.type === 'category'
        ? (state.categories.find(c => c.id === entry.key)?.label || entry.key)
        : entry.key.replace(/\b\w/g, c => c.toUpperCase());
      const row = toElement(
        <div className="auto-context-entry">
          <div className="auto-context-header">
            <span className="auto-context-badge" data-type={entry.type}>{entry.type === 'category' ? 'Category' : 'Tag'}: {displayKey}</span>
            <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
          </div>
          <textarea className="auto-context-text" rows={3}>{entry.text}</textarea>
        </div>
      );
      const textarea = row.querySelector('.auto-context-text') as HTMLTextAreaElement;
      let saveTimeout: ReturnType<typeof setTimeout> | null = null;
      textarea.addEventListener('input', () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
          autoContextEntries[i] = { ...entry, text: textarea.value };
          void saveEntries();
        }, 500);
      });
      row.querySelector('.category-delete-btn')!.addEventListener('click', () => {
        autoContextEntries.splice(i, 1);
        void saveEntries();
        renderEntries();
      });
      list.appendChild(row);
    }
  }

  addBtn.addEventListener('click', () => {
    showAddAutoContextDialog();
  });

  function showAddAutoContextDialog() {
    // Build options: categories + known tags
    const options: { type: 'category' | 'tag'; key: string; label: string }[] = [];
    for (const cat of state.categories) {
      if (!autoContextEntries.some(e => e.type === 'category' && e.key === cat.id)) {
        options.push({ type: 'category', key: cat.id, label: `Category: ${cat.label}` });
      }
    }
    // Fetch tags
    void api<string[]>('/tags').then(tags => {
      for (const tag of tags) {
        if (!autoContextEntries.some(e => e.type === 'tag' && e.key.toLowerCase() === tag.toLowerCase())) {
          options.push({ type: 'tag', key: tag, label: `Tag: ${tag.replace(/\b\w/g, c => c.toUpperCase())}` });
        }
      }
      renderDialog(options);
    });

    function renderDialog(options: { type: 'category' | 'tag'; key: string; label: string }[]) {
      const overlay = toElement(
        <div className="custom-view-editor-overlay">
          <div className="custom-view-editor" style="width:400px">
            <div className="custom-view-editor-header">
              <span>Add Auto-Context</span>
              <button className="detail-close" id="ac-dialog-close">{'\u00d7'}</button>
            </div>
            <div className="custom-view-editor-body">
              <div className="settings-field">
                <label>Select category or tag</label>
                <input type="text" id="ac-filter" placeholder="Filter..." autocomplete="off" />
              </div>
              <div id="ac-options" className="ac-options-list"></div>
            </div>
          </div>
        </div>
      );

      const filterInput = overlay.querySelector('#ac-filter') as HTMLInputElement;
      const optionsList = overlay.querySelector('#ac-options')!;

      function renderOptions(filter: string) {
        optionsList.innerHTML = '';
        const filtered = filter ? options.filter(o => o.label.toLowerCase().includes(filter.toLowerCase())) : options;
        if (filtered.length === 0) {
          optionsList.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:13px">No matching options</div>';
          return;
        }
        for (const opt of filtered) {
          const item = toElement(<button className="ac-option-item">{opt.label}</button>);
          item.addEventListener('click', () => {
            autoContextEntries.push({ type: opt.type, key: opt.key, text: '' });
            void saveEntries();
            renderEntries();
            overlay.remove();
            // Focus the new textarea
            const textareas = list.querySelectorAll('.auto-context-text');
            const last = textareas[textareas.length - 1] as HTMLTextAreaElement | null;
            last?.focus();
          });
          optionsList.appendChild(item);
        }
      }

      renderOptions('');
      filterInput.addEventListener('input', () => renderOptions(filterInput.value));

      const close = () => overlay.remove();
      overlay.querySelector('#ac-dialog-close')!.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      document.body.appendChild(overlay);
      filterInput.focus();
    }
  }

  // Load when settings dialog opens
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => { void loadEntries(); });
}

let customCommands: CustomCommand[] = [];

function bindExperimentalSettings() {
  const experimentalTab = document.getElementById('settings-tab-experimental') as HTMLElement;
  const experimentalPanel = document.getElementById('settings-experimental-panel') as HTMLElement;
  const channelCheckbox = document.getElementById('settings-channel-enabled') as HTMLInputElement;
  const channelHint = document.getElementById('settings-channel-hint')!;
  const channelInstructions = document.getElementById('settings-channel-instructions') as HTMLElement;
  const channelCopyBtn = document.getElementById('settings-channel-copy-btn');
  const channelCmd = document.getElementById('settings-channel-cmd');
  const customCommandsSection = document.getElementById('settings-custom-commands-section') as HTMLElement;

  // Check Claude CLI when settings open
  document.getElementById('settings-btn')!.addEventListener('click', () => {
    fetch('/api/channel/claude-check').then(r => r.ok ? r.json() : null).then((check: { installed: boolean; version: string | null; meetsMinimum: boolean } | null) => {
      if (!check || !check.installed) {
        experimentalTab.style.display = 'none';
        experimentalPanel.style.display = 'none';
        return;
      }
      experimentalTab.style.display = '';
      experimentalPanel.style.display = '';
      if (!check.meetsMinimum) {
        channelHint.textContent = `Claude Code ${check.version || 'unknown'} detected but v2.1.80+ is required. Please upgrade Claude Code.`;
        channelCheckbox.disabled = true;
      } else {
        channelHint.textContent = 'Push worklist events to a running Claude Code session via MCP channels.';
        channelCheckbox.disabled = false;
      }
      renderCustomCommandSettings();
    }).catch(() => {
      experimentalTab.style.display = 'none';
      experimentalPanel.style.display = 'none';
    });
  });

  // Load channel status and custom commands
  fetch('/api/channel/status').then(r => r.ok ? r.json() : null).then(s => {
    if (s) {
      channelCheckbox.checked = s.enabled;
      if (s.enabled) {
        channelInstructions.style.display = '';
        customCommandsSection.style.display = '';
      }
    }
  }).catch(() => {});

  // Load custom commands from settings
  void api<Record<string, string>>('/settings').then(settings => {
    if (settings.custom_commands) {
      try { customCommands = JSON.parse(settings.custom_commands); } catch { /* ignore */ }
    }
    renderChannelCommands();
  });

  channelCheckbox.addEventListener('change', async () => {
    if (channelCheckbox.checked) {
      await api('/channel/enable', { method: 'POST' });
      channelInstructions.style.display = '';
      customCommandsSection.style.display = '';
    } else {
      await api('/channel/disable', { method: 'POST' });
      channelInstructions.style.display = 'none';
      customCommandsSection.style.display = 'none';
    }
    void initChannel();
    renderChannelCommands();
  });

  channelCopyBtn?.addEventListener('click', () => {
    const text = channelCmd?.textContent || '';
    void navigator.clipboard.writeText(text).then(() => {
      if (channelCopyBtn) {
        channelCopyBtn.textContent = 'Copied!';
        setTimeout(() => { channelCopyBtn.textContent = 'Copy'; }, 1500);
      }
    });
  });

  // Add command button
  document.getElementById('settings-add-command-btn')?.addEventListener('click', () => {
    customCommands.push({ name: '', prompt: '' });
    renderCustomCommandSettings();
  });
}

function showColorDropdown(anchor: HTMLElement, cmdIndex: number) {
  document.querySelectorAll('.color-dropdown-popup').forEach(p => p.remove());
  const popup = toElement(
    <div className="color-dropdown-popup">
      {CMD_COLORS.map(c =>
        <button className={`color-dropdown-item${(customCommands[cmdIndex].color || CMD_COLORS[0].value) === c.value ? ' active' : ''}`} data-color={c.value}>
          <span className="command-color-swatch" style={`background:${c.value}`}></span>
          <span>{c.label}</span>
        </button>
      )}
    </div>
  );
  popup.querySelectorAll('.color-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const color = (item as HTMLElement).dataset.color!;
      customCommands[cmdIndex] = { ...customCommands[cmdIndex], color };
      anchor.style.background = color;
      popup.remove();
      void saveCustomCommands();
    });
  });
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  // Clamp to viewport
  const popupRect = popup.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

function showIconPicker(anchor: HTMLElement, cmdIndex: number) {
  // Remove any existing picker
  document.querySelectorAll('.icon-picker-popup').forEach(p => p.remove());

  const popup = toElement(
    <div className="icon-picker-popup">
      <input type="text" className="icon-picker-search" placeholder="Search icons..." />
      <div className="icon-picker-grid"></div>
    </div>
  );

  const grid = popup.querySelector('.icon-picker-grid') as HTMLElement;
  const searchInput = popup.querySelector('.icon-picker-search') as HTMLInputElement;

  const FEATURED = ['terminal', 'git-commit', 'git-branch', 'git-pull-request', 'code', 'play', 'send', 'upload', 'download', 'refresh-cw', 'check', 'save', 'rocket', 'zap', 'search', 'file-text', 'clipboard', 'trash', 'edit', 'settings', 'bug', 'test-tube', 'database', 'lock'];

  function renderIcons(filter = '') {
    grid.innerHTML = '';
    let icons: typeof CMD_ICONS;
    if (filter) {
      icons = CMD_ICONS.filter(ic => ic.name.includes(filter.toLowerCase()));
    } else {
      // Show featured icons first, then a separator, then all
      const featured = FEATURED.map(name => CMD_ICONS.find(ic => ic.name === name)).filter(Boolean) as typeof CMD_ICONS;
      const sep = document.createElement('div');
      sep.className = 'icon-picker-separator';
      addIconButtons(featured);
      grid.appendChild(sep);
      icons = CMD_ICONS.filter(ic => !FEATURED.includes(ic.name));
    }
    addIconButtons(icons);
  }

  function addIconButtons(icons: typeof CMD_ICONS) {
    for (const ic of icons) {
      const btn = toElement(
        <button className={`icon-picker-item${customCommands[cmdIndex].icon === ic.name ? ' active' : ''}`} title={ic.name}>
          {raw(renderIconSvg(ic.svg, 18))}
        </button>
      );
      btn.addEventListener('click', () => {
        customCommands[cmdIndex] = { ...customCommands[cmdIndex], icon: ic.name };
        anchor.innerHTML = renderIconSvg(ic.svg, 16);
        popup.remove();
        void saveCustomCommands();
      });
      grid.appendChild(btn);
    }
  }

  renderIcons();
  searchInput.addEventListener('input', () => renderIcons(searchInput.value));

  // Position below anchor, clamped to viewport
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  const popupRect = popup.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
  searchInput.focus();

  // Close on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

let draggedCmdIndex: number | null = null;

function renderCustomCommandSettings() {
  const list = document.getElementById('settings-commands-list');
  if (!list) return;
  list.innerHTML = '';

  for (let i = 0; i < customCommands.length; i++) {
    const cmd = customCommands[i];
    const currentIcon = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
    const currentColor = cmd.color || CMD_COLORS[0].value;

    const row = toElement(
      <div className="settings-command-row" draggable="true" data-cmd-index={String(i)}>
        <div className="settings-command-row-header">
          <span className="command-drag-handle" title="Drag to reorder">{'\u2630'}</span>
          <button className="command-color-dropdown-btn" title="Choose color" style={`background:${currentColor}`}></button>
          <button className="command-icon-picker-btn" title="Choose icon">{raw(renderIconSvg(currentIcon.svg, 16))}</button>
          <input type="text" value={cmd.name} placeholder="Button label..." />
          <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
        </div>
        <label>Prompt sent to Claude:</label>
        <textarea placeholder="Tell Claude what to do...">{cmd.prompt}</textarea>
      </div>
    );

    const nameInput = row.querySelector('input[type="text"]') as HTMLInputElement;
    const promptArea = row.querySelector('textarea') as HTMLTextAreaElement;

    const save = () => {
      customCommands[i] = { ...customCommands[i], name: nameInput.value, prompt: promptArea.value };
      void saveCustomCommands();
    };

    nameInput.addEventListener('input', save);
    promptArea.addEventListener('input', save);

    // Color dropdown
    const colorBtn = row.querySelector('.command-color-dropdown-btn') as HTMLElement;
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showColorDropdown(colorBtn, i);
    });

    // Icon picker
    row.querySelector('.command-icon-picker-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      showIconPicker(row.querySelector('.command-icon-picker-btn') as HTMLElement, i);
    });

    row.querySelector('.category-delete-btn')!.addEventListener('click', () => {
      customCommands.splice(i, 1);
      renderCustomCommandSettings();
      void saveCustomCommands();
    });

    // Drag and drop reordering
    row.addEventListener('dragstart', (e) => {
      draggedCmdIndex = i;
      e.dataTransfer!.setData('text/plain', String(i));
      e.dataTransfer!.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); draggedCmdIndex = null; });
    row.addEventListener('dragover', (e) => {
      if (draggedCmdIndex === null) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => { row.classList.remove('drop-target'); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      if (draggedCmdIndex === null || draggedCmdIndex === i) return;
      const [moved] = customCommands.splice(draggedCmdIndex, 1);
      customCommands.splice(i, 0, moved);
      draggedCmdIndex = null;
      renderCustomCommandSettings();
      void saveCustomCommands();
    });

    list.appendChild(row);
  }
}

async function saveCustomCommands() {
  await api('/settings', { method: 'PATCH', body: { custom_commands: JSON.stringify(customCommands) } });
  renderChannelCommands();
}

function renderChannelCommands() {
  const container = document.getElementById('channel-commands-container');
  if (!container) return;
  container.innerHTML = '';

  // Only show if channel is enabled and there are commands
  const channelSection = document.getElementById('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') return;

  for (const cmd of customCommands) {
    if (!cmd.name.trim() || !cmd.prompt.trim()) continue;
    const color = cmd.color || CMD_COLORS[0].value;
    const textColor = contrastColor(color);
    const iconDef = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
    const btn = toElement(
      <button className="channel-command-btn" style={`background:${color};color:${textColor}`}>{raw(renderIconSvg(iconDef.svg, 14, textColor))}<span>{cmd.name}</span></button>
    );
    btn.addEventListener('click', () => {
      triggerChannelAndMarkBusy(cmd.prompt);
    });
    container.appendChild(btn);
  }
}

// --- Permission Overlay ---

let permissionPollInterval: ReturnType<typeof setInterval> | null = null;

function startPermissionPolling() {
  if (permissionPollInterval) return;
  permissionPollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/channel/permission');
      if (!res.ok) return;
      const data = await res.json() as { pending: { request_id: string; tool_name: string; description: string; input_preview?: string } | null };
      if (data.pending) {
        showPermissionOverlay(data.pending);
      }
    } catch { /* ignore */ }
  }, 2000);
}

function stopPermissionPolling() {
  if (permissionPollInterval) { clearInterval(permissionPollInterval); permissionPollInterval = null; }
}

function showPermissionOverlay(perm: { request_id: string; tool_name: string; description: string; input_preview?: string }) {
  const overlay = document.getElementById('permission-overlay');
  if (!overlay || overlay.style.display !== 'none') return;
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  const detail = document.getElementById('permission-overlay-detail');
  if (detail) {
    let html = `<div class="permission-tool">${perm.tool_name}: ${perm.description}</div>`;
    if (perm.input_preview) {
      html += `<pre class="permission-preview">${perm.input_preview.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    }
    detail.innerHTML = html;
  }

  overlay.style.display = '';

  function respond(behavior: 'allow' | 'deny') {
    void fetch('/api/channel/permission/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: perm.request_id, behavior }),
    });
    overlay!.style.display = 'none';
  }

  function dismiss() {
    void fetch('/api/channel/permission/dismiss', { method: 'POST' });
    overlay!.style.display = 'none';
  }

  // Use one-time click handlers via { once: true }
  document.getElementById('permission-allow-btn')?.addEventListener('click', () => respond('allow'), { once: true });
  document.getElementById('permission-deny-btn')?.addEventListener('click', () => respond('deny'), { once: true });
  document.getElementById('permission-dismiss-btn')?.addEventListener('click', dismiss, { once: true });
}

// --- Claude Channel ---

let channelAutoMode = false;
let channelDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let channelBusy = false;

function setChannelBusy(busy: boolean) {
  channelBusy = busy;
  const indicator = document.getElementById('channel-status-indicator');
  if (!indicator) return;
  const channelSection = document.getElementById('channel-play-section');
  if (!channelSection || channelSection.style.display === 'none') {
    indicator.style.display = 'none';
    return;
  }
  if (busy) {
    indicator.style.display = '';
    indicator.className = 'channel-status-indicator busy';
    indicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Claude working';
  } else {
    indicator.style.display = '';
    indicator.className = 'channel-status-indicator';
    indicator.innerHTML = '\u2713 Claude idle';
    if (state.settings.notify_completed !== 'none') {
      requestAttention(state.settings.notify_completed);
    }
    // Auto-hide after 5 seconds
    setTimeout(() => {
      if (!channelBusy && indicator) indicator.style.display = 'none';
    }, 5000);
    // In auto mode, check for more up-next items when Claude becomes idle (HS-1453)
    if (channelAutoMode) {
      channelAutoTrigger();
    }
  }
}

let channelBusyTimeout: ReturnType<typeof setTimeout> | null = null;

function triggerChannelAndMarkBusy(message?: string) {
  setChannelBusy(true);
  void api('/channel/trigger', { method: 'POST', body: { message } });
  // Timeout fallback: clear busy after 120s if Claude never calls /done
  if (channelBusyTimeout) clearTimeout(channelBusyTimeout);
  channelBusyTimeout = setTimeout(() => {
    if (channelBusy) setChannelBusy(false);
  }, 120000);
}

async function checkAndTrigger(btn: HTMLElement) {
  try {
    const stats = await api<{ up_next: number }>('/stats');
    if (stats.up_next === 0) {
      showNoUpNextAlert();
      return;
    }
  } catch { /* proceed anyway if stats fail */ }
  btn.classList.add('pulsing');
  setTimeout(() => btn.classList.remove('pulsing'), 600);
  triggerChannelAndMarkBusy();
}

function showNoUpNextAlert() {
  const existing = document.getElementById('no-upnext-alert');
  if (existing) existing.remove();
  const alert = toElement(
    <div id="no-upnext-alert" className="no-upnext-alert">
      <span>No Up Next items to process</span>
      <button className="no-upnext-dismiss">{'\u00d7'}</button>
    </div>
  );
  alert.querySelector('.no-upnext-dismiss')!.addEventListener('click', () => alert.remove());
  setTimeout(() => alert.remove(), 4000);
  const playSection = document.getElementById('channel-play-section');
  if (playSection) playSection.after(alert);
}

async function initChannel() {
  let status = { enabled: false, alive: false };
  try {
    const res = await fetch('/api/channel/status');
    if (res.ok) status = await res.json();
  } catch { /* endpoint may not exist yet */ }
  const section = document.getElementById('channel-play-section')!;
  const btn = document.getElementById('channel-play-btn')!;
  const playIcon = document.getElementById('channel-play-icon')!;
  const autoIcon = document.getElementById('channel-auto-icon')!;

  if (!status.enabled) {
    section.style.display = 'none';
    stopPermissionPolling();
    return;
  }
  section.style.display = '';
  renderChannelCommands();
  startPermissionPolling();

  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  btn.addEventListener('click', () => {
    if (clickTimer) {
      // Double click detected
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleAutoMode(btn, playIcon, autoIcon);
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (channelAutoMode) {
          // Single click while in auto mode: turn off
          toggleAutoMode(btn, playIcon, autoIcon);
        } else {
          // Single click: on-demand trigger — check for up-next items first
          void checkAndTrigger(btn);
        }
      }, 250);
    }
  });
}

let channelAutoRetryInterval: ReturnType<typeof setInterval> | null = null;

function toggleAutoMode(btn: HTMLElement, playIcon: HTMLElement, autoIcon: HTMLElement) {
  channelAutoMode = !channelAutoMode;
  if (channelAutoMode) {
    btn.classList.add('auto-mode');
    playIcon.style.display = 'none';
    autoIcon.style.display = '';
    // Start initial 5-second debounce when entering auto mode (HS-1453)
    channelAutoTrigger();
  } else {
    btn.classList.remove('auto-mode');
    playIcon.style.display = '';
    autoIcon.style.display = 'none';
    // Clear pending debounce and retry when leaving auto mode
    if (channelDebounceTimeout) { clearTimeout(channelDebounceTimeout); channelDebounceTimeout = null; }
    if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }
  }
}

/** Called when entering auto mode or when a ticket's up_next changes.
 *  Debounces for 5s, then attempts to trigger. Restarts debounce on new up-next items. (HS-1453) */
function channelAutoTrigger() {
  if (!channelAutoMode) return;
  // Restart the debounce (new up-next items restart the timer)
  if (channelDebounceTimeout) clearTimeout(channelDebounceTimeout);
  // Clear any existing retry interval — fresh debounce takes priority
  if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }

  channelDebounceTimeout = setTimeout(() => {
    channelDebounceTimeout = null;
    void attemptAutoTrigger();
  }, 5000);
}

/** After debounce, try to trigger Claude. If busy, retry every 5s until idle. (HS-1453) */
async function attemptAutoTrigger() {
  if (!channelAutoMode) return;

  // Check if there are up-next items
  try {
    const stats = await api<{ up_next: number }>('/stats');
    if (stats.up_next === 0) return;
  } catch { /* proceed anyway */ }

  if (!channelBusy) {
    // Claude is idle — trigger now
    if (channelAutoRetryInterval) { clearInterval(channelAutoRetryInterval); channelAutoRetryInterval = null; }
    triggerChannelAndMarkBusy();
  } else if (!channelAutoRetryInterval) {
    // Claude is busy — start retrying every 5 seconds
    channelAutoRetryInterval = setInterval(() => {
      if (!channelAutoMode) {
        clearInterval(channelAutoRetryInterval!);
        channelAutoRetryInterval = null;
        return;
      }
      void attemptAutoTrigger();
    }, 5000);
  }
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

// --- Shared dropdown items ---

const PRIORITY_ITEMS = [
  { key: '1', value: 'highest', label: 'Highest' },
  { key: '2', value: 'high', label: 'High' },
  { key: '3', value: 'default', label: 'Default' },
  { key: '4', value: 'low', label: 'Low' },
  { key: '5', value: 'lowest', label: 'Lowest' },
];

const STATUS_ITEMS = [
  { key: 'n', value: 'not_started', label: 'Not Started' },
  { key: 's', value: 'started', label: 'Started' },
  { key: 'c', value: 'completed', label: 'Completed' },
  { key: 'v', value: 'verified', label: 'Verified' },
  { key: 'b', value: 'backlog', label: 'Backlog' },
  { key: 'a', value: 'archive', label: 'Archive' },
];

// --- Batch toolbar ---

function bindBatchToolbar() {
  const batchCategory = document.getElementById('batch-category') as HTMLButtonElement;
  batchCategory.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchCategory, state.categories.map(c => ({
      label: c.label,
      key: c.shortcutKey,
      color: c.color,
      action: async () => {
        const ids = Array.from(state.selectedIds);
        const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
        await trackedBatch(affected, { ids, action: 'category', value: c.id }, 'Batch change category');
        void loadTickets();
      },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, batchCategory);
    menu.style.visibility = '';
  });

  const batchPriority = document.getElementById('batch-priority') as HTMLButtonElement;
  batchPriority.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchPriority, PRIORITY_ITEMS.map(p => ({
      label: p.label,
      key: p.key,
      icon: getPriorityIcon(p.value),
      iconColor: getPriorityColor(p.value),
      action: async () => {
        const ids = Array.from(state.selectedIds);
        const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
        await trackedBatch(affected, { ids, action: 'priority', value: p.value }, 'Batch change priority');
        void loadTickets();
      },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, batchPriority);
    menu.style.visibility = '';
  });

  const batchStatus = document.getElementById('batch-status') as HTMLButtonElement;
  batchStatus.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const menu = createDropdown(batchStatus, STATUS_ITEMS.map(s => ({
      label: s.label,
      key: s.key,
      icon: getStatusIcon(s.value),
      action: async () => {
        const ids = Array.from(state.selectedIds);
        const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
        await trackedBatch(affected, { ids, action: 'status', value: s.value }, 'Batch change status');
        void loadTickets();
      },
    })));
    document.body.appendChild(menu);
    positionDropdown(menu, batchStatus);
    menu.style.visibility = '';
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
    channelAutoTrigger();
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
        label: 'Tags...',
        key: 't',
        action: () => { void showTagsDialog(); },
      },
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
      { label: '', key: '', separator: true, action: () => {} },
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
    const current = btn.dataset.value || '';
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
    const current = btn.dataset.value || '';
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
    const current = btn.dataset.value || '';
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
        tagInput.value = items[acIndex]?.textContent || tagInput.value;
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

// --- Tags batch dialog ---

async function showTagsDialog() {
  const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
  if (selectedTickets.length === 0) return;

  // Get all known tags
  const allTags: string[] = await api('/tags');

  // Also include tags from selected tickets that might not be in allTags
  for (const t of selectedTickets) {
    for (const tag of parseTags(t.tags)) {
      if (!hasTag(allTags, tag)) allTags.push(normalizeTag(tag));
    }
  }
  allTags.sort();

  // Compute initial check state: checked (all have), unchecked (none have), mixed (some have)
  type TagState = 'checked' | 'unchecked' | 'mixed';
  const tagStates = new Map<string, TagState>();
  for (const tag of allTags) {
    const count = selectedTickets.filter(t => hasTag(parseTags(t.tags), tag)).length;
    if (count === selectedTickets.length) tagStates.set(tag, 'checked');
    else if (count === 0) tagStates.set(tag, 'unchecked');
    else tagStates.set(tag, 'mixed');
  }

  // Track user changes (only changed tags will be applied)
  const originalStates = new Map(tagStates);
  const currentStates = new Map(tagStates);

  const overlay = toElement(
    <div className="tags-dialog-overlay">
      <div className="tags-dialog">
        <div className="tags-dialog-header">
          <span>Tags</span>
          <button className="detail-close" id="tags-dialog-close">{'\u00d7'}</button>
        </div>
        <div className="tags-dialog-body" id="tags-dialog-body"></div>
        <div className="tags-dialog-new">
          <input type="text" id="tags-dialog-new-input" placeholder="New tag..." />
          <button className="btn btn-sm" id="tags-dialog-add-btn">Add</button>
        </div>
        <div className="tags-dialog-footer">
          <button className="btn btn-sm" id="tags-dialog-cancel">Cancel</button>
          <button className="btn btn-sm btn-accent" id="tags-dialog-done">Done</button>
        </div>
      </div>
    </div>
  );

  function renderTagRows() {
    const body = overlay.querySelector('#tags-dialog-body')!;
    body.innerHTML = '';
    for (const tag of allTags) {
      const st = currentStates.get(tag)!;
      const row = toElement(
        <label className="tags-dialog-row">
          <input type="checkbox" checked={st === 'checked'} />
          <span>{displayTag(tag)}</span>
        </label>
      );
      const cb = row.querySelector('input') as HTMLInputElement;
      if (st === 'mixed') cb.indeterminate = true;
      cb.addEventListener('change', () => {
        currentStates.set(tag, cb.checked ? 'checked' : 'unchecked');
      });
      body.appendChild(row);
    }
    if (allTags.length === 0) {
      body.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted);font-size:13px">No tags yet. Create one below.</div>';
    }
  }

  renderTagRows();
  document.body.appendChild(overlay);

  // Add new tag
  const newInput = overlay.querySelector('#tags-dialog-new-input') as HTMLInputElement;
  const addTag = () => {
    const val = normalizeTag(newInput.value);
    if (!val || hasTag(allTags, val)) { newInput.value = ''; return; }
    allTags.push(val);
    allTags.sort();
    currentStates.set(val, 'checked');
    originalStates.set(val, 'unchecked');
    newInput.value = '';
    renderTagRows();
  };
  overlay.querySelector('#tags-dialog-add-btn')!.addEventListener('click', addTag);
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });

  // Close/cancel
  const close = () => overlay.remove();
  overlay.querySelector('#tags-dialog-close')!.addEventListener('click', close);
  overlay.querySelector('#tags-dialog-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Done — apply changes
  overlay.querySelector('#tags-dialog-done')!.addEventListener('click', async () => {
    // Find tags whose state changed from original
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const tag of allTags) {
      const orig = originalStates.get(tag);
      const curr = currentStates.get(tag);
      if (orig === curr) continue; // no change (including mixed→mixed)
      if (curr === 'checked') toAdd.push(tag);
      else if (curr === 'unchecked') toRemove.push(tag);
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      for (const ticket of selectedTickets) {
        const current = parseTags(ticket.tags);
        let updated = [...current];
        for (const tag of toAdd) { if (!hasTag(updated, tag)) updated.push(tag); }
        for (const tag of toRemove) { updated = updated.filter(t => normalizeTag(t) !== normalizeTag(tag)); }
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          await api(`/tickets/${ticket.id}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
        }
      }
      void loadTickets();
      refreshDetail();
    }

    close();
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
      // If editing a field in the detail panel, just blur it
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.closest('.detail-panel, .detail-body')) {
        active.blur();
        return;
      }
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

    // Cmd/Ctrl+P: print
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      showPrintDialog();
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

    // Delete/Backspace: delete selected tickets (when not in an input)
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput && state.selectedIds.size > 0) {
      e.preventDefault();
      const ids = Array.from(state.selectedIds);
      const affected = state.tickets.filter(t => state.selectedIds.has(t.id));
      void trackedBatch(affected, { ids, action: 'delete' }, 'Delete').then(() => {
        state.selectedIds.clear();
        void loadTickets();
      });
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
        if (!state.backupPreview?.active) {
          void loadTickets();
          refreshDetail();
        }
        // Check if Claude signaled done via /channel/done
        if (channelBusy) {
          fetch('/api/channel/status').then(r => r.ok ? r.json() : null).then(s => {
            if (s?.done) {
              setChannelBusy(false);
              if (channelBusyTimeout) { clearTimeout(channelBusyTimeout); channelBusyTimeout = null; }
            }
          }).catch(() => {});
        }
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
