import {
  disablePlugin, disablePluginEverywhere, enablePlugin, enablePluginEverywhere,
  getBundledPlugins, getPlugin, getSyncConflicts, installBundledPlugin, installPlugin, listPlugins,
  type PluginInfo, resolveSyncConflict, revealPlugin, type SyncConflict, uninstallPlugin,
} from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { raw } from '../jsx-runtime.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { ICON_FOLDER_OPEN, ICON_GLOBE, ICON_POWER, ICON_SETTINGS, ICON_UNINSTALL } from './icons.js';
import { createPreferenceRow, renderConfigLayout } from './pluginConfigDialog.js';
// HS-8686 — diff helper extracted to its own module + unit-tested. The
// previous inline render lived right here with a too-narrow zod schema that
// rejected the `tags: string[]` field every real conflict carries, silently
// dropping the whole diff section.
import { computeConflictDiff,type ConflictFieldDiff } from './pluginConflictDiff.js';
import { STATUS_DOT } from './pluginTypes.js';
import { refreshPluginUI } from './pluginUI.js';
import { refreshSyncConflictBanner } from './syncConflictBanner.js';
import { getTauriInvoke } from './tauriIntegration.js';

const CONFIGURE_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;

export function bindPluginSettings() {
  const settingsBtn = byId('settings-btn');
  settingsBtn.addEventListener('click', () => { void loadPlugins(); });

  const installBtn = byId('plugin-install-btn');
  installBtn.addEventListener('click', () => showFindPluginsDialog());
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
  void getBundledPlugins().then(bundled => {
    if (bundled.length === 0) {
      // HS-8554 — `.plugin-empty-message` carries the previous inline styles.
      officialPanel.replaceChildren(toElement(<div className="plugin-empty-message plugin-empty-message-centered">No official plugins available.</div>));
      return;
    }
    officialPanel.replaceChildren();
    for (const bp of bundled) {
      const row = toElement(
        <div className="bundled-plugin-row">
          <div className="bundled-plugin-info">
            {bp.manifest.icon != null && bp.manifest.icon !== '' ? <span className="bundled-plugin-icon">{
              // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- `bp.manifest.icon` is plugin-manifest SVG (trusted plugin data, bundled with the plugin).
              raw(bp.manifest.icon)
            }</span> : null}
            <div>
              <div className="bundled-plugin-name">{bp.manifest.name} <span className="plugin-version">v{bp.manifest.version}</span></div>
              {bp.manifest.description != null && bp.manifest.description !== '' ? <div className="bundled-plugin-desc">{bp.manifest.description}</div> : null}
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
            await installBundledPlugin(bp.manifest.id);
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
        if (selected != null && selected !== '') { pathInput.value = selected; confirmBtn.disabled = false; }
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
      await installPlugin(path);
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
  const list = byId('plugin-list');
  let plugins: PluginInfo[];
  try {
    plugins = await listPlugins();
  } catch {
    // HS-8554 — `.plugin-empty-message` carries the previous inline styles.
    list.replaceChildren(toElement(<div className="plugin-empty-message">Failed to load plugins.</div>));
    return;
  }

  if (plugins.length === 0) {
    list.replaceChildren(toElement(
      <div className="plugin-empty-message">
        No plugins installed. Place plugins in <code>~/.hotsheet/plugins/</code> and restart.
      </div>
    ));
    return;
  }

  list.replaceChildren();
  for (const plugin of plugins) {
    list.appendChild(createPluginRow(plugin));
  }

  void loadConflicts();
}

function createPluginRow(plugin: PluginInfo): HTMLElement {
  const statusHtml = plugin.error != null && plugin.error !== ''
    ? STATUS_DOT.error
    : plugin.needsConfiguration === true
      ? STATUS_DOT.needsConfig
      : plugin.enabled ? STATUS_DOT.connected : STATUS_DOT.disconnected;

  const statusLabel = plugin.error != null && plugin.error !== ''
    ? null
    : plugin.needsConfiguration === true
      ? 'Needs Configuration'
      : null;

  const row = toElement(
    <div className={`plugin-row${plugin.enabled ? ' enabled' : ''}${!plugin.enabled ? ' disabled' : ''}`} data-plugin-id={plugin.id}>
      <div className="plugin-row-header">
        <div className="plugin-row-info">
          {statusHtml}
          <span className="plugin-name">{plugin.name}</span>
          <span className="plugin-version">v{plugin.version}</span>
          {statusLabel ? <span className="plugin-needs-config">{statusLabel}</span> : null}
        </div>
        <button className="plugin-configure-btn" title="Configure">{CONFIGURE_ICON}</button>
      </div>
      {plugin.description != null && plugin.description !== '' ? <div className="plugin-description">{plugin.description}</div> : null}
      {plugin.error != null && plugin.error !== '' ? <div className="plugin-error">{plugin.error}</div> : null}
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
    showPluginContextMenu(e, plugin);
  });

  return row;
}

function showPluginContextMenu(e: MouseEvent, plugin: PluginInfo) {
  // Close any existing context menu
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = toElement(<div className="context-menu" style={`top:${e.clientY}px;left:${e.clientX}px;z-index:3000`}></div>);

  // HS-7835 — Lucide icons on every plugin context-menu entry.
  const iconRow = (icon: SafeHtml, label: string, extra: string = ''): HTMLElement => toElement(
    <div className={`context-menu-item${extra}`}>
      <span className="dropdown-icon">{icon}</span>
      <span className="context-menu-label">{label}</span>
    </div>
  );

  // Configure
  const configItem = iconRow(ICON_SETTINGS, 'Configure...');
  configItem.addEventListener('click', () => {
    menu.remove();
    void showPluginConfigDialog(plugin);
  });
  menu.appendChild(configItem);

  // Enable / Disable for this project
  if (plugin.enabled) {
    const disableItem = iconRow(ICON_POWER, 'Disable');
    disableItem.addEventListener('click', async () => {
      menu.remove();
      await disablePlugin(plugin.id);
      void loadPlugins();
      void refreshPluginUI();
    });
    menu.appendChild(disableItem);
  } else {
    const enableItem = iconRow(ICON_POWER, 'Enable');
    enableItem.addEventListener('click', async () => {
      menu.remove();
      await enablePlugin(plugin.id);
      void loadPlugins();
      void refreshPluginUI();
    });
    menu.appendChild(enableItem);
  }

  // Bulk enable/disable on all open projects
  menu.appendChild(toElement(<div className="context-menu-separator"></div>));

  const enableAllItem = iconRow(ICON_GLOBE, 'Enable on All Projects');
  enableAllItem.addEventListener('click', async () => {
    menu.remove();
    await enablePluginEverywhere(plugin.id);
    void loadPlugins();
    void refreshPluginUI();
  });
  menu.appendChild(enableAllItem);

  const disableAllItem = iconRow(ICON_GLOBE, 'Disable on All Projects');
  disableAllItem.addEventListener('click', async () => {
    menu.remove();
    await disablePluginEverywhere(plugin.id);
    void loadPlugins();
    void refreshPluginUI();
  });
  menu.appendChild(disableAllItem);

  // Separator
  menu.appendChild(toElement(<div className="context-menu-separator"></div>));

  // Uninstall
  const uninstallItem = iconRow(ICON_UNINSTALL, 'Uninstall', ' danger');
  uninstallItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Replace the menu content with a confirmation prompt
    menu.replaceChildren();
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
        await uninstallPlugin(plugin.id);
        void loadPlugins();
      } catch (err) {
        console.error('Failed to uninstall:', err);
      }
    });
  });
  menu.appendChild(uninstallItem);

  // Show in Finder
  if (plugin.path != null && plugin.path !== '') {
    menu.appendChild(toElement(<div className="context-menu-separator"></div>));
    const revealItem = iconRow(ICON_FOLDER_OPEN, 'Show in Finder');
    revealItem.addEventListener('click', async () => {
      menu.remove();
      try { await revealPlugin(plugin.id); } catch { /* ignore */ }
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
    detail = await getPlugin(plugin.id);
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

// Config layout rendering and preference inputs are in pluginConfigDialog.tsx

// --- Conflict resolution UI ---

async function loadConflicts() {
  const section = byId('plugin-conflicts-section');
  const list = byId('plugin-conflict-list');
  const countBadge = byId('plugin-conflict-count');

  let conflicts: SyncConflict[];
  try {
    conflicts = await getSyncConflicts();
  } catch {
    return;
  }

  if (conflicts.length === 0) {
    section.style.display = 'none';
    // Remove badge from Plugins tab
    const tab = byIdOrNull('settings-tab-plugins');
    const badge = tab?.querySelector('.plugin-tab-badge');
    if (badge) badge.remove();
    return;
  }

  section.style.display = '';
  countBadge.textContent = String(conflicts.length);

  // Add badge to Plugins tab
  const tab = byIdOrNull('settings-tab-plugins');
  if (tab && !tab.querySelector('.plugin-tab-badge')) {
    tab.appendChild(toElement(<span className="plugin-tab-badge">{String(conflicts.length)}</span>));
  }

  list.replaceChildren();
  for (const conflict of conflicts) {
    list.appendChild(createConflictRow(conflict));
  }
}

function createConflictRow(conflict: SyncConflict): HTMLElement {
  // HS-8686 — diff via the pure helper. Returns a renderable `{status, fields,
  // summary, baseSyncedAt}` for every case, including the pre-fix empty-render
  // failure modes (parse-error, schema mismatch, metadata-only conflicts).
  const diff = computeConflictDiff(conflict.conflict_data);

  const row = toElement(
    <div className="conflict-row">
      <div className="conflict-header">
        <span className="conflict-ticket">Ticket #{conflict.ticket_id}</span>
        <span className="conflict-plugin">{conflict.plugin_id}</span>
        <span className="conflict-remote">Remote: {conflict.remote_id}</span>
      </div>
      <div className="conflict-summary">
        {diff.summary}
        {diff.baseSyncedAt !== null ? (
          <span className="conflict-base-synced"> Last clean sync: {formatConflictTimestamp(diff.baseSyncedAt)}.</span>
        ) : null}
      </div>
      {diff.fields.length > 0 ? (
        <div className="conflict-fields">
          <div className="conflict-fields-head">
            <span className="conflict-col-field">Field</span>
            <span className="conflict-col-local">Local</span>
            <span className="conflict-col-remote">Remote</span>
          </div>
          {diff.fields.map((f) => renderFieldRow(f))}
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
      if (!(btn instanceof HTMLElement)) return;
      const resolution = btn.dataset['action'] === 'keep_local' ? 'keep_local' : 'keep_remote';
      try {
        await resolveSyncConflict(conflict.ticket_id, conflict.plugin_id, resolution);
        void loadConflicts();
        // HS-8959 — a resolution may clear the last conflict; update the banner.
        void refreshSyncConflictBanner();
      } catch { /* ignore */ }
    });
  });

  return row;
}

/**
 * HS-8686 — render one field-diff row. Multiline fields (newline-containing or
 * longer than 80 chars — e.g. `details`) get block layout with `pre` so the
 * user can scan paragraph breaks; short scalar fields stay inline.
 */
function renderFieldRow(f: ConflictFieldDiff): SafeHtml {
  return (
    <div className={f.multiline ? 'conflict-field conflict-field-multiline' : 'conflict-field'} data-field={f.key}>
      <span className="conflict-field-name">{f.label}</span>
      <div className="conflict-field-local">
        <span className="conflict-field-side-label">Local</span>
        {f.multiline
          ? <pre className="conflict-field-value">{f.local}</pre>
          : <span className="conflict-field-value">{f.local}</span>
        }
      </div>
      <div className="conflict-field-remote">
        <span className="conflict-field-side-label">Remote</span>
        {f.multiline
          ? <pre className="conflict-field-value">{f.remote}</pre>
          : <span className="conflict-field-value">{f.remote}</span>
        }
      </div>
    </div>
  );
}

/**
 * Format an ISO timestamp for the "Last clean sync" hint. Falls back to the
 * raw string when `Date` rejects it — never throws, never returns junk.
 */
function formatConflictTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
