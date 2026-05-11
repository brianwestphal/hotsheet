/**
 * §61 Phase 3a / HS-8317 — `projectsStore` consolidating the global
 * project list + active-project-secret pointer into a single kerf
 * `defineStore`. Replaces:
 *
 * - `state.tsx::activeProject` (raw `let` + `getActiveProject()` /
 *   `setActiveProject()` accessors).
 * - `projectTabs.tsx::projectListSignal` (HS-8235's standalone
 *   `Signal<readonly ProjectInfo[]>`).
 * - `projectTabs.tsx::activeSecretSignal` (HS-8235's mirror of
 *   `getActiveProject()?.secret`).
 *
 * Public surface (`getActiveProject()` / `setActiveProject(project)`)
 * stays unchanged — the migration is purely internal consolidation.
 * The 88 callsites across 18 files that read `getActiveProject()` and
 * the handful that call `setActiveProject(project)` see no behavioral
 * change.
 *
 * **Does NOT reset on project switch** (this store IS the source of
 * truth for what to switch TO). When production wires
 * `resetAllStores()` into a project-switch hook, this store must opt
 * out — kerf's `defineStore` doesn't currently expose an opt-out flag,
 * so the wiring will need either (a) a kerf upstream addition or (b) a
 * per-call-site exclusion list. Out of scope for HS-8317; revisit
 * when HS-8239 (`ticketsStore` — first per-project store) lands and
 * the production reset hook becomes useful.
 */
import type { ReadonlySignal } from './reactive.js';
import { computed, defineStore } from './reactive.js';
import type { ProjectInfo } from './state.js';

/** Internal state shape. `projects` marked `readonly` so the kerf
 *  `set()` contract (always replace, never mutate) is enforced at the
 *  type level — accidentally pushing into `state.value.projects` is a
 *  TS error.
 *
 *  HS-8317 — `activeProject` is stored as a sibling field of
 *  `projects`, NOT derived from a `(projects, activeSecret)` lookup.
 *  This matches the pre-migration shape (a raw `let` of type
 *  `ProjectInfo | null` in `state.tsx`, independent of any projects
 *  list) so callers can `setActiveProject(p)` before / without ever
 *  calling `setProjects(list)` and `getActiveProject()` keeps
 *  returning `p` — preserves the HS-7360 per-project-search test
 *  contract that exercises `setActiveProject` without a list. The
 *  two fields are kept loosely consistent by `setActive`'s "ensure
 *  the project is in the list, append if not" guard so a test that
 *  only calls setActive sees a coherent list afterward too. */
export interface ProjectsStoreState {
  projects: readonly ProjectInfo[];
  activeProject: ProjectInfo | null;
}

export const projectsStore = defineStore({
  initial: (): ProjectsStoreState => ({
    projects: [],
    activeProject: null,
  }),
  actions: (set, get) => ({
    /** Replace the entire project list. Used by `initProjectTabs` /
     *  `refreshProjectTabs` after each `/projects` fetch resolves.
     *  Keeps `activeProject` consistent: if the active project is
     *  no longer in the new list, clear it; if a same-secret entry
     *  exists in the new list, swap to that fresher reference (so
     *  e.g. a renamed project's name update flows through). */
    setProjects: (projects: readonly ProjectInfo[]) => {
      const current = get();
      let nextActive = current.activeProject;
      if (current.activeProject !== null) {
        const fresh = projects.find(p => p.secret === current.activeProject!.secret);
        nextActive = fresh ?? null;
      }
      set({ projects, activeProject: nextActive });
    },
    /** Set / clear the active project. `null` clears (no active
     *  project — boot state before the first fetch). Side effect:
     *  ensures the project is in the projects list (appended if
     *  missing) so a `setActive(p)` followed by a `projects` read
     *  always sees `p`. */
    setActive: (project: ProjectInfo | null) => {
      const current = get();
      let nextProjects = current.projects;
      if (project !== null && !current.projects.some(p => p.secret === project.secret)) {
        nextProjects = [...current.projects, project];
      }
      set({ projects: nextProjects, activeProject: project });
    },
    /** Reorder the project list to match the given secret order.
     *  Secrets not in the new order get dropped; secrets in the new
     *  order that aren't in the current list get skipped (defensive).
     *  Used by `projectTabs.tsx::handleDrop` after the user drag-and-
     *  drops a tab. */
    reorderProjects: (orderedSecrets: readonly string[]) => {
      const current = get();
      const byId = new Map(current.projects.map(p => [p.secret, p]));
      const next: ProjectInfo[] = [];
      for (const s of orderedSecrets) {
        const p = byId.get(s);
        if (p !== undefined) next.push(p);
      }
      set({ ...current, projects: next });
    },
  }),
});

/** Derived signal — the active project. Trivially reads
 *  `state.value.activeProject` so consumers (`getActiveProject()` +
 *  any future direct subscribers) get a `ReadonlySignal` to bind
 *  against without exposing the full store shape. */
export const activeProjectSignal: ReadonlySignal<ProjectInfo | null> = computed(() => {
  return projectsStore.state.value.activeProject;
});

/** Derived signal — `Record<secret, ProjectInfo>` lookup for the
 *  current project list. Recomputes only when `projects` itself
 *  changes (kerf's `computed()` tracks the parent state field
 *  reference, not the underlying contents — assignments via
 *  `setProjects([...])` produce a fresh array so this signal
 *  recomputes). Consumers that need O(1) by-secret lookup over the
 *  current list (e.g. linkifying ticket references across project
 *  surfaces) read from here instead of building their own Map. */
export const projectsByIdSignal: ReadonlySignal<Readonly<Record<string, ProjectInfo>>> = computed(() => {
  const out: Record<string, ProjectInfo> = {};
  for (const p of projectsStore.state.value.projects) {
    out[p.secret] = p;
  }
  return out;
});

/** **TEST ONLY.** Direct handle on the underlying store for unit
 *  tests to call `.reset()` between cases. Production code goes
 *  through the named exports above. */
export const _projectsStoreForTesting = projectsStore;
