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

import { refreshSidebarWidgetCost, updateSidebarWidgetCost } from './dashboardMode.js';
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
});

afterEach(() => {
  document.body.innerHTML = '';
  _setTelemetryCostModeForTesting('api');
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
});
