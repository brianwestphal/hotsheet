/**
 * Drawer tab context menu + bulk-close flow + rename overlay extracted
 * out of `terminal.tsx` per HS-8396 Phase 4. The context menu is the
 * right-click surface on a drawer tab (Close / Close Others / Close
 * Tabs to the Left / Close Tabs to the Right / Rename). It defers to
 * the shared `showSharedTabContextMenu` (in `terminal/tabContextMenu.tsx`)
 * which owns the actual menu DOM + positioning; this module is the
 * dashboard-side glue that supplies the menu's data and action callbacks.
 *
 * Cross-module state: the per-id `instances` Map lives in `terminal.tsx`,
 * plus the `closeDynamicTerminal` and `selectFallbackAfterClose`
 * lifecycle helpers. This module reaches them via the hooks set at
 * init time. `isDynamic` and `orderedTabIds` are small read-only
 * helpers that walk the live DOM + the instances Map; they move here
 * too so the new module's API surface stays self-contained, and are
 * re-exported for the few external callers in `terminal.tsx`.
 */

import { confirmDialog } from './confirm.js';
import { byIdOrNull } from './dom.js';
import { getActiveProject } from './state.js';
import type { TerminalInstance } from './terminal.js';
import { openRenameDialog } from './terminal/renameDialog.js';
import { showTabContextMenu as showSharedTabContextMenu } from './terminal/tabContextMenu.js';
import { tabDisplayName, updateTabLabel } from './terminalInstanceLabel.js';
import { setTransientTerminalName } from './terminalTransientNames.js';

interface TabContextMenuHooks {
  /** Lookup the per-instance state for an id. Returns undefined for ids
   *  that no longer exist (race between menu open and tab close). */
  getInstance: (id: string) => TerminalInstance | undefined;
  /** Lifecycle helper from `terminal.tsx` that destroys a dynamic
   *  terminal's PTY + tab + pane. The `skipConfirm` second arg bypasses
   *  the alive-process confirm dialog; `suppressFallback` skips the
   *  automatic fallback-tab activation. */
  closeDynamicTerminal: (id: string, skipConfirm?: boolean, suppressFallback?: boolean) => Promise<void>;
  /** Lifecycle helper that picks the next tab to activate after a bulk
   *  close. Anchors on the original strip order (passed as the first
   *  arg) so the choice is deterministic per HS-7275. */
  selectFallbackAfterClose: (orderBeforeClose: string[], closedIds: string[]) => Promise<void>;
}

let hooks: TabContextMenuHooks | null = null;

/** Initialize the tab-context-menu module with its lifecycle accessors.
 *  Called once from `initTerminal`. */
export function initTabContextMenu(h: TabContextMenuHooks): void {
  hooks = h;
}

function requireHooks(): TabContextMenuHooks {
  if (hooks === null) throw new Error('initTabContextMenu must be called before any menu fires');
  return hooks;
}

export function isDynamic(id: string): boolean {
  return requireHooks().getInstance(id)?.config.dynamic === true;
}

/** Ordered list of tab ids, matching the visible left-to-right tab strip
 *  order. Walks the live DOM rather than the `instances` Map so a
 *  freshly-dragged reorder reflects in the result without waiting for
 *  the next list refresh. */
export function orderedTabIds(): string[] {
  const strip = byIdOrNull('drawer-terminal-tabs');
  if (!strip) return [];
  const out: string[] = [];
  for (const el of Array.from(strip.children)) {
    const id = (el as HTMLElement).dataset.terminalId;
    if (typeof id === 'string' && id !== '') out.push(id);
  }
  return out;
}

export function showTabContextMenu(e: MouseEvent, clickedId: string): void {
  showSharedTabContextMenu({
    event: e,
    clickedId,
    clickedIsDynamic: isDynamic(clickedId),
    orderedIds: orderedTabIds(),
    isDynamic,
    onClose: (id) => { void requireHooks().closeDynamicTerminal(id); },
    onCloseSet: (ids) => { void closeTabs(ids); },
    onRename: (id) => {
      const inst = requireHooks().getInstance(id);
      if (inst) promptRenameTerminal(inst);
    },
  });
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
  const h = requireHooks();

  const aliveIds = ids.filter(id => h.getInstance(id)?.status === 'alive');
  const deadIds = ids.filter(id => !aliveIds.includes(id));

  // Snapshot order BEFORE any close so the fallback anchors on the original
  // positions after every close has completed (HS-7275).
  const orderBeforeClose = orderedTabIds();

  if (aliveIds.length === 0) {
    for (const id of ids) await h.closeDynamicTerminal(id, true, true);
    await h.selectFallbackAfterClose(orderBeforeClose, ids);
    return;
  }

  if (aliveIds.length === 1) {
    // Fall through to the single-tab confirm UX — if the user cancels there,
    // the whole bulk op aborts (no dead-tab destroys either). If they confirm,
    // the alive tab is destroyed by closeDynamicTerminal; we then clean up the
    // inert tabs.
    const aliveId = aliveIds[0];
    const before = h.getInstance(aliveId) !== undefined;
    await h.closeDynamicTerminal(aliveId, false, true);
    const confirmed = before && h.getInstance(aliveId) === undefined;
    if (!confirmed) return;
    for (const id of deadIds) await h.closeDynamicTerminal(id, true, true);
    await h.selectFallbackAfterClose(orderBeforeClose, ids);
    return;
  }

  const names = aliveIds
    .map(id => {
      const inst = h.getInstance(id);
      return inst !== undefined ? tabDisplayName(inst.config) : id;
    })
    .map(n => `  • ${n}`)
    .join('\n');
  const confirmed = await confirmDialog({
    title: 'Stop All Running Terminals?',
    message: `The following terminals have running processes that will be stopped:\n\n${names}`,
    confirmLabel: 'Stop All',
    danger: true,
  });
  if (!confirmed) return;
  for (const id of ids) await h.closeDynamicTerminal(id, true, true);
  await h.selectFallbackAfterClose(orderBeforeClose, ids);
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
  openRenameDialog({
    initialValue: tabDisplayName(inst.config),
    onApply: (next) => {
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
      // HS-9277 — publish the transient rename so the dashboard tile (which
      // renders from its own server config fetch, not this instance) reflects it.
      setTransientTerminalName(getActiveProject()?.secret ?? '', inst.id, next);
    },
  });
}
