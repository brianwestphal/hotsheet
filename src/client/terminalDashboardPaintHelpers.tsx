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

/** HS-8489 — build the (secret → project) lookup that `paintFlowLayout`'s
 *  per-tile callbacks (project-badge click, context menu, dedicated-bar
 *  mount) use to recover the originating project from a `TileEntry`.
 *
 *  Pre-fix `paintFlowLayout` keyed an equivalent map by `entry.id` (the
 *  terminal id), which collided whenever two projects each had a terminal
 *  with the same id (e.g. the default `default` terminal) — whichever
 *  project was inserted last won for every shared id, routing every
 *  project-badge click on a collision-id tile to the WRONG project. That
 *  surfaced as "clicking a project name in the terminal dashboard goes
 *  back to the previously selected project tab" because the last-loser
 *  project happened to be the one the user came from when they opened
 *  the dashboard.
 *
 *  Keyed by `secret` (which `TileEntry.secret` carries verbatim from
 *  `toTileEntry`), so two terminals sharing an id resolve correctly. */
export function buildSectionProjectLookup(sections: ProjectSectionData[]): Map<string, ProjectInfo> {
  const lookup = new Map<string, ProjectInfo>();
  for (const section of sections) lookup.set(section.project.secret, section.project);
  return lookup;
}

/** HS-8489 — companion to `buildSectionProjectLookup`. Returns the project
 *  that owns the given `TileEntry`, or `null` when the entry's secret
 *  isn't in the lookup (the project was removed between the section-data
 *  snapshot and the user's click — vanishingly rare but defensively
 *  handled). */
export function resolveTileEntryProject(
  entry: TileEntry,
  lookup: Map<string, ProjectInfo>,
): ProjectInfo | null {
  return lookup.get(entry.secret) ?? null;
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
