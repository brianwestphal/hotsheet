// @vitest-environment happy-dom
/**
 * HS-8817 — hover feedback for the cross-project Hourly Activity heatmap. Each
 * cell now carries its precise figures in `data-*` and the wrap hosts a styled
 * tooltip that fills + reveals on cell hover (replacing the delayed native SVG
 * `<title>`). These tests pin the precise-cost formatter and the rendered cell
 * markup + tooltip wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _testingHS8817 } from './crossProjectStatsPage.js';

const { renderHourlyHeatmap, formatPreciseCost } = _testingHS8817;

interface Cell { dow: number; hour: number; cost: number; promptCount: number; }

function cells(...overrides: Cell[]): Cell[] {
  return overrides;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('formatPreciseCost (HS-8817)', () => {
  it('shows $0.00 for zero (no <$0.01 floor)', () => {
    expect(formatPreciseCost(0)).toBe('$0.00');
  });

  it('shows 4 decimals for sub-dollar values instead of flooring to <$0.01', () => {
    // formatCost would render this as "<$0.01"; the tooltip wants the real value.
    expect(formatPreciseCost(0.0034)).toBe('$0.0034');
    expect(formatPreciseCost(0.5)).toBe('$0.5000');
  });

  it('delegates to formatCost for >= $1', () => {
    expect(formatPreciseCost(12.5)).toBe('$12.50');
    expect(formatPreciseCost(2500)).toBe('$2,500');
  });
});

describe('renderHourlyHeatmap cell markup (HS-8817)', () => {
  it('emits hoverable cells with precise data attributes + aria-label', () => {
    const wrap = renderHourlyHeatmap(cells({ dow: 1, hour: 14, cost: 0.0034, promptCount: 1 }));
    document.body.appendChild(wrap);
    const cell = wrap.querySelector('.telemetry-dashboard-heatmap-cell');
    expect(cell).not.toBeNull();
    // dow=1 (Monday) → row 0 → "Mon"; hour 14 → "14:00–15:00".
    expect(cell?.getAttribute('data-when')).toBe('Mon 14:00–15:00');
    expect(cell?.getAttribute('data-cost')).toBe('0.0034');
    expect(cell?.getAttribute('data-prompts')).toBe('1');
    expect(cell?.getAttribute('aria-label')).toBe('Mon 14:00–15:00: $0.0034, 1 prompts');
    // Intensity drives fill-opacity (not element opacity) so the hover stroke
    // stays visible on empty cells.
    expect(cell?.getAttribute('fill-opacity')).not.toBeNull();
    expect(cell?.getAttribute('opacity')).toBeNull();
  });

  it('wraps the hour at midnight (23 → 23:00–00:00)', () => {
    const wrap = renderHourlyHeatmap(cells({ dow: 0, hour: 23, cost: 1, promptCount: 0 }));
    const cell = wrap.querySelector('.telemetry-dashboard-heatmap-cell');
    // dow=0 (Sunday) → row 6 → "Sun".
    expect(cell?.getAttribute('data-when')).toBe('Sun 23:00–00:00');
  });

  it('starts with a hidden tooltip that fills + reveals on cell hover', () => {
    const wrap = renderHourlyHeatmap(cells({ dow: 2, hour: 9, cost: 3.5, promptCount: 4 }));
    document.body.appendChild(wrap);
    const tooltip = wrap.querySelector<HTMLElement>('.telemetry-dashboard-heatmap-tooltip');
    const svg = wrap.querySelector('svg');
    const cell = wrap.querySelector('.telemetry-dashboard-heatmap-cell');
    expect(tooltip?.hidden).toBe(true);

    cell?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 50, clientY: 50 }));
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.querySelector('.telemetry-dashboard-heatmap-tooltip-when')?.textContent).toBe('Tue 09:00–10:00');
    expect(tooltip?.querySelector('.telemetry-dashboard-heatmap-tooltip-cost')?.textContent).toBe('$3.50');
    expect(tooltip?.querySelector('.telemetry-dashboard-heatmap-tooltip-prompts')?.textContent).toBe('4 prompts');

    svg?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    expect(tooltip?.hidden).toBe(true);
  });

  it('singularizes the prompt label for a single prompt', () => {
    const wrap = renderHourlyHeatmap(cells({ dow: 3, hour: 0, cost: 0, promptCount: 1 }));
    document.body.appendChild(wrap);
    const tooltip = wrap.querySelector<HTMLElement>('.telemetry-dashboard-heatmap-tooltip');
    const cell = wrap.querySelector('.telemetry-dashboard-heatmap-cell');
    cell?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(tooltip?.querySelector('.telemetry-dashboard-heatmap-tooltip-prompts')?.textContent).toBe('1 prompt');
  });
});
