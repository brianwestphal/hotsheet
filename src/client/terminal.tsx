import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';

type Status = 'not-connected' | 'connecting' | 'alive' | 'exited';

// Lucide "square" (stop) and "play" (start) glyphs — used for the power toggle button.
const POWER_ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
const POWER_ICON_START = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
// Lucide `bell` glyph. Shown on drawer tabs when the process rings the bell
// (\x07) while the tab isn't active (HS-6473).
const BELL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

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
  /** Title pushed by the running process via OSC 0 / OSC 2 (`\x1b]0;TITLE\x07`).
   *  When non-empty, takes precedence over the configured `name` for the tab label
   *  (HS-6473, see docs/23-terminal-titles-and-bell.md). Reset on PTY restart. */
  runtimeTitle: string;
  /** True when the process has rung the bell (`\x07`) since this terminal tab
   *  was last activated. Cleared by `activateTerminal` (HS-6473). */
  hasBell: boolean;
}

const instances = new Map<string, TerminalInstance>();
let activeTerminalId: string | null = null;
/** The project secret the current instances were built for. Changes trigger a full rebuild (HS-6309). */
let currentProjectSecret: string | null = null;
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

  // HS-6502: refit the active terminal whenever the drawer panel changes size.
  // The drawer can resize without a window-level resize event — users drag the
  // top edge of the drawer (initResize in commandLog.tsx) and toggle the
  // full-height expand button. Both of those adjust the drawer element's
  // computed height directly, so we watch the drawer panel with a
  // ResizeObserver and re-run FitAddon.fit() for the active terminal.
  const drawerPanel = document.getElementById('command-log-panel');
  if (drawerPanel !== null && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const active = activeTerminalId === null ? null : instances.get(activeTerminalId);
      if (active !== null && active !== undefined && isTerminalTabActive(active)) doFit(active);
    });
    ro.observe(drawerPanel);
  }
}

/**
 * Load the configured + dynamic terminals from the server and (re)render the
 * drawer tab buttons accordingly. Called once at drawer first-open and again
 * whenever the user saves the Embedded Terminal settings.
 */
export async function loadAndRenderTerminalTabs(): Promise<void> {
  const active = getActiveProject();
  const activeSecret = active?.secret ?? null;

  // If the active project changed since the last render, every previously-mounted
  // xterm/ws is bound to the old project — tear them all down before refetching.
  // Otherwise `activateTerminal` would try to reuse stale instances keyed by id
  // (a configured `default` terminal in project A shadowing project B's `default`).
  if (currentProjectSecret !== null && currentProjectSecret !== activeSecret) {
    disposeAllInstances();
  }
  currentProjectSecret = activeSecret;

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

  // Hide other terminal panes; show this one. Clear the bell indicator on
  // the now-active tab — viewing the terminal counts as "the user has
  // acknowledged it" (HS-6473).
  for (const other of instances.values()) {
    other.pane.style.display = other.id === id ? '' : 'none';
    other.tabBtn.classList.toggle('active', other.id === id);
  }
  if (inst.hasBell) {
    inst.hasBell = false;
    updateTabLabel(inst);
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
  // IMPORTANT: the custom JSX runtime renders to an HTML string, so DOM elements
  // passed as JSX children (e.g. `<button>{label}</button>` where `label` is an
  // HTMLElement) silently render as empty strings — the resulting button has no
  // children at all. Build each tree as a single JSX expression and query the
  // inner pieces back out via querySelector. This is the root cause of HS-6342
  // (configured tabs rendered as blank buttons) and HS-6341 (dynamic tab + xterm
  // pane both rendered with no header / no label).
  const tabName = tabDisplayName(config);
  const tabBtn = toElement(
    <button className="drawer-tab drawer-terminal-tab" data-drawer-tab={`terminal:${config.id}`} data-terminal-id={config.id}>
      <span className="drawer-tab-label">{tabName}</span>
      {config.dynamic === true
        ? raw(`<button class="drawer-tab-close" title="Close terminal">${CLOSE_ICON}</button>`)
        : null}
    </button>
  );
  const closeBtn = tabBtn.querySelector<HTMLButtonElement>('.drawer-tab-close');
  tabBtn.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;
    // Delegate to the drawer tab switcher so the Commands Log pane is hidden too.
    void selectDrawerTab(`terminal:${config.id}`);
  });
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeDynamicTerminal(config.id);
  });
  tabBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e, config.id);
  });

  const pane = toElement(
    <div className="drawer-tab-content drawer-terminal-pane" data-drawer-panel={`terminal:${config.id}`} style="display:none">
      <div className="terminal-header">
        <span className="terminal-status-dot" title="Not connected"></span>
        <span className="terminal-label">{tabName}</span>
        <span className="terminal-header-spacer"></span>
        <button className="terminal-header-btn terminal-power-btn" title="Stop terminal">
          <span className="terminal-power-icon">{raw(POWER_ICON_STOP)}</span>
        </button>
        <button className="terminal-header-btn terminal-clear-btn" title="Clear screen (keeps process running)">
          {raw(TRASH_ICON)}
        </button>
      </div>
      <div className="terminal-body"></div>
    </div>
  );
  const header = pane.querySelector<HTMLElement>('.terminal-header')!;
  const body = pane.querySelector<HTMLElement>('.terminal-body')!;
  const statusDot = pane.querySelector<HTMLElement>('.terminal-status-dot')!;
  const labelText = pane.querySelector<HTMLElement>('.terminal-label')!;
  const powerBtn = pane.querySelector<HTMLButtonElement>('.terminal-power-btn')!;
  const clearBtn = pane.querySelector<HTMLButtonElement>('.terminal-clear-btn')!;

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
    runtimeTitle: '',
    hasBell: false,
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
  // Path-style commands like /bin/zsh → "zsh"; .exe stripped on Windows.
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/** The label actually shown on the drawer tab and the in-pane terminal header.
 *  Prefers the runtime title pushed via OSC 0/2 (HS-6473) — for shells like
 *  zsh that update their title with `cwd` or the running command, this is far
 *  more useful than the static configured name. Falls back to the configured
 *  name (or derived basename) when the process hasn't pushed a title. */
function effectiveTabLabel(inst: TerminalInstance): string {
  if (inst.runtimeTitle !== '') return inst.runtimeTitle;
  return tabDisplayName(inst.config);
}

function updateTabLabel(inst: TerminalInstance): void {
  const name = effectiveTabLabel(inst);
  const labelEl = inst.tabBtn.querySelector('.drawer-tab-label');
  if (labelEl) labelEl.textContent = name;
  inst.label.textContent = name;
  inst.tabBtn.classList.toggle('has-bell', inst.hasBell);

  // Insert / remove the bell glyph as a sibling of the label. Built and
  // placed via DOM (not via re-rendering the whole tab) so the close button
  // and event listeners survive (HS-6473).
  let bellEl = inst.tabBtn.querySelector<HTMLElement>('.drawer-tab-bell');
  if (inst.hasBell) {
    if (bellEl === null) {
      bellEl = document.createElement('span');
      bellEl.className = 'drawer-tab-bell';
      bellEl.setAttribute('title', 'Bell');
      bellEl.setAttribute('aria-label', 'Terminal bell');
      bellEl.innerHTML = BELL_ICON;
      // Insert immediately after the label so the order is [label][bell][close?].
      labelEl?.insertAdjacentElement('afterend', bellEl);
    }
  } else if (bellEl !== null) {
    bellEl.remove();
  }
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

  // OSC 0 / OSC 2 title-change escapes (HS-6473). xterm.js parses
  // `\x1b]0;TITLE\x07` and `\x1b]2;TITLE\x07` for us; we just store the
  // value and re-render the tab label. Empty string clears the runtime
  // title and restores the config-derived name.
  term.onTitleChange((newTitle) => {
    inst.runtimeTitle = typeof newTitle === 'string' ? newTitle : '';
    updateTabLabel(inst);
  });

  // Bell character `\x07` (HS-6473). Show a bell indicator on the tab when
  // the bell rings while the terminal is NOT the active drawer tab — the
  // user is looking elsewhere and would otherwise miss it. The bellStyle
  // option defaults to 'none' so xterm itself won't beep.
  term.onBell(() => {
    if (!isTerminalTabActive(inst)) {
      inst.hasBell = true;
      updateTabLabel(inst);
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
    // SIGHUP — what a terminal emulator sends when the user closes the window.
    // Interactive shells (zsh, bash, fish) respect SIGHUP and exit cleanly;
    // they typically ignore SIGTERM, which made the Stop button appear to do
    // nothing for dynamic shell terminals (HS-6471).
    try { await api('/terminal/kill', { method: 'POST', body: { terminalId: inst.id, signal: 'SIGHUP' } }); } catch { /* ignore */ }
    return;
  }

  if (alive && inst.stopRequested) {
    const confirmed = await confirmDialog({
      title: 'Force quit terminal?',
      message: 'The terminal process has not stopped. Force quit (SIGKILL) the process?',
      confirmLabel: 'Force quit',
      danger: true,
    });
    if (!confirmed) return;
    try { await api('/terminal/kill', { method: 'POST', body: { terminalId: inst.id, signal: 'SIGKILL' } }); } catch { /* ignore */ }
    return;
  }

  try {
    await api('/terminal/restart', { method: 'POST', body: { terminalId: inst.id } });
    inst.term?.clear();
    inst.exitCode = null;
    setStatus(inst, 'alive');
    // Restart wipes any title the previous process pushed via OSC; fall back
    // to the configured/derived name until the new process pushes its own.
    inst.runtimeTitle = '';
    updateTabLabel(inst);
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

/** Tear down every client-side terminal instance. The server-side PTYs are untouched. */
function disposeAllInstances(): void {
  for (const id of [...instances.keys()]) removeTerminalInstance(id);
  activeTerminalId = null;
}

/**
 * Called by the app when the active project has changed. Tears down the old
 * project's terminals on the next `loadAndRenderTerminalTabs()` and resets
 * the cached `activeTerminalId` so the new project starts clean (HS-6309).
 */
export function onProjectSwitch(): void {
  disposeAllInstances();
  currentProjectSecret = null;
  lastKnownConfigs = { configured: [], dynamic: [] };
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

// --- Context menu (HS-6470) ---
// Right-clicking a terminal tab opens a lightweight menu with the usual
// "close tab / close others / close to the left / close to the right" entries.
// Configured (default) terminals cannot be closed at all — the menu still
// opens on them, but "Close Tab" is disabled, and the "Close Others/Left/Right"
// actions skip configured tabs so only dynamic ones get torn down.

function dismissTabContextMenu(): void {
  document.querySelector('.terminal-tab-context-menu')?.remove();
}

function isDynamic(id: string): boolean {
  return instances.get(id)?.config.dynamic === true;
}

/** Ordered list of tab ids, matching the visible left-to-right tab strip order. */
function orderedTabIds(): string[] {
  const strip = document.getElementById('drawer-terminal-tabs');
  if (!strip) return [];
  const out: string[] = [];
  for (const el of Array.from(strip.children)) {
    const id = (el as HTMLElement).dataset.terminalId;
    if (typeof id === 'string' && id !== '') out.push(id);
  }
  return out;
}

function showTabContextMenu(e: MouseEvent, clickedId: string): void {
  dismissTabContextMenu();
  const isClickedDynamic = isDynamic(clickedId);

  const menu = toElement(
    <div className="terminal-tab-context-menu command-log-context-menu" style={`left:${e.clientX}px;top:${e.clientY}px`}>
      <div className={`context-menu-item${isClickedDynamic ? '' : ' disabled'}`} data-action="close">Close Tab</div>
      <div className="context-menu-item" data-action="close-others">Close Other Tabs</div>
      <div className="context-menu-item" data-action="close-left">Close Tabs to the Left</div>
      <div className="context-menu-item" data-action="close-right">Close Tabs to the Right</div>
    </div>
  );

  const bind = (action: string, handler: () => void) => {
    const el = menu.querySelector<HTMLElement>(`[data-action="${action}"]`);
    if (!el) return;
    if (el.classList.contains('disabled')) return;
    el.addEventListener('click', () => {
      dismissTabContextMenu();
      handler();
    });
  };

  bind('close', () => { void closeDynamicTerminal(clickedId); });
  bind('close-others', () => { void closeTabs(orderedTabIds().filter(id => id !== clickedId && isDynamic(id))); });
  bind('close-left', () => {
    const ids = orderedTabIds();
    const idx = ids.indexOf(clickedId);
    if (idx < 0) return;
    void closeTabs(ids.slice(0, idx).filter(isDynamic));
  });
  bind('close-right', () => {
    const ids = orderedTabIds();
    const idx = ids.indexOf(clickedId);
    if (idx < 0) return;
    void closeTabs(ids.slice(idx + 1).filter(isDynamic));
  });

  document.body.appendChild(menu);

  // Clamp to viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  setTimeout(() => {
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        dismissTabContextMenu();
        document.removeEventListener('click', close, true);
        document.removeEventListener('contextmenu', close, true);
      }
    };
    document.addEventListener('click', close, true);
    document.addEventListener('contextmenu', close, true);
  }, 0);
}

async function closeTabs(ids: string[]): Promise<void> {
  for (const id of ids) {
    await closeDynamicTerminal(id);
  }
}
