// @vitest-environment happy-dom
/**
 * HS-8566 — cost formatter shape contract.
 */
import { describe, expect, it } from 'vitest';

import { formatCost } from './telemetryFormat.js';

describe('formatCost (HS-8566)', () => {
  it('shows $0.00 for an exact zero — preserves cent-column parity', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('shows <$0.01 only when the half-up rounded value would be 0 cents', () => {
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(0.004)).toBe('<$0.01');
    // 0.0049 still rounds half-up to 0 cents (0.49 → Math.round → 0).
    expect(formatCost(0.0049)).toBe('<$0.01');
    // 0.005 is the half-up boundary — rounds UP to 1 cent.
    expect(formatCost(0.005)).toBe('$0.01');
    // 0.0099 rounds up to 1 cent.
    expect(formatCost(0.0099)).toBe('$0.01');
  });

  it('shows two decimals between 0.01 and 1000', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.99)).toBe('$0.99');
    expect(formatCost(1)).toBe('$1.00');
    expect(formatCost(12.34)).toBe('$12.34');
    expect(formatCost(999.99)).toBe('$999.99');
  });

  it('rounds the cents half-up — 0.005 rounds to 0.01, not 0.00', () => {
    // `toFixed(2)` uses banker's rounding on some engines so 0.005 might
    // round to 0.00; the HS-8566 contract requires half-up.
    expect(formatCost(0.005)).toBe('$0.01');
    expect(formatCost(1.235)).toBe('$1.24');
  });

  it('hides cents and adds thousands separators at >= $1000', () => {
    expect(formatCost(1000)).toBe('$1,000');
    expect(formatCost(1234.56)).toBe('$1,235');
    expect(formatCost(12_345.49)).toBe('$12,345');
    expect(formatCost(12_345.50)).toBe('$12,346'); // half-up
    expect(formatCost(1_000_000)).toBe('$1,000,000');
  });

  it('999.995 sits below the $1000 cutoff before rounding but the rounded value is $1,000 — verifies the threshold uses the unrounded input', () => {
    // 999.995 → cent-half-up logic would produce 100000 cents = $1000.00;
    // by the time the >= 1000 branch's `Math.round(n)` runs, n is still
    // 999.995, which rounds to 1000. Either branch yields the same dollar
    // value but a different shape ($1,000.00 vs $1,000); HS-8566 chose
    // the >= 1000 branch's "no cents" rule to use the INPUT value, so the
    // user sees $1,000.00 here. Lock in that distinction.
    expect(formatCost(999.995)).toBe('$1,000.00');
  });
});
