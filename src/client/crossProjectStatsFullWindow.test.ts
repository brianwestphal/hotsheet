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
});
