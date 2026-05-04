/**
 * HS-7948 / HS-8176 — pure unit tests for the persisted-column-count
 * parser used by the terminal dashboard's scale-slider hydration path.
 * The parser is the trust boundary between `<dataDir>/settings.json`
 * (which a user can hand-edit) and the in-memory `columnCount` that
 * drives every tile's sizing — so its acceptance rules have to be
 * deterministic.
 *
 * HS-8176 replaced the pre-existing `parsePersistedSliderValue(0..100)`
 * with `parsePersistedColumnCount(rawNew, rawLegacy)` which prefers
 * the new `dashboard_columns_per_row` key (integer 1..10) and falls
 * back to the legacy `dashboard_slider_value` key (continuous 0..100,
 * mapped via `legacySliderValueToColumnCount`).
 */
import { describe, expect, it } from 'vitest';

import { parsePersistedColumnCount } from './terminalDashboard.js';

describe('parsePersistedColumnCount (HS-8176)', () => {
  it('accepts the new column-count key (integer 1..10)', () => {
    expect(parsePersistedColumnCount(1, undefined)).toBe(1);
    expect(parsePersistedColumnCount(4, undefined)).toBe(4);
    expect(parsePersistedColumnCount(10, undefined)).toBe(10);
  });

  it('accepts a stringified integer for the new key', () => {
    expect(parsePersistedColumnCount('5', undefined)).toBe(5);
    expect(parsePersistedColumnCount('1', undefined)).toBe(1);
  });

  it('prefers the new key when both new and legacy are present', () => {
    expect(parsePersistedColumnCount(7, 33)).toBe(7);
    expect(parsePersistedColumnCount(2, 99)).toBe(2);
  });

  it('falls back to the legacy 0..100 key when the new key is missing', () => {
    // legacy 0 → perRow 1 (one big tile)
    expect(parsePersistedColumnCount(undefined, 0)).toBe(1);
    // legacy 100 → perRow 10 (smallest tiles)
    expect(parsePersistedColumnCount(undefined, 100)).toBe(10);
    // legacy 33 (the pre-HS-8176 default) → middle perRow
    const fromDefault = parsePersistedColumnCount(undefined, 33);
    expect(fromDefault).toBeGreaterThanOrEqual(1);
    expect(fromDefault).toBeLessThanOrEqual(10);
  });

  it('rejects out-of-range new values without falling back', () => {
    expect(parsePersistedColumnCount(0, undefined)).toBeNull();
    expect(parsePersistedColumnCount(11, undefined)).toBeNull();
    expect(parsePersistedColumnCount(99, undefined)).toBeNull();
    expect(parsePersistedColumnCount(-3, undefined)).toBeNull();
  });

  it('rejects non-numeric strings for both keys', () => {
    expect(parsePersistedColumnCount('abc', 'xyz')).toBeNull();
    expect(parsePersistedColumnCount('', '')).toBeNull();
  });

  it('rejects NaN / Infinity', () => {
    expect(parsePersistedColumnCount(Number.NaN, undefined)).toBeNull();
    expect(parsePersistedColumnCount(Number.POSITIVE_INFINITY, undefined)).toBeNull();
    expect(parsePersistedColumnCount(undefined, Number.NaN)).toBeNull();
  });

  it('rejects undefined / null on both keys (key missing from settings.json)', () => {
    expect(parsePersistedColumnCount(undefined, undefined)).toBeNull();
    expect(parsePersistedColumnCount(null, null)).toBeNull();
  });

  it('rejects non-scalar inputs (defensive against a settings shape drift)', () => {
    expect(parsePersistedColumnCount({}, undefined)).toBeNull();
    expect(parsePersistedColumnCount([], undefined)).toBeNull();
    expect(parsePersistedColumnCount(true, undefined)).toBeNull();
    expect(parsePersistedColumnCount(undefined, {})).toBeNull();
  });
});
