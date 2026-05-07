/**
 * HS-7948 / HS-8176 / HS-8290 — pure unit tests for the persisted-column-
 * count parser used by the terminal dashboard's scale-slider hydration
 * path. Post-HS-8290 the value lives in global config under
 * `dashboard.columnsPerRow`; the legacy `dashboard_slider_value` 0..100
 * shape was dropped (no migration since the feature wasn't public).
 */
import { describe, expect, it } from 'vitest';

import { parsePersistedColumnCount } from './terminalDashboard.js';

describe('parsePersistedColumnCount (HS-8290)', () => {
  it('accepts the column-count value (integer 1..10)', () => {
    expect(parsePersistedColumnCount(1)).toBe(1);
    expect(parsePersistedColumnCount(4)).toBe(4);
    expect(parsePersistedColumnCount(10)).toBe(10);
  });

  it('accepts a stringified integer', () => {
    expect(parsePersistedColumnCount('5')).toBe(5);
    expect(parsePersistedColumnCount('1')).toBe(1);
  });

  it('rejects out-of-range values', () => {
    expect(parsePersistedColumnCount(0)).toBeNull();
    expect(parsePersistedColumnCount(11)).toBeNull();
    expect(parsePersistedColumnCount(99)).toBeNull();
    expect(parsePersistedColumnCount(-3)).toBeNull();
  });

  it('rejects non-numeric strings', () => {
    expect(parsePersistedColumnCount('abc')).toBeNull();
    expect(parsePersistedColumnCount('')).toBeNull();
  });

  it('rejects NaN / Infinity', () => {
    expect(parsePersistedColumnCount(Number.NaN)).toBeNull();
    expect(parsePersistedColumnCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rejects undefined / null', () => {
    expect(parsePersistedColumnCount(undefined)).toBeNull();
    expect(parsePersistedColumnCount(null)).toBeNull();
  });

  it('rejects non-scalar inputs', () => {
    expect(parsePersistedColumnCount({})).toBeNull();
    expect(parsePersistedColumnCount([])).toBeNull();
    expect(parsePersistedColumnCount(true)).toBeNull();
  });
});
