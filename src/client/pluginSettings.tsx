import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { refreshPluginUI } from './pluginUI.js';
import { getTauriInvoke } from './tauriIntegration.js';

type ConfigLabelColor = 'default' | 'success' | 'error' | 'warning' | 'transient';

interface ConfigLayoutItem {
  type: 'preference' | 'divider' | 'spacer' | 'label' | 'button' | 'group';
  key?: string;
  id?: string;
  text?: string;
  color?: ConfigLabelColor;
  label?: string;
  action?: string;
  icon?: string;
  style?: string;
  title?: string;
  collapsed?: boolean;
  items?: ConfigLayoutItem[];
}

function labelColorClass(color: string | undefined): string {
  if (color == null || color === '' || color === 'default') return 'config-label';
  return `config-label label-color-${color}`;
}

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  enabled: boolean;
  hasBackend: boolean;
  error: string | null;
  preferences: PluginPreference[];
  configLayout?: ConfigLayoutItem[];
  path?: string;
  needsConfiguration?: boolean;
  missingFields?: string[];
}

interface PluginPreference {
  key: string;
  label: string;
  type: 'string' | 'boolean' | 'number' | 'select' | 'dropdown' | 'combo';
  default?: string | boolean | number;
  description?: string;
  required?: boolean;
  secret?: boolean;
  scope?: 'global' | 'project';
  options?: { value: string; label: string }[];
}

interface SyncConflict {
  id: number;
  ticket_id: number;
  plugin_id: string;
  remote_id: string;
  sync_status: string;
  conflict_data: string | null;
}

const STATUS_DOT = {
  connected: '<span class="plugin-status-dot connected" title="Connected"></span>',
  disconnected: '<span class="plugin-status-dot disconnected" title="Disconnected"></span>',
  error: '<span class="plugin-status-dot error" title="Error"></span>',
  needsConfig: '<span class="plugin-status-dot needs-config" title="Needs Configuration"></span>',
};

export function bindPluginSettings() {
  const settingsBtn = document.getElementById('settings-btn')!;
  settingsBtn.addEventListener('click', () => { void loadPlugins(); });

  const installBtn = document.getElementById('plugin-install-btn')!;
  installBtn.addEventListener('click', () => showFindPluginsDialog());
}

interface BundledPluginInfo {
  manifest: { id: string; name: string; version: string; description?: string; icon?: string };
  installed: boolean;
  dismissed: boolean;
}

function showFindPluginsDialog() {
  const overlay = toElement(
    <div className="custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor" style="width:480px;max-height:70vh">
        <div className="custom-view-editor-header">
          <span>Find Plugins</span>
          <button className="detail-close" id="find-plugins-close">{'\u00d7'}</button>
        </div>
        <div className="find-plugins-tabs">
          <button className="find-plugins-tab active" data-tab="official">Official Plugins</button>
          <button className="find-plugins-tab" data-tab="disk">From Disk</button>
        </div>
        <div className="custom-view-editor-body" style="overflow-y:auto">
          <div className="find-plugins-panel active" data-panel="official" id="find-plugins-official"></div>
          <div className="find-plugins-panel" data-panel="disk" id="find-plugins-disk">
            <div className="settings-field">
              <label>Plugin path</label>
              <span className="settings-hint">Select or enter the path to a plugin directory.</span>
              <div style="display:flex;gap:8px;margin-top:8px">
                <input type="text" id="install-path-input" className="settings-input" placeholder="/path/to/plugin" style="flex:1" />
                <button className="btn btn-sm" id="install-browse-btn">Browse...</button>
              </div>
            </div>
            <div style="text-align:center;margin-top:16px">
              <button className="btn-install-primary" id="install-confirm-btn" disabled={true}>Install Plugin</button>
            </div>
            <span className="settings-hint" id="install-status" style="display:block;text-align:center;margin-top:8px"></span>
          </div>
        </div>
      </div>
    </div>
  );

  // Tab switching
  const tabs = overlay.querySelectorAll('.find-plugins-tab');
  const panels = overlay.querySelectorAll('.find-plugins-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = (tab as HTMLElement).dataset.tab;
      overlay.querySelector(`.find-plugins-panel[data-panel="${target}"]`)?.classList.add('active');
    });
  });

  // --- Official Plugins tab ---
  const officialPanel = overlay.querySelector('#find-plugins-official')!;
  void api<BundledPluginInfo[]>('/plugins/bundled').then(bundled => {
    if (bundled.length === 0) {
      officialPanel.innerHTML = '<div style="padding:16px 0;color:var(--text-muted);text-align:center;font-size:13px">No official plugins available.</div>';
      return;
    }
    officialPanel.innerHTML = '';
    for (const bp of bundled) {
      const row = toElement(
        <div className="bundled-plugin-row">
          <div className="bundled-plugin-info">
            {bp.manifest.icon ? <span className="bundled-plugin-icon">{raw(bp.manifest.icon)}</span> : null}
            <div>
              <div className="bundled-plugin-name">{bp.manifest.name} <span className="plugin-version">v{bp.manifest.version}</span></div>
              {bp.manifest.description ? <div className="bundled-plugin-desc">{bp.manifest.description}</div> : null}
            </div>
          </div>
          <div className="bundled-plugin-action">
            {bp.installed && !bp.dismissed
              ? <span className="bundled-plugin-installed">Installed</span>
              : <button className="btn-install-primary btn-sm">{bp.dismissed ? 'Reinstall' : 'Install'}</button>
            }
          </div>
        </div>
      );
      const installBtn = row.querySelector('.btn-install-primary');
      if (installBtn) {
        installBtn.addEventListener('click', async () => {
          (installBtn as HTMLButtonElement).disabled = true;
          installBtn.textContent = 'Installing...';
          try {
            await api(`/plugins/bundled/${bp.manifest.id}/install`, { method: 'POST' });
            installBtn.textContent = 'Installed';
            installBtn.replaceWith(toElement(<span className="bundled-plugin-installed">Installed</span>));
            void loadPlugins();
          } catch {
            installBtn.textContent = 'Failed';
            (installBtn as HTMLButtonElement).disabled = false;
          }
        });
      }
      officialPanel.appendChild(row);
    }
  });

  // --- From Disk tab ---
  const pathInput = overlay.querySelector('#install-path-input') as HTMLInputElement;
  const browseBtn = overlay.querySelector('#install-browse-btn')!;
  const confirmBtn = overlay.querySelector('#install-confirm-btn') as HTMLButtonElement;
  const status = overlay.querySelector('#install-status')!;

  pathInput.addEventListener('input', () => {
    confirmBtn.disabled = pathInput.value.trim() === '';
  });

  browseBtn.addEventListener('click', async () => {
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        const selected = (await invoke('pick_folder')) as string | null;
        if (selected) { pathInput.value = selected; confirmBtn.disabled = false; }
      } catch { /* cancelled */ }
    } else {
      pathInput.focus();
    }
  });

  confirmBtn.addEventListener('click', async () => {
    const path = pathInput.value.trim();
    if (!path) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Installing...';
    status.textContent = '';
    try {
      await api('/plugins/install', { method: 'POST', body: { path } });
      confirmBtn.textContent = 'Installed!';
      status.textContent = 'Restart the app to load the plugin.';
      void loadPlugins();
    } catch (e) {
      confirmBtn.textContent = 'Install Plugin';
      confirmBtn.disabled = false;
      status.textContent = `Failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
  });

  const close = () => overlay.remove();
  overlay.querySelector('#find-plugins-close')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);
}

async function loadPlugins() {
  const list = document.getElementById('plugin-list')!;
  let plugins: PluginInfo[];
  try {
    plugins = await api<PluginInfo[]>('/plugins');
  } catch {
    list.innerHTML = '<div style="padding:12px 0;color:var(--text-muted);font-size:13px">Failed to load plugins.</div>';
    return;
  }

  if (plugins.length === 0) {
    list.innerHTML = '<div style="padding:12px 0;color:var(--text-muted);font-size:13px">No plugins installed. Place plugins in <code>~/.hotsheet/plugins/</code> and restart.</div>';
    return;
  }

  list.innerHTML = '';
  for (const plugin of plugins) {
    list.appendChild(createPluginRow(plugin));
  }

  void loadConflicts();
}

function createPluginRow(plugin: PluginInfo): HTMLElement {
  const statusHtml = plugin.error
    ? STATUS_DOT.error
    : plugin.needsConfiguration
      ? STATUS_DOT.needsConfig
      : plugin.enabled ? STATUS_DOT.connected : STATUS_DOT.disconnected;

  const statusLabel = plugin.error
    ? null
    : plugin.needsConfiguration
      ? 'Needs Configuration'
      : null;

  const row = toElement(
    <div className={`plugin-row${plugin.enabled ? ' enabled' : ''}${!plugin.enabled ? ' disabled' : ''}`} data-plugin-id={plugin.id}>
      <div className="plugin-row-header">
        <div className="plugin-row-info">
          {raw(statusHtml)}
          <span className="plugin-name">{plugin.name}</span>
          <span className="plugin-version">v{plugin.version}</span>
          {statusLabel ? <span className="plugin-needs-config">{statusLabel}</span> : null}
        </div>
        <button className="plugin-configure-btn" title="Configure">
          {raw('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>')}
        </button>
      </div>
      {plugin.description ? <div className="plugin-description">{plugin.description}</div> : null}
      {plugin.error ? <div className="plugin-error">{plugin.error}</div> : null}
    </div>
  );

  // Configure button
  row.querySelector('.plugin-configure-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    void showPluginConfigDialog(plugin);
  });

  // Right-click context menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPluginContextMenu(e as MouseEvent, plugin);
  });

  return row;
}

function showPluginContextMenu(e: MouseEvent, plugin: PluginInfo) {
  // Close any existing context menu
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = toElement(<div className="context-menu" style={`top:${e.clientY}px;left:${e.clientX}px;z-index:3000`}></div>);

  // Configure
  const configItem = toElement(<div className="context-menu-item">Configure...</div>);
  configItem.addEventListener('click', () => {
    menu.remove();
    void showPluginConfigDialog(plugin);
  });
  menu.appendChild(configItem);

  // Enable / Disable for this project
  if (plugin.enabled) {
    const disableItem = toElement(<div className="context-menu-item">Disable</div>);
    disableItem.addEventListener('click', async () => {
      menu.remove();
      await api(`/plugins/${plugin.id}/disable`, { method: 'POST' });
      void loadPlugins();
      void refreshPluginUI();
    });
    menu.appendChild(disableItem);
  } else {
    const enableItem = toElement(<div className="context-menu-item">Enable</div>);
    enableItem.addEventListener('click', async () => {
      menu.remove();
      await api(`/plugins/${plugin.id}/enable`, { method: 'POST' });
      void loadPlugins();
      void refreshPluginUI();
    });
    menu.appendChild(enableItem);
  }

  // Bulk enable/disable on all open projects
  menu.appendChild(toElement(<div className="context-menu-separator"></div>));

  const enableAllItem = toElement(<div className="context-menu-item">Enable on All Projects</div>);
  enableAllItem.addEventListener('click', async () => {
    menu.remove();
    await api(`/plugins/${plugin.id}/enable-all`, { method: 'POST' });
    void loadPlugins();
    void refreshPluginUI();
  });
  menu.appendChild(enableAllItem);

  const disableAllItem = toElement(<div className="context-menu-item">Disable on All Projects</div>);
  disableAllItem.addEventListener('click', async () => {
    menu.remove();
    await api(`/plugins/${plugin.id}/disable-all`, { method: 'POST' });
    void loadPlugins();
    void refreshPluginUI();
  });
  menu.appendChild(disableAllItem);

  // Separator
  menu.appendChild(toElement(<div className="context-menu-separator"></div>));

  // Uninstall
  const uninstallItem = toElement(<div className="context-menu-item danger">Uninstall</div>);
  uninstallItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Replace the menu content with a confirmation prompt
    menu.innerHTML = '';
    const confirmEl = toElement(
      <div style="padding:8px;min-width:200px">
        <div style="font-size:13px;margin-bottom:8px">Uninstall "{plugin.name}"?</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button className="btn btn-sm" id="uninstall-cancel">Cancel</button>
          <button className="btn btn-sm btn-danger" id="uninstall-confirm">Uninstall</button>
        </div>
      </div>
    );
    menu.appendChild(confirmEl);
    menu.querySelector('#uninstall-cancel')!.addEventListener('click', () => menu.remove());
    menu.querySelector('#uninstall-confirm')!.addEventListener('click', async () => {
      menu.remove();
      try {
        await api(`/plugins/${plugin.id}/uninstall`, { method: 'POST' });
        void loadPlugins();
      } catch (err) {
        console.error('Failed to uninstall:', err);
      }
    });
  });
  menu.appendChild(uninstallItem);

  // Show in Finder
  if (plugin.path) {
    menu.appendChild(toElement(<div className="context-menu-separator"></div>));
    const revealItem = toElement(<div className="context-menu-item">Show in Finder</div>);
    revealItem.addEventListener('click', async () => {
      menu.remove();
      try { await api(`/plugins/${plugin.id}/reveal`, { method: 'POST' }); } catch { /* ignore */ }
    });
    menu.appendChild(revealItem);
  }

  document.body.appendChild(menu);

  // Close on outside click
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

async function showPluginConfigDialog(plugin: PluginInfo) {
  // Fetch full details
  let detail: PluginInfo;
  try {
    detail = await api<PluginInfo>(`/plugins/${plugin.id}`);
  } catch {
    return;
  }

  const overlay = toElement(
    <div className="custom-view-editor-overlay" style="z-index:2500">
      <div className="custom-view-editor" style="width:500px;max-height:80vh">
        <div className="custom-view-editor-header">
          <span>{detail.name} — {document.querySelector('.project-tab.active .project-tab-name')?.textContent ?? 'Project'} Configuration</span>
          <button className="detail-close" id="plugin-config-close">{'\u00d7'}</button>
        </div>
        <div className="custom-view-editor-body" style="overflow-y:auto" id="plugin-config-body"></div>
      </div>
    </div>
  );

  const body = overlay.querySelector('#plugin-config-body')!;
  const prefsMap = new Map(detail.preferences.map(p => [p.key, p]));

  if (detail.configLayout && detail.configLayout.length > 0) {
    renderConfigLayout(body as HTMLElement, detail.configLayout, plugin.id, prefsMap);
  } else {
    // Fallback: flat preference list
    for (const pref of detail.preferences) {
      body.appendChild(createPreferenceRow(plugin.id, pref));
    }
  }

  // Close handlers
  const close = () => overlay.remove();
  overlay.querySelector('#plugin-config-close')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);
}

function renderConfigLayout(container: HTMLElement, items: ConfigLayoutItem[], pluginId: string, prefsMap: Map<string, PluginPreference>) {
  for (const item of items) {
    switch (item.type) {
      case 'preference': {
        const pref = item.key ? prefsMap.get(item.key) : undefined;
        if (pref) container.appendChild(createPreferenceRow(pluginId, pref));
        break;
      }
      case 'divider':
        container.appendChild(toElement(<hr className="config-divider" />));
        break;
      case 'spacer':
        container.appendChild(toElement(<div className="config-spacer"></div>));
        break;
      case 'label':
        container.appendChild(toElement(
          <div className={labelColorClass(item.color)} id={`config-label-${pluginId}-${item.id}`}>{item.text ?? ''}</div>
        ));
        break;
      case 'button': {
        const btn = toElement(
          <button className={`btn btn-sm${item.style === 'primary' ? ' btn-primary' : ''}`}>
            {item.icon ? raw(item.icon) : null}
            {item.label ?? 'Action'}
          </button>
        );
        btn.addEventListener('click', async () => {
          if (!item.action) return;
          (btn as HTMLButtonElement).disabled = true;
          try {
            await api(`/plugins/${pluginId}/action`, {
              method: 'POST', body: { actionId: item.action },
            });
            // Refresh dynamic labels (text + color)
            const labelsRes = await api<Record<string, { text: string; color?: string }>>(`/plugins/config-labels/${pluginId}`);
            for (const [labelId, payload] of Object.entries(labelsRes)) {
              const el = container.querySelector(`#config-label-${pluginId}-${labelId}`);
              if (el) {
                el.textContent = payload.text;
                el.className = labelColorClass(payload.color);
              }
            }
          } catch (e) {
            console.error('Config action failed:', e);
          }
          (btn as HTMLButtonElement).disabled = false;
        });
        container.appendChild(btn);
        break;
      }
      case 'group': {
        const collapsed = item.collapsed === true;
        const chevronRight = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
        const chevronDown = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
        const group = toElement(
          <div className={`config-group${collapsed ? ' collapsed' : ''}`}>
            <div className="config-group-header">
              <span className="config-group-title">{item.title ?? 'Group'}</span>
              <span className="config-group-chevron">{raw(collapsed ? chevronRight : chevronDown)}</span>
            </div>
            <div className="config-group-body" style={collapsed ? 'display:none' : ''}></div>
          </div>
        );
        group.querySelector('.config-group-header')!.addEventListener('click', () => {
          const bodyEl = group.querySelector('.config-group-body') as HTMLElement;
          const chevron = group.querySelector('.config-group-chevron') as HTMLElement;
          const isCollapsed = bodyEl.style.display === 'none';
          bodyEl.style.display = isCollapsed ? '' : 'none';
          chevron.innerHTML = isCollapsed ? chevronDown : chevronRight;
          group.classList.toggle('collapsed', !isCollapsed);
        });
        if (item.items) {
          renderConfigLayout(group.querySelector('.config-group-body')!, item.items, pluginId, prefsMap);
        }
        container.appendChild(group);
        break;
      }
    }
  }
}

function createPreferenceRow(pluginId: string, pref: PluginPreference): HTMLElement {
  const isGlobal = pref.scope === 'global';
  const row = toElement(
    <div className="plugin-pref-row">
      <label className="plugin-pref-label">
        {pref.label}
        {pref.required ? <span className="plugin-pref-required">*</span> : null}
        {isGlobal ? <span className="global-setting-badge">Global</span> : null}
      </label>
      {pref.description ? <span className="settings-hint">{pref.description}</span> : null}
      <div className="plugin-pref-input" id={`pref-input-${pluginId}-${pref.key}`}></div>
      <div className="plugin-pref-validation" id={`pref-validation-${pluginId}-${pref.key}`}></div>
    </div>
  );

  const inputContainer = row.querySelector(`#pref-input-${pluginId}-${pref.key}`)!;

  // Load current value from the correct source
  if (isGlobal) {
    void api<{ value: string | null }>(`/plugins/${pluginId}/global-config/${pref.key}`).then(result => {
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, result.value ?? String(pref.default ?? ''));
    }).catch(() => {
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, String(pref.default ?? ''));
    });
  } else {
    void api<Record<string, string>>('/settings').then(settings => {
      const settingKey = `plugin:${pluginId}:${pref.key}`;
      const currentValue = settings[settingKey] ?? String(pref.default ?? '');
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, currentValue);
    }).catch(() => {
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, String(pref.default ?? ''));
    });
  }

  return row;
}

function renderPrefInput(container: HTMLElement, pluginId: string, pref: PluginPreference, currentValue: string) {
  container.innerHTML = '';
  let input: HTMLElement;

  if ((pref.type === 'select' || pref.type === 'dropdown') && pref.options) {
    const select = toElement(
      <select className="settings-select">
        {pref.options.map(opt =>
          <option value={opt.value} selected={opt.value === currentValue}>{opt.label}</option>
        )}
      </select>
    ) as HTMLSelectElement;
    select.addEventListener('change', () => savePrefValue(pluginId, pref, select.value));
    input = select;
  } else if (pref.type === 'combo' && pref.options) {
    // Combo box: text input with a custom dropdown (not native <datalist>,
    // which has platform-specific dark mode rendering bugs in Tauri/WKWebView).
    const wrapper = toElement(<div className="plugin-combo-wrapper"></div>);
    const textInput = toElement(
      <input type="text" className="settings-input plugin-combo-input" value={currentValue} autocomplete="off" />
    ) as HTMLInputElement;
    const dropdown = toElement(<div className="plugin-combo-dropdown"></div>);

    function positionDropdown() {
      const rect = textInput.getBoundingClientRect();
      dropdown.style.left = `${rect.left}px`;
      dropdown.style.top = `${rect.bottom + 2}px`;
      dropdown.style.width = `${rect.width}px`;
    }

    function renderOptions(filter = '') {
      dropdown.innerHTML = '';
      const lower = filter.toLowerCase();
      const filtered = pref.options!.filter(opt =>
        lower === '' || opt.label.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower),
      );
      if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
      for (const opt of filtered) {
        const item = toElement(
          <div className={`plugin-combo-option${opt.value === textInput.value ? ' active' : ''}`}>{opt.label}</div>,
        );
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent blur before value is set
          textInput.value = opt.value;
          dropdown.style.display = 'none';
          savePrefValue(pluginId, pref, opt.value);
        });
        dropdown.appendChild(item);
      }
      positionDropdown();
      dropdown.style.display = 'block';
    }

    textInput.addEventListener('focus', () => renderOptions(textInput.value));
    textInput.addEventListener('input', () => renderOptions(textInput.value));
    textInput.addEventListener('blur', () => {
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
      savePrefValue(pluginId, pref, textInput.value);
    });

    // Append dropdown to body (not wrapper) so it escapes overflow-clipping parents
    wrapper.appendChild(textInput);
    document.body.appendChild(dropdown);
    input = wrapper;
  } else if (pref.type === 'boolean') {
    const checkbox = toElement(
      <label className="settings-checkbox-label">
        <input type="checkbox" checked={currentValue === 'true'} />
        <span>{pref.label}</span>
      </label>
    );
    const cb = checkbox.querySelector('input')!;
    cb.addEventListener('change', () => savePrefValue(pluginId, pref, String(cb.checked)));
    input = checkbox;
  } else {
    const textInput = toElement(
      <input
        type={pref.secret ? 'password' : 'text'}
        className="settings-input"
        value={currentValue}
        placeholder={pref.description ?? ''}
      />
    ) as HTMLInputElement;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    textInput.addEventListener('input', () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => savePrefValue(pluginId, pref, textInput.value), 500);
    });
    input = textInput;
  }

  container.appendChild(input);
}

function savePrefValue(pluginId: string, pref: PluginPreference, value: string) {
  if (pref.scope === 'global') {
    void api(`/plugins/${pluginId}/global-config`, { method: 'POST', body: { key: pref.key, value } });
  } else {
    const settingKey = `plugin:${pluginId}:${pref.key}`;
    void api('/settings', { method: 'PATCH', body: { [settingKey]: value } });
  }
  // Trigger validation
  void validateField(pluginId, pref.key, value);
}

async function validateField(pluginId: string, key: string, value: string) {
  const el = document.getElementById(`pref-validation-${pluginId}-${key}`);
  if (!el) return;
  try {
    const result = await api<{ status: string; message: string } | null>(
      `/plugins/validate/${pluginId}`, { method: 'POST', body: { key, value } },
    );
    if (!result) { el.textContent = ''; el.className = 'plugin-pref-validation'; return; }
    el.textContent = result.message;
    el.className = `plugin-pref-validation ${result.status}`;
  } catch {
    el.textContent = '';
    el.className = 'plugin-pref-validation';
  }
}

// --- Conflict resolution UI ---

async function loadConflicts() {
  const section = document.getElementById('plugin-conflicts-section')!;
  const list = document.getElementById('plugin-conflict-list')!;
  const countBadge = document.getElementById('plugin-conflict-count')!;

  let conflicts: SyncConflict[];
  try {
    conflicts = await api<SyncConflict[]>('/sync/conflicts');
  } catch {
    return;
  }

  if (conflicts.length === 0) {
    section.style.display = 'none';
    // Remove badge from Plugins tab
    const tab = document.getElementById('settings-tab-plugins');
    const badge = tab?.querySelector('.plugin-tab-badge');
    if (badge) badge.remove();
    return;
  }

  section.style.display = '';
  countBadge.textContent = String(conflicts.length);

  // Add badge to Plugins tab
  const tab = document.getElementById('settings-tab-plugins');
  if (tab && !tab.querySelector('.plugin-tab-badge')) {
    tab.appendChild(toElement(<span className="plugin-tab-badge">{String(conflicts.length)}</span>));
  }

  list.innerHTML = '';
  for (const conflict of conflicts) {
    list.appendChild(createConflictRow(conflict));
  }
}

function createConflictRow(conflict: SyncConflict): HTMLElement {
  const data = conflict.conflict_data ? JSON.parse(conflict.conflict_data) as {
    local: Record<string, unknown>;
    remote: Record<string, unknown>;
  } : null;

  const conflictFields = data
    ? Object.keys(data.local).filter(k => JSON.stringify(data.local[k]) !== JSON.stringify(data.remote[k]))
    : [];

  const row = toElement(
    <div className="conflict-row">
      <div className="conflict-header">
        <span className="conflict-ticket">Ticket #{conflict.ticket_id}</span>
        <span className="conflict-plugin">{conflict.plugin_id}</span>
        <span className="conflict-remote">Remote: {conflict.remote_id}</span>
      </div>
      {conflictFields.length > 0 ? (
        <div className="conflict-fields">
          {conflictFields.map(field => (
            <div className="conflict-field">
              <span className="conflict-field-name">{field}</span>
              <span className="conflict-field-local">Local: {String(data!.local[field] ?? '(empty)')}</span>
              <span className="conflict-field-remote">Remote: {String(data!.remote[field] ?? '(empty)')}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="conflict-actions">
        <button className="btn btn-sm" data-action="keep_local">Keep Local</button>
        <button className="btn btn-sm" data-action="keep_remote">Keep Remote</button>
      </div>
    </div>
  );

  row.querySelectorAll('.conflict-actions button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const resolution = (btn as HTMLElement).dataset.action as 'keep_local' | 'keep_remote';
      try {
        await api(`/sync/conflicts/${conflict.ticket_id}/resolve`, {
          method: 'POST',
          body: { plugin_id: conflict.plugin_id, resolution },
        });
        void loadConflicts();
      } catch { /* ignore */ }
    });
  });

  return row;
}
