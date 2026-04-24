import { raw } from '../jsx-runtime.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { loadTickets } from './ticketList.js';
import { showToast } from './toast.js';

interface PluginUIElement {
  id: string;
  type: string;
  location: string;
  label?: string;
  icon?: string;
  title?: string;
  color?: string;
  style?: string;
  action?: string;
  url?: string;
  _pluginId?: string;
}

let cachedElements: PluginUIElement[] = [];

// --- Plugin busy state ---

const busyPlugins = new Map<string, string>(); // pluginId → display name

const SPINNER_12 = '<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

function setPluginBusy(pluginId: string, name: string, busy: boolean) {
  if (busy) busyPlugins.set(pluginId, name);
  else busyPlugins.delete(pluginId);
  updateBusyIndicator();
  updateToolbarButtonState(pluginId, busy);
}

function updateBusyIndicator() {
  const indicator = document.getElementById('plugin-busy-indicator');
  if (!indicator) return;

  if (busyPlugins.size === 0) {
    indicator.style.display = 'none';
    return;
  }

  const names = Array.from(busyPlugins.values());
  // Check if Claude is also busy
  const claudeIndicator = document.getElementById('channel-status-indicator');
  const claudeBusy = claudeIndicator && claudeIndicator.style.display !== 'none' &&
    claudeIndicator.classList.contains('busy');

  let label: string;
  if (claudeBusy === true) {
    label = [...names, 'Claude'].join(' and ') + ' Working';
  } else {
    label = names.join(' and ') + ' Working';
  }

  indicator.style.display = '';
  indicator.innerHTML = `${SPINNER_12} ${label}`;
}

function updateToolbarButtonState(_pluginId: string, busy: boolean) {
  const container = document.querySelector('.plugin-toolbar-container');
  if (!container) return;
  for (const btn of container.querySelectorAll('.plugin-toolbar-btn')) {
    (btn as HTMLButtonElement).disabled = busy;
  }
}

// --- Loading + rendering ---

export async function loadPluginUI(): Promise<void> {
  try {
    cachedElements = await api<PluginUIElement[]>('/plugins/ui');
  } catch {
    cachedElements = [];
  }
}

export function getPluginUIForLocation(location: string): PluginUIElement[] {
  return cachedElements.filter(e => e.location === location);
}

/** Reload plugin UI elements from the server and re-render all plugin UI locations.
 *  Call after enable/disable to refresh visible plugin controls. */
export async function refreshPluginUI(): Promise<void> {
  await loadPluginUI();
  // Re-render toolbar
  const toolbar = document.querySelector('.plugin-toolbar-container');
  if (toolbar) { toolbar.innerHTML = ''; renderPluginToolbarButtons(toolbar as HTMLElement); }
  // Re-render status bar, sidebar top/bottom
  renderPluginLocationElements('plugin-status-bar', 'status_bar');
  renderPluginLocationElements('plugin-sidebar-top', 'sidebar_actions_top');
  renderPluginLocationElements('plugin-sidebar-bottom', 'sidebar_actions_bottom');
}

/** Render plugin UI elements into a container by DOM id and plugin location. */
function renderPluginLocationElements(containerId: string, location: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const elements = getPluginUIForLocation(location);
  for (const el of elements) {
    const rendered = createPluginElement(el);
    if (rendered) container.appendChild(rendered);
  }
}

/** Render plugin UI elements into a toolbar container. */
export function renderPluginToolbarButtons(container: HTMLElement): void {
  const elements = getPluginUIForLocation('toolbar');
  for (const el of elements) {
    const btn = createPluginButton(el);
    if (btn) container.appendChild(btn);
  }
}

/** Render plugin UI elements for the detail panel (top or bottom). */
export function renderPluginDetailElements(container: HTMLElement, location: 'detail_top' | 'detail_bottom', ticketIds: number[]): void {
  void ticketIds; // reserved for future per-ticket element rendering
  const elements = getPluginUIForLocation(location);
  for (const el of elements) {
    const rendered = createPluginElement(el);
    if (rendered) container.appendChild(rendered);
  }
}

/** Get plugin context menu items. */
export function getPluginContextMenuItems(ticketIds: number[]): { label: string; icon?: string; action: () => void }[] {
  const elements = getPluginUIForLocation('context_menu');
  return elements.map(el => ({
    label: el.label ?? el.title ?? el.id,
    icon: el.icon,
    action: () => void triggerAction(el, ticketIds),
  }));
}

/** Get plugin batch menu items. */
export function getPluginBatchMenuItems(ticketIds: number[]): { label: string; key: string; icon?: string; action: () => void }[] {
  const elements = getPluginUIForLocation('batch_menu');
  return elements.map(el => ({
    label: el.label ?? el.title ?? el.id,
    key: '',
    icon: el.icon,
    action: () => void triggerAction(el, ticketIds),
  }));
}

function createPluginButton(el: PluginUIElement): HTMLElement | null {
  if (el.type !== 'button') return null;

  // Toolbar: icon-only (compact). All other locations: show icon + label.
  const isToolbar = el.location === 'toolbar';
  const btn = toElement(
    <button
      className={`plugin-toolbar-btn${el.style === 'primary' ? ' primary' : ''}${el.style === 'danger' ? ' danger' : ''}`}
      title={el.title ?? el.label ?? ''}
    >
      {el.icon != null ? raw(el.icon) : null}
      {el.label != null && (!isToolbar || el.icon == null) ? <span>{el.label}</span> : null}
    </button>
  );

  btn.addEventListener('click', () => void triggerAction(el));
  return btn;
}

function createPluginElement(el: PluginUIElement): HTMLElement | null {
  if (el.type === 'button') return createPluginButton(el);
  if (el.type === 'link' && el.url != null && el.url !== '') {
    const link = toElement(
      <a className="plugin-ui-link" href={el.url} target="_blank" rel="noopener" title={el.title ?? ''}>
        {el.icon != null && el.icon !== '' ? raw(el.icon) : null}
        {el.label ?? el.url}
      </a>
    );
    return link;
  }
  return null;
}

async function triggerAction(el: PluginUIElement, ticketIds?: number[]): Promise<void> {
  if (el.action == null || el.action === '' || el._pluginId == null || el._pluginId === '') return;

  // Resolve display name from the element's plugin
  const pluginName = el.title?.replace('Sync with ', '') ?? el._pluginId;

  try {
    const result = await api<{ ok: boolean; result?: { redirect?: string; message?: string } }>(
      `/plugins/${el._pluginId}/action`,
      { method: 'POST', body: { actionId: el.action, ticketIds } },
    );

    // Handle special redirects
    if (result.result?.redirect === 'sync') {
      setPluginBusy(el._pluginId, pluginName, true);
      try {
        await api(`/plugins/${el._pluginId}/sync`, { method: 'POST' });
        void loadTickets();
      } finally {
        setPluginBusy(el._pluginId, pluginName, false);
      }
    } else if (result.result?.message != null && result.result.message !== '') {
      showToast(result.result.message);
    }
  } catch (e) {
    console.error(`Plugin action failed: ${getErrorMessage(e)}`);
    setPluginBusy(el._pluginId, pluginName, false);
  }
}

// Toast moved to `./toast.tsx` (HS-7264) so the OSC 9 desktop-notification
// path can reuse the same transient UI.
