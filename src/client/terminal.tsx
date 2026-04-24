import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { fireToastsForActiveProject, subscribeToBellState } from './bellPoll.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';
import { openExternalUrl } from './tauriIntegration.js';
import { formatCwdLabel, parseOsc7Payload } from './terminalOsc7.js';
import { replayHistoryToTerm } from './terminalReplay.js';
import { readXtermTheme } from './xtermTheme.js';

type Status = 'not-connected' | 'connecting' | 'alive' | 'exited';

// Lucide "square" (stop) and "play" (start) glyphs — used for the power toggle button.
const POWER_ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
const POWER_ICON_START = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
// Lucide `bell` glyph. Shown on drawer tabs when the process rings the bell
// (\x07) while the tab isn't active (HS-6473).
const BELL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
// Lucide `folder` glyph. Shown on the terminal toolbar CWD chip (HS-7262);
// clicking opens the folder in the OS file manager.
const FOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

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
  /** CWD pushed by the running shell via OSC 7 (`\x1b]7;file://host/path\x07`).
   *  Null until the shell pushes its first OSC 7 (typical zsh/fish/starship
   *  prompts emit this on every command). Shown as a clickable chip in the
   *  terminal toolbar that opens the folder in the OS file manager. Reset on
   *  PTY restart. HS-7262, see docs/29-osc7-cwd-tracking.md. */
  runtimeCwd: string | null;
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
  // Keep in-drawer bell indicators in sync with bellPoll (HS-6603 §24.4.3).
  ensureBellSubscription();
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

  // HS-6603 §24.3.1: the list response carries a server-side `bellPending`
  // flag per terminal. Phase 1's local onBell path only catches bells on a
  // mounted xterm — the server-authoritative field is what lets us surface
  // bells that fired before the xterm was mounted or while the project was
  // inactive.
  type ListEntry = TerminalTabConfig & { bellPending?: boolean; notificationMessage?: string | null };
  type ListResponse = { configured: ListEntry[]; dynamic: ListEntry[] };
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

  const wanted = new Map<string, ListEntry>();
  for (const c of data.configured) wanted.set(c.id, { ...c, dynamic: false });
  for (const c of data.dynamic) wanted.set(c.id, { ...c, dynamic: true });

  // Remove instances for terminals that no longer exist server-side.
  for (const id of [...instances.keys()]) {
    if (!wanted.has(id)) removeTerminalInstance(id);
  }

  // Ensure an instance + DOM exists for every wanted terminal, in order.
  tabStrip.innerHTML = '';
  paneContainer.querySelectorAll('.drawer-terminal-pane').forEach(el => el.remove());

  // HS-7264 — fire OSC 9 toasts for any pending desktop notifications the
  // server tracked while we were disconnected / on another project. Dedupes
  // against the bellPoll recentlyToasted map so a subsequent long-poll tick
  // doesn't re-fire the same message.
  fireToastsForActiveProject([...wanted.values()]);

  for (const entry of wanted.values()) {
    // `notificationMessage` is already surfaced as a toast via
    // fireToastsForActiveProject above — drop it here along with `bellPending`
    // so only the TerminalTabConfig shape flows into `inst.config`.
    const bellPending = entry.bellPending;
    const config: TerminalTabConfig = {
      id: entry.id, command: entry.command, name: entry.name,
      cwd: entry.cwd, lazy: entry.lazy, dynamic: entry.dynamic,
    };
    let inst = instances.get(config.id);
    if (!inst) {
      inst = createInstance(config);
      instances.set(config.id, inst);
    } else {
      // Config may have changed; update label text if the user renamed.
      inst.config = { ...inst.config, ...config };
      updateTabLabel(inst);
    }
    // Seed the bell indicator from the server so a tab that was hidden /
    // unmounted while the bell fired still shows the glyph the first time
    // the user sees it (HS-6603 §24.4.3).
    if (bellPending === true && !inst.hasBell) {
      inst.hasBell = true;
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

/** HS-6603 §24.4.3: re-sync each active-project terminal's bell indicator
 *  against the bellPoll snapshot. Driven by `subscribeToBellState` on every
 *  long-poll tick. We only touch terminals for the *active* project — other
 *  projects' bells surface via the project-tab indicator in projectTabs. */
function syncInstancesWithBellState(bellStates: Map<string, { terminalIds: string[] }>): void {
  const active = getActiveProject();
  if (!active) return;
  const entry = bellStates.get(active.secret);
  const pendingIds = new Set(entry?.terminalIds ?? []);
  for (const inst of instances.values()) {
    const wantsBell = pendingIds.has(inst.id);
    if (wantsBell && !inst.hasBell) {
      inst.hasBell = true;
      updateTabLabel(inst);
    } else if (!wantsBell && inst.hasBell) {
      // Poll cleared the flag (e.g., another tab acknowledged it) — drop the
      // local indicator too so the two views stay in sync.
      inst.hasBell = false;
      updateTabLabel(inst);
    }
  }
}

let bellSubscribed = false;
function ensureBellSubscription(): void {
  if (bellSubscribed) return;
  bellSubscribed = true;
  subscribeToBellState(syncInstancesWithBellState);
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
    // HS-6603 §24.4.3: also drop the server-side `bellPending` flag so the
    // cross-project poll stops reporting this terminal as pending. The local
    // indicator already cleared above; this call is fire-and-forget.
    void api('/terminal/clear-bell', { method: 'POST', body: { terminalId: id } }).catch(() => {});
  }

  const active = getActiveProject();
  if (!active) return;

  if (!inst.mounted) {
    mountXterm(inst, active.secret);
    // HS-6799: fit the xterm to its pane BEFORE opening the WebSocket so the
    // `?cols=&rows=` query reflects the real pane geometry. The server uses
    // those dims to spawn (or resize) the PTY so its startup output is
    // generated at the right width — avoiding the stray-glyph artifacts that
    // appeared when history was replayed from a DEFAULT 80×24 buffer.
    doFit(inst);
    connect(inst);
    inst.mounted = true;
  } else if (inst.wsSecret !== active.secret) {
    // Project switched — rebuild from scratch.
    teardown(inst);
    mountXterm(inst, active.secret);
    doFit(inst);
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
        {/* HS-7262 — CWD chip populated by OSC 7 handler; hidden by default,
            shown once the shell pushes its first file://host/path. Click opens
            the folder in the OS file manager via /api/terminal/open-cwd. */}
        <button className="terminal-cwd-chip" title="Open folder" style="display:none">
          {raw(FOLDER_ICON)}
          <span className="terminal-cwd-label"></span>
        </button>
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
    runtimeCwd: null,
    hasBell: false,
  };

  powerBtn.addEventListener('click', () => { void onPowerClick(inst); });
  clearBtn.addEventListener('click', () => { inst.term?.clear(); });

  // HS-7262 — CWD chip click reveals the folder in the OS file manager. Uses
  // the terminal's own record of the most recent OSC 7 push; the server
  // endpoint validates the path exists before spawning the file manager.
  const cwdChip = pane.querySelector<HTMLButtonElement>('.terminal-cwd-chip');
  cwdChip?.addEventListener('click', () => {
    if (inst.runtimeCwd === null || inst.runtimeCwd === '') return;
    void api('/terminal/open-cwd', { method: 'POST', body: { path: inst.runtimeCwd } }).catch(() => { /* ignore */ });
  });

  return inst;
}

/** Re-render the CWD chip on the terminal toolbar. HS-7262.
 *  `$HOME` is unknown to the client for v1, so tildification is disabled — a
 *  follow-up ticket can extend `/api/terminal/list` to include the resolved
 *  home directory (see §29.7). */
function updateCwdChip(inst: TerminalInstance): void {
  const chip = inst.header.querySelector<HTMLButtonElement>('.terminal-cwd-chip');
  const label = chip?.querySelector<HTMLElement>('.terminal-cwd-label');
  if (chip === null || label === null || label === undefined) return;
  const cwd = inst.runtimeCwd;
  if (cwd === null || cwd === '') {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  label.textContent = formatCwdLabel(cwd, null);
  chip.setAttribute('title', `Open folder: ${cwd}`);
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

/** The label for the in-pane terminal toolbar. Prefers the runtime title
 *  pushed via OSC 0/2 (HS-6473) — for shells like zsh that update their title
 *  with `cwd` or the running command, this is far more useful than the static
 *  configured name. Falls back to the static drawer-tab name when no process
 *  has pushed a title. */
function effectiveHeaderLabel(inst: TerminalInstance): string {
  if (inst.runtimeTitle !== '') return inst.runtimeTitle;
  return tabDisplayName(inst.config);
}

function updateTabLabel(inst: TerminalInstance): void {
  // HS-6473 follow-up: the drawer tab keeps the static configured/derived
  // name — only the in-pane toolbar follows the runtime title. Shells push
  // noisy per-cwd titles that make the narrow drawer-tab label unreadable.
  const tabName = tabDisplayName(inst.config);
  const headerName = effectiveHeaderLabel(inst);
  const labelEl = inst.tabBtn.querySelector('.drawer-tab-label');
  if (labelEl) labelEl.textContent = tabName;
  inst.label.textContent = headerName;
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
    theme: readXtermTheme(),
    // HS-7263 — OSC 8 hyperlink activation. Modern CLI tools (`gh`, `delta`,
    // `eza`, `rg --hyperlink-format`, `ls --hyperlink=auto`, git log piped
    // through delta) emit `\x1b]8;;URL\x07TEXT\x1b]8;;\x07` so the visible
    // text differs from the underlying URL — the plain-regex WebLinksAddon
    // misses these entirely since it scans rendered glyphs. xterm.js v5+
    // parses OSC 8 natively and calls our `linkHandler.activate` on click;
    // we route through the Tauri-safe openExternalUrl helper so the click
    // actually opens something (window.open is a silent no-op in WKWebView).
    linkHandler: {
      activate: (_event, text) => { openExternalUrl(text); },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // HS-7263 — pass an explicit click handler so plain-URL activation also
  // routes through Tauri's `open_url` instead of WebLinksAddon's default
  // `window.open`, which silently no-ops in WKWebView.
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
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

  // OSC 7 — shell-pushed CWD (HS-7262). Payload is `file://host/path` with
  // URL-encoded path bytes. xterm.js does NOT handle OSC 7 natively — we
  // register a parser hook on the number directly and return `true` to mark
  // the sequence consumed. Starship / zsh chpwd / fish-shell / bash with
  // Apple's or VS Code's integration all emit this on every prompt.
  term.parser.registerOscHandler(7, (payload) => {
    const parsed = parseOsc7Payload(payload);
    if (parsed !== null) {
      inst.runtimeCwd = parsed;
      updateCwdChip(inst);
    }
    return true;
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
  // HS-6799: include post-fit xterm dims so the server can spawn / resize the
  // PTY to match BEFORE sending the history frame. Without this the PTY ran
  // at DEFAULT 80×24 and its startup output leaked through as stray chars at
  // the top of the pane. Omits dims only if xterm hasn't been created yet
  // (shouldn't happen — `connect()` is always called after `mountXterm`).
  const dims = inst.term !== null && Number.isFinite(inst.term.cols) && Number.isFinite(inst.term.rows)
    ? `&cols=${inst.term.cols}&rows=${inst.term.rows}`
    : '';
  const url = `${protocol}//${window.location.host}/api/terminal/ws?project=${encodeURIComponent(inst.wsSecret)}&terminal=${encodeURIComponent(inst.id)}${dims}`;
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
    if (inst.term !== null) replayHistoryToTerm(inst.term, h);
    inst.exitCode = h.exitCode;
    setStatus(inst, h.alive ? 'alive' : 'exited');
    if (typeof h.command === 'string' && h.command !== '') {
      // Prefer the user-supplied name; fall back to resolved command for unnamed terminals.
      if ((inst.config.name ?? '') === '') inst.label.textContent = shortCommandName(h.command);
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
    // HS-7262 — same for the CWD; the new shell will push its own OSC 7 on
    // the first prompt.
    inst.runtimeTitle = '';
    inst.runtimeCwd = null;
    updateTabLabel(inst);
    updateCwdChip(inst);
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

// --- Dynamic terminal lifecycle (HS-6306) ---

async function createDynamicTerminal(): Promise<void> {
  try {
    const { config } = await api<{ config: TerminalTabConfig }>('/terminal/create', { method: 'POST' });
    await loadAndRenderTerminalTabs();
    await selectDrawerTab(`terminal:${config.id}`);
  } catch { /* ignore */ }
}

/**
 * Close a dynamic terminal, confirming first if its PTY is still alive.
 *
 * HS-6701: closing a tab with a running process used to silently kill the PTY.
 * Now matches the Settings → Embedded Terminal delete flow: reveal the tab in
 * the drawer, show an in-app confirmDialog naming the tab, and only destroy on
 * confirm. Tabs whose status is exited / not-connected close silently — there
 * is no running process to interrupt. Pass `skipConfirm: true` to bypass the
 * dialog (used by bulk flows that have already confirmed at a higher level).
 */
async function closeDynamicTerminal(id: string, skipConfirm = false): Promise<void> {
  const inst = instances.get(id);

  if (inst !== undefined && inst.status === 'alive' && !skipConfirm) {
    const name = tabDisplayName(inst.config);
    const mod = await import('./commandLog.js');
    const restoreDrawer = mod.previewDrawerTab(`terminal:${id}`);
    const confirmed = await confirmDialog({
      title: 'Close terminal?',
      message: `Close terminal "${name}"? Its running process will be stopped.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!confirmed) {
      restoreDrawer();
      return;
    }
    // If the user confirmed, keep the revealed tab active — it's about to
    // disappear anyway and the next selectDrawerTab() below handles fallback.
  }

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
      <div className="context-menu-separator"></div>
      <div className="context-menu-item" data-action="rename">Rename...</div>
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
  bind('rename', () => {
    const inst = instances.get(clickedId);
    if (inst) promptRenameTerminal(inst);
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

/**
 * Bulk-close a set of dynamic tabs (Close Others / Close Tabs to the Left /
 * Close Tabs to the Right). HS-6701: when any of the target PTYs are alive,
 * surface a confirm dialog before stopping their processes.
 *
 *   0 alive  → destroy all silently (nothing to interrupt).
 *   1 alive  → reuse the single-tab confirm flow for that one; on confirm, also
 *              destroy the inert tabs. On cancel, abort the whole bulk op.
 *   2+ alive → single "Stop All" dialog listing the running tab names;
 *              confirm destroys all, cancel aborts the whole bulk op.
 */
async function closeTabs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const aliveIds = ids.filter(id => instances.get(id)?.status === 'alive');
  const deadIds = ids.filter(id => !aliveIds.includes(id));

  if (aliveIds.length === 0) {
    for (const id of ids) await closeDynamicTerminal(id, true);
    return;
  }

  if (aliveIds.length === 1) {
    // Fall through to the single-tab confirm UX — if the user cancels there,
    // the whole bulk op aborts (no dead-tab destroys either). If they confirm,
    // the alive tab is destroyed by closeDynamicTerminal; we then clean up the
    // inert tabs.
    const aliveId = aliveIds[0];
    const before = instances.has(aliveId);
    await closeDynamicTerminal(aliveId);
    const confirmed = before && !instances.has(aliveId);
    if (!confirmed) return;
    for (const id of deadIds) await closeDynamicTerminal(id, true);
    return;
  }

  const names = aliveIds
    .map(id => {
      const inst = instances.get(id);
      return inst !== undefined ? tabDisplayName(inst.config) : id;
    })
    .map(n => `  • ${n}`)
    .join('\n');
  const confirmed = await confirmDialog({
    title: 'Stop all running terminals?',
    message: `The following terminals have running processes that will be stopped:\n\n${names}`,
    confirmLabel: 'Stop All',
    danger: true,
  });
  if (!confirmed) return;
  for (const id of ids) await closeDynamicTerminal(id, true);
}

/**
 * In-app rename dialog for a terminal tab (HS-6668). The rename is transient —
 * it updates the in-memory `config.name` on the instance and re-renders the tab
 * label, but does NOT persist to settings.json. A page reload or project-tab
 * switch restores the original configured / server-derived name. This matches
 * the "temporary for default terminals" requirement and keeps dynamic terminals
 * consistent (the dynamic config is also in-memory-only on the server).
 */
function promptRenameTerminal(inst: TerminalInstance): void {
  document.querySelectorAll('.terminal-rename-overlay').forEach(el => el.remove());
  const current = tabDisplayName(inst.config);

  const overlay = toElement(
    <div className="cmd-editor-overlay terminal-rename-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>Rename Terminal</span>
          <button className="cmd-editor-close-btn" title="Close">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Tab name</label>
            <input type="text" className="term-rename-input" value={current} />
            <span className="settings-hint">This rename is temporary — it doesn't change saved settings and resets on reload or project switch.</span>
          </div>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-cancel-btn">Cancel</button>
          <button className="btn btn-sm btn-primary cmd-editor-done-btn">Rename</button>
        </div>
      </div>
    </div>
  );

  const input = overlay.querySelector<HTMLInputElement>('.term-rename-input')!;

  const apply = () => {
    const next = input.value.trim();
    // Update the in-memory config so tabDisplayName() picks up the new name on
    // every subsequent updateTabLabel() call. Empty input falls back to the
    // default derivation (effectively restoring the original).
    if (next === '') {
      const rest = { ...inst.config };
      delete rest.name;
      inst.config = rest;
    } else {
      inst.config = { ...inst.config, name: next };
    }
    updateTabLabel(inst);
    overlay.remove();
  };

  const cancel = () => { overlay.remove(); };

  overlay.querySelector('.cmd-editor-close-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-cancel-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-done-btn')?.addEventListener('click', apply);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
