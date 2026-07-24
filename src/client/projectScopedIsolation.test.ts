// @vitest-environment happy-dom
/**
 * HS-9416 (docs/126 §126.4) — the generic A→B→A isolation harness.
 *
 * This is layer 2 of the docs/125 guard. Rather than asking every feature to
 * remember a per-project transition test, it walks **every registered
 * `projectScoped` cell** and asserts the three legs that define correct scoping:
 *
 *   1. project B must not see project A's value,
 *   2. project B must see its own initial, and
 *   3. switching back to A must still return A's value
 *      (leg 3 is what separates real scoping from a reset-on-switch, which
 *      throws data away — see the HS-9412 warning about zeroing `lastSeenId`).
 *
 * **Adopting modules are DISCOVERED, not listed.** The test greps `src/client`
 * for `projectScoped(` and imports exactly those files, so a cell declared in a
 * new module is covered the day it's written with nothing to remember. A
 * hard-coded list would reintroduce the very "did you remember?" failure mode
 * this whole guard exists to remove.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  _projectScopedCellsForTesting,
  _resetAllProjectScopedForTesting,
  projectScoped,
} from './projectScoped.js';
import { projectsStore } from './projectsStore.js';
import type { ProjectInfo } from './state.js';

const CLIENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Every `src/client/**` source file that declares a `projectScoped` cell. */
function findAdoptingModules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { findAdoptingModules(full, out); continue; }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    if (entry === 'projectScoped.ts') continue; // the primitive itself
    if (readFileSync(full, 'utf-8').includes('projectScoped(')) out.push(full);
  }
  return out;
}

const project = (secret: string): ProjectInfo =>
  ({ secret, name: `p-${secret}`, dataDir: `/tmp/${secret}` });

const activate = (secret: string | null) =>
  projectsStore.actions.setActive(secret === null ? null : project(secret));

let adopting: string[] = [];

beforeAll(async () => {
  adopting = findAdoptingModules(CLIENT_DIR);
  // Import each adopting module so its cells register. A failure here is a real
  // signal (the module can't load in a test env), so it is NOT swallowed — a
  // caught import would silently drop that module's cells from coverage, which
  // is exactly the blind spot this harness exists to close.
  for (const file of adopting) {
    await import(/* @vite-ignore */ file);
  }
});

beforeEach(() => {
  _resetAllProjectScopedForTesting();
  activate(null);
});

describe('projectScoped — every registered cell is project-isolated', () => {
  it('discovers the adopting modules', () => {
    // Guards the discovery mechanism itself: if the grep silently matched
    // nothing, every assertion below would vacuously pass.
    expect(adopting.length, `no src/client module declares projectScoped(); the harness would be vacuous`).toBeGreaterThan(0);
    expect(_projectScopedCellsForTesting().length).toBeGreaterThan(0);
  });

  it('walks A → B → A over every cell', () => {
    const cells = _projectScopedCellsForTesting();
    // An opaque sentinel: the harness asserts identity + isolation only, never
    // that the value type-checks for that particular cell.
    const sentinel = { __projectScopedSentinel: 'A' };

    for (const cell of cells) {
      _resetAllProjectScopedForTesting();

      activate('secret-A');
      const initialA = cell.getUnknown();
      cell.setUnknown(sentinel);
      expect(cell.getUnknown(), `${cell.label}: A should hold what A wrote`).toBe(sentinel);

      // Leg 1 + 2 — B sees its own initial, never A's value.
      activate('secret-B');
      expect(cell.getUnknown(), `${cell.label}: LEAKED project A's value into project B`).not.toBe(sentinel);
      expect(cell.getUnknown(), `${cell.label}: B should see the cell's initial`).toStrictEqual(initialA);

      // Leg 3 — A's value survives the round trip.
      activate('secret-A');
      expect(cell.getUnknown(), `${cell.label}: A's value was lost on the round trip`).toBe(sentinel);
    }
  });

  it('gives every cell a distinct instance per project (no shared mutable initial)', () => {
    for (const cell of _projectScopedCellsForTesting()) {
      _resetAllProjectScopedForTesting();
      activate('secret-A');
      const a = cell.getUnknown();
      activate('secret-B');
      const b = cell.getUnknown();
      // Primitives (0, '', null, undefined) are legitimately identical across
      // projects; only a SHARED mutable object would be a bug, since a write
      // through one project's handle would be visible from the other.
      if (a !== null && typeof a === 'object') {
        expect(b, `${cell.label}: both projects share ONE mutable instance`).not.toBe(a);
      }
    }
  });
});

describe('projectScoped — the harness itself', () => {
  // Proves the harness can actually fail. Without this, a broken assertion
  // (e.g. a sentinel that compares equal to everything) would make the suite
  // above green regardless of leaks.
  it('would catch a leaking cell', () => {
    let leaked: unknown = null; // a module-level `let` — the buggy pattern
    const buggy = {
      get: () => leaked,
      set: (v: unknown) => { leaked = v; },
    };
    const sentinel = { x: 1 };
    activate('secret-A');
    buggy.set(sentinel);
    activate('secret-B');
    expect(buggy.get()).toBe(sentinel); // the leak the harness looks for
  });

  it('a correctly-scoped cell does not leak', () => {
    const good = projectScoped<unknown>(() => null, 'harness-control');
    const sentinel = { x: 1 };
    activate('secret-A');
    good.set(sentinel);
    activate('secret-B');
    expect(good.get()).toBeNull();
  });
});
