/**
 * Per-drawer-terminal instance lifecycle, extracted out of `terminal.tsx`
 * per HS-8396 (the "instance management functions in their own file"
 * split). The shared types + state slot live in `terminalInstance.ts`;
 * this module imports them directly.
 *
 * Owns:
 * - SVG icon constants used by the per-pane DOM builders.
 * - `buildTabBtnEl` / `bindTabBtnHandlers` / `buildPaneEl` /
 *   `bindAppearanceBtn` / `bindPaneHeaderHandlers` — DOM construction
 *   for one tab strip button + one pane.
 * - `createInstance(config)` — entry point that builds the DOM,
 *   constructs the `TerminalInstance` record, and binds the per-pane
 *   handlers.
 * - `setStatus(inst, status)` / `updatePowerButton(inst)` /
 *   `onPowerClick(inst)` — alive / connecting / exited state machine.
 * - `teardown(inst)` / `removeTerminalInstance(id)` /
 *   `disposeAllInstances()` — clean shutdown of the per-instance xterm +
 *   WebSocket via §54 checkout release.
 * - `closeDynamicTerminal(id, ...)` / `selectFallbackAfterClose(...)` —
 *   close-with-confirm + post-close drawer-tab fallback selection.
 * - `shortCommandName(command)` — pure helper.
 *
 * Init hook: `initInstanceLifecycle({ selectDrawerTab })` — the drawer
 * tab switcher lives in `commandLog.tsx`; passing it in at init time
 * avoids a circular import (`commandLog.tsx` imports lifecycle helpers
 * back through `terminal.tsx`'s re-exports).
 */

import { destroyTerminal, killTerminal, openTerminalCwd, restartTerminal } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';
import { mountAppearancePopover } from './terminalAppearancePopover.js';
import {
  drawerInstancesSignal,
  instances,
  type Status,
  type TerminalInstance,
  terminalState,
  type TerminalTabConfig,
} from './terminalInstance.js';
import { reapplyAppearance } from './terminalInstanceAppearance.js';
import {
  tabDisplayName,
  updateCwdChip,
  updateTabLabel,
} from './terminalInstanceLabel.js';
import {
  copyLastOutput,
  freshShellIntegrationState,
  resetShellIntegration,
} from './terminalShellIntegration.js';
import { orderedTabIds, showTabContextMenu } from './terminalTabContextMenu.js';
import { attachTabDragHandlers } from './terminalTabDragDrop.js';
import { pickNearestTerminalTabId } from './terminalTabSelection.js';

const LUCIDE_14 = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '14',
  height: '14',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;

const POWER_ICON_STOP: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>;
const POWER_ICON_START: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>;
const TRASH_ICON = <svg {...LUCIDE_14}><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>;
const CLOSE_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
const FOLDER_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>;
const CLIPBOARD_ICON = <svg {...LUCIDE_14}><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M16 14h-6"/><path d="M10 18h.01"/></svg>;
const SETTINGS_ICON = <svg {...LUCIDE_14}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;

interface InstanceLifecycleHooks {
  /** Switch the active drawer tab — implemented in `commandLog.tsx`,
   *  passed in here at init time to avoid a circular import. */
  selectDrawerTab: (tabId: string) => Promise<void>;
}

let hooks: InstanceLifecycleHooks | null = null;

export function initInstanceLifecycle(h: InstanceLifecycleHooks): void {
  hooks = h;
}

function requireHooks(): InstanceLifecycleHooks {
  if (hooks === null) throw new Error('initInstanceLifecycle must be called before any instance is created');
  return hooks;
}

export function shortCommandName(command: string): string {
  if (command.startsWith('claude')) return 'claude';
  return command.split(/\s+/)[0] ?? 'terminal';
}

// HS-7271: each terminal tab DOM is built up-front via JSX so we never have to
// reparent or hand-construct elements after the fact. This was the original
// cause of HS-6342 (configured tabs rendered as blank buttons) and HS-6341
// (dynamic tab + xterm pane both rendered with no header / no label).
//
// HS-8562: the close glyph for dynamic tabs is a `<span role="button">`, NOT
// a nested `<button>`. Per the HTML5 spec a `<button>` inside another
// `<button>` is a parse error — real browsers auto-close the outer button
// and reparent the inner one as a sibling. Pre-kerfjs-0.12.0 our local
// `toElement` wrapper silently returned just the first parsed element (the
// outer button without the inner glyph); kerfjs 0.12.0 (HS-8529 bump) now
// returns a `DocumentFragment` for multi-root parses, and `DocumentFragment`
// has no `classList` / `style` / `remove` — so `activateTerminal`'s
// `other.tabBtn.classList.toggle('active', ...)` throws and the new pane
// never mounts. A span avoids the parser-driven split entirely.
function buildTabBtnEl(config: TerminalTabConfig, tabName: string): HTMLElement {
  return toElement(
    <button className="drawer-tab drawer-terminal-tab" data-drawer-tab={`terminal:${config.id}`} data-terminal-id={config.id} draggable="true">
      <span className="drawer-tab-label">{tabName}</span>
      {config.dynamic === true
        ? <span className="drawer-tab-close" role="button" title="Close terminal">{CLOSE_ICON}</span>
        : null}
    </button>
  );
}

function bindTabBtnHandlers(tabBtn: HTMLElement, config: TerminalTabConfig): void {
  // HS-8562 — the close glyph is a `<span role="button">` (not a real
  // `<button>`) so HTML5's no-nested-button parser rule doesn't split the
  // tab into two siblings. See the rationale on `buildTabBtnEl`.
  const closeBtn = tabBtn.querySelector<HTMLSpanElement>('.drawer-tab-close');
  tabBtn.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.drawer-tab-close')) return;
    void requireHooks().selectDrawerTab(`terminal:${config.id}`);
  });
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeDynamicTerminal(config.id);
  });
  // HS-7827 — block dragstart from the close button so the native drag
  // gesture stays bound to the tab body.
  closeBtn?.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  tabBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e, config.id);
  });
  // HS-7827 — drag-to-reorder. Configured-id reorder persists; dynamic-id
  // reorder is in-memory only.
  attachTabDragHandlers(tabBtn, config.id);
}

function buildPaneEl(config: TerminalTabConfig, tabName: string): HTMLElement {
  return toElement(
    <div className="drawer-tab-content drawer-terminal-pane" data-drawer-panel={`terminal:${config.id}`} style="display:none">
      <div className="terminal-header">
        <span className="terminal-status-dot" title="Not connected"></span>
        <span className="terminal-label">{tabName}</span>
        {/* HS-7262 — CWD chip; hidden until OSC 7 push. Click opens the
            folder in the OS file manager via /api/terminal/open-cwd. */}
        <button className="terminal-cwd-chip" title="Open folder" style="display:none">
          {FOLDER_ICON}
          <span className="terminal-cwd-label"></span>
        </button>
        <span className="terminal-header-spacer"></span>
        {/* HS-7331 — terminal search slot. Mounted from terminalSearch.tsx on
            xterm attach. */}
        <span className="terminal-search-slot"></span>
        {/* HS-8286 — per-pane "Server slow" chip removed. Stall detection
            now feeds the global server-slow banner via the per-entry
            watcher in `terminalCheckout.tsx::createEntry`. */}
        {/* HS-7268 — copy-last-output, hidden until first OSC 133 escape. */}
        <button className="terminal-header-btn terminal-copy-output-btn" title="Copy last command output" style="display:none">
          {CLIPBOARD_ICON}
        </button>
        <button className="terminal-header-btn terminal-power-btn" title="Stop terminal">
          <span className="terminal-power-icon">{POWER_ICON_STOP}</span>
        </button>
        <button className="terminal-header-btn terminal-clear-btn" title="Clear screen (keeps process running)">
          {TRASH_ICON}
        </button>
        {/* HS-6307 — per-terminal appearance (theme / font / size). */}
        <button className="terminal-header-btn terminal-appearance-btn" title="Appearance (theme, font)">
          {SETTINGS_ICON}
        </button>
      </div>
      {/* HS-7959 — `.terminal-body` keeps padding/focus-ring; xterm mounts
          inside an inner `.terminal-canvas-host` with NO padding so FitAddon
          reads the parent's true content height. */}
      <div className="terminal-body">
        <div className="terminal-canvas-host"></div>
      </div>
    </div>
  );
}

function bindAppearanceBtn(inst: TerminalInstance, pane: HTMLElement): void {
  // HS-6307 + HS-7896 — opens the popover anchored below the button; live
  // hooks read/write `inst.config` synchronously so the user's pick lands on
  // the live xterm without a settings round-trip.
  const appearanceBtn = pane.querySelector<HTMLButtonElement>('.terminal-appearance-btn');
  appearanceBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    mountAppearancePopover({
      anchor: appearanceBtn,
      terminalId: inst.id,
      // HS-8283 — drawer terminals belong to the active project; pass that
      // secret so the popover resolves the default against the right cache.
      projectSecret: getActiveProject()?.secret ?? '',
      isDynamic: inst.config.dynamic === true,
      onApply: () => { void reapplyAppearance(inst); },
      getCurrentConfigOverride: () => {
        const out: { theme?: string; fontFamily?: string; fontSize?: number } = {};
        if (inst.config.theme !== undefined) out.theme = inst.config.theme;
        if (inst.config.fontFamily !== undefined) out.fontFamily = inst.config.fontFamily;
        if (inst.config.fontSize !== undefined) out.fontSize = inst.config.fontSize;
        return out;
      },
      onConfigOverrideChange: (partial) => {
        if ('theme' in partial) {
          if (partial.theme === undefined) delete inst.config.theme;
          else inst.config.theme = partial.theme;
        }
        if ('fontFamily' in partial) {
          if (partial.fontFamily === undefined) delete inst.config.fontFamily;
          else inst.config.fontFamily = partial.fontFamily;
        }
        if ('fontSize' in partial) {
          if (partial.fontSize === undefined) delete inst.config.fontSize;
          else inst.config.fontSize = partial.fontSize;
        }
      },
    });
  });
}

function bindPaneHeaderHandlers(inst: TerminalInstance, pane: HTMLElement): void {
  pane.querySelector<HTMLButtonElement>('.terminal-power-btn')!.addEventListener('click', () => { void onPowerClick(inst); });
  pane.querySelector<HTMLButtonElement>('.terminal-clear-btn')!.addEventListener('click', () => { inst.term?.clear(); });
  bindAppearanceBtn(inst, pane);

  // HS-7268 — copy-last-output click. Button hidden until shell-integration
  // flips, so by click time we have at least one record.
  pane.querySelector<HTMLButtonElement>('.terminal-copy-output-btn')
    ?.addEventListener('click', () => { void copyLastOutput(inst); });

  // HS-7262 — CWD chip click reveals the folder via /api/terminal/open-cwd.
  pane.querySelector<HTMLButtonElement>('.terminal-cwd-chip')?.addEventListener('click', () => {
    if (inst.runtimeCwd === null || inst.runtimeCwd === '') return;
    void openTerminalCwd(inst.runtimeCwd).catch(() => { /* ignore */ });
  });
}

export function createInstance(config: TerminalTabConfig): TerminalInstance {
  const tabName = tabDisplayName(config);
  const tabBtn = buildTabBtnEl(config, tabName);
  bindTabBtnHandlers(tabBtn, config);

  const pane = buildPaneEl(config, tabName);
  const inst: TerminalInstance = {
    id: config.id,
    config,
    checkout: null,
    termHandlerDisposers: [],
    term: null,
    fit: null,
    search: null,
    searchHandle: null,
    body: pane.querySelector<HTMLElement>('.terminal-body')!,
    canvasHost: pane.querySelector<HTMLElement>('.terminal-canvas-host')!,
    header: pane.querySelector<HTMLElement>('.terminal-header')!,
    label: pane.querySelector<HTMLElement>('.terminal-label')!,
    statusDot: pane.querySelector<HTMLElement>('.terminal-status-dot')!,
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
    shellIntegration: freshShellIntegrationState(),
  };

  bindPaneHeaderHandlers(inst, pane);
  return inst;
}

export function setStatus(inst: TerminalInstance, status: Status): void {
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

export function updatePowerButton(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-power-btn');
  const icon = btn?.querySelector<HTMLElement>('.terminal-power-icon');
  if (!btn || !icon) return;
  const showStop = inst.status === 'alive' || inst.status === 'connecting';
  icon.replaceChildren(toElement(<span>{showStop ? POWER_ICON_STOP : POWER_ICON_START}</span>));
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
    try { await killTerminal(inst.id, 'SIGHUP'); } catch { /* ignore */ }
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
    try { await killTerminal(inst.id, 'SIGKILL'); } catch { /* ignore */ }
    return;
  }

  try {
    await restartTerminal(inst.id);
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
    // HS-7267 — drop all prior shell-integration records + decorations; the
    // new shell rebuilds its own A/B/C/D cycle.
    resetShellIntegration(inst);
  } catch { /* ignore */ }
}

export function teardown(inst: TerminalInstance): void {
  if (inst.reconnectTimer !== null) clearTimeout(inst.reconnectTimer);
  inst.reconnectTimer = null;
  // HS-8044 — drop term-level handlers (OSC 7 / OSC 133 parser hooks,
  // onResize / onTitleChange / onBell, the prompt-resume keystroke
  // hider) BEFORE releasing the checkout. These were registered on the
  // shared term — leaving them attached after release would leak state
  // into a future re-checkout.
  for (const d of inst.termHandlerDisposers) {
    try { d.dispose(); } catch { /* already disposed */ }
  }
  inst.termHandlerDisposers = [];
  inst.searchHandle?.dispose();
  inst.searchHandle = null;
  inst.search = null;
  // HS-8044 — release the checkout instead of disposing the term + ws
  // directly. The empty-stack dispose path inside the checkout module
  // closes the WS + disposes the xterm; if a sibling consumer (e.g. a
  // dashboard tile or quit-confirm preview for the same terminal) is
  // still on the stack, the live xterm reparents to that consumer's
  // mount and the dispose is skipped.
  if (inst.checkout !== null) {
    try { inst.checkout.release(); } catch { /* already released */ }
    inst.checkout = null;
  }
  inst.term = null;
  inst.fit = null;
  inst.ws = null;
  inst.mounted = false;
  inst.status = 'not-connected';
}

export function removeTerminalInstance(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  teardown(inst);
  inst.tabBtn.remove();
  inst.pane.remove();
  instances.delete(id);
  if (terminalState.activeTerminalId === id) terminalState.activeTerminalId = null;
  // HS-8312 — keep the drawer bindLists' `live` Map in sync. Without
  // this drop, a future signal write that does NOT include this id
  // would still see the cached entry on the live Map; the removed
  // tabBtn / pane (`parentNode === null` after `inst.tabBtn.remove()`
  // above) would survive in the cache and a hypothetical re-creation
  // of the same id with a fresh tabBtn would still resolve to the
  // stale cached element. Filter conditionally so callers that
  // remove-en-masse via disposeAllInstances (which sets the signal to
  // [] up-front) don't fire N redundant signal writes.
  const current = drawerInstancesSignal.value;
  const filtered = current.filter(i => i.id !== id);
  if (filtered.length !== current.length) {
    drawerInstancesSignal.value = filtered;
  }
}

/** Tear down every client-side terminal instance. The server-side PTYs are untouched. */
export function disposeAllInstances(): void {
  // HS-8312 — flush the drawer bindLists' live Map up-front so the
  // per-id removeTerminalInstance calls below don't cascade N signal
  // writes (each would trigger a bindList effect run + DOM reconcile).
  // After this assignment removeTerminalInstance's filter sees an
  // already-empty signal and short-circuits the subsequent writes.
  drawerInstancesSignal.value = [];
  for (const id of [...instances.keys()]) removeTerminalInstance(id);
  terminalState.activeTerminalId = null;
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
export async function closeDynamicTerminal(
  id: string,
  skipConfirm = false,
  skipActiveFallback = false,
): Promise<void> {
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

  // Snapshot the tab-strip order BEFORE removal so the fallback can walk the
  // original positions and pick the nearest surviving tab (HS-7275).
  const orderBeforeClose = orderedTabIds();

  try {
    await destroyTerminal(id);
  } catch { /* ignore */ }
  removeTerminalInstance(id);
  if (skipActiveFallback) return;
  await selectFallbackAfterClose(orderBeforeClose, [id]);
}

/**
 * Select the next drawer tab after one or more terminals have been closed.
 *
 * Only fires when the drawer was actually showing a closed tab — otherwise the
 * user stays on whatever they were viewing (e.g., commands-log). When the drawer
 * WAS showing a closed tab, prefer the nearest surviving terminal to the right
 * of the first closed position, then to the left, and fall back to commands-log
 * when no terminal tab survives. HS-7275.
 */
export async function selectFallbackAfterClose(
  orderBeforeClose: readonly string[],
  closedIds: readonly string[],
): Promise<void> {
  if (closedIds.length === 0) return;
  const mod = await import('./commandLog.js');
  const activeDrawerTab = mod.getActiveDrawerTab();
  const closedDrawerTabs = new Set(closedIds.map(id => `terminal:${id}`));
  if (!closedDrawerTabs.has(activeDrawerTab)) return;

  const nextTabId = pickNearestTerminalTabId(orderBeforeClose, closedIds);
  const select = requireHooks().selectDrawerTab;
  if (nextTabId !== null) {
    await select(`terminal:${nextTabId}`);
  } else {
    await select('commands-log');
  }
}
