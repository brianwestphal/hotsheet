// HS-9416 (docs/126) — the project-scoped state primitive.
//
// Nine shipped bugs share one shape: client state belonging to project A
// survived a switch to project B (docs/125). The audit's key finding was that
// the caches which never leaked are the ones **keyed by project secret**, not
// the ones reset in `reloadAppState` — keying makes the wrong value
// *unreachable*, including during fetch failures and races, whereas resetting
// only works while somebody maintains a hand-written list of refresh calls.
//
// This module generalizes that keying to a one-line declaration, INCLUDING for
// scalars (`let lastSeenId = 0`), which a keyed-`Map` convention alone can't
// reach:
//
//     const lastSeenId = projectScoped(() => 0);
//     lastSeenId.get();          // this project's value, or the initial
//     lastSeenId.set(entry.id);
//
// Design constraints worth preserving if this is ever refactored:
//
//  1. **It must be less code than the status quo.** It replaces both the bare
//     module `let` AND the hand-rolled `Map<secret, T>` + lookup boilerplate.
//     Adoption pressure is the whole point — a primitive that costs more than
//     the buggy pattern does not get used.
//  2. **The active secret is read AT ACCESS TIME**, not pushed in on switch.
//     A pushed copy is one more thing that can desync; reading the store means
//     the cell is correct by construction the instant the active project flips.
//  3. **No import cycle.** This module depends only on `projectsStore` (a leaf).
//     `state.tsx` may depend on THIS module (it calls `evictProjectScope` from
//     `clearPerProjectSessionState`), never the reverse.
//
// See docs/126-project-scoped-primitive.md.

import { projectsStore } from './projectsStore.js';

/** Key used before any project is active (boot, or after the last project is
 *  removed). A distinct symbol rather than `null`/`''` so a value written at
 *  boot is retained for reads in that same no-project window, yet can never be
 *  returned once a real project is active. */
const NO_PROJECT = Symbol('no-project');

type ScopeKey = string | typeof NO_PROJECT;

function activeScope(): ScopeKey {
  const secret = projectsStore.state.value.activeProject?.secret;
  return secret === undefined || secret === '' ? NO_PROJECT : secret;
}

/** A per-project value cell. `get()` never returns another project's value. */
export interface ProjectScoped<T> {
  /** This project's value, or a freshly-built initial if it has none yet. */
  get: () => T;
  /** Set this project's value. */
  set: (value: T) => void;
  /** Drop this project's value; the next `get()` rebuilds from the initial. */
  clear: () => void;
  /** Drop EVERY project's value. For a module's own test-reset hook — production
   *  code wants `clear()` (this project) or `evictProjectScope` (one project,
   *  every cell). */
  clearAllScopes: () => void;
  /** Label used in the generic isolation test's failure messages. */
  readonly label: string;
}

/** Registry entry — the type-erased handle the generic isolation test drives. */
interface RegisteredCell {
  label: string;
  getUnknown: () => unknown;
  setUnknown: (value: unknown) => void;
  /** Drop one project's value (project unregistered). */
  clearFor: (secret: string) => void;
  /** Drop every project's value (test isolation). */
  clearAll: () => void;
}

const cells: RegisteredCell[] = [];

/**
 * Declare a per-project value.
 *
 * `initial` is called lazily, per project, the first time that project reads a
 * cell it hasn't written — so each project gets its own fresh object/Map rather
 * than sharing one instance.
 *
 * Reads before any project is active return the initial rather than throwing:
 * module-level cells are constructed at import time, well before the project
 * list loads, and a throw there would be a boot crash for a value nobody has
 * looked at yet.
 */
export function projectScoped<T>(initial: () => T, label = 'anonymous'): ProjectScoped<T> {
  // Values are BOXED (`{ v }`) rather than stored bare so that a cell whose T
  // legitimately includes `undefined` still distinguishes "never written" from
  // "written as undefined" — and so `get()` needs no type assertion, per the
  // project's default-to-no-`as` rule.
  const byScope = new Map<ScopeKey, { v: T }>();

  const boxFor = (key: ScopeKey): { v: T } => {
    const existing = byScope.get(key);
    if (existing !== undefined) return existing;
    const fresh = { v: initial() };
    byScope.set(key, fresh);
    return fresh;
  };

  const cell: ProjectScoped<T> = {
    get: () => boxFor(activeScope()).v,
    set: (value: T) => { byScope.set(activeScope(), { v: value }); },
    clear: () => { byScope.delete(activeScope()); },
    clearAllScopes: () => { byScope.clear(); },
    label,
  };

  cells.push({
    label,
    getUnknown: () => boxFor(activeScope()).v,
    // The isolation harness writes an opaque sentinel; it only ever asserts
    // identity/isolation, never that the value type-checks.
    setUnknown: (value: unknown) => { byScope.set(activeScope(), { v: value as T }); },
    clearFor: (secret: string) => { byScope.delete(secret); },
    clearAll: () => { byScope.clear(); },
  });

  return cell;
}

/**
 * Drop every cell's value for `secret`. Called by
 * `state.tsx::clearPerProjectSessionState` when a project is unregistered, so
 * the maps can't grow without bound and a project re-added at the same secret
 * starts clean.
 *
 * This is the ONE place eviction happens — a cell author never writes cleanup.
 */
export function evictProjectScope(secret: string): void {
  for (const c of cells) c.clearFor(secret);
}

/** **TEST ONLY.** Every registered cell, for the generic A→B→A isolation test
 *  (`projectScopedIsolation.test.ts`). Coverage grows automatically: any cell
 *  declared anywhere is included the moment its module is imported. */
export function _projectScopedCellsForTesting(): readonly RegisteredCell[] {
  return cells;
}

/** **TEST ONLY.** Wipe every cell in every scope so suites don't leak. */
export function _resetAllProjectScopedForTesting(): void {
  for (const c of cells) c.clearAll();
}
