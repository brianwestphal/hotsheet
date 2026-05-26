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
  _getDropInsertIdxForTesting,
  _hasProjectFeedbackForTests,
  _renderTabsForTesting,
  _resetProjectTabsForTesting,
  _setDragSecretForTesting,
  _setPendingReorderSecretsForTesting,
  _setProjectsForTesting,
  refreshProjectFeedbackState,
  refreshProjectTabs,
  setProjectFeedback,
  updateStatusDots,
} from './projectTabs.js';
import type { ProjectInfo } from './state.js';
import { resetApiTransport, wireRealApiTransport } from './test-helpers/realApiTransport.js';

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
  // HS-8634/HS-8635 — projectTabs now calls typed `../api/index.js` callers
  // (getProjectsFeedbackState / reorderProjects), which route through the
  // injected transport. Wire it to the real `api` so the fetch-stub tests
  // below still exercise the real `api()` → `fetch` URL path.
  wireRealApiTransport();
  _resetProjectTabsForTesting();
});

afterEach(() => {
  resetApiTransport();
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

describe('project-tab non-selectable text (HS-8413)', () => {
  // The bug class — Tauri's WKWebView ignores unprefixed `user-select`
  // on older Safari/WKWebView versions, so a `.project-tab` rule with
  // only `user-select: none` lets the user drag-select tab text across
  // the header. Always pair with `-webkit-user-select: none`. happy-dom
  // doesn't load the SCSS, so this is a static-text tripwire on the
  // compiled rule block — if a future refactor drops the prefix the
  // assertion catches it before the user does.
  it('styles.scss `.project-tab` rule carries both `-webkit-user-select` and `user-select`', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    // happy-dom mangles `import.meta.url` to a non-`file:` scheme, so
    // resolve from `process.cwd()` (vitest runs from the project root).
    const scssPath = path.join(process.cwd(), 'src/client/styles.scss');
    const source = await readFile(scssPath, 'utf8');
    // Pull just the `.project-tab` rule body (NOT `.project-tab-name`
    // or `.project-tab-dot`); the regex anchors on the bare class
    // followed by a `{`, then captures until the matching `}` at the
    // same nesting level. SCSS nests selectors inside but those
    // children sit between balanced inner braces, so a non-greedy
    // capture up to a `^}` on its own line gets the right block.
    const match = source.match(/^\.project-tab\s*\{[\s\S]*?^\}/m);
    expect(match, 'failed to find .project-tab rule in styles.scss').not.toBeNull();
    const body = match![0];
    expect(body).toContain('-webkit-user-select: none');
    expect(body).toContain('user-select: none');
  });
});

describe('project-tab draggable attribute (HS-8431)', () => {
  // Pre-fix the multi-tab path rendered `<div draggable={true}>`, which
  // the custom JSX runtime serialized as a bare `draggable` attribute.
  // HTML treats a value-less `draggable` as the "auto" enumerated state,
  // which means a `<div>` is NOT draggable — only `draggable="true"` (or
  // `el.draggable = true` set as an IDL property) flips the element into
  // the "true" state. The regression silently broke project-tab
  // reordering after HS-8235 because none of the existing tests probed
  // the attribute shape itself.
  it('every rendered tab carries draggable="true" so native drag events fire', () => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();

    const rows = tabs();
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.getAttribute('draggable')).toBe('true');
    }
  });
});

describe('single drop spot per gap (HS-8432)', () => {
  // Pre-fix the tab strip had TWO drop spots for every position: the
  // "after tab N" path (handleDragOver on tab N, cursor in right half)
  // positioned the indicator at `tabN.right + 1`; the "before tab N+1"
  // path (handleDragOver on tab N+1, cursor in left half) positioned it
  // at `tabN+1.left - 1`. With a 4 px CSS gap between tabs those two
  // positions differ by ~2 px, so the indicator visibly jitters as the
  // cursor traverses the gap even though both cursor regions represent
  // the same insertion position.
  //
  // The fix collapses the model to a single insertion-index per gap.
  // Both regions now compute identical `dropInsertIdx` AND identical
  // indicator X-coordinates. This describe block locks in both halves
  // of that contract.
  //
  // happy-dom returns zero-sized client rects out of the box, so each
  // test stubs `getBoundingClientRect` on the rendered tabs (and their
  // container) to deterministic geometry — that's the only way to make
  // the gap-center math observable in a unit test.
  const TAB_W = 50;
  const GAP = 4;
  /** Stub `getBoundingClientRect` on each tab so positions are
   *  deterministic. Tab i occupies x = [i*(TAB_W+GAP), i*(TAB_W+GAP)+TAB_W). */
  function stubTabGeometry(): void {
    const inner = document.querySelector<HTMLElement>('.project-tabs-inner');
    if (inner === null) throw new Error('tab strip not mounted');
    Object.defineProperty(inner, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 30, width: 1000, height: 30, x: 0, y: 0, toJSON: () => ({}) } as DOMRect),
    });
    Object.defineProperty(inner, 'scrollLeft', { configurable: true, value: 0 });
    const rows = tabs();
    rows.forEach((row, i) => {
      const left = i * (TAB_W + GAP);
      const right = left + TAB_W;
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left, top: 0, right, bottom: 30, width: TAB_W, height: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect),
      });
    });
  }

  function dispatchDragOver(targetTab: HTMLElement, clientX: number): void {
    // happy-dom's DragEvent constructor ignores `dataTransfer` AND
    // `clientX` from the init dict (verified: a listener sees them as
    // undefined). Patch both onto the event after construction so the
    // production handler sees the values the test cares about.
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { configurable: true, value: { dropEffect: 'none', effectAllowed: 'all' } });
    Object.defineProperty(ev, 'clientX', { configurable: true, value: clientX });
    Object.defineProperty(ev, 'clientY', { configurable: true, value: 15 });
    targetTab.dispatchEvent(ev);
  }

  it('"right half of tab N" and "left half of tab N+1" produce the SAME insertion index', () => {
    // The core invariant. Pre-fix these produced `{secret: N, side: 'after'}`
    // vs `{secret: N+1, side: 'before'}` — two distinct drop targets in the
    // model. Post-fix both collapse to insertIdx = N+1, a single gap.
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    stubTabGeometry();
    _setDragSecretForTesting(A.secret);

    const rows = tabs();
    // Right half of tab B (index 1) — tab spans 54..104, right half is 79..104.
    dispatchDragOver(rows[1], 95);
    const idxAfterB = _getDropInsertIdxForTesting();
    expect(idxAfterB).toBe(2);

    // Left half of tab C (index 2) — tab spans 108..158, left half is 108..133.
    dispatchDragOver(rows[2], 115);
    const idxBeforeC = _getDropInsertIdxForTesting();
    expect(idxBeforeC).toBe(2);

    expect(idxAfterB).toBe(idxBeforeC);
  });

  it('drop indicator sits at the same X for both sides of the same gap', () => {
    // Pre-fix the indicator X for "after B" was 105 (B.right + 1) and for
    // "before C" was 107 (C.left - 1) — a visible 2 px jiggle as the
    // cursor crossed the gap. Post-fix both center the indicator in the
    // gap (B.right=104, C.left=108, center=106, indicator.left=105 for a
    // 2 px-wide bar) so the indicator stays put.
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    stubTabGeometry();
    _setDragSecretForTesting(A.secret);

    const rows = tabs();
    dispatchDragOver(rows[1], 95); // right half of B
    const leftAfterB = document.querySelector<HTMLElement>('.tab-drop-indicator')?.style.left;
    dispatchDragOver(rows[2], 115); // left half of C
    const leftBeforeC = document.querySelector<HTMLElement>('.tab-drop-indicator')?.style.left;

    expect(leftAfterB).toBeDefined();
    expect(leftAfterB).toBe(leftBeforeC);
    // Verify the gap-center math: B.right + (C.left - B.right)/2 = 106,
    // minus half the 2 px indicator width = 105.
    expect(leftAfterB).toBe('105px');
  });

  it('first gap (insertIdx 0) and last gap (insertIdx N) sit outside the tab strip', () => {
    // Edge case — the inner gaps use the average of two adjacent edges;
    // the outermost gaps don't have a "previous" or "next" tab so they
    // need their own positioning. Positions chosen: 2 px outside the
    // first / last tab, then -halfWidth so the bar straddles that line.
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    stubTabGeometry();
    _setDragSecretForTesting(C.secret);

    const rows = tabs();
    // Left half of tab A — insertIdx should be 0 (insert before everything).
    dispatchDragOver(rows[0], 10);
    expect(_getDropInsertIdxForTesting()).toBe(0);
    const leftEdge = document.querySelector<HTMLElement>('.tab-drop-indicator')?.style.left;
    // A.left = 0, target center = -2, minus halfWidth (1) = -3.
    expect(leftEdge).toBe('-3px');

    // Right half of tab B — with C as the dragged tab, this should be
    // insertIdx 2 (between B and C in the visible strip). C is still
    // visible in the strip even though it's dragged.
    dispatchDragOver(rows[1], 95);
    expect(_getDropInsertIdxForTesting()).toBe(2);
  });

  it('hovering over the dragged tab itself clears the insertion index (no indicator)', () => {
    // The dragged tab is rendered with `.dragging` opacity; it would be
    // confusing to also show a drop indicator on top of it. Cursor
    // hovering the dragged tab → insertIdx clears → indicator hides.
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    stubTabGeometry();
    _setDragSecretForTesting(B.secret);

    const rows = tabs();
    // First land somewhere valid so the indicator is mounted + visible.
    dispatchDragOver(rows[0], 10);
    expect(_getDropInsertIdxForTesting()).toBe(0);
    expect(document.querySelector<HTMLElement>('.tab-drop-indicator')?.style.display).not.toBe('none');

    // Now hover the dragged tab itself — both halves should yield null.
    dispatchDragOver(rows[1], 60); // left half of B
    expect(_getDropInsertIdxForTesting()).toBeNull();
    expect(document.querySelector<HTMLElement>('.tab-drop-indicator')?.style.display).toBe('none');

    dispatchDragOver(rows[1], 95); // right half of B
    expect(_getDropInsertIdxForTesting()).toBeNull();
  });

  it('handleDrop is a no-op when the gap touches the dragged tab', () => {
    // Insertion indices `sourceIdx` (gap immediately before the dragged
    // tab) and `sourceIdx + 1` (gap immediately after) both leave the
    // array order unchanged — pre-fix the code computed the same array
    // and POSTed a redundant /api/projects/reorder. Post-fix `handleDrop`
    // recognizes both as no-ops and skips the store action + the POST.
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    stubTabGeometry();
    _setDragSecretForTesting(B.secret);

    const fetchSpy = vi.fn(() => Promise.resolve({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve({}),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);

    const rows = tabs();
    // Left half of tab B → insertIdx = 1, which equals sourceIdx (B is at
    // index 1) — i.e. "drop B at its current position".
    dispatchDragOver(rows[1], 60);
    // (Confirmed null by the previous test — but we still need an
    // insertIdx that lands on a sourceIdx / sourceIdx+1 case for the
    // no-op check, so dispatch a dragover on the NEIGHBOR's correct half.)
    dispatchDragOver(rows[0], 30); // right half of A → insertIdx = 1 = sourceIdx
    expect(_getDropInsertIdxForTesting()).toBe(1);

    const drop = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { configurable: true, value: { dropEffect: 'none', effectAllowed: 'all' } });
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 30 });
    Object.defineProperty(drop, 'clientY', { configurable: true, value: 15 });
    rows[0].dispatchEvent(drop);

    // No reorder POST should have fired — the array order doesn't change.
    const reorderCalls = (fetchSpy.mock.calls as unknown as unknown[][]).filter((call) => {
      const url = call[0];
      return typeof url === 'string' && url.includes('/projects/reorder');
    });
    expect(reorderCalls.length).toBe(0);
    expect(tabSecrets()).toEqual(['sec-a', 'sec-b', 'sec-c']);

    vi.unstubAllGlobals();
  });
});

describe('pendingReorderSecrets race guard (HS-8431)', () => {
  // The bug class: a poll-driven `refreshProjectTabs` runs while the
  // user's drag-reorder POST is still in flight. The GET response
  // carries the pre-reorder order; without a guard, the resulting
  // `setProjects` overwrites the optimistic local order and the
  // dragged tab visibly snaps back to its original position. This
  // describe block exercises `refreshProjectTabs` directly with a
  // stubbed `/api/projects` GET so the race can be reproduced
  // deterministically without spinning up the long-poll loop.
  function stubProjectsFetch(list: { name: string; dataDir: string; secret: string }[]): void {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      // The server's `GET /projects` always includes `ticketCount`, which
      // `ProjectListItemSchema` (validated by the typed `listProjects`) requires.
      json: () => Promise.resolve(list.map(p => ({ ...p, ticketCount: 0 }))),
    } as unknown as Response)));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('honors the pending reorder — a refresh during a pending reorder reorders the server response, not the local store', async () => {
    makeTitleArea();
    _setProjectsForTesting([A, B, C], A.secret);
    _renderTabsForTesting();
    expect(tabSecrets()).toEqual(['sec-a', 'sec-b', 'sec-c']);

    // Simulate a drop that requested [B, C, A] but whose POST hasn't
    // landed yet. The pending flag is what `handleDrop` sets right
    // alongside its `reorderProjects` action call.
    _setProjectsForTesting([B, C, A], A.secret);
    _setPendingReorderSecretsForTesting(['sec-b', 'sec-c', 'sec-a']);

    // GET /api/projects races ahead with the STALE pre-drop order.
    // Pre-fix, `refreshProjectTabs` would `setProjects([A, B, C])` here
    // and the tabs would snap back.
    stubProjectsFetch([
      { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' },
      { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' },
      { name: 'C', dataDir: '/tmp/c', secret: 'sec-c' },
    ]);
    await refreshProjectTabs();

    // With the fix: the pending-reorder guard re-projects the server's
    // response through `['sec-b', 'sec-c', 'sec-a']` before reaching
    // `setProjects`, so the tab strip stays in the post-drop order.
    expect(tabSecrets()).toEqual(['sec-b', 'sec-c', 'sec-a']);
  });

  it('reverts to the server order once the pending flag clears', async () => {
    // Companion to the previous test — proves the guard is short-
    // lived. After the user's POST resolves and `pendingReorderSecrets`
    // is cleared, the very next `refreshProjectTabs` MUST pass the
    // server's response through verbatim, so a project added /
    // removed / renamed on disk between the drop and the next poll
    // surfaces correctly.
    makeTitleArea();
    _setProjectsForTesting([B, C, A], A.secret);
    _renderTabsForTesting();
    _setPendingReorderSecretsForTesting(null);

    // The server's response carries the same secrets in a different
    // order — e.g. another client / project-list edit happened.
    stubProjectsFetch([
      { name: 'C', dataDir: '/tmp/c', secret: 'sec-c' },
      { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' },
      { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' },
    ]);
    await refreshProjectTabs();

    expect(tabSecrets()).toEqual(['sec-c', 'sec-a', 'sec-b']);
  });

  it('clears the pending flag when a refresh sees the server first-N entries match (HS-8431 race fix)', async () => {
    // The fix the user actually hit: when the POST resolves FAST, a
    // GET that was issued mid-POST may still be in flight. Its
    // response carries the pre-reorder order and arrives AFTER the
    // POST finished. Pre-fix the POST's `finally` cleared the pending
    // flag immediately, so the stale GET response went through
    // un-re-projected and snapped the tabs back. Post-fix the flag
    // only clears once a refreshProjectTabs's GET response itself
    // confirms the server has caught up — i.e. the server's first N
    // entries match the pending order. The unit-level surface of
    // that contract: a refresh whose server response matches the
    // pending order MUST clear the pending flag.
    makeTitleArea();
    _setProjectsForTesting([B, C, A], A.secret);
    _renderTabsForTesting();
    _setPendingReorderSecretsForTesting(['sec-b', 'sec-c', 'sec-a']);

    // Server has caught up — its GET response is now in the pending
    // order. A subsequent refresh must clear the pending flag.
    stubProjectsFetch([
      { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' },
      { name: 'C', dataDir: '/tmp/c', secret: 'sec-c' },
      { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' },
    ]);
    await refreshProjectTabs();

    // First-refresh result: the tabs are in the matching order (no
    // re-projection needed — the server's response IS the pending
    // order verbatim).
    expect(tabSecrets()).toEqual(['sec-b', 'sec-c', 'sec-a']);

    // Now an INDEPENDENT refresh arrives — e.g. another client edited
    // the project list while the user wasn't watching, server returns
    // a different order. Pre-fix-fix (i.e. if the pending flag had
    // stayed set forever), this independent edit would never surface.
    // The clear-on-match check above must have fired so this second
    // refresh passes through verbatim.
    stubProjectsFetch([
      { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' },
      { name: 'C', dataDir: '/tmp/c', secret: 'sec-c' },
      { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' },
    ]);
    await refreshProjectTabs();
    expect(tabSecrets()).toEqual(['sec-a', 'sec-c', 'sec-b']);
  });

  it('keeps projects added after the drop alongside the pending order', async () => {
    // The pending flag holds the secrets the user asked for. If the
    // server returns ADDITIONAL projects in its GET response (e.g. a
    // background plugin registered a new one), they must still appear
    // — the guard's job is to preserve the drop's intent, not to drop
    // unfamiliar entries.
    makeTitleArea();
    _setProjectsForTesting([B, C, A], A.secret);
    _renderTabsForTesting();
    _setPendingReorderSecretsForTesting(['sec-b', 'sec-c', 'sec-a']);

    const D = { name: 'D', dataDir: '/tmp/d', secret: 'sec-d' };
    stubProjectsFetch([
      { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' },
      { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' },
      { name: 'C', dataDir: '/tmp/c', secret: 'sec-c' },
      D,
    ]);
    await refreshProjectTabs();

    // The pending-order secrets come first in the requested order; the
    // unfamiliar new project gets appended.
    expect(tabSecrets()).toEqual(['sec-b', 'sec-c', 'sec-a', 'sec-d']);
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
