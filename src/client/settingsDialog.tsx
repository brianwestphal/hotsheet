import { api } from './api.js';
import { loadBackupList } from './backups.js';
import { toElement } from './dom.js';
import { bindExperimentalSettings } from './experimentalSettings.js';
import type { CategoryDef, NotifyLevel } from './state.js';
import { state } from './state.js';
import { getTauriInvoke, showUpdateBanner } from './tauriIntegration.js';

let categorySyncTimeout: ReturnType<typeof setTimeout> | null = null;

export function bindSettingsDialog(rebuildCategoryUI: () => void) {
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
    (document.getElementById('settings-auto-order') as HTMLInputElement).checked = state.settings.auto_order;
    (document.getElementById('settings-notify-permission') as HTMLSelectElement).value = state.settings.notify_permission;
    (document.getElementById('settings-notify-completed') as HTMLSelectElement).value = state.settings.notify_completed;
    overlay.style.display = 'flex';
    void loadBackupList();
    // Load file-based settings (app name, backup dir)
    void api<{ appName?: string; backupDir?: string }>('/file-settings').then((fs) => {
      (document.getElementById('settings-app-name') as HTMLInputElement).value = fs.appName ?? '';
      (document.getElementById('settings-backup-dir') as HTMLInputElement).value = fs.backupDir ?? '';
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
    if (fs.appIcon !== undefined && fs.appIcon !== '') {
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

  // Auto-prioritize toggle
  const autoOrderCheckbox = document.getElementById('settings-auto-order') as HTMLInputElement;
  autoOrderCheckbox.addEventListener('change', () => {
    state.settings.auto_order = autoOrderCheckbox.checked;
    void api('/settings', { method: 'PATCH', body: { auto_order: String(autoOrderCheckbox.checked) } });
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
      if (version !== null && version !== '') {
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
  bindCategorySettings(rebuildCategoryUI);
}

function renderCategoryList(rebuildCategoryUI: () => void) {
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
      debouncedCategorySync(rebuildCategoryUI);
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
      renderCategoryList(rebuildCategoryUI);
      debouncedCategorySync(rebuildCategoryUI);
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

function debouncedCategorySync(rebuildCategoryUI: () => void) {
  if (categorySyncTimeout) clearTimeout(categorySyncTimeout);
  categorySyncTimeout = setTimeout(async () => {
    await api('/categories', { method: 'PUT', body: state.categories });
    rebuildCategoryUI();
  }, 500);
}

function bindCategorySettings(rebuildCategoryUI: () => void) {
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
    renderCategoryList(rebuildCategoryUI);
    // Focus the label input of the new row
    const rows = document.querySelectorAll('.category-row');
    const last = rows[rows.length - 1];
    (last.querySelector('.category-label-input') as HTMLInputElement).focus();
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
      renderCategoryList(rebuildCategoryUI);
      rebuildCategoryUI();
    }
    presetSelect.value = '';
  });

  // Render initial list when settings dialog opens
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => {
    renderCategoryList(rebuildCategoryUI);
  });
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
      if (settings.auto_context !== undefined && settings.auto_context !== '') {
        autoContextEntries = JSON.parse(settings.auto_context) as AutoContextEntry[];
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
        ? (state.categories.find(c => c.id === entry.key)?.label ?? entry.key)
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
      const dialogOverlay = toElement(
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

      const filterInput = dialogOverlay.querySelector('#ac-filter') as HTMLInputElement;
      const optionsList = dialogOverlay.querySelector('#ac-options')!;

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
            dialogOverlay.remove();
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

      const close = () => dialogOverlay.remove();
      dialogOverlay.querySelector('#ac-dialog-close')!.addEventListener('click', close);
      dialogOverlay.addEventListener('click', (e) => { if (e.target === dialogOverlay) close(); });

      document.body.appendChild(dialogOverlay);
      filterInput.focus();
    }
  }

  // Load when settings dialog opens
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => { void loadEntries(); });
}
