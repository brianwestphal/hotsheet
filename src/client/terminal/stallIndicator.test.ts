/**
 * HS-8175 — Tests for the stall-indicator pure helper.
 */
import { describe, expect, it } from 'vitest';

import { shouldShowStallIndicator, STALL_INDICATOR_THRESHOLD_MS } from './stallIndicator.js';

describe('shouldShowStallIndicator (HS-8175)', () => {
  it('returns false when nothing has been typed yet', () => {
    expect(shouldShowStallIndicator(0, 0, 10_000)).toBe(false);
    expect(shouldShowStallIndicator(0, 5_000, 10_000)).toBe(false);
  });

  it('returns false when echo arrived after the most recent type', () => {
    expect(shouldShowStallIndicator(1_000, 1_500, 10_000)).toBe(false);
    expect(shouldShowStallIndicator(1_000, 1_000, 10_000)).toBe(false); // simultaneous still counts as echoed
  });

  it('returns false when typed within the threshold and no echo yet', () => {
    expect(shouldShowStallIndicator(9_000, 0, 10_000)).toBe(false);
    expect(shouldShowStallIndicator(9_000, 0, 10_500)).toBe(false); // exactly threshold ms — boundary stays hidden
    expect(shouldShowStallIndicator(9_000, 0, 9_000 + STALL_INDICATOR_THRESHOLD_MS)).toBe(false);
  });

  it('returns true when typed past the threshold and no echo since', () => {
    expect(shouldShowStallIndicator(9_000, 0, 9_000 + STALL_INDICATOR_THRESHOLD_MS + 1)).toBe(true);
    expect(shouldShowStallIndicator(9_000, 8_000, 11_000)).toBe(true); // echo predates the type
    expect(shouldShowStallIndicator(1_000, 0, 10_000)).toBe(true);
  });

  it('returns false the moment a fresh echo arrives', () => {
    // Was stalled, then echo lands → hidden.
    expect(shouldShowStallIndicator(1_000, 0, 10_000)).toBe(true);
    expect(shouldShowStallIndicator(1_000, 9_500, 10_000)).toBe(false);
  });

  it('honours a custom thresholdMs', () => {
    expect(shouldShowStallIndicator(9_000, 0, 9_400, 500)).toBe(false);
    expect(shouldShowStallIndicator(9_000, 0, 9_600, 500)).toBe(true);
    expect(shouldShowStallIndicator(9_000, 0, 12_000, 5_000)).toBe(false);
    expect(shouldShowStallIndicator(9_000, 0, 14_500, 5_000)).toBe(true);
  });
});
