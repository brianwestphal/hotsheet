/**
 * Bounded paint helpers extracted out of `terminalDashboard.tsx` per
 * HS-8395 Phase 3 (Phase 3a — the truly stateless slice). The big paint
 * functions (`paintDashboardSections`, `paintSectionedLayout`,
 * `paintFlowLayout`, `buildSectionEl`, `mountSectionGrid`, etc.) stay
 * in the main file for now because they're tightly coupled to
 * `dashboardState`'s `gridHandles` map + `centeredHandle` /
 * `dedicatedSearchHandle` / `lastSectionData` slots. Splitting those
 * requires either a shared state-holder module or paint-context
 * parameter threading — a separate phase.
 *
 * What lives here is bounded:
 * - `flattenSectionsToTiles` — pure list flattener.
 * - `fillDedicatedLabel` — pure DOM mutator.
 * - `attachDedicatedBarSearch` — pure: `SearchAddon` + widget mount.
 */

import { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';

import { DASHBOARD_SCOPE, filterVisible as filterVisibleEntries } from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';
import type { ProjectInfo } from './state.js';
import type { ProjectSectionData } from './terminalDashboardState.js';
import { toTileEntry } from './terminalDashboardTiles.js';
import { mountTerminalSearch, type TerminalSearchHandle } from './terminalSearch.js';
import { type TileEntry } from './terminalTileGrid.js';

export interface FlowTile {
  secret: string;
  entry: TileEntry;
  project: ProjectInfo;
}

/** HS-7662 flow-mode layout flattener. Walks each project's visible
 *  terminals (post hidden-terminal filter), wraps the tile entry with a
 *  `projectBadge` so the tile label always carries a project-name
 *  prefix in flow mode (per the §25.10.5 spec + the user feedback that
 *  lone-first-tile prefixes were ambiguous). */
export function flattenSectionsToTiles(sections: ProjectSectionData[]): FlowTile[] {
  const flat: FlowTile[] = [];
  for (const section of sections) {
    const visible = filterVisibleEntries(DASHBOARD_SCOPE, section.project.secret, section.terminals);
    if (visible.length === 0) continue;
    for (const terminal of visible) {
      const baseEntry = toTileEntry(section.project.secret)(terminal);
      flat.push({
        secret: section.project.secret,
        project: section.project,
        entry: { ...baseEntry, projectBadge: { name: section.project.name } },
      });
    }
  }
  return flat;
}

/** Populate the dedicated-view top-bar label with the
 *  `{project name} › {terminal label}` breadcrumb. Replaces any existing
 *  children — safe to call multiple times. Used by both the sectioned-
 *  mode and flow-mode dedicated-bar mount callbacks. */
export function fillDedicatedLabel(label: HTMLElement, project: ProjectInfo, terminalLabel: string): void {
  label.replaceChildren();
  label.appendChild(toElement(
    <span className="terminal-dashboard-dedicated-project">{project.name}</span>
  ));
  label.appendChild(toElement(
    <span className="terminal-dashboard-dedicated-sep">{'›'}</span>
  ));
  label.appendChild(toElement(
    <span className="terminal-dashboard-dedicated-terminal">{terminalLabel}</span>
  ));
}

/** HS-8341 — attach a terminal-search widget to a dedicated-view top bar.
 *  Both the flow-mode and sectioned-mode dedicated-bar mount callbacks
 *  share this two-step setup (load a SearchAddon onto the live xterm, then
 *  mount the widget and append its root into the bar). Returns the handle
 *  + a disposer that removes the widget root from the bar AND disposes the
 *  handle. The widget is right-aligned via the
 *  `.terminal-dashboard-dedicated-bar > .terminal-search-box` CSS rule.
 *  Pre-fix the widget mounted into a `#terminal-dashboard-search-slot` in
 *  the app-header, which was always occluded by the fixed-position
 *  `.terminal-dashboard-dedicated` overlay. Exported for unit tests. */
export function attachDedicatedBarSearch(
  bar: HTMLElement,
  term: Terminal,
  placeholderLabel: string,
): { handle: TerminalSearchHandle; dispose: () => void } {
  const search = new SearchAddon();
  term.loadAddon(search);
  const handle = mountTerminalSearch(term, search, { placeholder: `Search ${placeholderLabel}` });
  bar.appendChild(handle.root);
  return {
    handle,
    dispose: () => {
      try { handle.dispose(); } catch { /* ignore */ }
      handle.root.remove();
    },
  };
}
