import { PLUGINS_ENABLED } from '../feature-flags.js';
import { api } from './api.js';
import { loadBackupList } from './backups.js';
import { toElement } from './dom.js';
import { bindExperimentalSettings } from './experimentalSettings.js';
import { bindCategorySettings } from './settingsCategories.js';
import type { NotifyLevel } from './state.js';
import { state } from './state.js';
import { getTauriInvoke, showUpdateBanner } from './tauriIntegration.js';

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
    // Always reset to General tab when opening
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tabs[0].classList.add('active');
    panels[0].classList.add('active');

    // Update dialog title with project name (from active tab, or app title if single project)
    const activeTabName = document.querySelector('.project-tab.active .project-tab-name')?.textContent;
    const projectName = activeTabName ?? document.querySelector('.app-title h1')?.textContent ?? 'Settings';
    const titleEl = document.getElementById('settings-dialog-title');
    if (titleEl) titleEl.textContent = `${projectName} Settings`;

    // Populate fields with current values
    (document.getElementById('settings-trash-days') as HTMLInputElement).value = String(state.settings.trash_cleanup_days);
    (document.getElementById('settings-verified-days') as HTMLInputElement).value = String(state.settings.verified_cleanup_days);
    (document.getElementById('settings-auto-order') as HTMLInputElement).checked = state.settings.auto_order;
    (document.getElementById('settings-hide-verified-column') as HTMLInputElement).checked = state.settings.hide_verified_column;
    (document.getElementById('settings-shell-integration-ui') as HTMLInputElement).checked = state.settings.shell_integration_ui;
    (document.getElementById('settings-notify-permission') as HTMLSelectElement).value = state.settings.notify_permission;
    (document.getElementById('settings-notify-completed') as HTMLSelectElement).value = state.settings.notify_completed;
    overlay.style.display = 'flex';
    void loadBackupList();
    // Load file-based settings (app name, backup dir, terminal settings)
    void api<{
      appName?: string;
      backupDir?: string;
      ticketPrefix?: string;
      terminal_scrollback_bytes?: string | number;
    }>('/file-settings').then((fs) => {
      (document.getElementById('settings-app-name') as HTMLInputElement).value = fs.appName ?? '';
      (document.getElementById('settings-backup-dir') as HTMLInputElement).value = fs.backupDir ?? '';
      (document.getElementById('settings-ticket-prefix') as HTMLInputElement).value = fs.ticketPrefix ?? '';
      const scrollback = fs.terminal_scrollback_bytes;
      const scrollbackInput = document.getElementById('settings-terminal-scrollback') as HTMLInputElement;
      scrollbackInput.value = scrollback === undefined || scrollback === '' ? '' : String(scrollback);
    });
    // Terminals outline list (HS-6271) — loads asynchronously.
    void import('./terminalsSettings.js').then(({ loadAndRenderTerminalsSettings }) => loadAndRenderTerminalsSettings());
    // HS-6307 — populate + wire the "Default appearance" panel on open.
    void import('./terminalDefaultAppearanceUI.js').then(({ loadAndWireTerminalDefaultAppearance }) => {
      void loadAndWireTerminalDefaultAppearance();
    });
    // HS-7596 / §37 — populate + wire the Quit confirmation panel.
    void import('./quitConfirmSettingsUI.js').then(({ loadAndWireQuitConfirmSettings }) => {
      void loadAndWireQuitConfirmSettings();
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

  // Hide verified column toggle
  const hideVerifiedCheckbox = document.getElementById('settings-hide-verified-column') as HTMLInputElement;
  hideVerifiedCheckbox.addEventListener('change', async () => {
    state.settings.hide_verified_column = hideVerifiedCheckbox.checked;
    await api('/settings', { method: 'PATCH', body: { hide_verified_column: String(hideVerifiedCheckbox.checked) } });
    // Re-render to apply column change immediately
    const { renderTicketList } = await import('./ticketList.js');
    renderTicketList();
  });

  // HS-7269 — Shell integration UI toggle. Covers gutter glyphs + copy-output
  // button + Cmd/Ctrl+Arrow jump shortcuts + hover popover. Toggling fires a
  // custom event that the terminal module listens for so it can re-apply
  // visibility on the currently-active instance without a full rebuild.
  const shellIntegrationCheckbox = document.getElementById('settings-shell-integration-ui') as HTMLInputElement;
  shellIntegrationCheckbox.addEventListener('change', () => {
    state.settings.shell_integration_ui = shellIntegrationCheckbox.checked;
    void api('/settings', { method: 'PATCH', body: { shell_integration_ui: String(shellIntegrationCheckbox.checked) } });
    document.dispatchEvent(new CustomEvent('hotsheet:shell-integration-ui-changed'));
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

  // Ticket prefix (file-based setting)
  const prefixInput = document.getElementById('settings-ticket-prefix') as HTMLInputElement;
  const prefixHint = document.getElementById('settings-ticket-prefix-hint')!;
  let prefixTimeout: ReturnType<typeof setTimeout> | null = null;
  prefixInput.addEventListener('input', () => {
    if (prefixTimeout) clearTimeout(prefixTimeout);
    prefixTimeout = setTimeout(() => {
      const val = prefixInput.value.trim();
      if (val !== '' && !/^[a-zA-Z0-9_-]{1,10}$/.test(val)) {
        prefixHint.textContent = 'Invalid: use up to 10 alphanumeric, hyphen, or underscore characters.';
        return;
      }
      void api('/file-settings', { method: 'PATCH', body: { ticketPrefix: val } }).then(() => {
        prefixHint.textContent = val ? `New tickets will use "${val}-" prefix.` : 'Using default prefix (HS).';
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

  // --- Embedded Terminal settings (HS-6268, docs/22-terminal.md §22.10) ---
  // The Terminal settings tab is Tauri-only (HS-6437, HS-6337) — the backing
  // PTY runs on the user's machine, so there is no sensible web-only UX. The
  // feature is now always on in Tauri (no toggle): adding a terminal entry
  // makes a tab appear; removing the last entry hides them again.
  const termTabBtn = document.getElementById('settings-tab-terminal');
  if (termTabBtn !== null) termTabBtn.style.display = getTauriInvoke() !== null ? '' : 'none';

  // Add Terminal button (the per-row editing lives in src/client/terminalsSettings.tsx).
  document.getElementById('settings-terminals-add-btn')?.addEventListener('click', () => {
    void import('./terminalsSettings.js').then(({ addTerminalEntry }) => addTerminalEntry());
  });

  const termScrollbackInput = document.getElementById('settings-terminal-scrollback') as HTMLInputElement;
  let termScrollbackTimeout: ReturnType<typeof setTimeout> | null = null;
  termScrollbackInput.addEventListener('input', () => {
    if (termScrollbackTimeout) clearTimeout(termScrollbackTimeout);
    termScrollbackTimeout = setTimeout(() => {
      const raw = termScrollbackInput.value.trim();
      if (raw === '') {
        void api('/file-settings', { method: 'PATCH', body: { terminal_scrollback_bytes: '' } });
        return;
      }
      const n = Math.max(65536, Math.min(16777216, parseInt(raw, 10) || 1048576));
      termScrollbackInput.value = String(n);
      void api('/file-settings', { method: 'PATCH', body: { terminal_scrollback_bytes: String(n) } });
    }, 800);
  });

  // --- Context tab (auto-context) ---
  bindAutoContextSettings();

  // --- Plugins tab ---
  if (PLUGINS_ENABLED) {
    void import('./pluginSettings.js').then(({ bindPluginSettings }) => bindPluginSettings());
  }

  // --- Experimental tab (channel + custom commands) ---
  bindExperimentalSettings();

  // --- Category management ---
  bindCategorySettings(rebuildCategoryUI);

  // --- CLI tool install (Tauri only) ---
  bindCliToolSettings();
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
      if (settings.auto_context !== '') {
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
      list.replaceChildren(toElement(<div style="padding:12px 0;color:var(--text-muted);font-size:13px">No auto-context entries yet. Click + Add to create one.</div>));
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
          optionsList.replaceChildren(toElement(<div style="padding:8px;color:var(--text-muted);font-size:13px">No matching options</div>));
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

// --- CLI tool install (Tauri only) ---

function bindCliToolSettings() {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  const section = document.getElementById('cli-tool-section');
  if (!section) return;
  section.style.display = '';

  const dot = document.getElementById('cli-status-dot')!;
  const statusText = document.getElementById('cli-status-text')!;
  const installBtn = document.getElementById('cli-install-btn') as HTMLButtonElement;
  const hint = document.getElementById('cli-install-hint')!;

  function showInstalled() {
    dot.className = 'cli-status-dot installed';
    statusText.textContent = 'Installed';
    installBtn.style.display = 'none';
    hint.textContent = 'The hotsheet command is available at /usr/local/bin/hotsheet.';
  }

  function showNotInstalled() {
    dot.className = 'cli-status-dot not-installed';
    statusText.textContent = 'Not installed';
    installBtn.style.display = '';
    hint.textContent = 'Installs the hotsheet command to /usr/local/bin.';
  }

  // Check current status
  void invoke('check_cli_installed').then((result: unknown) => {
    const data = result as { installed?: boolean } | null;
    if (data?.installed === true) {
      showInstalled();
    } else {
      showNotInstalled();
    }
  }).catch(() => {
    showNotInstalled();
  });

  // Bind install button
  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    installBtn.textContent = 'Installing...';
    try {
      await invoke('install_cli');
      showInstalled();
    } catch {
      installBtn.textContent = 'Install Failed';
      installBtn.disabled = false;
    }
  });

  // Re-check when settings dialog opens
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => {
    void invoke('check_cli_installed').then((result: unknown) => {
      const data = result as { installed?: boolean } | null;
      if (data?.installed === true) showInstalled();
      else showNotInstalled();
    }).catch(() => {});
  });
}
