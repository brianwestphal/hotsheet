// @vitest-environment happy-dom
/**
 * §60 / HS-8235 — integration test for the trial migration of project
 * tabs to `bindList`. Exercises:
 *
 * 1. Initial multi-tab render mounts the strip via `bindList`.
 * 2. Adding / removing / reordering projects reconciles via the keyed
 *    list helper — DOM identity preserved for surviving rows.
 * 3. Active-secret signal flips the `.active` class on existing rows
 *    without re-mounting them.
 * 4. Single ↔ multi transition tears down the bindList cleanly + paints
 *    the h1 header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _hasProjectFeedbackForTests,
  _renderTabsForTesting,
  _resetProjectTabsForTesting,
  _setProjectsForTesting,
  refreshProjectFeedbackState,
  setProjectFeedback,
  updateStatusDots,
} from './projectTabs.js';
import type { ProjectInfo } from './state.js';

function makeTitleArea(): HTMLDivElement {
  const div = document.createElement('div');
  div.id = 'app-title-area';
  document.body.appendChild(div);
  return div;
}

function tabs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.project-tab'));
}

function tabSecrets(): string[] {
  return tabs().map((t) => t.dataset.secret ?? '');
}

function activeTabSecret(): string | null {
  return document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? null;
}

const A: ProjectInfo = { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' };
const B: ProjectInfo = { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' };
const C: ProjectInfo = { name: 'C', dataDir: '/tmp/c', secret: 'sec-c' };

beforeEach(() => {
  document.body.innerHTML = '';
  _resetProjectTabsForTesting();
});

afterEach(() => {
  _resetProjectTabsForTesting();
  document.body.innerHTML = '';
});

describe('projectTabs trial migration (HS-8235)', () => {
  it('initial multi-tab render mounts every project + flips the active class on the right one', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], B.secret);
    _renderTabsForTesting();

    expect(tabSecrets()).toEqual(['sec-a', 'sec-b', 'sec-c']);
    expect(activeTabSecret()).toBe('sec-b');
  });

  it('adding a project after initial render reconciles in place — surviving rows keep DOM identity', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B], A.secret);
    _renderTabsForTesting();
    const rowA = document.querySelector<HTMLElement>('[data-secret="sec-a"]')!;
    const rowB = document.querySelector<HTMLElement>('[data-secret="sec-b"]')!;

    _setProjectsForTesting([A, B, C], A.secret);
    // No second renderTabs() call — bindList drives the rebuild
    // automatically off the signal write.

    expect(tabSecrets()).toEqual(['sec-a', 'sec-b', 'sec-c']);
    expect(document.querySelector('[data-secret="sec-a"]')).toBe(rowA);
    expect(document.querySelector('[data-secret="sec-b"]')).toBe(rowB);
  });

  it('removing a project tears down its row + leaves the others intact', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    const rowA = document.querySelector<HTMLElement>('[data-secret="sec-a"]')!;
    const rowC = document.querySelector<HTMLElement>('[data-secret="sec-c"]')!;

    _setProjectsForTesting([A, C], A.secret);

    expect(tabSecrets()).toEqual(['sec-a', 'sec-c']);
    expect(document.querySelector('[data-secret="sec-b"]')).toBeNull();
    expect(document.querySelector('[data-secret="sec-a"]')).toBe(rowA);
    expect(document.querySelector('[data-secret="sec-c"]')).toBe(rowC);
  });

  it('reorder preserves DOM identity for moved rows + arrives at the right strip order', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    const rowA = document.querySelector<HTMLElement>('[data-secret="sec-a"]')!;
    const rowB = document.querySelector<HTMLElement>('[data-secret="sec-b"]')!;
    const rowC = document.querySelector<HTMLElement>('[data-secret="sec-c"]')!;

    _setProjectsForTesting([C, A, B], A.secret);

    expect(tabSecrets()).toEqual(['sec-c', 'sec-a', 'sec-b']);
    expect(tabs()[0]).toBe(rowC);
    expect(tabs()[1]).toBe(rowA);
    expect(tabs()[2]).toBe(rowB);
  });

  it('active-secret signal flips the .active class without re-mounting any row', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    const rowA = document.querySelector<HTMLElement>('[data-secret="sec-a"]')!;
    const rowB = document.querySelector<HTMLElement>('[data-secret="sec-b"]')!;
    expect(activeTabSecret()).toBe('sec-a');

    _setProjectsForTesting([A, B, C], B.secret);

    expect(activeTabSecret()).toBe('sec-b');
    // Identity preserved on both — proves the per-row effect did the
    // class flip rather than the bindList tearing down + re-mounting.
    expect(document.querySelector('[data-secret="sec-a"]')).toBe(rowA);
    expect(document.querySelector('[data-secret="sec-b"]')).toBe(rowB);
    expect(rowA.classList.contains('active')).toBe(false);
    expect(rowB.classList.contains('active')).toBe(true);
  });

  it('multi → single transition tears down the bindList + paints the h1', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B], A.secret);
    _renderTabsForTesting();
    expect(document.querySelector('.project-tabs-inner')).not.toBeNull();

    _setProjectsForTesting([A], A.secret);
    _renderTabsForTesting();

    expect(document.querySelector('.project-tabs-inner')).toBeNull();
    const h1 = document.querySelector<HTMLElement>('#app-title-area h1');
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe('A');
  });

  it('single → multi transition wires the bindList + mounts every project', () => {
    makeTitleArea();
    _setProjectsForTesting([A], A.secret);
    _renderTabsForTesting();
    expect(document.querySelector('#app-title-area h1')).not.toBeNull();

    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();

    expect(document.querySelector('#app-title-area h1')).toBeNull();
    expect(tabSecrets()).toEqual(['sec-a', 'sec-b', 'sec-c']);
    expect(activeTabSecret()).toBe('sec-a');
  });
});

describe('refreshProjectFeedbackState (HS-8378)', () => {
  // Fetch-stub helper. `api()` in `src/client/api.tsx` calls `fetch(url,
  // { ... })` and reads `res.json()`; we only need a `.ok` + `.json()`
  // surface for the GET /projects/feedback-state call to succeed.
  function stubFetchWithFeedback(map: Record<string, boolean>): void {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ projects: map }),
    } as unknown as Response)));
  }

  beforeEach(() => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('populates `feedbackSecrets` from the server response (bulk replace)', async () => {
    stubFetchWithFeedback({ 'sec-a': false, 'sec-b': true, 'sec-c': false });
    await refreshProjectFeedbackState();
    expect(_hasProjectFeedbackForTests('sec-a')).toBe(false);
    expect(_hasProjectFeedbackForTests('sec-b')).toBe(true);
    expect(_hasProjectFeedbackForTests('sec-c')).toBe(false);
  });

  it('paints `.project-tab-dot.feedback` on every project the server reports as having feedback', async () => {
    stubFetchWithFeedback({ 'sec-a': false, 'sec-b': true, 'sec-c': true });
    await refreshProjectFeedbackState();
    // Tab A has no feedback dot
    const dotA = document.querySelector<HTMLElement>('[data-secret="sec-a"] .project-tab-dot');
    expect(dotA?.className).toBe('project-tab-dot');
    // Tabs B + C do
    const dotB = document.querySelector<HTMLElement>('[data-secret="sec-b"] .project-tab-dot');
    const dotC = document.querySelector<HTMLElement>('[data-secret="sec-c"] .project-tab-dot');
    expect(dotB?.className).toBe('project-tab-dot feedback');
    expect(dotC?.className).toBe('project-tab-dot feedback');
  });

  it('clears stale feedback membership when a project drops to false (cross-project resolution)', async () => {
    // First fetch: B has feedback.
    stubFetchWithFeedback({ 'sec-a': false, 'sec-b': true, 'sec-c': false });
    await refreshProjectFeedbackState();
    expect(_hasProjectFeedbackForTests('sec-b')).toBe(true);

    // Second fetch: B's feedback resolved.
    stubFetchWithFeedback({ 'sec-a': false, 'sec-b': false, 'sec-c': false });
    await refreshProjectFeedbackState();
    expect(_hasProjectFeedbackForTests('sec-b')).toBe(false);
    const dotB = document.querySelector<HTMLElement>('[data-secret="sec-b"] .project-tab-dot');
    expect(dotB?.className).toBe('project-tab-dot');
  });

  it('leaves the previous snapshot in place on a network error (no `feedbackSecrets` clobber)', async () => {
    stubFetchWithFeedback({ 'sec-a': false, 'sec-b': true, 'sec-c': false });
    await refreshProjectFeedbackState();
    expect(_hasProjectFeedbackForTests('sec-b')).toBe(true);

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    await refreshProjectFeedbackState();
    // B stays in the set — a transient network blip shouldn't make the
    // dot flicker off and back on at the next successful poll.
    expect(_hasProjectFeedbackForTests('sec-b')).toBe(true);
  });

  it('coexists with the inline active-project `setProjectFeedback` path (both write into the same set)', () => {
    // Inline write (still used by `feedbackDialog.checkFeedbackState()` for
    // the active project) — verify it surfaces the dot without requiring
    // a poll round-trip.
    setProjectFeedback('sec-a', true);
    expect(_hasProjectFeedbackForTests('sec-a')).toBe(true);
    const dotA = document.querySelector<HTMLElement>('[data-secret="sec-a"] .project-tab-dot');
    expect(dotA?.className).toBe('project-tab-dot feedback');
    setProjectFeedback('sec-a', false);
    expect(_hasProjectFeedbackForTests('sec-a')).toBe(false);
  });

  it('updateStatusDots is safe to call when no tabs are mounted (multi → single transition)', () => {
    document.body.innerHTML = '';
    expect(() => { updateStatusDots(); }).not.toThrow();
  });
});
