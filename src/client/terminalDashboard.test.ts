/**
 * HS-7948 — pure unit tests for the persisted-slider-value parser used by
 * the terminal dashboard's scale-slider hydration path. The parser is the
 * trust boundary between `<dataDir>/settings.json` (which a user can
 * hand-edit) and the in-memory `sliderValue` that drives every tile's
 * sizing — so its acceptance rules have to be deterministic.
 */
import { describe, expect, it } from 'vitest';

import { parsePersistedSliderValue } from './terminalDashboard.js';

describe('parsePersistedSliderValue (HS-7948)', () => {
  it('accepts a numeric value in range', () => {
    expect(parsePersistedSliderValue(42)).toBe(42);
    expect(parsePersistedSliderValue(0)).toBe(0);
    expect(parsePersistedSliderValue(100)).toBe(100);
    expect(parsePersistedSliderValue(33)).toBe(33);
  });

  it('accepts a numeric string and parses it', () => {
    expect(parsePersistedSliderValue('42')).toBe(42);
    expect(parsePersistedSliderValue('33.5')).toBe(33.5);
    expect(parsePersistedSliderValue('0')).toBe(0);
  });

  it('rejects values outside [0, 100] so a corrupted settings file cannot break the slider', () => {
    expect(parsePersistedSliderValue(-1)).toBeNull();
    expect(parsePersistedSliderValue(101)).toBeNull();
    expect(parsePersistedSliderValue(99999)).toBeNull();
    expect(parsePersistedSliderValue('-5')).toBeNull();
    expect(parsePersistedSliderValue('1000')).toBeNull();
  });

  it('rejects non-numeric strings', () => {
    expect(parsePersistedSliderValue('abc')).toBeNull();
    expect(parsePersistedSliderValue('')).toBeNull();
    expect(parsePersistedSliderValue('NaN')).toBeNull();
  });

  it('rejects NaN / Infinity / -Infinity', () => {
    expect(parsePersistedSliderValue(Number.NaN)).toBeNull();
    expect(parsePersistedSliderValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parsePersistedSliderValue(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('rejects undefined and null (key missing from settings.json)', () => {
    expect(parsePersistedSliderValue(undefined)).toBeNull();
    expect(parsePersistedSliderValue(null)).toBeNull();
  });

  it('rejects non-scalar inputs (defensive against a settings shape drift)', () => {
    expect(parsePersistedSliderValue({})).toBeNull();
    expect(parsePersistedSliderValue([])).toBeNull();
    expect(parsePersistedSliderValue(true)).toBeNull();
    expect(parsePersistedSliderValue([42])).toBeNull();
  });
});
