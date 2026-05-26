/**
 * Drawer tab strip drag-and-drop reorder, extracted out of `terminal.tsx`
 * per HS-8396 Phase 3. Owns the per-tab dragstart/dragover/drop event
 * handlers AND the persistence logic that fires after a successful drop:
 * computing the new order, walking the live DOM to reorder tab buttons
 * + matching panes, and patching `/file-settings.terminals` so the
 * configured subset survives a reload.
 *
 * Cross-module state: the `lastKnownConfigs` map lives in `terminal.tsx`
 * and is consumed by other surfaces too (reconciliation, project switch,
 * `getLastKnownTerminalConfigs` test seam). This module reaches it via
 * the `getLastKnownConfigs` / `setLastKnownConfigs` hooks set at init
 * time. The drag state (`dragFromId`) is private to this module since no
 * other code touches it.
 */

import { updateFileSettings } from '../api/index.js';
import { byIdOrNull } from './dom.js';
import type { TerminalTabConfig } from './terminal.js';
import { configuredSubsetInStripOrder, reorderConfigsById, reorderIds } from './terminalTabReorder.js';

/** The shape of `lastKnownConfigs` carried by `terminal.tsx`. Matches the
 *  inline interface field so this module's hooks can read + write the
 *  same slot without forcing a separate type re-export. */
export interface LastKnownConfigs {
  configured: TerminalTabConfig[];
  dynamic: TerminalTabConfig[];
}

interface TabDragDropHooks {
  getLastKnownConfigs: () => LastKnownConfigs;
  setLastKnownConfigs: (next: LastKnownConfigs) => void;
}

let hooks: TabDragDropHooks | null = null;

/** Initialize the drag-drop module's accessors. Called once from
 *  `initTerminal` before any tab strip is rendered. */
export function initTabDragDrop(h: TabDragDropHooks): void {
  hooks = h;
}

function requireHooks(): TabDragDropHooks {
  if (hooks === null) throw new Error('initTabDragDrop must be called before any tab handlers fire');
  return hooks;
}

/** Mutable per-drag origin id. Set on dragstart, read on dragover/drop,
 *  cleared on dragend (and after a successful drop). Module-private so
 *  no other surface can race against the in-flight drag. */
let dragFromId: string | null = null;

export function attachTabDragHandlers(tabBtn: HTMLElement, terminalId: string): void {
  tabBtn.addEventListener('dragstart', (e) => {
    dragFromId = terminalId;
    if (e.dataTransfer !== null) {
      e.dataTransfer.effectAllowed = 'move';
      // Required by Firefox to start the drag — payload itself is unused.
      e.dataTransfer.setData('text/plain', terminalId);
    }
    tabBtn.classList.add('dragging');
  });
  tabBtn.addEventListener('dragend', () => {
    dragFromId = null;
    tabBtn.classList.remove('dragging');
    document.querySelectorAll('.drawer-terminal-tab.drag-over')
      .forEach(el => el.classList.remove('drag-over'));
  });
  tabBtn.addEventListener('dragover', (e) => {
    if (dragFromId === null || dragFromId === terminalId) return;
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    tabBtn.classList.add('drag-over');
  });
  tabBtn.addEventListener('dragleave', () => {
    tabBtn.classList.remove('drag-over');
  });
  tabBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    tabBtn.classList.remove('drag-over');
    if (dragFromId === null || dragFromId === terminalId) return;
    void reorderTabAfterDrop(dragFromId, terminalId);
    dragFromId = null;
  });
}

async function reorderTabAfterDrop(fromId: string, toId: string): Promise<void> {
  const tabStrip = byIdOrNull('drawer-terminal-tabs');
  if (tabStrip === null) return;
  const currentOrder: string[] = [];
  for (const el of tabStrip.querySelectorAll<HTMLElement>('.drawer-terminal-tab')) {
    const id = el.dataset.terminalId;
    if (typeof id === 'string' && id !== '') currentOrder.push(id);
  }
  const nextOrder = reorderIds(currentOrder, fromId, toId);
  if (nextOrder.join('|') === currentOrder.join('|')) return;

  // Apply the visual reorder by re-appending tabs (and matching panes) in
  // the new order. Browsers handle move-via-append cleanly — no flicker.
  const paneContainer = byIdOrNull('drawer-terminal-panes');
  for (const id of nextOrder) {
    const tab = tabStrip.querySelector<HTMLElement>(`.drawer-terminal-tab[data-terminal-id="${CSS.escape(id)}"]`);
    if (tab !== null) tabStrip.appendChild(tab);
    if (paneContainer !== null) {
      const pane = paneContainer.querySelector<HTMLElement>(`.drawer-terminal-pane[data-drawer-panel="${CSS.escape(`terminal:${id}`)}"]`);
      if (pane !== null) paneContainer.appendChild(pane);
    }
  }

  // Persist the configured-only subset to settings.terminals. Dynamic ids
  // are intentionally NOT persisted — their position in the strip is a
  // session-only concern (per the HS-7827 spec).
  const lastKnown = requireHooks().getLastKnownConfigs();
  const canonicalIds = lastKnown.configured.map(c => c.id);
  const newConfiguredOrder = configuredSubsetInStripOrder(nextOrder, canonicalIds);
  if (newConfiguredOrder.join('|') === canonicalIds.join('|')) return; // no change to persist
  const reorderedConfigs = reorderConfigsById(lastKnown.configured, newConfiguredOrder);
  // Strip the runtime-only fields the cache carries from /terminal/list
  // (`bellPending`, `state`, `exitCode`, `notificationMessage`, `dynamic`)
  // before persisting — settings.terminals is the canonical config shape.
  const persistShape = reorderedConfigs.map(({ id, name, command, cwd, lazy, theme, fontFamily, fontSize }) => {
    const out: { id: string; name?: string; command: string; cwd?: string; lazy?: boolean; theme?: string; fontFamily?: string; fontSize?: number } = { id, command };
    if (name !== undefined) out.name = name;
    if (cwd !== undefined) out.cwd = cwd;
    if (lazy !== undefined) out.lazy = lazy;
    if (theme !== undefined) out.theme = theme;
    if (fontFamily !== undefined) out.fontFamily = fontFamily;
    if (fontSize !== undefined) out.fontSize = fontSize;
    return out;
  });
  // Update the local cache so a subsequent rebuild before the PATCH
  // round-trips reflects the new order. /terminal/list will re-confirm
  // after the server applies the patch.
  requireHooks().setLastKnownConfigs({ ...lastKnown, configured: persistShape.map(c => ({ ...c, dynamic: false })) });
  try {
    await updateFileSettings({ terminals: persistShape });
  } catch {
    // PATCH failed — the in-memory + DOM order still moved, so the user
    // sees their reorder; on the next reload the server-side order wins.
  }
}
