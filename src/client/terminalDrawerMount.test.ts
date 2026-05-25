// @vitest-environment happy-dom
/**
 * HS-8590 — unit coverage for `shouldRefitOnRender`, the exact-match guard
 * that drives the drawer terminal's `onRender` fit-convergence. The guard is
 * the testable core of the fix: it must say "re-fit" only when the freshly-
 * painted pane geometry actually implies different cols/rows than the term
 * currently has, so the `onRender → fit → resize → render` loop settles once
 * the pane has converged (the HS-8055 feedback-loop class).
 *
 * The DOM mount + onRender wiring itself is timing-driven (real xterm paints
 * into a laid-out pane) and is exercised in the app / e2e, not here.
 */
import { describe, expect, it } from 'vitest';

import { shouldRefitOnRender } from './terminalDrawerMount.js';

describe('shouldRefitOnRender (HS-8590)', () => {
  it('returns false when proposeDimensions returned undefined (pane not measurable)', () => {
    expect(shouldRefitOnRender(undefined, 80, 24)).toBe(false);
  });

  it('returns false when the proposed dims match the term (converged → no-op)', () => {
    expect(shouldRefitOnRender({ cols: 178, rows: 42 }, 178, 42)).toBe(false);
  });

  it('returns true when the proposed cols differ (e.g. fresh 80-col checkout in a 178-col pane)', () => {
    expect(shouldRefitOnRender({ cols: 178, rows: 24 }, 80, 24)).toBe(true);
  });

  it('returns true when only the proposed rows differ', () => {
    expect(shouldRefitOnRender({ cols: 80, rows: 42 }, 80, 24)).toBe(true);
  });

  it('returns true when both differ', () => {
    expect(shouldRefitOnRender({ cols: 178, rows: 42 }, 80, 24)).toBe(true);
  });
});
