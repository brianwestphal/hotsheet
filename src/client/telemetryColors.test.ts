/** HS-9131 — the shared telemetry donut palette is a fixed, non-empty list of
 *  hex colors consumed by-index across the telemetry charts. */
import { describe, expect, it } from 'vitest';

import { MODEL_DONUT_COLORS } from './telemetryColors.js';

describe('MODEL_DONUT_COLORS', () => {
  it('is a non-empty list of unique 6-digit hex colors', () => {
    expect(MODEL_DONUT_COLORS.length).toBeGreaterThan(0);
    for (const c of MODEL_DONUT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(MODEL_DONUT_COLORS).size).toBe(MODEL_DONUT_COLORS.length);
  });
});
