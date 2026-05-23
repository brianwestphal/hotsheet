// @vitest-environment happy-dom
/**
 * HS-8524 — pin the full-window-mode behavior of the cross-project
 * stats page. Pre-HS-8524 the page rendered into `#ticket-list` /
 * `#dashboard-container`, which made it read as a subview riding
 * inside the active project's content area; the terminal-dashboard
 * button couldn't switch to it, the ticket-view toolbar bled
 * through, and there was no clean "previous surface" to restore on
 * toggle-off when the user had opened the page from the terminal
 * dashboard.
 *
 * Post-fix the page renders into a dedicated
 * `#cross-project-stats-root` element controlled by the
 * `body.cross-project-stats-active` body class — exactly the takeover pattern the terminal dashboard
 * uses. These tests assert the body-class state machine + the
 * teardown helper that other surfaces (terminal-dashboard enter,
 * dashboard-mode enter, project-tab click) call when they take over
 * from cross-project stats.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { teardownCrossProjectStatsPage } from './crossProjectStatsPage.js';
import {
  _resetMainSurfaceStateForTesting,
  isCrossProjectStatsPageActive,
  markCrossProjectStatsActive,
} from './mainSurfaceState.js';

function mountCrossProjectRoot(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'cross-project-stats-root';
  root.style.display = 'none';
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  _resetMainSurfaceStateForTesting();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  _resetMainSurfaceStateForTesting();
});

describe('teardownCrossProjectStatsPage — full-window takeover handoff (HS-8524)', () => {
  it('is a no-op when the cross-project page is not active', () => {
    const root = mountCrossProjectRoot();
    teardownCrossProjectStatsPage();
    expect(isCrossProjectStatsPageActive()).toBe(false);
    expect(document.body.classList.contains('cross-project-stats-active')).toBe(false);
    expect(root.style.display).toBe('none');
  });

  it('clears the active flag + body class + root visibility when active', () => {
    const root = mountCrossProjectRoot();
    // Simulate the post-show state: flag set, body class set, root
    // visible with some content.
    markCrossProjectStatsActive(true);
    document.body.classList.add('cross-project-stats-active');
    root.style.display = '';
    root.innerHTML = '<div class="telemetry-dashboard-empty">test content</div>';

    teardownCrossProjectStatsPage();

    expect(isCrossProjectStatsPageActive()).toBe(false);
    expect(document.body.classList.contains('cross-project-stats-active')).toBe(false);
    expect(root.style.display).toBe('none');
    expect(root.innerHTML).toBe('');
  });

  it('survives a missing root element (idempotent for tests + edge cases)', () => {
    markCrossProjectStatsActive(true);
    document.body.classList.add('cross-project-stats-active');
    // No root mounted.
    expect(() => teardownCrossProjectStatsPage()).not.toThrow();
    expect(isCrossProjectStatsPageActive()).toBe(false);
    expect(document.body.classList.contains('cross-project-stats-active')).toBe(false);
  });

  it('only fires the teardown when active — repeat calls are no-ops', () => {
    const root = mountCrossProjectRoot();
    markCrossProjectStatsActive(true);
    document.body.classList.add('cross-project-stats-active');

    teardownCrossProjectStatsPage();
    expect(isCrossProjectStatsPageActive()).toBe(false);

    // Re-add some unrelated body class to verify the second teardown
    // doesn't strip it.
    document.body.classList.add('terminal-dashboard-active');
    teardownCrossProjectStatsPage();
    expect(document.body.classList.contains('terminal-dashboard-active')).toBe(true);
    expect(root.style.display).toBe('none');
  });

  // HS-8564 — pin the documented contract: teardown clears `#cross-project-
  // stats-root` and the body class but does NOT touch / repopulate `#ticket-
  // list`. Callers that want a populated ticket area MUST call `loadTickets()`
  // (or trigger the project-switch reload path) themselves. The pre-fix bug
  // was the project-tab row-click handler in `src/client/projectTabs.tsx`
  // assuming `switchProject(p)` would always run the reload pipeline, but
  // `switchProject` early-returns on a matching secret, so a same-project tab
  // click while on cross-project stats torn down the page WITHOUT repopulating
  // `#ticket-list` — the user saw an empty project area until they switched
  // views. The fix calls `loadTickets()` directly in that branch; this test
  // pins the underlying invariant so the fix can't silently regress if
  // teardown is later refactored to repopulate the ticket list itself.
  it('does NOT touch the #ticket-list contents — caller is responsible for repopulating (HS-8564)', () => {
    const root = mountCrossProjectRoot();
    markCrossProjectStatsActive(true);
    document.body.classList.add('cross-project-stats-active');

    // Mount an empty ticket-list element. The pre-show flow's
    // `unmountBindList()` would have left it in exactly this state
    // (no children, but the element exists in the DOM).
    const tl = document.createElement('div');
    tl.id = 'ticket-list';
    document.body.appendChild(tl);
    expect(tl.children.length).toBe(0);

    teardownCrossProjectStatsPage();

    // Teardown should NOT have populated `#ticket-list` — that's the
    // caller's responsibility.
    expect(tl.children.length).toBe(0);
    // And the cross-project root should be hidden + cleared as before.
    expect(root.style.display).toBe('none');
    expect(root.innerHTML).toBe('');
  });
});
