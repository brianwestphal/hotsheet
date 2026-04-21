import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';

type Status = 'not-connected' | 'connecting' | 'alive' | 'exited';

// Lucide "square" (stop) and "play" (start) glyphs — used for the power toggle button.
const POWER_ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
const POWER_ICON_START = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export interface TerminalTabConfig {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  lazy?: boolean;
  /** True for dynamically-created terminals (closable from the tab strip). */
  dynamic?: boolean;
}

interface TerminalInstance {
  id: string;
  config: TerminalTabConfig;
  term: XTerm | null;
  fit: FitAddon | null;
  body: HTMLElement;
  header: HTMLElement;
  label: HTMLElement;
  statusDot: HTMLElement;
  pane: HTMLElement;
  tabBtn: HTMLElement;
  ws: WebSocket | null;
  wsSecret: string | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  status: Status;
  exitCode: number | null;
  stopRequested: boolean;
  /** Becomes true once the xterm DOM has been mounted (happens on first activation). */
  mounted: boolean;
}

const instances = new Map<string, TerminalInstance>();
let activeTerminalId: string | null = null;
/** Populated on each loadAndRenderTerminalTabs(). Consumed by settings-refresh flows. */
let lastKnownConfigs: { configured: TerminalTabConfig[]; dynamic: TerminalTabConfig[] } = { configured: [], dynamic: [] };

/** One-time DOM setup for the terminal area inside the drawer. Called from app init. */
export function initTerminal(): void {
  // Wire up the new + button that creates dynamic terminals.
  document.getElementById('drawer-add-terminal-btn')?.addEventListener('click', () => { void createDynamicTerminal(); });
  window.addEventListener('resize', () => {
    const active = activeTerminalId === null ? null : instances.get(activeTerminalId);
    if (active !== null && active !== undefined && isTerminalTabActive(active)) doFit(active);
  });
}

/**
 * Load the configured + dynamic terminals from the server and (re)render the
 * drawer tab buttons accordingly. Called once at drawer first-open and again
 * whenever the user saves the Embedded Terminal settings.
 */
export async function loadAndRenderTerminalTabs(): Promise<void> {
  type ListResponse = { configured: TerminalTabConfig[]; dynamic: TerminalTabConfig[] };
  let data: ListResponse;
  try {
    data = await api<ListResponse>('/terminal/list');
  } catch {
    return;
  }
  lastKnownConfigs = data;

  const tabStrip = document.getElementById('drawer-terminal-tabs');
  const paneContainer = document.getElementById('drawer-terminal-panes');
  if (!tabStrip || !paneContainer) return;

  const wanted = new Map<string, TerminalTabConfig>();
  for (const c of data.configured) wanted.set(c.id, { ...c, dynamic: false });
  for (const c of data.dynamic) wanted.set(c.id, { ...c, dynamic: true });

  // Remove instances for terminals that no longer exist server-side.
  for (const id of [...instances.keys()]) {
    if (!wanted.has(id)) removeTerminalInstance(id);
  }

  // Ensure an instance + DOM exists for every wanted terminal, in order.
  tabStrip.innerHTML = '';
  paneContainer.querySelectorAll('.drawer-terminal-pane').forEach(el => el.remove());

  for (const config of wanted.values()) {
    let inst = instances.get(config.id);
    if (!inst) {
      inst = createInstance(config);
      instances.set(config.id, inst);
    } else {
      // Config may have changed; update label text if the user renamed.
      inst.config = { ...inst.config, ...config };
      updateTabLabel(inst);
    }
    tabStrip.appendChild(inst.tabBtn);
    paneContainer.appendChild(inst.pane);
  }

  // If the previously-active id no longer exists, default to the first terminal.
  if (activeTerminalId !== null && !wanted.has(activeTerminalId)) {
    activeTerminalId = null;
  }
}

/** Activate the named terminal tab (mount xterm + connect ws on first activation). */
export function activateTerminal(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  activeTerminalId = id;

  // Hide other terminal panes; show this one.
  for (const other of instances.values()) {
    other.pane.style.display = other.id === id ? '' : 'none';
    other.tabBtn.classList.toggle('active', other.id === id);
  }

  const active = getActiveProject();
  if (!active) return;

  if (!inst.mounted) {
    mountXterm(inst, active.secret);
    connect(inst);
    inst.mounted = true;
  } else if (inst.wsSecret !== active.secret) {
    // Project switched — rebuild from scratch.
    teardown(inst);
    mountXterm(inst, active.secret);
    connect(inst);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      doFit(inst);
      inst.term?.focus();
    });
  });
}

/** Drawer visibility flipped off — stop sending resizes etc. */
export function deactivateAllTerminals(): void {
  for (const inst of instances.values()) {
    inst.tabBtn.classList.remove('active');
  }
}

/** Is the given instance the currently-active drawer tab? */
function isTerminalTabActive(inst: TerminalInstance): boolean {
  return activeTerminalId === inst.id && inst.pane.style.display !== 'none';
}

function createInstance(config: TerminalTabConfig): TerminalInstance {
  const label = toElement(<span className="drawer-tab-label">{tabDisplayName(config)}</span>);
  const closeBtn = config.dynamic === true
    ? toElement(<button className="drawer-tab-close" title="Close terminal">{raw(CLOSE_ICON)}</button>)
    : null;
  const tabBtn = toElement(
    <button className="drawer-tab drawer-terminal-tab" data-drawer-tab={`terminal:${config.id}`} data-terminal-id={config.id}>
      {label}
    </button>
  );
  if (closeBtn) tabBtn.appendChild(closeBtn);
  tabBtn.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;
    // Delegate to the drawer tab switcher so the Commands Log pane is hidden too.
    void selectDrawerTab(`terminal:${config.id}`);
  });
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeDynamicTerminal(config.id);
  });

  const statusDot = toElement(<span className="terminal-status-dot" title="Not connected"></span>);
  const labelText = toElement(<span className="terminal-label">{tabDisplayName(config)}</span>);
  const powerBtn = toElement(
    <button className="terminal-header-btn terminal-power-btn" title="Stop terminal">
      <span className="terminal-power-icon">{raw(POWER_ICON_STOP)}</span>
    </button>
  );
  const clearBtn = toElement(
    <button className="terminal-header-btn" title="Clear screen (keeps process running)">
      {raw(TRASH_ICON)}
    </button>
  );
  const header = toElement(
    <div className="terminal-header">
      {statusDot}
      {labelText}
      <span className="terminal-header-spacer"></span>
      {powerBtn}
      {clearBtn}
    </div>
  );
  const body = toElement(<div className="terminal-body"></div>);
  const pane = toElement(
    <div className="drawer-tab-content drawer-terminal-pane" data-drawer-panel={`terminal:${config.id}`} style="display:none">
      {header}
      {body}
    </div>
  );

  const inst: TerminalInstance = {
    id: config.id,
    config,
    term: null,
    fit: null,
    body,
    header,
    label: labelText,
    statusDot,
    pane,
    tabBtn,
    ws: null,
    wsSecret: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    status: 'not-connected',
    exitCode: null,
    stopRequested: false,
    mounted: false,
  };

  powerBtn.addEventListener('click', () => { void onPowerClick(inst); });
  clearBtn.addEventListener('click', () => { inst.term?.clear(); });

  return inst;
}

function tabDisplayName(config: TerminalTabConfig): string {
  if (typeof config.name === 'string' && config.name !== '') return config.name;
  const word = config.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  return clean !== '' ? clean : 'terminal';
}

function updateTabLabel(inst: TerminalInstance): void {
  const name = tabDisplayName(inst.config);
  const labelEl = inst.tabBtn.querySelector('.drawer-tab-label');
  if (labelEl) labelEl.textContent = name;
  inst.label.textContent = name;
}

function mountXterm(inst: TerminalInstance, secret: string): void {
  const term = new XTerm({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: readTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(new SerializeAddon());
  term.open(inst.body);

  inst.body.addEventListener('click', () => { term.focus(); });

  const encoder = new TextEncoder();
  term.onData((data) => {
    if (inst.ws !== null && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(encoder.encode(data));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (inst.ws !== null && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  inst.term = term;
  inst.fit = fit;
  inst.wsSecret = secret;
}

function connect(inst: TerminalInstance): void {
  if (inst.wsSecret === null) return;
  setStatus(inst, 'connecting');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/terminal/ws?project=${encodeURIComponent(inst.wsSecret)}&terminal=${encodeURIComponent(inst.id)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  inst.ws = ws;

  ws.addEventListener('open', () => {
    inst.reconnectAttempts = 0;
    if (inst.term) ws.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }));
  });
  ws.addEventListener('message', (ev) => {
    const data: unknown = ev.data;
    if (data instanceof ArrayBuffer) { inst.term?.write(new Uint8Array(data)); return; }
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as { type: string; [k: string]: unknown };
        handleControlMessage(inst, msg);
      } catch { /* ignore malformed */ }
    }
  });
  ws.addEventListener('close', () => {
    inst.ws = null;
    if (inst.status === 'alive') {
      setStatus(inst, 'not-connected');
      scheduleReconnect(inst);
    }
  });
  ws.addEventListener('error', () => { /* close handles cleanup */ });
}

interface HistoryMessage { type: 'history'; bytes: string; alive: boolean; exitCode: number | null; cols: number; rows: number; command: string }
interface ExitMessage { type: 'exit'; code: number }

function handleControlMessage(inst: TerminalInstance, msg: { type: string; [k: string]: unknown }): void {
  if (msg.type === 'history') {
    const h = msg as unknown as HistoryMessage;
    if (inst.term && h.bytes && h.bytes.length > 0) {
      inst.term.write(base64ToUint8Array(h.bytes));
    }
    inst.exitCode = h.exitCode;
    setStatus(inst, h.alive ? 'alive' : 'exited');
    if (typeof h.command === 'string' && h.command !== '') {
      // Prefer the user-supplied name; fall back to resolved command for unnamed terminals.
      if ((inst.config.name ?? '') === '') inst.label.textContent = shortCommandName(h.command);
    }
    if (inst.term && Number.isFinite(h.cols) && Number.isFinite(h.rows) && h.cols > 0 && h.rows > 0) {
      inst.term.resize(h.cols, h.rows);
    }
    requestAnimationFrame(() => doFit(inst));
    return;
  }
  if (msg.type === 'exit') {
    const e = msg as unknown as ExitMessage;
    inst.exitCode = e.code;
    setStatus(inst, 'exited');
    inst.term?.write(`\r\n[process exited with code ${e.code}]\r\n`);
    return;
  }
}

function shortCommandName(command: string): string {
  if (command.startsWith('claude')) return 'claude';
  return command.split(/\s+/)[0] ?? 'terminal';
}

function scheduleReconnect(inst: TerminalInstance): void {
  if (inst.reconnectTimer !== null) return;
  const delayMs = Math.min(1000 * 2 ** inst.reconnectAttempts, 15_000);
  inst.reconnectAttempts += 1;
  inst.reconnectTimer = setTimeout(() => {
    inst.reconnectTimer = null;
    connect(inst);
  }, delayMs);
}

function setStatus(inst: TerminalInstance, status: Status): void {
  inst.status = status;
  inst.statusDot.className = `terminal-status-dot status-${status}`;
  inst.statusDot.setAttribute('title', {
    'not-connected': 'Not connected',
    'connecting': 'Connecting…',
    'alive': 'Running',
    'exited': inst.exitCode !== null ? `Exited (code ${inst.exitCode})` : 'Exited',
  }[status]);
  if (status !== 'alive') inst.stopRequested = false;
  updatePowerButton(inst);
}

function updatePowerButton(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-power-btn');
  const icon = btn?.querySelector<HTMLElement>('.terminal-power-icon');
  if (!btn || !icon) return;
  const showStop = inst.status === 'alive' || inst.status === 'connecting';
  icon.innerHTML = showStop ? POWER_ICON_STOP : POWER_ICON_START;
  btn.setAttribute('title', showStop
    ? (inst.stopRequested ? 'Stop again to force quit' : 'Stop terminal')
    : 'Start terminal');
  btn.classList.toggle('is-stop-pending', showStop && inst.stopRequested);
}

async function onPowerClick(inst: TerminalInstance): Promise<void> {
  const alive = inst.status === 'alive' || inst.status === 'connecting';

  if (alive && !inst.stopRequested) {
    inst.stopRequested = true;
    updatePowerButton(inst);
    try { await api('/terminal/kill', { method: 'POST', body: { terminalId: inst.id } }); } catch { /* ignore */ }
    return;
  }

  if (alive && inst.stopRequested) {
    const confirmed = window.confirm('The terminal process has not stopped. Force quit (SIGKILL) the process?');
    if (!confirmed) return;
    try { await api('/terminal/kill', { method: 'POST', body: { terminalId: inst.id, signal: 'SIGKILL' } }); } catch { /* ignore */ }
    return;
  }

  try {
    await api('/terminal/restart', { method: 'POST', body: { terminalId: inst.id } });
    inst.term?.clear();
    inst.exitCode = null;
    setStatus(inst, 'alive');
  } catch { /* ignore */ }
}

function teardown(inst: TerminalInstance): void {
  if (inst.reconnectTimer !== null) clearTimeout(inst.reconnectTimer);
  inst.reconnectTimer = null;
  if (inst.ws) { try { inst.ws.close(); } catch { /* ignore */ } }
  inst.ws = null;
  inst.term?.dispose();
  inst.term = null;
  inst.fit = null;
  inst.mounted = false;
  inst.status = 'not-connected';
}

function removeTerminalInstance(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  teardown(inst);
  inst.tabBtn.remove();
  inst.pane.remove();
  instances.delete(id);
  if (activeTerminalId === id) activeTerminalId = null;
}

function doFit(inst: TerminalInstance): void {
  if (!inst.fit) return;
  try { inst.fit.fit(); } catch { /* body not visible yet */ }
}

function readTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const getColor = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: getColor('--bg', '#ffffff'),
    foreground: getColor('--text', '#000000'),
    cursor: getColor('--accent', '#3b82f6'),
  };
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Dynamic terminal lifecycle (HS-6306) ---

async function createDynamicTerminal(): Promise<void> {
  try {
    const { config } = await api<{ config: TerminalTabConfig }>('/terminal/create', { method: 'POST' });
    await loadAndRenderTerminalTabs();
    await selectDrawerTab(`terminal:${config.id}`);
  } catch { /* ignore */ }
}

async function closeDynamicTerminal(id: string): Promise<void> {
  try {
    await api('/terminal/destroy', { method: 'POST', body: { terminalId: id } });
  } catch { /* ignore */ }
  removeTerminalInstance(id);
  // Fall back to Commands Log if we closed the active tab.
  if (activeTerminalId === null) await selectDrawerTab('commands-log');
}

// Bridge to the drawer tab switcher implemented in commandLog.tsx.
async function selectDrawerTab(tabId: string): Promise<void> {
  const mod = await import('./commandLog.js');
  mod.switchDrawerTab(tabId);
}

/** Called by experimental settings after the user saves the terminals list. */
export async function refreshTerminalsAfterSettingsChange(): Promise<void> {
  await loadAndRenderTerminalTabs();
}

/** Exposed for debugging / tests. */
export function getLastKnownTerminalConfigs() {
  return lastKnownConfigs;
}
