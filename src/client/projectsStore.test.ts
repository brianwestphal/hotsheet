// @vitest-environment happy-dom
/**
 * §61 Phase 3a / HS-8317 — unit tests for the `projectsStore`. The
 * store consolidates the project list + active-project pointer that
 * pre-migration lived as a raw `let activeProject` in `state.tsx`
 * plus the `projectListSignal` + `activeSecretSignal` HS-8235 signals
 * in `projectTabs.tsx`. These tests pin the action contract +
 * derived-signal behaviour in isolation; integration with
 * `getActiveProject()` / `setActiveProject()` is covered by
 * `state.test.ts`, and integration with the bindList tab strip is
 * covered by `projectTabs.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _projectsStoreForTesting,
  activeProjectSignal,
  projectsByIdSignal,
  projectsStore,
} from './projectsStore.js';
import type { ProjectInfo } from './state.js';

beforeEach(() => {
  _projectsStoreForTesting.reset();
});

afterEach(() => {
  _projectsStoreForTesting.reset();
});

const projA: ProjectInfo = { name: 'Alpha', dataDir: '/tmp/a', secret: 'sec-a' };
const projB: ProjectInfo = { name: 'Beta', dataDir: '/tmp/b', secret: 'sec-b' };
const projC: ProjectInfo = { name: 'Gamma', dataDir: '/tmp/c', secret: 'sec-c' };

describe('projectsStore — initial state', () => {
  it('starts with an empty projects list and no active project', () => {
    expect(projectsStore.state.value.projects).toEqual([]);
    expect(projectsStore.state.value.activeProject).toBeNull();
  });

  it('reset() returns to initial after mutations', () => {
    projectsStore.actions.setProjects([projA, projB]);
    projectsStore.actions.setActive(projA);
    _projectsStoreForTesting.reset();
    expect(projectsStore.state.value.projects).toEqual([]);
    expect(projectsStore.state.value.activeProject).toBeNull();
  });
});

describe('projectsStore — setProjects', () => {
  it('replaces the entire projects list', () => {
    projectsStore.actions.setProjects([projA]);
    expect(projectsStore.state.value.projects).toEqual([projA]);
    projectsStore.actions.setProjects([projB, projC]);
    expect(projectsStore.state.value.projects).toEqual([projB, projC]);
  });

  it('clears activeProject if the active secret is no longer in the new list', () => {
    projectsStore.actions.setActive(projA);
    expect(projectsStore.state.value.activeProject).toBe(projA);
    projectsStore.actions.setProjects([projB, projC]);
    expect(projectsStore.state.value.activeProject).toBeNull();
  });

  it('swaps activeProject to the fresher reference when same-secret entry exists in the new list', () => {
    projectsStore.actions.setActive(projA);
    const renamedA: ProjectInfo = { ...projA, name: 'Alpha-renamed' };
    projectsStore.actions.setProjects([renamedA, projB]);
    expect(projectsStore.state.value.activeProject).toBe(renamedA);
    expect(projectsStore.state.value.activeProject?.name).toBe('Alpha-renamed');
  });
});

describe('projectsStore — setActive', () => {
  it('sets the active project', () => {
    projectsStore.actions.setProjects([projA, projB]);
    projectsStore.actions.setActive(projB);
    expect(projectsStore.state.value.activeProject).toBe(projB);
  });

  it('clears the active project on setActive(null)', () => {
    projectsStore.actions.setProjects([projA]);
    projectsStore.actions.setActive(projA);
    projectsStore.actions.setActive(null);
    expect(projectsStore.state.value.activeProject).toBeNull();
  });

  it('appends the project to the list when setting active a project not yet in the list (HS-7360 contract)', () => {
    projectsStore.actions.setActive(projA);
    expect(projectsStore.state.value.projects).toEqual([projA]);
    expect(projectsStore.state.value.activeProject).toBe(projA);
  });

  it('does NOT duplicate an already-listed project when setting it active', () => {
    projectsStore.actions.setProjects([projA, projB]);
    projectsStore.actions.setActive(projA);
    expect(projectsStore.state.value.projects).toEqual([projA, projB]);
  });
});

describe('projectsStore — reorderProjects', () => {
  it('reorders the projects to match the given secret order', () => {
    projectsStore.actions.setProjects([projA, projB, projC]);
    projectsStore.actions.reorderProjects(['sec-c', 'sec-a', 'sec-b']);
    expect(projectsStore.state.value.projects.map(p => p.secret)).toEqual(['sec-c', 'sec-a', 'sec-b']);
  });

  it('drops projects whose secret is missing from the new order', () => {
    projectsStore.actions.setProjects([projA, projB, projC]);
    projectsStore.actions.reorderProjects(['sec-a', 'sec-c']);
    expect(projectsStore.state.value.projects.map(p => p.secret)).toEqual(['sec-a', 'sec-c']);
  });

  it('skips secrets in the order that are not in the current list (defensive)', () => {
    projectsStore.actions.setProjects([projA, projB]);
    projectsStore.actions.reorderProjects(['sec-a', 'sec-missing', 'sec-b']);
    expect(projectsStore.state.value.projects.map(p => p.secret)).toEqual(['sec-a', 'sec-b']);
  });
});

describe('activeProjectSignal — derived', () => {
  it('mirrors state.value.activeProject', () => {
    expect(activeProjectSignal.value).toBeNull();
    projectsStore.actions.setActive(projA);
    expect(activeProjectSignal.value).toBe(projA);
    projectsStore.actions.setActive(null);
    expect(activeProjectSignal.value).toBeNull();
  });
});

describe('projectsByIdSignal — derived', () => {
  it('builds a Record<secret, ProjectInfo> from the current projects', () => {
    projectsStore.actions.setProjects([projA, projB]);
    expect(projectsByIdSignal.value).toEqual({ 'sec-a': projA, 'sec-b': projB });
  });

  it('recomputes when the projects list changes', () => {
    projectsStore.actions.setProjects([projA]);
    expect(Object.keys(projectsByIdSignal.value)).toEqual(['sec-a']);
    projectsStore.actions.setProjects([projB, projC]);
    expect(Object.keys(projectsByIdSignal.value).sort()).toEqual(['sec-b', 'sec-c']);
  });
});
