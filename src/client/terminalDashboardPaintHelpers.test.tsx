// @vitest-environment happy-dom
//
// HS-8489 — pure unit tests for the (secret → project) lookup used by
// `paintFlowLayout`'s per-tile callbacks. Pre-fix the equivalent lookup
// was keyed by terminal id, which collided whenever two projects had
// terminals sharing an id (e.g. the default `default` terminal), routing
// project-badge clicks on the collision-id tile to the wrong project.
import { describe, expect, it } from 'vitest';

import type { ProjectInfo } from './state.js';
import {
  buildSectionProjectLookup,
  resolveTileEntryProject,
} from './terminalDashboardPaintHelpers.js';
import type { ProjectSectionData, TerminalListEntry } from './terminalDashboardState.js';
import { type TileEntry } from './terminalTileGrid.js';

function project(secret: string, name: string): ProjectInfo {
  return { name, dataDir: `/tmp/${name}`, secret };
}

function section(p: ProjectInfo, terminals: TerminalListEntry[] = []): ProjectSectionData {
  return { project: p, terminals };
}

function tileEntry(secret: string, id: string): TileEntry {
  return {
    id,
    secret,
    label: id,
    state: 'not_spawned',
    exitCode: null,
  };
}

describe('buildSectionProjectLookup + resolveTileEntryProject (HS-8489)', () => {
  it('resolves a tile to its owning project when each project has a unique terminal id', () => {
    const projA = project('secretA', 'Alpha');
    const projB = project('secretB', 'Beta');
    const lookup = buildSectionProjectLookup([section(projA), section(projB)]);

    expect(resolveTileEntryProject(tileEntry('secretA', 'term-a-only'), lookup)).toBe(projA);
    expect(resolveTileEntryProject(tileEntry('secretB', 'term-b-only'), lookup)).toBe(projB);
  });

  it('routes each project-badge click to the correct project even when two projects share a terminal id', () => {
    // The HS-8489 regression: both projects carry a terminal with id
    // `default` (the out-of-the-box configured terminal). Pre-fix the
    // map was keyed by id, so whichever project was inserted last won
    // for every tile with id `default` and a click on project A's badge
    // routed to project B (or vice-versa).
    const projA = project('secretA', 'Alpha');
    const projB = project('secretB', 'Beta');
    const lookup = buildSectionProjectLookup([section(projA), section(projB)]);

    // Both tile entries have id `default` but different secrets — the
    // lookup keys on secret so each one resolves to its true owner.
    const tileA = tileEntry('secretA', 'default');
    const tileB = tileEntry('secretB', 'default');
    expect(resolveTileEntryProject(tileA, lookup)).toBe(projA);
    expect(resolveTileEntryProject(tileB, lookup)).toBe(projB);
  });

  it('routes correctly regardless of section-iteration order', () => {
    // Swap the section order to prove the result is order-independent
    // (pre-fix, `entry.id`-keyed inserts overwrote earlier entries —
    // last-writer-wins. The secret-keyed map can't collide, so the
    // order doesn't matter).
    const projA = project('secretA', 'Alpha');
    const projB = project('secretB', 'Beta');
    const lookupAB = buildSectionProjectLookup([section(projA), section(projB)]);
    const lookupBA = buildSectionProjectLookup([section(projB), section(projA)]);

    expect(resolveTileEntryProject(tileEntry('secretA', 'default'), lookupAB)).toBe(projA);
    expect(resolveTileEntryProject(tileEntry('secretA', 'default'), lookupBA)).toBe(projA);
    expect(resolveTileEntryProject(tileEntry('secretB', 'default'), lookupAB)).toBe(projB);
    expect(resolveTileEntryProject(tileEntry('secretB', 'default'), lookupBA)).toBe(projB);
  });

  it('returns null when the entry secret is not in the lookup (project removed between snapshot and click)', () => {
    const projA = project('secretA', 'Alpha');
    const lookup = buildSectionProjectLookup([section(projA)]);

    expect(resolveTileEntryProject(tileEntry('secretGone', 'default'), lookup)).toBeNull();
  });

  it('builds an empty lookup from an empty section list', () => {
    const lookup = buildSectionProjectLookup([]);
    expect(lookup.size).toBe(0);
    expect(resolveTileEntryProject(tileEntry('secretA', 'default'), lookup)).toBeNull();
  });
});
