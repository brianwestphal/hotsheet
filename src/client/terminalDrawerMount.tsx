/**
 * Drawer xterm mount path (HS-8044 §54 checkout integration) +
 * WebSocket control-message dispatch, extracted out of `terminal.tsx`
 * per HS-8396 Phases 5+6 (paired because Phase 5's
 * `attachDrawerTermHandlers` is where the Phase 6 `handleControlMessage`
 * callback gets registered via `checkout({...onControlMessage})`).
 *
 * Owns:
 * - `mountInstanceViaCheckout(inst, secret)` — top-level entry that
 *   acquires a §54 checkout handle for the `(secret, terminalId)` xterm,
 *   wires the drawer's per-instance chrome (addons, key handler, OSC
 *   parser hooks, bell + title + cwd updaters), and stamps the resulting
 *   handles onto `inst.checkout` / `inst.term` / `inst.fit` /
 *   `inst.search` / `inst.searchHandle` / `inst.wsSecret`.
 * - `applyDrawerXtermOptions`, `mountDrawerSearchAddon`,
 *   `attachDrawerKeyHandler`, `attachDrawerTermHandlers` — internal
 *   helpers `mountInstanceViaCheckout` chains together.
 * - `HistoryMessage` / `ExitMessage` / `ControlMessage` types + their
 *   type-guard predicates (`isHistoryMessage`, `isExitMessage`).
 * - `handleControlMessage(inst, msg)` — the checkout's
 *   `onControlMessage` callback target; dispatches by message type.
 *
 * Cross-module hooks: the mount path and message dispatch reach into
 * five lifecycle helpers that stay in `terminal.tsx` because they
 * touch the broader instance lifecycle that hasn't been phase-extracted
 * yet — `setStatus`, `shortCommandName`, `doFit`, `isTerminalTabActive`,
 * `resolveInstanceAppearance`, `resolveAppearanceThemeForInit`,
 * `reapplyAppearance`. Wired once at `initTerminal` time via
 * `initDrawerMount(hooks)`.
 */

import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal as XTerm } from '@xterm/xterm';

import { openExternalUrl } from './tauriIntegration.js';
import type { TerminalInstance } from './terminal.js';
import { resolveAppearanceBackground } from './terminalAppearance.js';
import { checkout } from './terminalCheckout.js';
import {
  doFit,
  reapplyAppearance,
  resolveAppearanceThemeForInit,
  resolveInstanceAppearance,
} from './terminalInstanceAppearance.js';
import { updateCwdChip, updateTabLabel } from './terminalInstanceLabel.js';
import { isClearTerminalShortcut, isFindShortcut, isJumpShortcut, isTerminalViewToggleShortcut } from './terminalKeybindings.js';
import { parseOsc7Payload } from './terminalOsc7.js';
import { mountTerminalSearch, type TerminalSearchHandle } from './terminalSearch.js';
import {
  closeDanglingCommand,
  handleOsc133,
  jumpToPromptMarker,
  shellIntegrationUiEnabled,
} from './terminalShellIntegration.js';

interface DrawerMountHooks {
  setStatus: (inst: TerminalInstance, status: 'not-connected' | 'connecting' | 'alive' | 'exited') => void;
  shortCommandName: (command: string) => string;
  isTerminalTabActive: (inst: TerminalInstance) => boolean;
}

let hooks: DrawerMountHooks | null = null;

/** Initialize the drawer-mount module's lifecycle hooks. Called once at
 *  the top of `initTerminal`. */
export function initDrawerMount(h: DrawerMountHooks): void {
  hooks = h;
}

function requireHooks(): DrawerMountHooks {
  if (hooks === null) throw new Error('initDrawerMount must be called before any drawer mounts fire');
  return hooks;
}

// -----------------------------------------------------------------------------
// xterm option / addon / handler wiring (HS-8044 §54 consumer)
// -----------------------------------------------------------------------------

function applyDrawerXtermOptions(inst: TerminalInstance, term: XTerm): void {
  // HS-8044 — option overrides applied here win for the drawer's lifetime as
  // long as it stays at top-of-stack of the shared (secret, terminalId) xterm.
  term.options.theme = resolveAppearanceThemeForInit(inst);
  term.options.linkHandler = {
    activate: (_event, text) => { openExternalUrl(text); },
  };
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
  term.loadAddon(new SerializeAddon());
}

function mountDrawerSearchAddon(inst: TerminalInstance, term: XTerm): { search: SearchAddon; searchHandle: TerminalSearchHandle | null } {
  // HS-7331 — xterm's SearchAddon powers the toolbar Find widget. Disposed on
  // PTY restart + re-created on the next mount so search state doesn't leak.
  const search = new SearchAddon();
  term.loadAddon(search);
  const searchSlot = inst.header.querySelector<HTMLElement>('.terminal-search-slot');
  let searchHandle: TerminalSearchHandle | null = null;
  if (searchSlot !== null) {
    searchHandle = mountTerminalSearch(term, search);
    searchSlot.replaceChildren(searchHandle.root);
  }
  return { search, searchHandle };
}

function attachDrawerKeyHandler(inst: TerminalInstance, term: XTerm): void {
  // Per-shortcut rationale lives on the original mountXterm comments
  // (HS-7329 / HS-7269 / HS-7331 / HS-7594).
  term.attachCustomKeyEventHandler((e) => {
    if (isClearTerminalShortcut(e)) {
      inst.checkout?.term.clear();
      return false;
    }
    if (isFindShortcut(e)) return false;
    if (isTerminalViewToggleShortcut(e) !== null) return false;
    if (!shellIntegrationUiEnabled()) return true;
    if (!inst.shellIntegration.enabled) return true;
    const direction = isJumpShortcut(e);
    if (direction !== null) {
      jumpToPromptMarker(inst, direction);
      return false;
    }
    return true;
  });
}

/**
 * HS-8590 — true when xterm's freshly-painted pane geometry implies different
 * cols/rows than the term currently has, so a re-fit is worth running. The
 * exact-match guard (matching the §37 quit-confirm + §25 tile precedent)
 * breaks the `onRender → fit → resize → render` feedback loop once the pane
 * geometry has converged. Pure — exported for unit testing.
 */
export function shouldRefitOnRender(
  proposed: { cols: number; rows: number } | undefined,
  cols: number,
  rows: number,
): boolean {
  if (proposed === undefined) return false;
  return proposed.cols !== cols || proposed.rows !== rows;
}

function attachDrawerTermHandlers(inst: TerminalInstance, term: XTerm, handle: ReturnType<typeof checkout>): void {
  // HS-8044 — echo fit-driven dim changes through `handle.resize` so the WS
  // resize frame is sent and `lastApplied` bookkeeping stays current.
  inst.termHandlerDisposers.push(term.onResize(({ cols, rows }) => {
    handle.resize(cols, rows);
  }));

  // HS-8590 — converge the fit once xterm actually paints into the laid-out
  // pane. The mount-time + double-rAF `doFit` calls in `activateTerminal` can
  // all run before the pane reaches its final geometry on a project switch:
  // the fresh checkout starts at 80×24, and because the drawer PANEL's box is
  // unchanged across the switch, the panel-level ResizeObserver never fires to
  // correct it — so the terminal renders cramped at 80×24 until the user
  // manually resizes ("not getting the resize signal"). `onRender` fires AFTER
  // the element is in the DOM + laid out, so `proposeDimensions()` is reliable
  // here. The `shouldRefitOnRender` exact-match guard makes this a no-op once
  // converged (so it doesn't feed the HS-8055 fit→resize→render loop). This is
  // the same convergence the §25 dashboard tiles got in HS-8051.
  inst.termHandlerDisposers.push(term.onRender(() => {
    if (!requireHooks().isTerminalTabActive(inst)) return;
    try {
      if (shouldRefitOnRender(handle.fit.proposeDimensions(), term.cols, term.rows)) {
        doFit(inst);
      }
    } catch { /* fit/proposeDimensions can throw if the pane detached mid-frame */ }
  }));

  // OSC 0 / OSC 2 title-change escapes (HS-6473).
  inst.termHandlerDisposers.push(term.onTitleChange((newTitle) => {
    inst.runtimeTitle = typeof newTitle === 'string' ? newTitle : '';
    updateTabLabel(inst);
  }));

  // OSC 7 — shell-pushed CWD (HS-7262). xterm.js doesn't handle OSC 7
  // natively — register a parser hook on the number directly.
  inst.termHandlerDisposers.push(term.parser.registerOscHandler(7, (payload) => {
    const parsed = parseOsc7Payload(payload);
    if (parsed !== null) {
      inst.runtimeCwd = parsed;
      updateCwdChip(inst);
    }
    return true;
  }));

  // OSC 133 — FinalTerm / iTerm2 / VS Code shell integration (HS-7267).
  inst.termHandlerDisposers.push(term.parser.registerOscHandler(133, (payload) => {
    handleOsc133(inst, term, payload);
    return true;
  }));

  // Bell character `\x07` (HS-6473).
  inst.termHandlerDisposers.push(term.onBell(() => {
    if (!requireHooks().isTerminalTabActive(inst)) {
      inst.hasBell = true;
      updateTabLabel(inst);
    }
  }));
}

export function mountInstanceViaCheckout(inst: TerminalInstance, secret: string): void {
  const handle = checkout({
    projectSecret: secret,
    terminalId: inst.id,
    cols: 80,
    rows: 24,
    mountInto: inst.canvasHost,
    // HS-8295 — paint the §54 "Terminal in use elsewhere" placeholder with
    // this terminal's resolved theme background so a §47 popup borrowing
    // the live xterm doesn't flash the drawer canvas to `--bg-secondary`.
    placeholderBackground: resolveAppearanceBackground(resolveInstanceAppearance(inst)),
    onControlMessage(msg) { handleControlMessage(inst, msg); },
    onRestoredToTop() {
      // HS-8206 v2 — when another consumer (e.g. the §47 permission popup
      // borrowing the live terminal via §54 checkout) releases, the live
      // xterm reparents back into our `canvasHost`. `applyResizeIfChanged`
      // inside `releaseInternal` resizes the term to the cols/rows we
      // originally requested at checkout time (80×24), NOT to the drawer
      // pane's actual current geometry — which is typically much wider
      // (e.g. 178×42). Without an explicit refit here, the user sees the
      // drawer terminal stuck at the popup's narrow size with content
      // wrapping at ~80 cols even though the drawer pane is full-width.
      // Defer one rAF so the reparent + applyResizeIfChanged round-trip
      // has settled before FitAddon reads CSS dims.
      requestAnimationFrame(() => doFit(inst));
    },
  });
  const term = handle.term;
  const fit = handle.fit;

  applyDrawerXtermOptions(inst, term);
  const { search, searchHandle } = mountDrawerSearchAddon(inst, term);

  // HS-7960 — paint the body's gutter to match the theme BEFORE the async
  // appearance load runs (fire-and-forget below). Without this synchronous
  // prime the very first canvas paint flashes with the app's `--bg`.
  inst.body.style.backgroundColor = resolveAppearanceBackground(resolveInstanceAppearance(inst));
  // HS-6307 — apply full appearance (font family + size). Fire-and-forget.
  void reapplyAppearance(inst);

  // Clicking the body (including padding gutters outside the canvas) focuses
  // the terminal — preserves the pre-HS-7959 click-to-focus reach.
  inst.body.addEventListener('click', () => { term.focus(); });

  attachDrawerKeyHandler(inst, term);
  attachDrawerTermHandlers(inst, term, handle);

  inst.checkout = handle;
  inst.term = term;
  inst.fit = fit;
  inst.search = search;
  inst.searchHandle = searchHandle;
  inst.wsSecret = secret;
}

// -----------------------------------------------------------------------------
// WebSocket control-message dispatch (HS-8044 / HS-8088)
// -----------------------------------------------------------------------------
//
// HS-8088 — discriminated union over the control-message shapes the
// drawer currently consumes. Pre-fix the parsed JSON arrived as
// `{ type: string; [k: string]: unknown }` and each branch did
// `msg as unknown as HistoryMessage` / `as unknown as ExitMessage` to
// peel apart the fields. The narrowing predicates below let TS pick
// the right branch from a `msg.type === 'history'` / `'exit'` check
// without an escape-hatch cast at every callsite. The interface members
// extend an index signature so the predicates' type guards can narrow
// against the JSON-shape parameter type.

interface HistoryMessage { type: 'history'; bytes: string; alive: boolean; exitCode: number | null; cols: number; rows: number; command: string; [k: string]: unknown }
interface ExitMessage { type: 'exit'; code: number; [k: string]: unknown }
export type ControlMessage = HistoryMessage | ExitMessage;

function isHistoryMessage(msg: { type: string; [k: string]: unknown }): msg is HistoryMessage {
  return msg.type === 'history' && typeof msg.bytes === 'string' && typeof msg.alive === 'boolean';
}
function isExitMessage(msg: { type: string; [k: string]: unknown }): msg is ExitMessage {
  return msg.type === 'exit' && typeof msg.code === 'number';
}

export function handleControlMessage(inst: TerminalInstance, msg: { type: string; [k: string]: unknown }): void {
  const h = requireHooks();
  if (isHistoryMessage(msg)) {
    // HS-8044 — bytes-replay (resize first, write second) is now done
    // inside the checkout module's WS handler. The drawer just extracts
    // the metadata fields (alive, exitCode, command) for tab-status /
    // tab-label updates.
    inst.exitCode = msg.exitCode;
    h.setStatus(inst, msg.alive ? 'alive' : 'exited');
    if (msg.command !== '') {
      // Prefer the user-supplied name; fall back to resolved command for unnamed terminals.
      if ((inst.config.name ?? '') === '') inst.label.textContent = h.shortCommandName(msg.command);
    }
    requestAnimationFrame(() => doFit(inst));
    return;
  }
  if (isExitMessage(msg)) {
    inst.exitCode = msg.code;
    h.setStatus(inst, 'exited');
    inst.term?.write(`\r\n[process exited with code ${msg.code}]\r\n`);
    // HS-7267 — if a command was in-flight (A seen, no D yet), close it out
    // with exitCode=-1 so its gutter glyph stays visible (otherwise the
    // record sits dangling with no visible end). §26.9 edge case "runaway
    // C without D".
    if (inst.term !== null) closeDanglingCommand(inst, inst.term);
    return;
  }
}
