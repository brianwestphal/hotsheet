// @vitest-environment happy-dom
/**
 * HS-8527 — unit tests for `updateSidebarWidgetCost`. The widget cost
 * span replaces the per-tab cost chip that lived in `.project-tab-cost`
 * pre-HS-8527. The helper has to:
 *
 * 1. Pull cost for the *active* project's secret out of the bulk map.
 * 2. Hide when cost is zero / unknown.
 * 3. Hide entirely under subscription billing (the dollar amount is an
 *    API-equivalent estimate, not what the user pays).
 * 4. Show `<$0.01` for sub-cent values; otherwise `$N.NN`.
 * 5. Re-apply the most recently observed map after re-render via
 *    `refreshSidebarWidgetCost` so the widget repopulates immediately
 *    on project switch (no blank between re-mount + next bell tick).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _testingSidebarCost, refreshSidebarWidgetCost, updateSidebarWidgetCost } from './dashboardMode.js';
import { _setProjectsForTesting } from './projectTabs.js';
import type { ProjectInfo } from './state.js';
import { _setTelemetryCostModeForTesting } from './telemetryCostMode.js';

const A: ProjectInfo = { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' };
const B: ProjectInfo = { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' };

function mountWidget(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.id = 'sidebar-dashboard-widget';
  wrap.innerHTML = `
    <div class="sidebar-widget-wip">
      <span>3 in progress</span>
      <span class="sidebar-widget-cost" title="Claude usage today (resets at local midnight)"></span>
    </div>
  `;
  document.body.appendChild(wrap);
  return wrap.querySelector<HTMLElement>('.sidebar-widget-cost')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  _setTelemetryCostModeForTesting('api');
  // HS-8531 — the sidebar cost cache is module-level + sticky across
  // calls; clear it between tests so each case starts from a known
  // "no projects observed yet" state.
  _testingSidebarCost.resetCache();
});

afterEach(() => {
  document.body.innerHTML = '';
  _setTelemetryCostModeForTesting('api');
  _testingSidebarCost.resetCache();
});

describe('updateSidebarWidgetCost', () => {
  it('renders the active project\'s cost as $N.NN', () => {
    const span = mountWidget();
    _setProjectsForTesting([A, B], A.secret);
    updateSidebarWidgetCost({ 'sec-a': 1.234, 'sec-b': 9.99 });
    expect(span.textContent).toBe('$1.23');
    expect(span.style.display).toBe('');
  });

  it('hides when the active project has zero / missing cost', () => {
    const span = mountWidget();
    _setProjectsForTesting([A, B], A.secret);
    updateSidebarWidgetCost({ 'sec-b': 5.0 });
    expect(span.textContent).toBe('');
    expect(span.style.display).toBe('none');
  });

  it('uses <$0.01 for sub-cent values', () => {
    const span = mountWidget();
    _setProjectsForTesting([A], A.secret);
    updateSidebarWidgetCost({ 'sec-a': 0.004 });
    expect(span.textContent).toBe('<$0.01');
    expect(span.style.display).toBe('');
  });

  it('hides under subscription billing even when cost > 0', () => {
    const span = mountWidget();
    _setProjectsForTesting([A], A.secret);
    _setTelemetryCostModeForTesting('subscription');
    updateSidebarWidgetCost({ 'sec-a': 4.2 });
    expect(span.textContent).toBe('');
    expect(span.style.display).toBe('none');
  });

  it('switches the displayed cost when the active project changes', () => {
    const span = mountWidget();
    _setProjectsForTesting([A, B], A.secret);
    updateSidebarWidgetCost({ 'sec-a': 1.0, 'sec-b': 2.5 });
    expect(span.textContent).toBe('$1.00');

    _setProjectsForTesting([A, B], B.secret);
    // Re-render scenario: a fresh widget is mounted (replaceWith), and
    // refreshSidebarWidgetCost re-applies the cached map without a new
    // poll tick.
    document.body.innerHTML = '';
    const span2 = mountWidget();
    refreshSidebarWidgetCost();
    expect(span2.textContent).toBe('$2.50');
  });

  it('is a no-op when no widget is mounted', () => {
    _setProjectsForTesting([A], A.secret);
    expect(() => updateSidebarWidgetCost({ 'sec-a': 1.0 })).not.toThrow();
  });

  // HS-8531 — sticky-cache regression coverage. The user reported the
  // cost disappearing briefly after switching tabs; the fix caches each
  // project's last-known value and keeps showing it when subsequent
  // fetches omit the project (which the server does when today's cost
  // is zero — by design — but also during transient tab-switch
  // re-mounts before the next bell-poll lands).
  it('keeps showing the previously-displayed cost when the next fetch omits the project', () => {
    const span = mountWidget();
    _setProjectsForTesting([A, B], A.secret);

    // First fetch: A = $5, B = $2.
    updateSidebarWidgetCost({ 'sec-a': 5.0, 'sec-b': 2.0 });
    expect(span.textContent).toBe('$5.00');

    // Second fetch: A is omitted (server only includes nonzero today).
    // Pre-HS-8531 this would hide the span; post-fix it stays at $5.00
    // until a fresh value for sec-a arrives.
    updateSidebarWidgetCost({ 'sec-b': 3.5 });
    expect(span.textContent).toBe('$5.00');
    expect(span.style.display).toBe('');
  });

  it('updates the cached value when the new fetch includes a different cost for the active project', () => {
    const span = mountWidget();
    _setProjectsForTesting([A], A.secret);
    updateSidebarWidgetCost({ 'sec-a': 1.0 });
    expect(span.textContent).toBe('$1.00');
    updateSidebarWidgetCost({ 'sec-a': 7.5 });
    expect(span.textContent).toBe('$7.50');
  });

  it('does NOT carry a cached value forward to a never-observed project', () => {
    const span = mountWidget();
    _setProjectsForTesting([A, B], A.secret);
    updateSidebarWidgetCost({ 'sec-a': 5.0 });
    expect(span.textContent).toBe('$5.00');

    // Switch to B (which has no observed cost yet) and re-render the
    // widget — the cost should be hidden, not "inherit" sec-a's value.
    _setProjectsForTesting([A, B], B.secret);
    document.body.innerHTML = '';
    const span2 = mountWidget();
    refreshSidebarWidgetCost();
    expect(span2.textContent).toBe('');
    expect(span2.style.display).toBe('none');
  });

  it('refreshSidebarWidgetCost re-renders from the sticky cache without a new fetch', () => {
    const span = mountWidget();
    _setProjectsForTesting([A], A.secret);
    updateSidebarWidgetCost({ 'sec-a': 4.2 });
    expect(span.textContent).toBe('$4.20');

    // Simulate a project-switch re-mount: blow away the DOM, mount a
    // fresh widget, call refreshSidebarWidgetCost — the cached value
    // should land back on screen without another /telemetry fetch.
    document.body.innerHTML = '';
    const span2 = mountWidget();
    refreshSidebarWidgetCost();
    expect(span2.textContent).toBe('$4.20');
  });
});
