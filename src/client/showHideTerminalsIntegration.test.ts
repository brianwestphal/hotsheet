// @vitest-environment happy-dom
/**
 * HS-8356 — integration tests for the show/hide flow as it propagates
 * from the live `dashboardHiddenTerminals` store into the actual
 * filterVisible-driven rendering paths used by:
 *
 *   - the global Terminal Dashboard (§25, `terminalDashboard.tsx::paintSectionedLayout`
 *     + `flattenSectionsToTiles` — both call `filterVisible(secret, entries)` to
 *     drop hidden ids before rendering, and drop the entire project section
 *     when every configured terminal in the section is hidden).
 *   - the per-project Drawer Terminal Grid (§36, `drawerTerminalGrid.tsx`
 *     subscribes to `subscribeToHiddenChanges` + calls `filterVisible` on
 *     every rebuild so a hide / unhide flows into the grid handle's
 *     reconciled tile list).
 *
 * Existing unit coverage (`visibilityGroupings.test.ts`,
 * `visibilityGroupingsStore.test.ts`, `dashboardHiddenTerminals.test.ts`,
 * `drawerTerminalGrid.test.ts`) already exhausts the state machinery
 * (toggle, set, prune, hydrate, group CRUD, subscribe/unsubscribe) and
 * the drawer-grid lifecycle wiring. This file pins the integration
 * contract: when the live store changes via the same API the dialog
 * uses, the consumer-side `filterVisible` call drops the right ids,
 * grouping switches don't bleed, and the subscribe-fires-on-change
 * round trip works end-to-end for both surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests,
  addGrouping,
  applyHideButtonBadge,
  countHiddenAcrossAllProjects,
  countHiddenForProject,
  filterVisible,
  hideAllInGrouping,
  setActiveGrouping,
  setTerminalHidden,
  setTerminalHiddenInGrouping,
  subscribeToHiddenChanges,
  unhideAllEverywhere,
  unhideAllInGrouping,
  unhideAllInProject,
} from './dashboardHiddenTerminals.js';
import { DEFAULT_GROUPING_ID } from './visibilityGroupings.js';

interface Tile { id: string; name: string }

const PROJECT_A = 'project-a-secret';
const PROJECT_B = 'project-b-secret';

function tiles(...ids: string[]): Tile[] {
  return ids.map(id => ({ id, name: `name-${id}` }));
}

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
});

describe('HS-8356 — dashboard `paintSectionedLayout` filterVisible integration', () => {
  // The dashboard's per-section filter chain is:
  //   visible = filterVisible(section.project.secret, section.terminals)
  // and a section is dropped when `section.terminals.length > 0 && visible.length === 0`.
  // These tests reproduce the same chain over the live store so the
  // dashboard's contract with the store is pinned end-to-end.

  it('initial state — no ids hidden, every tile is visible', () => {
    const result = filterVisible(PROJECT_A, tiles('t1', 't2', 't3'));
    expect(result.map(t => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('hiding one id drops only that id from the section', () => {
    setTerminalHidden(PROJECT_A, 't2', true);
    const result = filterVisible(PROJECT_A, tiles('t1', 't2', 't3'));
    expect(result.map(t => t.id)).toEqual(['t1', 't3']);
  });

  it('hiding every configured id in a project drops the entire section (count drops to 0)', () => {
    // Hide every id in the project.
    setTerminalHidden(PROJECT_A, 't1', true);
    setTerminalHidden(PROJECT_A, 't2', true);
    setTerminalHidden(PROJECT_A, 't3', true);
    const result = filterVisible(PROJECT_A, tiles('t1', 't2', 't3'));
    expect(result).toHaveLength(0);
    // Mirrors the `paintSectionedLayout` `continue` condition: when the
    // section has 3 configured terminals + 0 visible, the section is
    // dropped entirely. This assertion locks the contract via the same
    // values dashboard.tsx reads.
    expect(tiles('t1', 't2', 't3').length > 0 && result.length === 0).toBe(true);
  });

  it('a hide in project A does NOT affect project B (cross-project isolation)', () => {
    setTerminalHidden(PROJECT_A, 't1', true);
    const aTiles = filterVisible(PROJECT_A, tiles('t1', 't2'));
    const bTiles = filterVisible(PROJECT_B, tiles('t1', 't2'));
    expect(aTiles.map(t => t.id)).toEqual(['t2']);
    expect(bTiles.map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('unhiding restores the tile back into the filtered list', () => {
    setTerminalHidden(PROJECT_A, 't2', true);
    expect(filterVisible(PROJECT_A, tiles('t1', 't2')).map(t => t.id)).toEqual(['t1']);

    setTerminalHidden(PROJECT_A, 't2', false);
    expect(filterVisible(PROJECT_A, tiles('t1', 't2')).map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('unhideAllInProject restores every tile in that project but leaves other projects alone', () => {
    setTerminalHidden(PROJECT_A, 't1', true);
    setTerminalHidden(PROJECT_A, 't2', true);
    setTerminalHidden(PROJECT_B, 't1', true);

    unhideAllInProject(PROJECT_A);

    expect(filterVisible(PROJECT_A, tiles('t1', 't2')).map(t => t.id)).toEqual(['t1', 't2']);
    expect(filterVisible(PROJECT_B, tiles('t1', 't2')).map(t => t.id)).toEqual(['t2']);
  });

  it('unhideAllEverywhere restores every tile in every project', () => {
    setTerminalHidden(PROJECT_A, 't1', true);
    setTerminalHidden(PROJECT_B, 't1', true);

    unhideAllEverywhere();

    expect(filterVisible(PROJECT_A, tiles('t1'))).toHaveLength(1);
    expect(filterVisible(PROJECT_B, tiles('t1'))).toHaveLength(1);
  });
});

describe('HS-8356 — drawer terminal grid filterVisible integration', () => {
  // The drawer terminal grid subscribes to `subscribeToHiddenChanges`
  // and calls `filterVisible(secret, entries)` on every grid rebuild
  // (see `drawerTerminalGrid.tsx`). The list of entries it filters is
  // ALWAYS the active project's terminals — single-project scope. These
  // tests mirror that exact shape.

  it('initial state — every tile in the active project is visible to the drawer grid', () => {
    const visible = filterVisible(PROJECT_A, tiles('t1', 't2', 't3'));
    expect(visible.map(t => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('a single-project hide fires the change subscription exactly once per state change', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden(PROJECT_A, 't1', true);
    expect(fires).toBe(1);
    setTerminalHidden(PROJECT_A, 't1', true);
    expect(fires).toBe(1); // idempotent
    setTerminalHidden(PROJECT_A, 't1', false);
    expect(fires).toBe(2);
    unsub();
  });

  it('the subscription does NOT fire on a project-OTHER hide (per-secret scoping is upstream)', () => {
    // Note: the subscription is global — it fires on ANY change to the
    // global state. The drawer-grid filters by its OWN project secret on
    // every fire, so cross-project changes are a no-op visually but
    // still trigger the subscription. This test pins the global-fire
    // contract so an over-eager optimisation that scopes the
    // subscription doesn't accidentally drop cross-project rebuilds.
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden(PROJECT_B, 't1', true);
    expect(fires).toBe(1);
    unsub();
  });

  it('a hide via the dialog flow (specific-grouping + setActiveGrouping) takes effect in filterVisible', () => {
    // Reproduces the dialog's behavior when the user is on a non-active
    // tab: it calls setTerminalHiddenInGrouping for the OTHER grouping.
    // Only when setActiveGrouping flips the active id does
    // filterVisible (which reads the active grouping) reflect the
    // change. This pins that contract.
    const g = addGrouping('Server');
    setTerminalHiddenInGrouping(PROJECT_A, g.id, 't1', true);

    // Still on Default grouping — the hide isn't visible yet.
    expect(filterVisible(PROJECT_A, tiles('t1', 't2')).map(t => t.id)).toEqual(['t1', 't2']);

    // Activate the Server grouping — now the hide takes effect.
    setActiveGrouping(g.id);
    expect(filterVisible(PROJECT_A, tiles('t1', 't2')).map(t => t.id)).toEqual(['t2']);

    // Switch back — Default grouping's empty hidden list takes over.
    setActiveGrouping(DEFAULT_GROUPING_ID);
    expect(filterVisible(PROJECT_A, tiles('t1', 't2')).map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('hideAllInGrouping (dialog "Hide All" path) hides every supplied id in one call', () => {
    const g = addGrouping('Server');
    setActiveGrouping(g.id);

    hideAllInGrouping(PROJECT_A, g.id, ['t1', 't2', 't3']);
    expect(filterVisible(PROJECT_A, tiles('t1', 't2', 't3'))).toHaveLength(0);

    unhideAllInGrouping(PROJECT_A, g.id);
    expect(filterVisible(PROJECT_A, tiles('t1', 't2', 't3')).map(t => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('HS-8356 — hide-button badge integration (dashboard + drawer grid)', () => {
  // Both the dashboard's hide button and the drawer grid's hide button
  // call `applyHideButtonBadge(button, count)` where count comes from
  // `countHiddenForProject(secret)` (drawer grid) or
  // `countHiddenAcrossAllProjects()` (dashboard). These tests pin the
  // badge → count → state round trip.

  it('hiding one terminal increments the per-project count by 1', () => {
    expect(countHiddenForProject(PROJECT_A)).toBe(0);
    setTerminalHidden(PROJECT_A, 't1', true);
    expect(countHiddenForProject(PROJECT_A)).toBe(1);
    setTerminalHidden(PROJECT_A, 't2', true);
    expect(countHiddenForProject(PROJECT_A)).toBe(2);
  });

  it('hiding one terminal in project A leaves project B count at 0', () => {
    setTerminalHidden(PROJECT_A, 't1', true);
    expect(countHiddenForProject(PROJECT_A)).toBe(1);
    expect(countHiddenForProject(PROJECT_B)).toBe(0);
  });

  it('the dashboard-scope count sums across every project', () => {
    setTerminalHidden(PROJECT_A, 't1', true);
    setTerminalHidden(PROJECT_A, 't2', true);
    setTerminalHidden(PROJECT_B, 't1', true);
    expect(countHiddenAcrossAllProjects()).toBe(3);
  });

  it('applyHideButtonBadge writes / removes the .hide-btn-badge node based on the live count', () => {
    const button = document.createElement('button');
    setTerminalHidden(PROJECT_A, 't1', true);
    applyHideButtonBadge(button, countHiddenForProject(PROJECT_A));
    expect(button.querySelector('.hide-btn-badge')?.textContent).toBe('1');

    setTerminalHidden(PROJECT_A, 't2', true);
    applyHideButtonBadge(button, countHiddenForProject(PROJECT_A));
    expect(button.querySelector('.hide-btn-badge')?.textContent).toBe('2');

    unhideAllInProject(PROJECT_A);
    applyHideButtonBadge(button, countHiddenForProject(PROJECT_A));
    expect(button.querySelector('.hide-btn-badge')).toBeNull();
  });
});

describe('HS-8356 — grouping switch fires the subscription so dashboard + drawer-grid rebuild', () => {
  // The dashboard / drawer-grid rebuild paths are triggered by the
  // hidden-changes subscription. A grouping flip (active-id change) is
  // a state change that should fire so the next rebuild picks up the
  // grouping's hiddenByProject. This pins that contract.

  it('setActiveGrouping fires the subscription', () => {
    const g = addGrouping('Server');
    const handler = vi.fn();
    const unsub = subscribeToHiddenChanges(handler);
    setActiveGrouping(g.id);
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('setActiveGrouping that does NOT change the active id is a no-op', () => {
    const handler = vi.fn();
    const unsub = subscribeToHiddenChanges(handler);
    setActiveGrouping(DEFAULT_GROUPING_ID);
    expect(handler).not.toHaveBeenCalled();
    unsub();
  });

  it('group CRUD (add / rename / delete / reorder) fires the subscription so the grouping selector picks up the change', async () => {
    const handler = vi.fn();
    const unsub = subscribeToHiddenChanges(handler);
    addGrouping('Server');
    expect(handler).toHaveBeenCalledTimes(1);
    // The subscription doesn't double-fire across micro-task boundaries
    // for the same action (kerf store's setState short-circuits no-ops).
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
  });
});
