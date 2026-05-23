import { z } from 'zod';

import { PLUGINS_ENABLED } from '../feature-flags.js';
import { parseJsonOrNull } from '../schemas.js';
import { api } from './api.js';
import { setAppTitle } from './appTitle.js';
import { loadBackupList } from './backups.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { bindExperimentalSettings } from './experimentalSettings.js';
import { isDiagnosticsEnabled, setDiagnosticsEnabled } from './globalDiagnostics.js';
import { watchHorizontalOverflow } from './scrollbarPref.js';
import { bindCategorySettings } from './settingsCategories.js';
import type { NotifyLevel } from './state.js';
import { state } from './state.js';
import { getTauriInvoke, showUpdateBanner } from './tauriIntegration.js';
import { getTelemetryCostMode, setTelemetryCostMode } from './telemetryCostMode.js';

interface FileSettingsForGeneralAndTerminal {
  appName?: string;
  backupDir?: string;
  ticketPrefix?: string;
  terminal_scrollback_bytes?: string | number;
}

export function bindSettingsDialog(rebuildCategoryUI: () => void) {
  bindTabSwitching();
  bindDialogOpenClose();
  // HS-8494 follow-up — keep the `.has-overflow` class on the settings
  // tab strip in sync with its actual horizontal-overflow state so the
  // iOS scrollbar reliably appears under macOS "Always" / Linux /
  // Windows scrollbar modes. Same root-cause fix as the project-tabs
  // strip; see `scrollbarPref.ts::watchHorizontalOverflow`.
  const settingsTabs = byIdOrNull('settings-tabs');
  if (settingsTabs !== null) watchHorizontalOverflow(settingsTabs);

  bindGeneralTab();
  bindBackupsTab();
  bindTerminalTab();
  bindTelemetryTab();

  bindAutoContextSettings();
  if (PLUGINS_ENABLED) {
    void import('./pluginSettings.js').then(({ bindPluginSettings }) => bindPluginSettings());
  }
  bindExperimentalSettings();
  bindCategorySettings(rebuildCategoryUI);
  bindCliToolSettings();
}

// --- Tab switching + dialog open/close ---

function bindTabSwitching() {
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-tab-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = (tab as HTMLElement).dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.settings-tab-panel[data-panel="${target}"]`)?.classList.add('active');
      // HS-7953 — lazy-load the Permissions tab's allow-list when it's
      // first shown so the rule list renders without an extra fetch on
      // every settings-dialog open.
      if (target === 'permissions') {
        void import('./permissionAllowListUI.js').then(m => m.loadAndRenderAllowList());
      }
    });
  });
}

function bindDialogOpenClose() {
  const overlay = byId('settings-overlay');
  const closeBtn = byId('settings-close');
  const settingsBtn = byId('settings-btn');
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-tab-panel');

  settingsBtn.addEventListener('click', () => {
    // Always reset to General tab when opening
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tabs[0].classList.add('active');
    panels[0].classList.add('active');

    // Update dialog title with project name (from active tab, or app title if single project)
    const activeTabName = document.querySelector('.project-tab.active .project-tab-name')?.textContent;
    const projectName = activeTabName ?? document.querySelector('.app-title h1')?.textContent ?? 'Settings';
    const titleEl = byIdOrNull('settings-dialog-title');
    if (titleEl) titleEl.textContent = `${projectName} Settings`;

    overlay.style.display = 'flex';
  });

  closeBtn.addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.style.display = 'none';
    }
  });
}

// --- General tab ---

function bindGeneralTab() {
  const settingsBtn = byId('settings-btn');

  const trashInput = byId<HTMLInputElement>('settings-trash-days');
  const verifiedInput = byId<HTMLInputElement>('settings-verified-days');
  const autoOrderCheckbox = byId<HTMLInputElement>('settings-auto-order');
  const hideVerifiedCheckbox = byId<HTMLInputElement>('settings-hide-verified-column');
  const shellIntegrationCheckbox = byId<HTMLInputElement>('settings-shell-integration-ui');
  const shellStreamingCheckbox = byId<HTMLInputElement>('settings-shell-streaming-enabled');
  // HS-8446 — global diagnostics opt-in. Single checkbox in Settings →
  // Experimental → Diagnostics that gates BOTH the slow-server banner
  // (HS-8175) AND the HS-8054 UI-hang toast. Stored in
  // `~/.hotsheet/config.json` under `diagnosticsEnabled` (was the
  // per-project `diagnostics_freeze_toast_enabled` key pre-HS-8446).
  const diagnosticsEnabledCheckbox = byId<HTMLInputElement>('settings-diagnostics-enabled');
  const notifyPermSelect = byId<HTMLSelectElement>('settings-notify-permission');
  const notifyCompSelect = byId<HTMLSelectElement>('settings-notify-completed');
  const appNameInput = byId<HTMLInputElement>('settings-app-name');
  const prefixInput = byId<HTMLInputElement>('settings-ticket-prefix');

  // Populate values + load file-settings fields when dialog opens.
  settingsBtn.addEventListener('click', () => {
    trashInput.value = String(state.settings.trash_cleanup_days);
    verifiedInput.value = String(state.settings.verified_cleanup_days);
    autoOrderCheckbox.checked = state.settings.auto_order;
    hideVerifiedCheckbox.checked = state.settings.hide_verified_column;
    shellIntegrationCheckbox.checked = state.settings.shell_integration_ui;
    // HS-7984 — §53 Phase 4 streaming toggle.
    shellStreamingCheckbox.checked = state.settings.shell_streaming_enabled;
    // HS-8446 — global diagnostics opt-in (read from the in-memory
    // cache hydrated at app boot by `loadGlobalDiagnostics`).
    diagnosticsEnabledCheckbox.checked = isDiagnosticsEnabled();
    notifyPermSelect.value = state.settings.notify_permission;
    notifyCompSelect.value = state.settings.notify_completed;
    void api<FileSettingsForGeneralAndTerminal>('/file-settings').then((fs) => {
      appNameInput.value = fs.appName ?? '';
      prefixInput.value = fs.ticketPrefix ?? '';
    });
  });

  // Trash cleanup days
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

  bindAppIconPicker();

  // Auto-prioritize toggle
  autoOrderCheckbox.addEventListener('change', () => {
    state.settings.auto_order = autoOrderCheckbox.checked;
    void api('/settings', { method: 'PATCH', body: { auto_order: String(autoOrderCheckbox.checked) } });
  });

  // Hide verified column toggle
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
  shellIntegrationCheckbox.addEventListener('change', () => {
    state.settings.shell_integration_ui = shellIntegrationCheckbox.checked;
    void api('/settings', { method: 'PATCH', body: { shell_integration_ui: String(shellIntegrationCheckbox.checked) } });
    document.dispatchEvent(new CustomEvent('hotsheet:shell-integration-ui-changed'));
  });

  // HS-7984 — §53 Phase 4 streaming-output toggle. Per-project (DB-backed
  // settings via `/settings`). When off, both client surfaces (sidebar
  // row preview + Commands Log live `<pre>`) gate rendering on the flag
  // — server still buffers so re-enabling mid-run picks up where we
  // left off. The shell-partial-output event is still dispatched; the
  // consumers decide whether to act on it.
  shellStreamingCheckbox.addEventListener('change', () => {
    state.settings.shell_streaming_enabled = shellStreamingCheckbox.checked;
    void api('/settings', { method: 'PATCH', body: { shell_streaming_enabled: String(shellStreamingCheckbox.checked) } });
  });

  // HS-8446 — global diagnostics opt-in. PATCH `/api/global-config`
  // (not `/api/settings`) — the value lives in `~/.hotsheet/config.json`
  // under `diagnosticsEnabled` so it applies across every project on
  // this machine. The serverBusyChip + longTaskObserver gates read the
  // cached value synchronously, so flipping the checkbox takes effect
  // immediately without a page reload.
  diagnosticsEnabledCheckbox.addEventListener('change', () => {
    void setDiagnosticsEnabled(diagnosticsEnabledCheckbox.checked);
  });

  // Notification dropdowns
  notifyPermSelect.addEventListener('change', () => {
    state.settings.notify_permission = notifyPermSelect.value as NotifyLevel;
    void api('/settings', { method: 'PATCH', body: { notify_permission: notifyPermSelect.value } });
  });
  notifyCompSelect.addEventListener('change', () => {
    state.settings.notify_completed = notifyCompSelect.value as NotifyLevel;
    void api('/settings', { method: 'PATCH', body: { notify_completed: notifyCompSelect.value } });
  });

  // App name (file-based setting)
  const appNameHint = byId('settings-app-name-hint');
  let appNameTimeout: ReturnType<typeof setTimeout> | null = null;
  appNameInput.addEventListener('input', () => {
    if (appNameTimeout) clearTimeout(appNameTimeout);
    appNameTimeout = setTimeout(() => {
      const val = appNameInput.value.trim();
      void api('/file-settings', { method: 'PATCH', body: { appName: val } }).then(() => {
        // HS-8451 — `setAppTitle` now also pushes the title through to
        // the native Tauri window via `set_window_title`, so the
        // "Restart the desktop app to update the title bar" hint that
        // used to live here is obsolete for the title-bar case.
        setAppTitle(val || 'Hot Sheet');
        appNameHint.textContent = val ? 'Saved.' : 'Using default name.';
      });
    }, 800);
  });

  // Ticket prefix (file-based setting)
  const prefixHint = byId('settings-ticket-prefix-hint');
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
  const checkUpdatesBtn = byId<HTMLButtonElement>('check-updates-btn');
  const checkUpdatesStatus = byId('check-updates-status');
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
        byId('settings-overlay').style.display = 'none';
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
}

function bindAppIconPicker() {
  const iconBtn = byId('app-icon-picker-btn');
  const iconPreview = byId<HTMLImageElement>('app-icon-preview');
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
}

// --- Backups tab ---

function bindBackupsTab() {
  const settingsBtn = byId('settings-btn');
  const backupDirInput = byId<HTMLInputElement>('settings-backup-dir');
  const backupDirHint = byId('settings-backup-dir-hint');

  settingsBtn.addEventListener('click', () => {
    void loadBackupList();
    void api<FileSettingsForGeneralAndTerminal>('/file-settings').then((fs) => {
      backupDirInput.value = fs.backupDir ?? '';
    });
  });

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

// --- Embedded Terminal tab (HS-6268, docs/22-terminal.md §22.10) ---
//
// The Terminal settings tab is Tauri-only (HS-6437, HS-6337) — the backing
// PTY runs on the user's machine, so there is no sensible web-only UX. The
// feature is now always on in Tauri (no toggle): adding a terminal entry
// makes a tab appear; removing the last entry hides them again.

function bindTerminalTab() {
  const settingsBtn = byId('settings-btn');

  // Hide the Terminal tab button entirely outside Tauri.
  const termTabBtn = byIdOrNull('settings-tab-terminal');
  if (termTabBtn !== null) termTabBtn.style.display = getTauriInvoke() !== null ? '' : 'none';

  // Add Terminal button (the per-row editing lives in src/client/terminalsSettings.tsx).
  byIdOrNull('settings-terminals-add-btn')?.addEventListener('click', () => {
    void import('./terminalsSettings.js').then(({ addTerminalEntry }) => addTerminalEntry());
  });

  const termScrollbackInput = byId<HTMLInputElement>('settings-terminal-scrollback');
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

  settingsBtn.addEventListener('click', () => {
    void api<FileSettingsForGeneralAndTerminal>('/file-settings').then((fs) => {
      const scrollback = fs.terminal_scrollback_bytes;
      termScrollbackInput.value = scrollback === undefined || scrollback === '' ? '' : String(scrollback);
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
    // HS-7830 — wire the Reset visibility button + live-update its
    // status text from the dashboardHiddenTerminals subscription.
    void import('./hiddenTerminalsResetUI.js').then(({ loadAndWireHiddenTerminalsReset }) => {
      loadAndWireHiddenTerminalsReset();
    });
  });
}

// --- Auto-context settings ---

// HS-8567 — zod schema for the per-project `auto_context` settings JSON.
const AutoContextEntrySchema = z.object({
  type: z.enum(['category', 'tag']),
  key: z.string(),
  text: z.string(),
}).loose();
const AutoContextEntryArraySchema = z.array(AutoContextEntrySchema);
type AutoContextEntry = z.infer<typeof AutoContextEntrySchema>;

let autoContextEntries: AutoContextEntry[] = [];

function bindAutoContextSettings() {
  const list = byId('auto-context-list');
  const addBtn = byId('auto-context-add-btn');

  async function loadEntries() {
    try {
      const settings = await api<Record<string, string>>('/settings');
      if (settings.auto_context !== '') {
        // HS-8567 — zod-validate the persisted JSON column.
        const parsed = parseJsonOrNull(AutoContextEntryArraySchema, settings.auto_context);
        autoContextEntries = parsed ?? [];
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
            <button className="category-delete-btn" title="Remove">{'×'}</button>
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
              <button className="detail-close" id="ac-dialog-close">{'×'}</button>
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
  const settingsBtn = byId('settings-btn');
  settingsBtn.addEventListener('click', () => { void loadEntries(); });
}

// --- CLI tool install (Tauri only) ---

function bindCliToolSettings() {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  const section = byIdOrNull('cli-tool-section');
  if (!section) return;
  section.style.display = '';

  const dot = byId('cli-status-dot');
  const statusText = byId('cli-status-text');
  const installBtn = byId<HTMLButtonElement>('cli-install-btn');
  const hint = byId('cli-install-hint');

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
  const settingsBtn = byId('settings-btn');
  settingsBtn.addEventListener('click', () => {
    void invoke('check_cli_installed').then((result: unknown) => {
      const data = result as { installed?: boolean } | null;
      if (data?.installed === true) showInstalled();
      else showNotInstalled();
    }).catch(() => {});
  });
}

/**
 * HS-8146 — §67 Claude Code Telemetry settings panel. Per-project
 * file-settings (`telemetry_enabled` master + `telemetry_*_enabled`
 * sub-toggles + `telemetry_retention_days`). All values live in
 * `<dataDir>/settings.json` and are PATCHed via `/api/file-settings`.
 *
 * Master toggle gates spawn-env injection (HS-8145's
 * `buildOtelEnv(dataDir)` reads the same setting). When the master is
 * off, sub-toggles are still visually editable but their values don't
 * matter — flipping the master back on uses whatever the sub-toggles
 * were last set to. This matches the §52 terminal-prompts settings
 * pattern (no cascading disable on the master).
 *
 * Retention picker writes `telemetry_retention_days` as a number; `0`
 * = keep forever per §67.6 / HS-8154.
 */
interface TelemetryFileSettings {
  telemetry_enabled?: boolean;
  telemetry_metrics_enabled?: boolean;
  telemetry_logs_enabled?: boolean;
  telemetry_traces_enabled?: boolean;
  telemetry_retention_days?: number;
}

function bindTelemetryTab() {
  const masterEl = byIdOrNull<HTMLInputElement>('settings-telemetry-enabled');
  const metricsEl = byIdOrNull<HTMLInputElement>('settings-telemetry-metrics-enabled');
  const logsEl = byIdOrNull<HTMLInputElement>('settings-telemetry-logs-enabled');
  const tracesEl = byIdOrNull<HTMLInputElement>('settings-telemetry-traces-enabled');
  const retentionEl = byIdOrNull<HTMLInputElement>('settings-telemetry-retention-days');
  // HS-8497 — billing-model select (global setting, not part of the
  // per-project TelemetryFileSettings shape).
  const costModeEl = byIdOrNull<HTMLSelectElement>('settings-telemetry-cost-mode');
  if (masterEl === null || metricsEl === null || logsEl === null || tracesEl === null || retentionEl === null) return;

  // Per-checkbox change → PATCH the matching file-settings key. The
  // §67.9 contract treats undefined sub-toggles as "default-on for
  // metrics + logs, default-off for traces" — so we always write the
  // explicit boolean rather than rely on absence.
  masterEl.addEventListener('change', () => {
    void api('/file-settings', { method: 'PATCH', body: { telemetry_enabled: masterEl.checked } }).then(() => {
      // HS-8479 — refresh the conditional Telemetry sidebar entry so
      // it appears / disappears instantly on toggle.
      void import('./telemetrySidebar.js').then(({ refreshTelemetrySidebarVisibility }) => {
        void refreshTelemetrySidebarVisibility();
      });
    });
  });
  metricsEl.addEventListener('change', () => {
    void api('/file-settings', { method: 'PATCH', body: { telemetry_metrics_enabled: metricsEl.checked } });
  });
  logsEl.addEventListener('change', () => {
    void api('/file-settings', { method: 'PATCH', body: { telemetry_logs_enabled: logsEl.checked } });
  });
  tracesEl.addEventListener('change', () => {
    void api('/file-settings', { method: 'PATCH', body: { telemetry_traces_enabled: tracesEl.checked } });
  });

  // Retention picker — debounced (matches the §52 scrollback pattern
  // upstream). Clamp negative values to 0 ("keep forever" per §67.6).
  let retentionTimeout: ReturnType<typeof setTimeout> | null = null;
  retentionEl.addEventListener('input', () => {
    if (retentionTimeout !== null) clearTimeout(retentionTimeout);
    retentionTimeout = setTimeout(() => {
      const raw = retentionEl.value.trim();
      const n = raw === '' ? 30 : Math.max(0, parseInt(raw, 10) || 0);
      retentionEl.value = String(n);
      void api('/file-settings', { method: 'PATCH', body: { telemetry_retention_days: n } });
    }, 600);
  });

  // HS-8497 — billing-model select. Updates the global cost-mode and
  // notifies any visible cost surfaces so they reflect the new mode on
  // the next paint without needing a reload.
  if (costModeEl !== null) {
    costModeEl.addEventListener('change', () => {
      const v = costModeEl.value === 'subscription' ? 'subscription' : 'api';
      void setTelemetryCostMode(v).then(() => {
        // HS-8527 — the cost surface is now the sidebar dashboard
        // widget (not the per-tab chip); refresh it so subscription
        // mode hides the value without waiting for the next bell tick.
        void import('./dashboardMode.js').then(({ refreshSidebarWidgetCost }) => {
          refreshSidebarWidgetCost();
        }).catch(() => {});
        // HS-8509 — the drawer Telemetry tab was removed; the
        // analytics-dashboard telemetry section + cross-project stats
        // page both render the subscription-mode notice via their own
        // boot path on next open, so no re-render hook needed here.
      });
    });
  }

  // On Settings open → fetch current file-settings + populate the form.
  const settingsBtn = byId('settings-btn');
  settingsBtn.addEventListener('click', () => {
    void api<TelemetryFileSettings>('/file-settings').then((fs) => {
      masterEl.checked = fs.telemetry_enabled === true;
      // Defaults: metrics + logs ON, traces OFF — matches §67.9.
      metricsEl.checked = fs.telemetry_metrics_enabled !== false;
      logsEl.checked = fs.telemetry_logs_enabled !== false;
      tracesEl.checked = fs.telemetry_traces_enabled === true;
      retentionEl.value = String(typeof fs.telemetry_retention_days === 'number' ? fs.telemetry_retention_days : 30);
    });
    // HS-8497 — read the cached global cost mode (already loaded at app
    // boot) so the select reflects the current value without a second
    // round-trip.
    if (costModeEl !== null) {
      costModeEl.value = getTelemetryCostMode();
    }
  });
}
