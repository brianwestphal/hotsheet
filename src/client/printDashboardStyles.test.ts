// @vitest-environment happy-dom
/**
 * HS-8525 — regression test for the dashboard print stylesheet.
 *
 * The "Claude usage" section appended to the analytics dashboard
 * by `analyticsTelemetrySection.tsx` (HS-8508 / §71) ships its own
 * class hierarchy (`.analytics-telemetry-*` + `.telemetry-chip*` +
 * `.telemetry-dashboard-model-*` + `.telemetry-histogram-*` +
 * `.telemetry-recent-prompt*` + `.telemetry-cost-over-time-*`).
 * Pre-HS-8525 the dashboard print stylesheet only knew about the
 * ticket-charts grid classes, so the Claude-usage block printed
 * un-styled — full-width SVGs + tiny stacked labels — instead of
 * matching the boxed-card aesthetic the rest of the dashboard
 * uses.
 *
 * This test pins the contract: every class used by the analytics-
 * telemetry render path AND the shared telemetry renderers
 * (model donut / tool histogram / recent prompts / cost-over-time)
 * has at least one matching selector in `dashboardPrintStyles()`.
 * When someone adds a new class to the telemetry render path
 * without a matching print rule, this test fails with a precise
 * message pointing at the un-printed class.
 */
import { describe, expect, it } from 'vitest';

import { dashboardPrintStyles } from './print.js';

const REQUIRED_CLASS_SELECTORS = [
  // analyticsTelemetrySection.tsx
  '.analytics-telemetry-section',
  '.analytics-telemetry-header',
  '.analytics-telemetry-title',
  '.analytics-telemetry-window-selector',
  '.analytics-telemetry-body',
  '.analytics-telemetry-section-block',
  '.analytics-telemetry-chips',
  '.telemetry-chip',
  '.telemetry-chip-label',
  '.telemetry-chip-cost',
  '.telemetry-chip-meta',
  // telemetryCostOverTimeChart.tsx
  '.telemetry-cost-over-time-chart',
  '.telemetry-cost-over-time-svg-wrap',
  '.telemetry-cost-over-time-svg',
  '.telemetry-cost-over-time-mode-toggle',
  '.telemetry-cost-over-time-legend',
  // telemetryModelDonut.tsx
  '.telemetry-dashboard-model-donut-wrap',
  '.telemetry-dashboard-model-donut',
  '.telemetry-dashboard-model-legend',
  '.telemetry-dashboard-model-legend-row',
  '.telemetry-dashboard-model-legend-swatch',
  '.telemetry-dashboard-model-legend-name',
  '.telemetry-dashboard-model-legend-pct',
  '.telemetry-dashboard-model-legend-cost',
  '.telemetry-dashboard-model-single-caption',
  // telemetryToolHistogram.tsx
  '.telemetry-histogram-row',
  '.telemetry-histogram-header',
  '.telemetry-histogram-tool',
  '.telemetry-histogram-meta',
  '.telemetry-histogram-svg',
  // telemetryRecentPromptsList.tsx
  '.telemetry-recent-prompts',
  '.telemetry-recent-prompt',
  '.telemetry-recent-prompt-ts',
  '.telemetry-recent-prompt-model',
  '.telemetry-recent-prompt-id',
] as const;

describe('dashboardPrintStyles — Claude-usage / analytics-telemetry coverage', () => {
  const stylesheet = dashboardPrintStyles();

  it.each(REQUIRED_CLASS_SELECTORS)('print stylesheet has a rule for %s', (selector) => {
    expect(stylesheet).toContain(selector);
  });

  it('hides the window selector (interactive control has no place in print output)', () => {
    expect(stylesheet).toMatch(/\.analytics-telemetry-window-selector\s*{\s*display:\s*none/);
  });

  it('hides the cost-over-time mode toggle (interactive control has no place in print output)', () => {
    expect(stylesheet).toMatch(/\.telemetry-cost-over-time-mode-toggle\s*{\s*display:\s*none/);
  });

  it('constrains the cost-over-time SVG width so it does not blow out the page', () => {
    expect(stylesheet).toMatch(/\.telemetry-cost-over-time-svg\s*{[^}]*width:\s*100%/);
    expect(stylesheet).toMatch(/\.telemetry-cost-over-time-svg\s*{[^}]*max-height/);
  });

  it('fixes the donut at a printable pixel size (was rendering as a pixel-wide ring in the pre-fix output)', () => {
    expect(stylesheet).toMatch(/\.telemetry-dashboard-model-donut\s*{[^}]*width:\s*\d+px/);
    expect(stylesheet).toMatch(/\.telemetry-dashboard-model-donut\s*{[^}]*height:\s*\d+px/);
  });

  it('boxes the section blocks with a border so they match the ticket-charts card aesthetic', () => {
    expect(stylesheet).toMatch(/\.analytics-telemetry-section-block\s*{[^}]*border:\s*1px solid/);
  });

  it('boxes the window-total chips so they render as tiles not bare text', () => {
    expect(stylesheet).toMatch(/\.telemetry-chip[^{]*{[^}]*border:\s*1px solid/);
  });
});
